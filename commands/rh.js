const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const rh = require('../utils/rh');
const { isAdmin, isSuperStaff, podeAdministrar, RECUSA_ADMINISTRATIVA } = require('../utils/permissoes');
const logRh = require('../utils/logRh');
const config = require('../config');
const auditoria = require('../utils/auditoria');
const db = require('../database/db');
const { truncar } = require('../utils/texto');
const carteirinha = require('../utils/carteirinha');
const diario = require('../utils/diarioOficial');
const responsaveis = require('../utils/responsaveis');

// Título que vai na frente do apelido quando o cargo é aprovado (ex: "Juiz Fulano").
// Desembargador abrevia pra caber no limite de 32 caracteres do apelido do Discord.
const TITULO = {
  Delegado: 'Delegado', Promotor: 'Promotor', Juiz: 'Juiz',
  Advogado: 'Advogado', Desembargador: 'Des.', Procurador: 'Procurador',
};

// Cargos que NÃO podem ser pedidos por autoatendimento (só a Staff atribui, via /rh contratar):
// decisão de mérito (Juiz) e supervisão (Desembargador/Procurador). Sem isso, qualquer um pedia
// Juiz/Desembargador/Procurador livremente, ficando só na barreira da aprovação manual da staff.
const CARGOS_RESTRITOS = ['Juiz', 'Desembargador', 'Procurador'];

function roleIdPorCargo(cargo) {
  return {
    Delegado: config.roleDelegadoId,
    Promotor: config.rolePromotorId,
    Juiz: config.roleJuizId,
    Advogado: config.roleAdvogadoId,
    Desembargador: config.roleDesembargadorId,
    Procurador: config.roleProcuradorId,
  }[cargo];
}

// Aplica o apelido "Título Nome" (ex: "Juiz Fulano"). Pode falhar se o cargo do bot estiver
// abaixo do alvo na hierarquia ou faltar permissão "Gerenciar Apelidos" — retorna false nesse
// caso (sem quebrar o fluxo), pra quem chama avisar a staff.
async function aplicarApelido(membro, cargo, nomePersonagem) {
  if (!membro || !nomePersonagem) return null;
  const apelido = `${TITULO[cargo] || cargo} ${nomePersonagem}`.slice(0, 32);
  return membro.setNickname(apelido).then(() => true).catch(() => false);
}


// Com que PODER a pessoa agiu. Congelado na linha do log: ler "Fulano demitiu" meses depois não
// diz nada se Fulano já não for Procurador. Staff não tem cargo no /rh, e é isso que o fallback
// nomeia — não é "desconhecido", é o poder que ela de fato usou.
function cargoDoExecutor(executorId) {
  const reg = rh.getCargo(executorId);
  return (reg && reg.cargo) || 'Staff/Administração';
}

async function contratarComRole(guild, usuarioId, cargo, executorId = null, nomePersonagem = null, rg = null, motivo = null) {
  // Captura o cargo ATIVO anterior antes de contratar (rh.contratar desativa o registro antigo).
  const anterior = rh.getCargo(usuarioId);
  rh.contratar(usuarioId, cargo, nomePersonagem, rg);
  const membro = await guild.members.fetch(usuarioId).catch(() => null);
  const roleId = roleIdPorCargo(cargo);
  if (membro) {
    // Troca de cargo: remove a role do cargo anterior — senão promover (ex.) Delegado→Juiz deixava
    // a role de Delegado pendurada no Discord (o temCargo segue o registro do rh, mas a role não).
    if (anterior && anterior.cargo !== cargo) {
      const roleAnterior = roleIdPorCargo(anterior.cargo);
      if (roleAnterior) await membro.roles.remove(roleAnterior).catch(() => {});
    }
    if (roleId) await membro.roles.add(roleId).catch(() => {});
  }
  const apelidoOk = nomePersonagem ? await aplicarApelido(membro, cargo, nomePersonagem) : null;
  // Emite a carteira CERTA conforme o cargo (Advogado → OAB; Juiz/Desembargador/Promotor/Procurador
  // → carteira funcional; demais cargos → nada) e envia na DM. Render/DM que falhar é logado dentro
  // de emitirCarteirinha e não interrompe a contratação.
  const carteira = await carteirinha.emitirCarteirinha(guild, usuarioId)
    .catch(err => { console.error('[rh] falha ao emitir carteira:', err.message); return null; });
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: contratação', executorId, referencia: `<@${usuarioId}> → ${cargo}${nomePersonagem ? ` ("${nomePersonagem}")` : ''}`, motivo });
    // LOG PERSISTENTE, além da auditoria no canal: a auditoria é o AVISO (mensagem, some), isto é
    // o ARQUIVO (tabela, consultável). Ver o cabeçalho de utils/logRh.js.
    const log = logRh.registrar({
      acao: 'contratar', executorId, cargoExecutor: cargoDoExecutor(executorId),
      alvoId: usuarioId, cargoAlvo: cargo, motivo, guildId: guild?.id,
    });
    // Falha de log NÃO desfaz a contratação (o cargo já foi dado) — mas também não some mais em
    // silêncio: o aviso com os dados do lançamento manual vai para o canal de auditoria, que é
    // onde quem opera RH já está olhando. Ver utils/logRh.js.
    if (!log.ok) await auditoria.avisar(guild, log.aviso);
  }
  // Publica a nomeação no Diário Oficial (try/catch — falha aqui não pode quebrar a contratação).
  // Cobre TODOS os caminhos que contratam: /rh contratar, aprovação de solicitação e aprovação de
  // inscrição de edital (resultado de seletivo).
  try {
    await diario.publicarNoDiario(guild, 'nomeacao', { userId: usuarioId, cargo, nome: nomePersonagem, porQuemId: executorId });
  } catch (e) { console.error('[rh] publicação de nomeação no Diário falhou (ignorado):', e.message); }
  // CICLO FECHADO (19/08/2026): demitido → sem ninguém → aguardando designação → contratado →
  // o caso vai para ele sozinho. Sem isto, o caso ficava esperando a varredura periódica passar,
  // e a Staff tinha de designar na mão justamente no momento em que acabara de resolver a falta.
  //
  // Só magistratura/MP: são os papéis que o bot sorteia. Advogado entra por habilitação, que é
  // ato da parte — ninguém é designado advogado de um caso.
  let assumidos = [];
  if (rh.CARGOS_MAGISTRATURA.includes(cargo)) {
    assumidos = await responsaveis.recuperarPendencias(guild).catch(err => {
      console.error('[rh] falha ao designar pendências para o contratado:', err.message);
      return [];
    });
    if (assumidos.length) {
      console.log(`♻️ [rh] Contratação de ${usuarioId} (${cargo}): ${assumidos.length} caso(s) que aguardavam designação foram atribuídos — `
        + assumidos.map(a => `${a.numero}/${a.papel}→${a.novoId}`).join(', ') + '.');
    }
  }

  return { apelidoOk, carteira, assumidos };
}

