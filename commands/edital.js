const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('../database/db');
const estado = require('../utils/estado');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const auditoria = require('../utils/auditoria');
const documentoPng = require('../services/gerarDocumentoPNG');
const { truncar } = require('../utils/texto');
const rhCmd = require('./rh'); // reutiliza contratarComRole (não duplica a lógica de contratação)
const diario = require('../utils/diarioOficial');

// Edital de processo seletivo para Juiz/Promotor. Fluxo 100% botão→modal, dispatch por prefixo
// "edital:" (roteado em index.js pro router abaixo, no mesmo padrão do painel:). O gate de staff
// é o MESMO das aprovações de cargo (isAdmin OU isSuperStaff) e é checado em CADA handler, não só
// na visibilidade dos botões.

const CARGO_POR_SLUG = { juiz: 'Juiz', promotor: 'Promotor' };
const CARGO_LABEL = { Juiz: 'Juiz de Direito', Promotor: 'Promotor de Justiça' };

function podeStaff(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction);
}

function row(componente) {
  return new ActionRowBuilder().addComponents(componente);
}

// ---- datas (dd/mm/aaaa) ----
function parseDataBR(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null; // rejeita 31/02 etc.
  return dt;
}

// Extrai exatamente duas datas dd/mm/aaaa de um texto livre ("01/09/2026 a 15/09/2026").
function extrairPeriodo(texto) {
  const achados = String(texto).match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  if (achados.length !== 2) return null;
  const inicio = parseDataBR(achados[0]);
  const fim = parseDataBR(achados[1]);
  if (!inicio || !fim) return null;
  return { inicioStr: achados[0], fimStr: achados[1], inicio, fim };
}

// null = pode inscrever; string = motivo da recusa.
function motivoInscricaoBloqueada(edital) {
  if (!edital) return 'Edital não encontrado.';
  if (edital.status !== 'aberto') return '🔒 Este edital está encerrado — inscrições fechadas.';
  const agora = Date.now();
  if (edital.inicioISO && agora < Date.parse(edital.inicioISO)) return `As inscrições deste edital só abrem em **${edital.inscricaoInicio}**.`;
  if (edital.fimISO && agora > Date.parse(edital.fimISO)) return `O prazo de inscrição encerrou em **${edital.inscricaoFim}**.`;
  return null;
}

// ---- embed + botões do edital ----
function embedEdital(edital) {
  const aberto = edital.status === 'aberto';
  return new EmbedBuilder()
    .setTitle(`📜 Edital de Processo Seletivo nº ${edital.numero}`)
    .setColor(aberto ? 0x2c3e50 : 0x95a5a6)
    .setDescription(aberto
      ? 'Inscrições **abertas**. Clique no botão do cargo desejado para se inscrever.'
      : '🔒 Edital **encerrado** — inscrições fechadas.')
    .addFields(
      { name: '⚖️ Vagas — Juiz de Direito', value: String(edital.vagasJuiz), inline: true },
      { name: '🏛️ Vagas — Promotor de Justiça', value: String(edital.vagasPromotor), inline: true },
      { name: '🗓️ Período de inscrição', value: `${edital.inscricaoInicio} a ${edital.inscricaoFim}` },
      { name: '📋 Requisitos', value: truncar(edital.requisitos, 1024) },
    )
    .setFooter({ text: `Edital #${edital.id} · ${aberto ? 'ABERTO' : 'ENCERRADO'}` });
}

function botoesEdital(edital) {
  const aberto = edital.status === 'aberto';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`edital:inscrever:juiz:${edital.id}`).setLabel('Inscrever-se (Juiz)').setStyle(ButtonStyle.Success).setDisabled(!aberto),
      new ButtonBuilder().setCustomId(`edital:inscrever:promotor:${edital.id}`).setLabel('Inscrever-se (Promotor)').setStyle(ButtonStyle.Success).setDisabled(!aberto),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`edital:ver:${edital.id}`).setLabel('Ver inscrições (staff)').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`edital:encerrar:${edital.id}`).setLabel('Encerrar edital (staff)').setStyle(ButtonStyle.Danger).setDisabled(!aberto),
    ),
  ];
}