// Contratação via PAINEL (Staff) com captura de nome + RG num modal — o painel é o caminho
// principal da Staff, então ele também passa a capturar RG (igual o /rh contratar slash). Ambos os
// campos são OPCIONAIS: RG que faltar num cargo de magistratura dispara o aviso fail-open no submit
// (não bloqueia). Pré-preenche com o cadastro atual (troca de cargo preserva nome/RG).

// Modal de MOTIVO para as ações que o painel executava direto (demitir, licença). Elas mudam
// quem pode o quê e agora exigem razão registrada — o mesmo que já vale no slash.
// `chave` volta no customId para o handler saber sobre quem e o quê.
function modalMotivoRh(acao, chave, titulo) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:rh:${acao}:${chave}`).setTitle(titulo.slice(0, 45));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('motivo').setLabel('Motivo — fica no log de RH')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
  ));
  return modal;
}

function modalContratarStaff(usuarioId, cargo) {
  const reg = rh.getCargo(usuarioId);
  const modal = new ModalBuilder().setCustomId(`painel:modal:rh:contratar:${usuarioId}#${cargo}`).setTitle(`Contratar — ${cargo}`.slice(0, 45));
  const campoNome = new TextInputBuilder().setCustomId('nome').setLabel('Nome do personagem (apelido/carteira)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30);
  if (reg && reg.nomePersonagem) campoNome.setValue(reg.nomePersonagem);
  const campoRg = new TextInputBuilder().setCustomId('rg').setLabel('RG — necessário p/ magistrado/MP').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20);
  if (reg && reg.rg) campoRg.setValue(reg.rg);
  // MOTIVO OBRIGATÓRIO (21/08/2026) — vai para o log de RH consultável. Nome e RG seguem
  // opcionais; o motivo não, porque é o único campo que explica a decisão a quem auditar depois.
  const campoMotivo = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo da contratação').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
  modal.addComponents(
    new ActionRowBuilder().addComponents(campoNome),
    new ActionRowBuilder().addComponents(campoRg),
    new ActionRowBuilder().addComponents(campoMotivo),
  );
  return modal;
}

async function contratarViaModal(interaction, usuarioId, cargo) {
  // Gate ÚNICO (21/08/2026): `podeAdministrar` — staff, ou Desembargador/Procurador pelo CARGO
  // ATIVO NO RH. Antes era `isAdmin` aqui e no slash, cada um com a sua string de recusa; agora
  // os dois caminhos batem, e quem perde o cargo no /rh perde a contratação no mesmo instante.
  if (!podeAdministrar(interaction)) {
    return interaction.reply({ content: RECUSA_ADMINISTRATIVA, ephemeral: true });
  }
  if (!usuarioId || !cargo || !rh.CARGOS.includes(cargo)) {
    return interaction.reply({ content: 'Contratação inválida (usuário/cargo).', ephemeral: true });
  }
  // deferReply ANTES do contratarComRole: ele renderiza a carteira funcional via Puppeteer (lento
  // em Chromium frio no host), o que estoura a janela de 3s da interação. Sem o defer, o reply que
  // carrega o aviso fail-open de RG morre com 10062 e o alerta some CALADO — justo o que a feature
  // existe pra evitar. Mesmo padrão de decidirSolicitacao/ofício/medida. (guards acima são rápidos,
  // ficam antes do defer.)
  await interaction.deferReply({ ephemeral: true });
  const nome = (interaction.fields.getTextInputValue('nome') || '').trim() || null;
  const rg = (interaction.fields.getTextInputValue('rg') || '').trim() || null;
  await contratarComRole(interaction.guild, usuarioId, cargo, interaction.user.id, nome, rg, (interaction.fields.getTextInputValue('motivo') || '').trim());
  // Mesmo aviso fail-open do slash: magistrado/MP que ficou sem RG → impedimento não verificável.
  const reg = rh.getCargo(usuarioId);
  const aviso = rh.precisaRg(cargo) && !(reg && reg.rg)
    ? '\n⚠️ **Sem RG cadastrado** — o impedimento não é verificável pra essa pessoa até preencher o RG em **Gerenciar dados**. Veja todos com `/rh sem-rg`.'
    : '';
  const embed = new EmbedBuilder().setColor(0x2ecc71).setDescription(`<@${usuarioId}> agora é **${cargo}**.${aviso}`);
  return interaction.editReply({ embeds: [embed] });
}

// Resumo do que aconteceu com os CASOS, para a Staff ver na hora se sobrou algo sem responsável.
// Demissão que reatribui em silêncio é a mesma coisa que demissão que não reatribui: em nenhum
// dos dois casos quem clicou sabe se pode ir embora tranquilo.
function resumoDaDemissao(saiu) {
  const lista = saiu.reatribuidos || [];
  if (!lista.length) return '📋 Nenhum caso aberto estava sob responsabilidade dele.';
  const ok = lista.filter(t => t.resultado === 'reatribuido');
  const pend = lista.filter(t => t.resultado === 'pendencia_sem_substituto');
  const habs = lista.filter(t => t.numero && t.aindaTemDefesa !== undefined);
  const linhas = [];
  if (ok.length) linhas.push(`♻️ ${ok.length} caso(s) redistribuído(s): ${ok.map(t => `**${t.numero}** → <@${t.novoId}>`).join(', ')}`);
  if (pend.length) linhas.push(`📌 ${pend.length} caso(s) **aguardando designação** (não há ninguém do cargo): ${pend.map(t => `**${t.numero}**`).join(', ')}`);
  if (habs.length) {
    const semDefesa = habs.filter(t => !t.aindaTemDefesa);
    linhas.push(`⚖️ ${habs.length} habilitação(ões) revogada(s)${semDefesa.length ? `; ${semDefesa.length} processo(s) sem defesa: ${semDefesa.map(t => `**${t.numero}**`).join(', ')}` : ''}`);
  }
  return linhas.join('\n');
}

async function demitirComRole(guild, usuarioId, executorId = null, motivo = null) {
  const registro = rh.getCargo(usuarioId);
  rh.demitir(usuarioId);
  if (registro) {
    const roleId = roleIdPorCargo(registro.cargo);
    if (roleId) {
      const membro = await guild.members.fetch(usuarioId).catch(() => null);
      if (membro) await membro.roles.remove(roleId).catch(() => {});
    }
  }
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: demissão', executorId, referencia: `<@${usuarioId}>${registro ? ` (era ${registro.cargo})` : ''}`, motivo });
    const log = logRh.registrar({
      acao: 'demitir', executorId, cargoExecutor: cargoDoExecutor(executorId),
      alvoId: usuarioId, cargoAlvo: registro ? registro.cargo : null, motivo, guildId: guild?.id,
    });
    // Idem contratar: a demissão está feita e NÃO é revertida por causa do log. O aviso aparece.
    if (!log.ok) await auditoria.avisar(guild, log.aviso);
  }

  // O CASO NÃO PODE FICAR SEM DONO (19/08/2026). Antes, a demissão só mexia no quadro; os casos
  // dela ficavam parados até a varredura periódica passar — e a varredura ABORTA quando muitos
  // aparecem de uma vez, por ser sintoma de RH zerado. Foi o que aconteceu com 8 casos de um
  // promotor desligado: ninguém assumiu, e o aviso se repetia a cada boot.
  //
  // Agora a redistribuição é EVENTO: acontece no ato da demissão, um caso por vez, com quem saiu já
  // fora do quadro. A varredura fica como rede de segurança, com a trava de massa intacta.
  // Continua devolvendo NULL quando não havia cargo — quem chama distingue "demitido" de "não tinha
  // cargo" por esse valor, e transformar isso num objeto sempre-truthy faria o painel dizer que
  // removeu alguém que nunca esteve no quadro.
  if (!registro) return null;
  const reatribuidos = await redistribuirCasosDe(guild, usuarioId, registro.cargo);
  return { ...registro, reatribuidos };
}

// Redistribui, no ato da demissão, tudo em que a pessoa era responsável.
//
// MAGISTRATURA/MP re-sorteia (respeitando a cobertura: Desembargador cobre Juiz, Procurador cobre
// Promotor). Sem ninguém disponível, o caso vira "aguardando designação" — explicitamente sem
// responsável, nunca um nome fantasma nos autos.
//
// ADVOGADO é outra coisa: ele é PARTE, não órgão. Não se sorteia advogado para alguém — as
// habilitações dele caem e o processo volta a precisar de defesa.
async function redistribuirCasosDe(guild, usuarioId, cargo) {
  if (cargo === 'Advogado') return derrubarHabilitacoesDe(guild, usuarioId);

  if (!rh.CARGOS_MAGISTRATURA.includes(cargo)) return []; // Delegado e afins: nada a re-sortear

  const tratados = await responsaveis.tratarResponsavelInvalido(guild, usuarioId, 'demitido').catch(err => {
    console.error('[rh] falha ao redistribuir casos do demitido:', err.stack || err.message);
    return [];
  });

  const reatribuidos = tratados.filter(t => t.resultado === 'reatribuido');
  const pendentes = tratados.filter(t => t.resultado === 'pendencia_sem_substituto');
  if (tratados.length) {
    console.log(`♻️ [rh] Demissão de ${usuarioId} (${cargo}): ${tratados.length} caso(s) tratado(s) — `
      + `${reatribuidos.length} redistribuído(s)${reatribuidos.length ? ` (${reatribuidos.map(t => `${t.numero}→${t.novoId}`).join(', ')})` : ''}`
      + `${pendentes.length ? `; ${pendentes.length} sem substituto, aguardando designação (${pendentes.map(t => t.numero).join(', ')})` : ''}.`);
  }
  return tratados;
}