// ---- 1) Abrir edital (staff) ----
function modalAbrirEdital() {
  const modal = new ModalBuilder().setCustomId('edital:criar').setTitle('Abrir edital');
  modal.addComponents(
    row(new TextInputBuilder().setCustomId('numero').setLabel('Número do edital').setPlaceholder('Ex: 001/2026').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
    row(new TextInputBuilder().setCustomId('vagas_juiz').setLabel('Vagas de Juiz (número)').setPlaceholder('Ex: 2').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
    row(new TextInputBuilder().setCustomId('vagas_promotor').setLabel('Vagas de Promotor (número)').setPlaceholder('Ex: 3').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
    row(new TextInputBuilder().setCustomId('requisitos').setLabel('Requisitos').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
    // Label ENCURTADO: o texto antigo tinha 46 chars e estourava o limite de 45 do Discord
    // ("Invalid string length" — o modal nem abria). O formato foi pro placeholder (limite 100).
    row(new TextInputBuilder().setCustomId('periodo').setLabel('Período de inscrição').setPlaceholder('Início e fim — ex: 01/09/2026 a 15/09/2026').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
  );
  return modal;
}

async function criarEdital(interaction) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode abrir editais.', ephemeral: true });

  const numero = interaction.fields.getTextInputValue('numero').trim();
  const vagasJuiz = parseInt(interaction.fields.getTextInputValue('vagas_juiz').trim(), 10);
  const vagasPromotor = parseInt(interaction.fields.getTextInputValue('vagas_promotor').trim(), 10);
  const requisitos = interaction.fields.getTextInputValue('requisitos').trim();
  const periodoRaw = interaction.fields.getTextInputValue('periodo').trim();

  if (!numero) return interaction.reply({ content: 'Informe o número do edital.', ephemeral: true });
  if (!Number.isInteger(vagasJuiz) || vagasJuiz < 0 || !Number.isInteger(vagasPromotor) || vagasPromotor < 0) {
    return interaction.reply({ content: 'Vagas inválidas — use números inteiros ≥ 0 para Juiz e Promotor.', ephemeral: true });
  }
  if (!requisitos) return interaction.reply({ content: 'Informe os requisitos.', ephemeral: true });
  const periodo = extrairPeriodo(periodoRaw);
  if (!periodo) return interaction.reply({ content: 'Período inválido — informe duas datas no formato dd/mm/aaaa (ex.: `01/09/2026 a 15/09/2026`).', ephemeral: true });
  if (periodo.fim < periodo.inicio) return interaction.reply({ content: 'A data de término não pode ser anterior à de início.', ephemeral: true });

  // Canal de editais vem do storage (estado.canalEditaisId), criado por /criar-canal-editais.
  // Sem ele NÃO cria o edital — avisa pra criar o canal primeiro (sem fallback pra contratações).
  const canalEditaisId = estado.obter('canalEditaisId');
  if (!canalEditaisId) return interaction.reply({ content: '⚠️ O canal de editais ainda não existe. Rode **/criar-canal-editais** primeiro.', ephemeral: true });
  const canal = await interaction.guild.channels.fetch(canalEditaisId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) return interaction.reply({ content: '⚠️ O canal de editais salvo não existe mais. Rode **/criar-canal-editais** de novo.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true }); // PNG (Puppeteer) é lento — defer antes

  const fimFimDoDia = new Date(periodo.fim); fimFimDoDia.setHours(23, 59, 59, 999);
  const edital = db.inserir('editais', {
    numero, status: 'aberto', vagasJuiz, vagasPromotor, requisitos,
    inscricaoInicio: periodo.inicioStr, inscricaoFim: periodo.fimStr,
    inicioISO: periodo.inicio.toISOString(), fimISO: fimFimDoDia.toISOString(),
    canalId: null, messageId: null,
    abertoPor: interaction.user.id, abertoEm: new Date().toISOString(),
    fechadoPor: null, fechadoEm: null,
  });

  const png = await documentoPng.gerarEditalPNG({ numero, vagasJuiz, vagasPromotor, requisitos, inicio: periodo.inicioStr, fim: periodo.fimStr })
    .catch(err => { console.error('Falha ao gerar PNG do edital:', err.message); return null; });

  const msg = await canal.send({
    embeds: [embedEdital(edital)],
    components: botoesEdital(edital),
    ...(png ? { files: [{ attachment: png, name: `Edital-${numero.replace(/[^\w.-]/g, '_')}.png` }] } : {}),
  });
  db.atualizarPorFiltro('editais', e => e.id === edital.id, { canalId: canal.id, messageId: msg.id });

  await auditoria.registrar(interaction.guild, {
    acao: 'Edital aberto', executorId: interaction.user.id,
    referencia: `Edital nº ${numero} (Juiz: ${vagasJuiz}, Promotor: ${vagasPromotor}) — inscrições ${periodo.inicioStr} a ${periodo.fimStr}`,
  });

  // Publica no Diário Oficial (em try/catch — falha aqui não pode quebrar a abertura do edital).
  try {
    await diario.publicarNoDiario(interaction.guild, 'edital_aberto', {
      numero, vagasJuiz, vagasPromotor, inicio: periodo.inicioStr, fim: periodo.fimStr,
      files: png ? [{ attachment: png, name: `Edital-${numero.replace(/[^\w.-]/g, '_')}.png` }] : undefined,
    });
  } catch (e) { console.error('[edital] publicação no Diário falhou (ignorado):', e.message); }

  return interaction.editReply(`✅ Edital nº **${numero}** aberto em ${canal}.${png ? '' : '\n⚠️ Não consegui renderizar a imagem; o embed foi postado mesmo assim.'}`);
}

// ---- 2) Inscrição (candidato) ----
async function abrirModalInscricao(interaction, slug, editalId) {
  const cargo = CARGO_POR_SLUG[slug];
  if (!cargo) return interaction.reply({ content: 'Cargo inválido.', ephemeral: true });
  const edital = db.buscarUm('editais', e => e.id === Number(editalId));
  const bloqueio = motivoInscricaoBloqueada(edital);
  if (bloqueio) return interaction.reply({ content: bloqueio, ephemeral: true });
  const jaInscrito = db.buscarUm('inscricoesEdital', i => i.editalId === edital.id && i.userId === interaction.user.id && i.cargo === cargo);
  if (jaInscrito) return interaction.reply({ content: `Você já se inscreveu como **${cargo}** neste edital (status: **${jaInscrito.status}**).`, ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`edital:inscricao:${slug}:${edital.id}`).setTitle(`Inscrição — ${cargo}`.slice(0, 45));
  modal.addComponents(
    row(new TextInputBuilder().setCustomId('nome').setLabel('Nome (RP)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)),
    row(new TextInputBuilder().setCustomId('rg').setLabel('RG (RP)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
    row(new TextInputBuilder().setCustomId('experiencia').setLabel('Experiência anterior em RP jurídico').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(600)),
    row(new TextInputBuilder().setCustomId('disponibilidade').setLabel('Disponibilidade + motivação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(600)),
  );
  return interaction.showModal(modal);
}

async function salvarInscricao(interaction, slug, editalId) {
  const cargo = CARGO_POR_SLUG[slug];
  if (!cargo) return interaction.reply({ content: 'Cargo inválido.', ephemeral: true });
  const edital = db.buscarUm('editais', e => e.id === Number(editalId));
  const bloqueio = motivoInscricaoBloqueada(edital);
  if (bloqueio) return interaction.reply({ content: bloqueio, ephemeral: true });
  const jaInscrito = db.buscarUm('inscricoesEdital', i => i.editalId === edital.id && i.userId === interaction.user.id && i.cargo === cargo);
  if (jaInscrito) return interaction.reply({ content: `Você já se inscreveu como **${cargo}** neste edital.`, ephemeral: true });

  const nomeRp = interaction.fields.getTextInputValue('nome').trim();
  const rg = interaction.fields.getTextInputValue('rg').trim();
  const experiencia = interaction.fields.getTextInputValue('experiencia').trim();
  const disponibilidade = interaction.fields.getTextInputValue('disponibilidade').trim();
  if (!nomeRp || !rg || !experiencia || !disponibilidade) return interaction.reply({ content: 'Preencha todos os campos.', ephemeral: true });

  db.inserir('inscricoesEdital', {
    editalId: edital.id, userId: interaction.user.id, cargo,
    nomeRp, rg, experiencia, disponibilidade,
    status: 'pendente', inscritoEm: new Date().toISOString(), decididoPor: null, decididoEm: null,
  });
  return interaction.reply({ content: `✅ Inscrição enviada como **${cargo}** no edital nº **${edital.numero}**! A staff vai avaliar e você recebe a decisão por DM.`, ephemeral: true });
}

// ---- 3) Gerenciar inscrições (staff) ----
async function verInscricoes(interaction, editalId) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só a staff pode ver as inscrições.', ephemeral: true });
  const edital = db.buscarUm('editais', e => e.id === Number(editalId));
  if (!edital) return interaction.reply({ content: 'Edital não encontrado.', ephemeral: true });
  const todas = db.todos('inscricoesEdital', i => i.editalId === edital.id); // já vem ordenado por id desc
  if (!todas.length) return interaction.reply({ content: `Nenhuma inscrição no edital nº **${edital.numero}** ainda.`, ephemeral: true });

  const pendentes = todas.filter(i => i.status === 'pendente');
  const embed = new EmbedBuilder()
    .setTitle(`Inscrições — Edital nº ${edital.numero}`)
    .setColor(0x2c3e50)
    .setDescription(`${todas.length} inscrição(ões) · **${pendentes.length} pendente(s)**.`);
  for (const i of todas.slice(0, 10)) {
    embed.addFields({
      name: `#${i.id} · ${i.cargo} · ${i.nomeRp} (RG ${i.rg}) — ${i.status}`,
      value: truncar(`Exp.: ${i.experiencia}\nDisp./motiv.: ${i.disponibilidade}`, 400),
    });
  }
  const MAX = 5; // no máx. 5 action rows por mensagem
  const rows = pendentes.slice(0, MAX).map(i => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`edital:aprovar:${i.id}`).setLabel(`✅ Aprovar #${i.id} · ${i.nomeRp}`.slice(0, 80)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`edital:reprovar:${i.id}`).setLabel(`❌ Reprovar #${i.id}`.slice(0, 80)).setStyle(ButtonStyle.Danger),
  ));
  const aviso = pendentes.length > MAX ? `\n⚠️ Mostrando ${MAX} de ${pendentes.length} pendentes — decida essas e clique de novo em "Ver inscrições".` : '';
  return interaction.reply({ content: `⚙️ **Gerenciar inscrições**${aviso}`, embeds: [embed], components: rows, ephemeral: true });
}

async function decidirInscricao(interaction, inscricaoId, aprovar) {
  if (!podeStaff(interaction)) return interaction.reply({ content: `Só a staff pode ${aprovar ? 'aprovar' : 'reprovar'} inscrições.`, ephemeral: true });
  const insc = db.buscarUm('inscricoesEdital', i => i.id === Number(inscricaoId));
  if (!insc) return interaction.reply({ content: 'Inscrição não encontrada.', ephemeral: true });
  if (insc.status !== 'pendente') return interaction.reply({ content: `Essa inscrição já foi **${insc.status}**.`, ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  db.atualizarPorFiltro('inscricoesEdital', i => i.id === insc.id, {
    status: aprovar ? 'aprovada' : 'reprovada', decididoPor: interaction.user.id, decididoEm: new Date().toISOString(),
  });

  let apelidoOk = null;
  if (aprovar) {
    // REUTILIZA o fluxo de contratação existente — não duplica atribuição de cargo/role/apelido.
    ({ apelidoOk } = await rhCmd.contratarComRole(interaction.guild, insc.userId, insc.cargo, interaction.user.id, insc.nomeRp, insc.rg));
  }

  const edital = db.buscarUm('editais', e => e.id === insc.editalId);
  const nomeAprovador = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const membro = await interaction.guild.members.fetch(insc.userId).catch(() => null);
  let dmOk = false;
  if (membro) {
    try {
      await membro.send(aprovar
        ? `✅ Sua inscrição no **Edital nº ${edital?.numero}** para **${CARGO_LABEL[insc.cargo]}** foi **APROVADA** por ${nomeAprovador}. Seu cargo já foi atribuído no servidor.`
        : `❌ Sua inscrição no **Edital nº ${edital?.numero}** para **${CARGO_LABEL[insc.cargo]}** foi **reprovada** por ${nomeAprovador}.`);
      dmOk = true;
    } catch (e) { console.error(`[edital] DM fechada/erro ao avisar ${insc.userId}:`, e.message); }
  }

  await auditoria.registrar(interaction.guild, {
    acao: `Edital: inscrição ${aprovar ? 'aprovada' : 'reprovada'}`,
    executorId: interaction.user.id,
    referencia: `Inscrição #${insc.id} — ${insc.cargo} "${insc.nomeRp}" (edital nº ${edital?.numero}) por ${nomeAprovador}`,
  });

  const avisoApelido = (aprovar && apelidoOk === false)
    ? '\n⚠️ Cargo atribuído, mas não consegui trocar o apelido (cheque a hierarquia/permissão do bot).' : '';
  const avisoDm = dmOk ? ' Candidato avisado por DM.' : ' ⚠️ DM fechada — não avisei o candidato.';
  return interaction.editReply(
    (aprovar ? `✅ Inscrição #${insc.id} **aprovada** — cargo **${insc.cargo}** atribuído a <@${insc.userId}>.` : `❌ Inscrição #${insc.id} **reprovada**.`) + avisoDm + avisoApelido,
  );
}

// ---- 4) Encerrar edital (staff) ----
async function encerrarEdital(interaction, editalId) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só a staff pode encerrar o edital.', ephemeral: true });
  const edital = db.buscarUm('editais', e => e.id === Number(editalId));
  if (!edital) return interaction.reply({ content: 'Edital não encontrado.', ephemeral: true });
  if (edital.status !== 'aberto') return interaction.reply({ content: 'Este edital já está encerrado.', ephemeral: true });

  db.atualizarPorFiltro('editais', e => e.id === edital.id, { status: 'fechado', fechadoPor: interaction.user.id, fechadoEm: new Date().toISOString() });
  const atualizado = db.buscarUm('editais', e => e.id === edital.id);

  // Desativa os botões de inscrição editando o embed postado.
  if (atualizado.canalId && atualizado.messageId) {
    const canal = await interaction.guild.channels.fetch(atualizado.canalId).catch(() => null);
    const msg = canal ? await canal.messages.fetch(atualizado.messageId).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [embedEdital(atualizado)], components: botoesEdital(atualizado) }).catch(() => {});
  }
  await auditoria.registrar(interaction.guild, { acao: 'Edital encerrado', executorId: interaction.user.id, referencia: `Edital nº ${edital.numero}` });
  try { await diario.publicarNoDiario(interaction.guild, 'edital_encerrado', { numero: edital.numero }); } catch (e) { console.error('[edital] publicação no Diário falhou (ignorado):', e.message); }
  return interaction.reply({ content: `🔒 Edital nº **${edital.numero}** encerrado — botões de inscrição desativados e novas inscrições bloqueadas.`, ephemeral: true });
}

// ---- Router (prefixo "edital:") ----
async function router(interaction) {
  const p = interaction.customId.split(':');
  const acao = p[1];
  if (interaction.isButton()) {
    if (acao === 'inscrever') return abrirModalInscricao(interaction, p[2], p[3]);
    if (acao === 'ver') return verInscricoes(interaction, p[2]);
    if (acao === 'encerrar') return encerrarEdital(interaction, p[2]);
    if (acao === 'aprovar') return decidirInscricao(interaction, p[2], true);
    if (acao === 'reprovar') return decidirInscricao(interaction, p[2], false);
    return;
  }
  if (interaction.isModalSubmit()) {
    if (acao === 'criar') return criarEdital(interaction);
    if (acao === 'inscricao') return salvarInscricao(interaction, p[2], p[3]);
  }
}

// Abre o modal de criação (gate de staff no handler). Reutilizado pelo slash /abrir-edital
// (fallback) E pelo botão "📢 Abrir edital" do hub de staff (painel:acao:edital:abrir).
async function abrirModalEdital(interaction) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode abrir editais.', ephemeral: true });
  return interaction.showModal(modalAbrirEdital());
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('abrir-edital')
    .setDescription('(Staff) Abre um edital de processo seletivo para Juiz e Promotor'),

  // Slash mantido como FALLBACK — o fluxo principal é o botão do painel.
  execute(interaction) { return abrirModalEdital(interaction); },

  router,
  abrirModalEdital,
};