// Advogado demitido: as habilitações dele caem e o processo volta a precisar de defesa.
//
// A habilitação não é APAGADA — vira 'Revogada'. Ato praticado não some dos autos; o que muda é
// que ela deixa de dar acesso (podeVerTeor e os gates leem status === 'Aprovado').
async function derrubarHabilitacoesDe(guild, usuarioId) {
  const tratados = [];
  for (const processo of db.todos('processos')) {
    const habs = processo.habilitacoes || [];
    if (!habs.some(h => h.advogadoId === usuarioId && h.status === 'Aprovado')) continue;

    const atualizadas = habs.map(h => (h.advogadoId === usuarioId && h.status === 'Aprovado')
      ? { ...h, status: 'Revogada', revogadaEm: new Date().toISOString(), revogadaPorDemissao: true }
      : h);
    const aindaTemDefesa = atualizadas.some(h => h.status === 'Aprovado');
    db.atualizar('processos', processo.numero, {
      habilitacoes: atualizadas,
      // Só marca "precisa de defesa" se o processo ficou SEM nenhum advogado — litisconsórcio com
      // outro defensor habilitado segue defendido.
      ...(aindaTemDefesa ? {} : { aguardandoDefesa: true, aguardandoDefesaDesde: new Date().toISOString() }),
    });
    tratados.push({ numero: processo.numero, aindaTemDefesa });

    const canal = processo.canalId ? await guild.channels.fetch(processo.canalId).catch(() => null) : null;
    if (canal) {
      await canal.permissionOverwrites.delete(usuarioId).catch(() => {});
      await canal.send({
        content: `⚠️ <@${usuarioId}> deixou o quadro de advogados — a habilitação dele neste processo foi **revogada**.\n`
          + (aindaTemDefesa
            ? 'O processo segue com os demais advogados habilitados.'
            : '📌 O processo está **sem defesa constituída**: é preciso habilitar novo advogado (ou nomear defensor dativo).'),
      }).catch(() => {});
    }
  }
  if (tratados.length) {
    console.log(`♻️ [rh] Demissão de advogado ${usuarioId}: ${tratados.length} habilitação(ões) revogada(s) — `
      + `${tratados.filter(t => !t.aindaTemDefesa).length} processo(s) sem defesa.`);
  }
  return tratados;
}

// ---- Auto-atendimento de contratação (Parte 7) ----
// Fluxo: painel "Solicitar cargo" → select do cargo → modal do nome do personagem →
// solicitação pendente postada pra staff aprovar/negar. Ao aprovar: cargo + apelido + registro.

function selectCargoDesejado() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('painel:select:cargo:desejado')
      .setPlaceholder('Qual cargo você quer solicitar?')
      .addOptions(rh.CARGOS.filter(c => !CARGOS_RESTRITOS.includes(c)).map(c => ({ label: c, value: c }))),
  );
}

function modalSolicitacao(cargo) {
  const modal = new ModalBuilder()
    .setCustomId(`painel:modal:cargo:solicitar:${cargo}`)
    .setTitle(`Solicitar cargo — ${cargo}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('nome').setLabel('Nome do seu personagem')
        .setPlaceholder('Ex: Ricardo Fernandes').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
    ),
    // RG obrigatório pra TODOS os cargos pedidos por este formulário (Update 2).
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rg').setLabel('RG do personagem')
        .setPlaceholder('Ex: 12.345.678-9').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
    ),
  );
  return modal;
}

async function solicitarCargo(interaction, cargo) {
  if (!rh.CARGOS.includes(cargo)) {
    return interaction.reply({ content: 'Cargo inválido.', ephemeral: true });
  }
  if (CARGOS_RESTRITOS.includes(cargo)) {
    return interaction.reply({ content: `O cargo **${cargo}** não pode ser solicitado por autoatendimento — é atribuído diretamente pela Staff (\`/rh contratar\`). Fale com a Staff.`, ephemeral: true });
  }
  const nome = interaction.fields.getTextInputValue('nome').trim();
  const rg = interaction.fields.getTextInputValue('rg').trim();
  if (!nome) return interaction.reply({ content: 'Informe o nome do personagem.', ephemeral: true });
  if (!rg) return interaction.reply({ content: 'Informe o RG do personagem.', ephemeral: true });

  // Uma solicitação pendente por vez, pra não encher a staff de pedidos repetidos.
  const pendente = db.buscarUm('solicitacoesCargo', s => s.discordId === interaction.user.id && s.status === 'Pendente');
  if (pendente) {
    return interaction.reply({ content: 'Você já tem uma solicitação pendente aguardando a staff. Espere a decisão dela antes de pedir de novo.', ephemeral: true });
  }

  const sol = db.inserir('solicitacoesCargo', {
    discordId: interaction.user.id, cargo, nomePersonagem: nome, rg,
    status: 'Pendente', criadoEm: new Date().toISOString(),
  });

  const embed = new EmbedBuilder()
    .setTitle('🪪 Nova solicitação de cargo')
    .setColor(0xf1c40f)
    .addFields(
      { name: 'Solicitante', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Cargo pedido', value: cargo, inline: true },
      { name: 'Nome do personagem', value: nome },
      { name: 'RG', value: rg, inline: true },
    )
    .setFooter({ text: `Solicitação #${sol.id}` });

  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:cargo:aprovar:${sol.id}`).setLabel('✅ Aprovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:cargo:negar:${sol.id}`).setLabel('❌ Negar').setStyle(ButtonStyle.Danger),
  );

  const canalId = config.canalContratacoesId || config.canalAuditoriaId;
  const canalStaff = canalId ? await interaction.guild.channels.fetch(canalId).catch(() => null) : null;
  // O card traz botões de aprovar/negar — só pode ir pra canal de staff (contratações ou auditoria).
  // NÃO cai mais pro canal onde a pessoa clicou (o /painel abre em qualquer lugar, inclusive público),
  // o que vazava o card num canal aberto. Sem canal de staff, a solicitação fica salva pra revisão.
  if (canalStaff && canalStaff.isTextBased?.()) {
    await canalStaff.send({ embeds: [embed], components: [botoes] }).catch(() => {});
    return interaction.reply({
      content: `✅ Solicitação enviada! A staff vai analisar seu pedido de **${cargo}** (personagem: **${nome}**). Você é avisado por DM quando for decidido.`,
      ephemeral: true,
    });
  }
  return interaction.reply({
    content: `✅ Solicitação de **${cargo}** (personagem: **${nome}**) registrada. ⚠️ O canal de contratações ainda não está configurado — a Staff precisa revisar as solicitações pendentes manualmente (o card com os botões não foi postado pra não vazar num canal público).`,
    ephemeral: true,
  });
}

// R7 — aprovar × negar solicitação de cargo compartilham o mesmo esqueleto (gate staff, buscar,
// guard "não pendente", deferUpdate, atualizarPorFiltro, DM, embed decidido). A divergência
// (aprovar → contratarComRole + followUp com apelido; negar → auditoria) fica ramificada por
// `aprovar`, PRESERVANDO a ordem exata de cada uma.
async function decidirSolicitacao(interaction, id, aprovar) {
  if (!podeAdministrar(interaction)) {
    return interaction.reply({ content: RECUSA_ADMINISTRATIVA, ephemeral: true });
  }
  const sol = db.buscarUm('solicitacoesCargo', s => s.id === Number(id));
  if (!sol) return interaction.reply({ content: 'Solicitação não encontrada.', ephemeral: true });
  if (sol.status !== 'Pendente') return interaction.reply({ content: `Essa solicitação já foi **${sol.status.toLowerCase()}**.`, ephemeral: true });

  await interaction.deferUpdate();
  db.atualizarPorFiltro('solicitacoesCargo', s => s.id === Number(id), {
    status: aprovar ? 'Aprovada' : 'Negada', decididoPor: interaction.user.id, decididoEm: new Date().toISOString(),
  });

  let apelidoOk = null, carteira = null;
  if (aprovar) {
    ({ apelidoOk, carteira } = await contratarComRole(interaction.guild, sol.discordId, sol.cargo, interaction.user.id, sol.nomePersonagem, sol.rg));
  }

  const membro = await interaction.guild.members.fetch(sol.discordId).catch(() => null);
  if (membro) {
    membro.send(aprovar
      ? `✅ Sua solicitação de **${sol.cargo}** foi **aprovada**! Seu cargo e apelido já foram aplicados no servidor.`
      : `❌ Sua solicitação de **${sol.cargo}** foi **negada** pela staff.`).catch(() => {});
  }

  if (!aprovar) {
    await auditoria.registrar(interaction.guild, { acao: 'Contratação negada (auto-atendimento)', executorId: interaction.user.id, referencia: `<@${sol.discordId}> → ${sol.cargo}` });
  }

  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(aprovar ? 0x2ecc71 : 0xe74c3c).setTitle(aprovar ? '🪪 Solicitação de cargo — APROVADA' : '🪪 Solicitação de cargo — NEGADA')
    .addFields({ name: 'Decidido por', value: `<@${interaction.user.id}>` });
  await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});

  if (aprovar) {
    const aviso = apelidoOk === false
      ? '\n⚠️ O cargo foi dado, mas **não consegui trocar o apelido** — verifique se o cargo do bot está **acima** do cargo dado na hierarquia e se ele tem a permissão "Gerenciar Apelidos". Ajuste o apelido na mão.'
      : '';
    // Informa o número da carteira emitida (OAB p/ advogado, matrícula p/ os demais) e a DM.
    const notaCarteira = (carteira && carteira.ok)
      ? `\n🪪 ${carteira.tipo === 'oab' ? 'OAB' : 'Matrícula'} **${carteira.numero}** emitida${carteira.dmOk ? ' — carteira enviada na DM.' : ' — **DM fechada**, não consegui enviar a carteira (use `/gerar-carteirinhas` depois).'}`
      : '';
    return interaction.followUp({
      content: `✅ <@${sol.discordId}> agora é **${sol.cargo}** — apelido: \`${TITULO[sol.cargo] || sol.cargo} ${sol.nomePersonagem}\`.${aviso}${notaCarteira}`,
      ephemeral: true,
    });
  }
}

async function aprovarSolicitacao(interaction, id) { return decidirSolicitacao(interaction, id, true); }
async function negarSolicitacao(interaction, id) { return decidirSolicitacao(interaction, id, false); }

// ---- Ficha funcional do judiciário (Parte 6) ----
// Estatísticas de atuação de cada membro, calculadas na hora a partir dos autos existentes
// (sem contagem manual). Os campos usados batem com o resto do código: processos têm
// juiz/promotor/delegado/status/habilitacoes, medidas têm delegado/promotor, petições têm
// requerenteId, apelações têm desembargadorId.
const EMOJI_CARGO = { Delegado: '👮', Promotor: '🧑‍⚖️', Juiz: '⚖️', Advogado: '🛡️', Desembargador: '🏛️', Procurador: '⚖️' };

function estatisticasDe(id, cargo, dados) {
  const { processos, medidas, peticoes, apelacoes, habilitacoes } = dados;
  switch (cargo) {
    case 'Juiz': {
      const julgados = processos.filter(p => p.juiz === id && p.status === 'Encerrado').length;
      const emAndamento = processos.filter(p => p.juiz === id && !['Encerrado', 'Arquivado'].includes(p.status)).length;
      return `${julgados} caso(s) julgado(s)${emAndamento ? ` · ${emAndamento} em andamento` : ''}`;
    }
    case 'Promotor': {
      const denuncias = processos.filter(p => p.promotor === id && p.juiz).length;
      const arquivados = processos.filter(p => p.promotor === id && p.status === 'Arquivado').length;
      const med = medidas.filter(m => m.promotor === id).length;
      return `${denuncias} denúncia(s) · ${arquivados} arquivamento(s) · ${med} medida(s)`;
    }
    case 'Advogado': {
      const pet = peticoes.filter(p => p.requerenteId === id).length;
      const hab = habilitacoes.filter(h => h.advogadoId === id && h.status === 'Aprovado').length;
      return `${pet} petição(ões) · ${hab} habilitação(ões) aprovada(s)`;
    }
    case 'Delegado': {
      const med = medidas.filter(m => m.delegado === id).length;
      return `${med} medida(s) solicitada(s)`;
    }
    case 'Desembargador': {
      const apel = apelacoes.filter(a => a.desembargadorId === id).length;
      return `${apel} apelação(ões) relatada(s)`;
    }
    case 'Procurador': {
      const med = medidas.filter(m => m.promotor === id).length;
      return `${med} atuação(ões) no MP`;
    }
    default: return '—';
  }
}

function fichaFuncional() {
  const dados = {
    processos: db.todos('processos'),
    medidas: db.todos('medidas'),
    peticoes: db.todos('peticoes'),
    apelacoes: db.todos('apelacoes'),
    habilitacoes: [],
  };
  dados.habilitacoes = dados.processos.flatMap(p => p.habilitacoes || []);

  const embed = new EmbedBuilder().setTitle('🏛️ Ficha Funcional do Judiciário').setColor(0x2c3e50);
  let algum = false;
  // Limites do Discord: campo de embed ≤ 1024 chars, embed inteiro ≤ 6000. Com muitos membros
  // isso estoura, então limita quantos aparecem por cargo e corta o valor com folga (900 < 1024,
  // e 6 cargos × 900 < 6000). Excedente vira "…e mais N".
  const LIMITE_POR_CARGO = 12;
  for (const cargo of rh.CARGOS) {
    const membros = rh.listarPorCargo(cargo);
    if (!membros.length) continue;
    algum = true;
    const linhas = membros.slice(0, LIMITE_POR_CARGO).map(m => {
      const nome = m.nomePersonagem ? ` **${m.nomePersonagem}**` : '';
      const licenca = m.licenca ? ' *(de licença)*' : '';
      return `• <@${m.discordId}>${nome}${licenca}\n   ↳ ${estatisticasDe(m.discordId, cargo, dados)}`;
    });
    if (membros.length > LIMITE_POR_CARGO) linhas.push(`*…e mais ${membros.length - LIMITE_POR_CARGO}*`);
    embed.addFields({ name: `${EMOJI_CARGO[cargo] || ''} ${cargo}`, value: truncar(linhas.join('\n'), 900) });
  }
  embed.setDescription(algum
    ? 'Atuação de cada membro, calculada automaticamente a partir dos autos.'
    : 'Nenhum membro do judiciário cadastrado ainda. Use **🪪 Solicitar cargo** pra começar.');
  return embed;
}

async function mostrarFichaFuncional(interaction) {
  return interaction.reply({ embeds: [fichaFuncional()], ephemeral: true });
}

// ---- Gerenciar dados (global, Staff/Admin) — Update 3 ----
// Edita, por usuário, o cadastro jurídico (nome do personagem, RG e OAB). Ao mudar nome/RG/OAB de
// um Advogado, regenera e reenvia a carteirinha na DM. Log via auditoria. Não mexe em cargos nem
// no apelido/roles do membro — só nos DADOS do cadastro. Fluxo botão→user-select→modal.
function podeGerenciarDados(interaction) {
  return podeAdministrar(interaction);
}

async function abrirGerenciarDados(interaction) {
  if (!podeGerenciarDados(interaction)) {
    return interaction.reply({ content: 'Só Staff/Administração pode gerenciar dados.', ephemeral: true });
  }
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('painel:userselect:dados:usuario').setPlaceholder('Selecione a pessoa'),
  );
  return interaction.reply({ content: '⚙️ **Gerenciar dados** — escolha de quem editar nome / RG / OAB:', components: [row], ephemeral: true });
}

async function abrirModalGerenciarDados(interaction, usuarioId) {
  if (!podeGerenciarDados(interaction)) {
    return interaction.reply({ content: 'Só Staff/Administração pode gerenciar dados.', ephemeral: true });
  }
  const reg = rh.getCargo(usuarioId);
  if (!reg) {
    return interaction.reply({ content: `<@${usuarioId}> não tem cadastro jurídico ativo — não há nome/RG/OAB pra editar.`, ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`painel:modal:dados:editar:${usuarioId}`).setTitle('Editar dados');
  const campoNome = new TextInputBuilder().setCustomId('nome').setLabel('Nome do personagem').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30);
  if (reg.nomePersonagem) campoNome.setValue(reg.nomePersonagem);
  const campoRg = new TextInputBuilder().setCustomId('rg').setLabel('RG').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20);
  if (reg.rg) campoRg.setValue(reg.rg);
  const campoOab = new TextInputBuilder().setCustomId('oab').setLabel('OAB (só advogado) — formato 000.000').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10);
  if (reg.oab) campoOab.setValue(reg.oab);
  modal.addComponents(
    new ActionRowBuilder().addComponents(campoNome),
    new ActionRowBuilder().addComponents(campoRg),
    new ActionRowBuilder().addComponents(campoOab),
  );
  return interaction.showModal(modal);
}

async function salvarGerenciarDados(interaction, usuarioId) {
  if (!podeGerenciarDados(interaction)) {
    return interaction.reply({ content: 'Só Staff/Administração pode gerenciar dados.', ephemeral: true });
  }
  const reg = rh.getCargo(usuarioId);
  if (!reg) return interaction.reply({ content: `<@${usuarioId}> não tem cadastro jurídico ativo.`, ephemeral: true });

  const nome = (interaction.fields.getTextInputValue('nome') || '').trim();
  const rg = (interaction.fields.getTextInputValue('rg') || '').trim();
  const oab = (interaction.fields.getTextInputValue('oab') || '').trim();
  if (!nome) return interaction.reply({ content: 'O nome não pode ficar vazio.', ephemeral: true });
  if (!rg) return interaction.reply({ content: 'O RG não pode ficar vazio.', ephemeral: true });

  const antes = { nome: reg.nomePersonagem || '—', rg: reg.rg || '—', oab: reg.oab || '—' };
  const patch = {};
  if (nome !== (reg.nomePersonagem || '')) patch.nomePersonagem = nome;
  if (rg !== (reg.rg || '')) patch.rg = rg;
  if (oab !== (reg.oab || '')) patch.oab = oab || null;
  if (!Object.keys(patch).length) {
    return interaction.reply({ content: 'Nada mudou — os valores são iguais aos atuais.', ephemeral: true });
  }
  rh.atualizarDados(usuarioId, patch);

  await auditoria.registrar(interaction.guild, {
    acao: 'Edição de dados (global)', executorId: interaction.user.id,
    referencia: `<@${usuarioId}>: ` + [
      patch.nomePersonagem !== undefined ? `nome "${antes.nome}" → "${nome}"` : null,
      patch.rg !== undefined ? `RG "${antes.rg}" → "${rg}"` : null,
      patch.oab !== undefined ? `OAB "${antes.oab}" → "${oab || '—'}"` : null,
    ].filter(Boolean).join(' · '),
  });

  // Cargo com carteira (Advogado/Juiz/Desembargador/Promotor/Procurador) e mudança que aparece
  // nela (nome/RG) → regenera e reenvia na DM.
  let notaCarteira = '';
  if (carteirinha.CARGOS_COM_CARTEIRA.includes(reg.cargo)) {
    const r = await carteirinha.emitirCarteirinha(interaction.guild, usuarioId).catch(() => null);
    if (r && r.ok) notaCarteira = `\n🪪 Carteira regenerada (nº ${r.numero})${r.dmOk ? ' e reenviada na DM.' : ' — DM fechada, não consegui enviar.'}`;
  }

  return interaction.reply({ content: `✅ Dados de <@${usuarioId}> atualizados.${notaCarteira}`, ephemeral: true });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rh')
    .setDescription('Gestão de cargos jurídicos (Staff, Desembargador ou Procurador)')
    // MOTIVO OBRIGATÓRIO nas três ações que mudam quem pode o quê (21/08/2026). Elas deixaram de
    // ser só da staff — Desembargador e Procurador também as praticam —, e um poder distribuído
    // sem registro de razão é o que ninguém consegue auditar depois. Vai para `logRh`, consultável
    // por "📜 Log de RH" no painel de Administração.
    .addSubcommand(sub => sub.setName('contratar').setDescription('Atribui um cargo jurídico a alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai receber o cargo').setRequired(true))
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c }))))
      .addStringOption(o => o.setName('motivo').setDescription('Por que esta contratação — fica no log de RH').setRequired(true))
      .addStringOption(o => o.setName('rg').setDescription('RG do personagem — necessário p/ magistrado/MP, impedimento casa por RG').setRequired(false)))
    .addSubcommand(sub => sub.setName('sem-rg').setDescription('Lista magistrados/MP ativos sem RG — impedimento não verificável'))
    .addSubcommand(sub => sub.setName('demitir').setDescription('Remove o cargo jurídico de alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai perder o cargo').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Por que esta demissão — fica no log de RH').setRequired(true)))
    .addSubcommand(sub => sub.setName('licenca').setDescription('Marca/desmarca alguém como afastado')
      .addUserOption(o => o.setName('usuario').setDescription('Quem entra/sai de licença').setRequired(true))
      .addBooleanOption(o => o.setName('afastado').setDescription('true = entra de licença, false = volta ativo').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Por que — fica no log de RH').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista quem está em cada cargo')
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c }))))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (!podeAdministrar(interaction)) {
      return interaction.reply({ content: RECUSA_ADMINISTRATIVA, ephemeral: true });
    }

    if (sub === 'contratar') {
      const usuario = interaction.options.getUser('usuario');
      const cargo = interaction.options.getString('cargo');
      const rg = (interaction.options.getString('rg') || '').trim() || null;
      // deferReply antes do contratarComRole (render da carteira via Puppeteer estoura os 3s em
      // Chromium frio) — senão o reply que carrega o aviso fail-open de RG morre com 10062. Mesmo
      // motivo do contratarViaModal. editReply depois.
      await interaction.deferReply();
      await contratarComRole(interaction.guild, usuario.id, cargo, interaction.user.id, null, rg, interaction.options.getString('motivo'));
      // Fail-open VISÍVEL: se é cargo de magistratura/MP e a pessoa segue sem RG (nem informado agora,
      // nem preservado de um cargo anterior), avisa que o impedimento não vai pegar pra ela.
      const reg = rh.getCargo(usuario.id);
      const aviso = rh.precisaRg(cargo) && !(reg && reg.rg)
        ? '\n⚠️ **Sem RG cadastrado** — o impedimento não é verificável pra essa pessoa até preencher o RG em **Gerenciar dados**. Veja todos com `/rh sem-rg`.'
        : '';
      return interaction.editReply({ content: `${usuario} agora é **${cargo}**.${aviso}` });
    }

    if (sub === 'sem-rg') {
      const lista = rh.magistradosSemRg();
      if (!lista.length) {
        return interaction.reply({ content: '✅ Todos os magistrados/MP ativos têm RG cadastrado — o impedimento é verificável pra todos.', ephemeral: true });
      }
      const linhas = lista.map(r => `• <@${r.discordId}>${r.nomePersonagem ? ` **${r.nomePersonagem}**` : ''} — ${r.cargo}`);
      const embed = new EmbedBuilder().setColor(0xe67e22)
        .setTitle('⚠️ Magistrados/MP sem RG — impedimento não verificável')
        .setDescription(truncar(linhas.join('\n'), 3800) + '\n\n*Preencha o RG em **Gerenciar dados** pra a trava de impedimento passar a valer pra essas pessoas.*');
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'demitir') {
      const usuario = interaction.options.getUser('usuario');
      // Defer: a redistribuição percorre os tickets abertos e posta nos canais — passa dos 3s.
      await interaction.deferReply();
      const saiu = await demitirComRole(interaction.guild, usuario.id, interaction.user.id, interaction.options.getString('motivo'));
      if (!saiu) return interaction.editReply({ content: `${usuario} não tinha cargo jurídico ativo.` });
      // Diz o que aconteceu com os CASOS, não só com o cargo: era isso que faltava para a Staff
      // saber se sobrou algo aguardando designação.
      return interaction.editReply({ content: `${usuario} foi removido do cargo jurídico.
${resumoDaDemissao(saiu)}` });
    }

    if (sub === 'licenca') {
      const usuario = interaction.options.getUser('usuario');
      const afastado = interaction.options.getBoolean('afastado');
      const motivo = interaction.options.getString('motivo');
      const atualizado = rh.setLicenca(usuario.id, afastado);
      if (!atualizado) return interaction.reply({ content: 'Essa pessoa não tem cargo jurídico ativo.', ephemeral: true });
      await auditoria.registrar(interaction.guild, {
        acao: `RH: ${afastado ? 'licença' : 'retorno de licença'}`, executorId: interaction.user.id, referencia: `${usuario}`, motivo,
      });
      const log = logRh.registrar({
        acao: 'licenca', executorId: interaction.user.id, cargoExecutor: cargoDoExecutor(interaction.user.id),
        alvoId: usuario.id, cargoAlvo: (rh.getCargo(usuario.id) || {}).cargo || null,
        motivo: `${afastado ? 'Afastamento' : 'Retorno'} — ${motivo}`, guildId: interaction.guild?.id,
      });
      // Aqui HÁ quem clicou, então o aviso vai direto para ele — é quem pode lançar à mão agora,
      // sem depender de alguém ler o canal de auditoria depois. A licença em si já valeu.
      if (!log.ok) await auditoria.avisar(interaction.guild, log.aviso);
      const okTexto = `${usuario} agora está ${afastado ? '**de licença**' : '**ativo**'}.`;
      return interaction.reply({ content: log.ok ? okTexto : `${okTexto}\n\n${log.aviso}` });
    }

    if (sub === 'listar') {
      const cargo = interaction.options.getString('cargo');
      const lista = rh.listarPorCargo(cargo);
      if (lista.length === 0) return interaction.reply({ content: `Ninguém com o cargo ${cargo} no momento.`, ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle(`Cargo: ${cargo}`)
        .setColor(0x3498db)
        .setDescription(lista.map(r => `<@${r.discordId}>${r.licenca ? ' — *de licença*' : ''}`).join('\n'));

      return interaction.reply({ embeds: [embed] });
    }
  },

  modalMotivoRh, cargoDoExecutor,
  contratarComRole,
  demitirComRole, resumoDaDemissao, redistribuirCasosDe, derrubarHabilitacoesDe,
  modalContratarStaff,
  contratarViaModal,
  selectCargoDesejado,
  modalSolicitacao,
  solicitarCargo,
  aprovarSolicitacao,
  negarSolicitacao,
  mostrarFichaFuncional,
  abrirGerenciarDados,
  abrirModalGerenciarDados,
  salvarGerenciarDados,
};
