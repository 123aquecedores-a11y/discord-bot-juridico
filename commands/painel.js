const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const config = require('../config');
const { temCargo, isAdmin, isSuperStaff, papelInstitucional } = require('../utils/permissoes');
const rh = require('../utils/rh');
const crimes = require('../data/crimes.json');
const { crimeLabel, buscarCrimes } = require('../utils/crimesTexto');
const processoCmd = require('./processo');
const medidaCmd = require('./medida');
const mandadoCmd = require('./mandado');
const oficioCmd = require('./oficio');
const rhCmd = require('./rh');
const editalCmd = require('./edital');
const diarioOficialCmd = require('./diarioOficial');
const gerarCarteirinhasCmd = require('./gerarCarteirinhas');
const crimeCmd = require('./crime');
const rascunhoCrimes = require('../utils/rascunhoCrimes');
const crimePicker = require('../utils/crimePicker');
const supervisao = require('../utils/supervisao');
const peticaoCmd = require('./peticao');
const canais = require('../utils/canais');
const auditoria = require('../utils/auditoria');
const fichaCmd = require('./ficha');
const estado = require('../utils/estado');
const { truncar } = require('../utils/texto');
const certidoes = require('../utils/certidoes');
const ministerioPublico = require('../utils/ministerioPublico');
const { gerarBannerPainel } = require('../services/gerarBannerPainel');
const { detectarProcessoDoCanal } = require('../utils/contextoProcesso');
const instituicoes = require('../utils/instituicoes');
const instituicaoCmd = require('./instituicao');
const preferencias = require('../utils/preferencias');

// ---- Menu principal ----

// Brasão como thumbnail (não a arte cheia do banner) — cabe no canto do embed sem ocupar
// espaço que o menu de botões precisa, mas mantém a marca institucional em toda tela do painel,
// não só na mensagem fixa do canal.
const CAMINHO_BRASAO = path.join(__dirname, '..', 'assets', 'logo-tjsp.png');
function anexoBrasao() {
  return fs.existsSync(CAMINHO_BRASAO) ? [{ attachment: CAMINHO_BRASAO, name: 'brasao.png' }] : [];
}

// Confirmação efêmera que se AUTO-APAGA depois de `ms` (some sozinha da tela de quem clicou, pra
// não acumular "aberto em X" no canal do painel). O ato em si já está no canal do processo; isso
// é só o aviso pra quem clicou.
async function respostaSumindo(interaction, payload, ms = 45000) {
  const r = await interaction.editReply(payload);
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return r;
}

function embedMenuPrincipal() {
  const embed = new EmbedBuilder()
    .setTitle('⚖️ Painel Jurídico')
    .setColor(0x2c3e50)
    .setDescription('Escolha um módulo abaixo — mesmas funções dos comandos de barra, só que sem digitar.');
  if (fs.existsSync(CAMINHO_BRASAO)) embed.setThumbnail('attachment://brasao.png');
  return embed;
}

// Cada cargo só vê os módulos que de fato usa — os mesmos predicados que já valem lá dentro de
// cada submenu (podeEmitirOficio, fichaCmd.podeConsultar, ministerioPublico.ehMembroDoMP,
// supervisao.podeSupervisionar), só que aplicados na porta de entrada. Isso é curadoria de UX,
// não é a trava de segurança — quem chegar direto num customId (replay, link antigo) ainda
// esbarra nos MESMOS gates internos que sempre existiram (abrirSubmenu, botaoSe de cada ação).
// Delegado/Promotor/Juiz formam o eixo investigativo-processual (Medida/Mandado/Ofício);
// Desembargador/Procurador formam a supervisão (trocam gente, não abrem caso); Advogado é o
// único que protocola Petição; MP (Promotor/Procurador) é atribuição exclusiva do art. 129 CF.
function botoesMenuPrincipal(interaction) {
  const staff = isAdmin(interaction) || isSuperStaff(interaction);
  const ehDelegado = temCargo(interaction, 'Delegado');
  const ehPromotor = temCargo(interaction, 'Promotor');
  const ehJuiz = temCargo(interaction, 'Juiz');
  const doInvestigativo = ehDelegado || ehPromotor || ehJuiz;
  const revAutoLigada = preferencias.revisaoAutomaticaLigada(interaction.user.id);

  // Estilo uniforme (Secondary/cinza) em todo o menu de propósito — botão de bot só tem 5 estilos
  // fixos no Discord (sem cor customizada, sem fonte própria), e o azul vibrante do Primary lê
  // como app comum. Cinza uniforme é o que mais se aproxima de "sistema oficial" dentro do que
  // a plataforma permite. Cores semânticas (verde/vermelho) ficam reservadas pra ações de
  // decisão de mérito (aprovar/negar), não pra navegação.
  return [
    // Frente 3 — Petição virou item de Processo; Mandado e Ofício viraram itens de Medida (agrupador);
    // Ficha do judiciário virou item de Supervisão; o botão "Revisar texto" saiu (só o toggle inline).
    linha(
      botaoSe(true, 'painel:menu:processo', '📁 Processo', ButtonStyle.Secondary),
      botaoSe(doInvestigativo || staff || podeEmitirOficio(interaction), 'painel:menu:medida', '📋 Medida / Mandado / Ofício', ButtonStyle.Secondary),
      botaoSe(true, 'painel:menu:crime', '🔍 Crime', ButtonStyle.Secondary),
    ),
    linha(
      botaoSe(fichaCmd.podeConsultar(interaction), 'painel:menu:ficha', '🗂️ SISBAJUS', ButtonStyle.Secondary),
      botaoSe(ministerioPublico.ehMembroDoMP(interaction), 'painel:menu:mp', '🏛️ Ministério Público', ButtonStyle.Secondary),
      botaoSe(supervisao.podeSupervisionar(interaction), 'painel:menu:supervisao', '⚖️ Supervisão', ButtonStyle.Secondary),
    ),
    linha(
      botaoSe(true, 'painel:acao:pessoal:pendencias', '📌 Minhas pendências', ButtonStyle.Secondary),
      botaoSe(true, 'painel:acao:cargo:solicitar', '🪪 Solicitar cargo', ButtonStyle.Secondary),
      botaoSe(staff, 'painel:menu:rh', '👥 RH', ButtonStyle.Secondary),
      botaoSe(staff, 'painel:acao:dados:gerenciar', '🪪 Gerenciar dados', ButtonStyle.Secondary),
      botaoSe(staff, 'painel:acao:edital:abrir', '📢 Abrir edital', ButtonStyle.Secondary),
    ),
    linha(
      botaoSe(staff, 'painel:acao:comunicado:abrir', '📢 Publicar comunicado', ButtonStyle.Secondary),
      botaoSe(staff, 'painel:acao:carteiras:gerar', '🪪 Gerar carteiras', ButtonStyle.Secondary),
    ),
    // Preferência pessoal: quando LIGADA, a IA já revisa e publica a fundamentação sozinha (sem a
    // tela de "Revisar/Publicar"). Rótulo reflete o estado atual de quem abriu o painel.
    linha(
      revAutoLigada
        ? botaoSe(true, 'painel:acao:pessoal:revisaoauto', '✨ Revisão automática (IA): LIGADA', ButtonStyle.Success)
        : botaoSe(true, 'painel:acao:pessoal:revisaoauto', '✨ Revisão automática (IA): desligada', ButtonStyle.Secondary),
    ),
  ].filter(Boolean);
}

function botaoVoltar() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('painel:menu:home').setLabel('⬅️ Voltar ao menu').setStyle(ButtonStyle.Secondary),
  );
}

const TITULOS = {
  processo: '📁 Processo',
  medida: '📋 Medida',
  mandado: '📜 Mandado',
  oficio: '✉️ Ofício',
  crime: '🔍 Crime',
  rh: '👥 RH (Staff/Administração)',
  supervisao: '⚖️ Supervisão (Desembargador/Procurador/Staff)',
  peticao: '📄 Petição administrativa',
  ficha: '🗂️ SISBAJUS (Promotor pra cima)',
  mp: '🏛️ Ministério Público (Promotor/Procurador)',
};

// Monta um botão só se `permitido` for true — usado pra cada pessoa ver só as ações que o
// próprio cargo libera, em vez de mostrar tudo e recusar depois de clicar.
function botaoSe(permitido, customId, label, style) {
  return permitido ? new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style) : null;
}

// Uma ActionRow com pelo menos 1 botão — descarta linhas que ficaram vazias depois do filtro
// (o Discord recusa um row sem componente nenhum).
function linha(...botoes) {
  const validos = botoes.filter(Boolean);
  return validos.length ? new ActionRowBuilder().addComponents(validos) : null;
}

function submenuProcesso(interaction) {
  return [
    linha(
      botaoSe(temCargo(interaction, 'Delegado'), 'painel:acao:processo:penal', 'Abrir Penal', ButtonStyle.Success),
      botaoSe(temCargo(interaction, 'Advogado'), 'painel:acao:processo:civil', 'Abrir Civil', ButtonStyle.Success),
    ),
    linha(
      botaoSe(true, 'painel:acao:processo:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:processo:listar', 'Listar recentes', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:processo:historico', 'Histórico (autos)', ButtonStyle.Secondary),
    ),
    // Frente 3.1 — Petições administrativas agora ficam sob Processo (abre o submenu de petição).
    linha(
      botaoSe(temCargo(interaction, 'Advogado') || isAdmin(interaction), 'painel:menu:peticao', '📄 Petição administrativa', ButtonStyle.Secondary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuMedida(interaction) {
  const doInvestigativo = temCargo(interaction, 'Delegado') || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Juiz');
  return [
    linha(
      botaoSe(temCargo(interaction, 'Delegado'), 'painel:acao:medida:solicitar', 'Solicitar', ButtonStyle.Success),
      botaoSe(true, 'painel:acao:medida:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:medida:listar', 'Listar recentes', ButtonStyle.Primary),
    ),
    // Frente 3.2 — Mandado e Ofício agora ficam sob Medida (agrupador); abrem os próprios submenus.
    linha(
      botaoSe(doInvestigativo || isAdmin(interaction), 'painel:menu:mandado', '📜 Mandado', ButtonStyle.Secondary),
      botaoSe(podeEmitirOficio(interaction), 'painel:menu:oficio', '✉️ Ofício', ButtonStyle.Secondary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuMandado() {
  return [
    linha(
      botaoSe(true, 'painel:acao:mandado:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:mandado:listar', 'Listar recentes', ButtonStyle.Primary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuOficio(interaction) {
  return [
    linha(
      botaoSe(podeEmitirOficio(interaction), 'painel:acao:oficio:criar', 'Criar', ButtonStyle.Success),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuCrime() {
  return [
    linha(botaoSe(true, 'painel:acao:crime:buscar', 'Buscar', ButtonStyle.Primary)),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuRh() {
  return [
    linha(
      new ButtonBuilder().setCustomId('painel:acao:rh:contratar').setLabel('Contratar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('painel:acao:rh:demitir').setLabel('Demitir').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('painel:acao:rh:licenca').setLabel('Licença').setStyle(ButtonStyle.Secondary),
    ),
    linha(new ButtonBuilder().setCustomId('painel:acao:rh:listar').setLabel('Listar cargos').setStyle(ButtonStyle.Primary)),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuSupervisao(interaction) {
  return [
    linha(
      botaoSe(temCargo(interaction, 'Desembargador') || isAdmin(interaction), 'painel:acao:supervisao:trocarjuiz', 'Trocar Juiz', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Procurador') || isAdmin(interaction), 'painel:acao:supervisao:trocarpromotor', 'Trocar Promotor', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Desembargador') || isAdmin(interaction), 'painel:acao:supervisao:trocardesembargador', 'Trocar relator (apelação)', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Procurador') || temCargo(interaction, 'Desembargador') || isAdmin(interaction), 'painel:acao:supervisao:trocardelegado', 'Trocar Delegado', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Procurador') || isAdmin(interaction), 'painel:acao:supervisao:forcardenuncia', 'Forçar denúncia', ButtonStyle.Danger),
    ),
    // Frente 3.3 — a Ficha do judiciário (funcional) passou a viver aqui, na Supervisão.
    linha(
      // Parte 2 — caminho universal: qualquer caso (processo, medida, petição, apelação), qualquer
      // papel. Os quatro botões acima são os atalhos de sempre; este cobre o resto sem enumerar tipo.
      botaoSe(true, 'painel:acao:supervisao:trocarresponsavel', '🔁 Trocar responsável', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:supervisao:filas', 'Filas pendentes', ButtonStyle.Secondary),
      botaoSe(true, 'painel:acao:cargo:ficha', '🏅 Ficha do judiciário', ButtonStyle.Secondary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuPeticao(interaction) {
  const podeProtocolar = temCargo(interaction, 'Advogado') || isAdmin(interaction);
  return [
    linha(
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirportearma', 'Porte de Arma', ButtonStyle.Success),
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirtrocanome', 'Troca de Nome', ButtonStyle.Success),
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirlimpezaficha', 'Limpeza de Ficha', ButtonStyle.Success),
      botaoSe(podeProtocolar, 'painel:acao:peticao:abriralvaraevento', 'Alvará de Evento', ButtonStyle.Success),
    ),
    !podeProtocolar ? new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('painel:disabled').setLabel('Só Advogados protocolam petições').setStyle(ButtonStyle.Secondary).setDisabled(true)) : null,
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuFicha(interaction) {
  const pode = fichaCmd.podeConsultar(interaction);
  return [
    linha(
      botaoSe(pode, 'painel:acao:ficha:consultar', '🔍 Consultar RG/Discord', ButtonStyle.Primary),
      botaoSe(pode, 'painel:acao:ficha:certidao', '📄 Requisitar certidão', ButtonStyle.Secondary),
    ),
    !pode ? new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('painel:disabled').setLabel('Só Promotor pra cima consulta o SISBAJUS').setStyle(ButtonStyle.Secondary).setDisabled(true)) : null,
    botaoVoltar(),
  ].filter(Boolean);
}

// Instrumentos extrajudiciais do MP (art. 129 CF) — só Promotor/Procurador, de propósito:
// Juiz e Desembargador são do Judiciário, uma instituição diferente, sem essas atribuições.
function submenuMp(interaction) {
  const pode = ministerioPublico.ehMembroDoMP(interaction);
  return [
    linha(
      botaoSe(pode, 'painel:acao:mp:requisicao', 'Requisição', ButtonStyle.Primary),
      botaoSe(pode, 'painel:acao:mp:recomendacao', 'Recomendação', ButtonStyle.Primary),
      botaoSe(pode, 'painel:acao:mp:inqueritocivil', 'Abrir Inquérito Civil', ButtonStyle.Success),
    ),
    !pode ? new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('painel:disabled').setLabel('Só Promotor/Procurador — atribuição exclusiva do MP').setStyle(ButtonStyle.Secondary).setDisabled(true)) : null,
    botaoVoltar(),
  ].filter(Boolean);
}

const SUBMENUS = {
  processo: submenuProcesso,
  medida: submenuMedida,
  mandado: submenuMandado,
  oficio: submenuOficio,
  crime: submenuCrime,
  rh: submenuRh,
  supervisao: submenuSupervisao,
  peticao: submenuPeticao,
  ficha: submenuFicha,
  mp: submenuMp,
};

async function abrirSubmenu(interaction, modulo) {
  if (modulo === 'rh' && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });
  }
  if (modulo === 'supervisao' && !supervisao.podeSupervisionar(interaction)) {
    return interaction.reply({ content: 'Só Desembargador, Procurador ou Staff/Administração podem usar isso.', ephemeral: true });
  }
  const embed = new EmbedBuilder().setTitle(TITULOS[modulo]).setColor(0x2c3e50).setDescription('Escolha uma ação:');
  return interaction.update({ embeds: [embed], components: SUBMENUS[modulo](interaction) });
}

// ---- Listagens diretas ---- (embeds de medida/mandado moram nos próprios módulos — Frente 4a.5)

async function listarEResponder(interaction, tabela, embedFn, filtroAcesso = null) {
  let rows = db.todos(tabela);
  if (filtroAcesso) rows = rows.filter(r => filtroAcesso(interaction, r)); // esconde itens sigilosos de quem não tem acesso
  rows = rows.slice(0, 15);
  if (rows.length === 0) return interaction.reply({ content: 'Nenhum registro encontrado.', ephemeral: true });
  return interaction.reply({ embeds: [embedFn(rows)], ephemeral: true });
}

// Diferente de "Filas pendentes" (visão global, só Desembargador/Procurador/Staff), isto é
// pessoal: só o que está esperando uma ação de QUEM clicou, seja qual for o cargo — Juiz,
// Promotor, Delegado, Desembargador. Sem isso, a única forma de saber era lembrar de cabeça
// quais números tinham pendência e ir atrás um por um.
const STATUS_TERMINAIS_PROCESSO = ['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'];

async function minhasPendencias(interaction) {
  const uid = interaction.user.id;

  const processosJulgar = db.todos('processos', p => p.juiz === uid && !STATUS_TERMINAIS_PROCESSO.includes(p.status));
  const processosDenunciar = db.todos('processos', p => p.promotor === uid && p.status === 'Aguardando decisão do MP');
  const medidasAnalisar = db.todos('medidas', m => m.promotor === uid && m.status === 'Aguardando MP');
  const medidasDeliberar = db.todos('medidas', m => m.juiz === uid && m.status === 'Aprovada - aguardando juiz');
  const peticoesDecidir = db.todos('peticoes', p => p.juiz === uid && ['Pendente', 'Diligência'].includes(p.status));
  const apelacoesDecidir = db.todos('apelacoes', a => a.desembargadorId === uid && a.status === 'Aguardando decisão');

  const minhasMedidasComoDelegado = db.todos('medidas', m => m.delegado === uid).map(m => m.numero);
  const mandadosCumprir = db.todos('mandados', m => m.status === 'Emitido' && minhasMedidasComoDelegado.includes(m.medidaNumero));

  const habilitacoesAprovar = db.todos('processos', p => p.juiz === uid)
    .flatMap(p => (p.habilitacoes || []).filter(h => h.status === 'Pendente').map(() => p.numero));

  const linha = lista => (lista.length ? lista.map(x => x.numero ?? x).join(', ') : '—');
  const total = processosJulgar.length + processosDenunciar.length + medidasAnalisar.length + medidasDeliberar.length
    + peticoesDecidir.length + apelacoesDecidir.length + mandadosCumprir.length + habilitacoesAprovar.length;

  const embed = new EmbedBuilder().setTitle('📌 Minhas pendências').setColor(0x16a085);
  if (total === 0) {
    embed.setDescription(`Nenhuma pendência no momento, <@${uid}>.`);
  } else {
    embed.setDescription(`Tudo que está aguardando uma ação sua, <@${uid}>.`).addFields(
      ...(processosJulgar.length ? [{ name: '⚖️ Processos aguardando julgamento', value: linha(processosJulgar) }] : []),
      ...(processosDenunciar.length ? [{ name: '📁 Processos aguardando denúncia/arquivamento (MP)', value: linha(processosDenunciar) }] : []),
      ...(medidasAnalisar.length ? [{ name: '📋 Medidas aguardando sua manifestação (MP)', value: linha(medidasAnalisar) }] : []),
      ...(medidasDeliberar.length ? [{ name: '📋 Medidas aguardando sua deliberação (Juiz)', value: linha(medidasDeliberar) }] : []),
      ...(mandadosCumprir.length ? [{ name: '📜 Mandados pra cumprir', value: linha(mandadosCumprir) }] : []),
      ...(peticoesDecidir.length ? [{ name: '📄 Petições aguardando sua decisão', value: linha(peticoesDecidir) }] : []),
      ...(apelacoesDecidir.length ? [{ name: '⚖️ Apelações aguardando sua decisão', value: linha(apelacoesDecidir) }] : []),
      ...(habilitacoesAprovar.length ? [{ name: '🖋️ Habilitações pendentes de aprovação', value: truncar(habilitacoesAprovar.join(', ')) }] : []),
    );
  }

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- Modais ----

function abrirModalProcessoPenal(interaction) {
  // Frente 7: réu segue identidade nome+RG (@ opcional), como no cível. Réu com Discord vai em
  // "Menções @"; réu sem Discord entra por nome+RG. Nenhum é obrigatório (pode identificar depois).
  const modal = new ModalBuilder().setCustomId('painel:modal:processo:penal').setTitle('Abrir processo penal');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Descrição objetiva dos fatos').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_nome').setLabel('Nome do réu (se não tiver Discord)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_rg').setLabel('RG do réu').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus (se tiverem Discord)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('medida').setLabel('Nº da medida vinculada (opcional)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

async function finalizarProcessoPenal(interaction) {
  const rascunho = rascunhoCrimes.obter(interaction.user.id);
  if (!rascunho) return interaction.update({ content: 'Sessão expirada, comece de novo pelo painel.', embeds: [], components: [] });
  if (rascunho.crimes.length === 0) return interaction.reply({ content: 'Adicione ao menos um crime antes de finalizar.', ephemeral: true });

  await interaction.deferUpdate();
  try {
    const resultado = await processoCmd.criarProcessoPenal({
      guild: interaction.guild,
      delegadoId: rascunho.dados.delegadoId,
      promotorId: rascunho.dados.promotorId || null,
      crimesTexto: rascunho.crimes.join(','),
      motivo: rascunho.dados.motivo,
      reusTexto: rascunho.dados.reusTexto,
      reuNome: rascunho.dados.reuNome,
      reuRg: rascunho.dados.reuRg,
      medidaNumero: rascunho.dados.medidaNumero,
      atoMpNumero: rascunho.dados.atoMpNumero,
    });

    if (resultado.erro) return interaction.editReply({ content: resultado.erro, embeds: [], components: [] });

    if (rascunho.tipo === 'penal-medida' && rascunho.dados.medidaNumero) {
      const medida = db.buscarPorNumero('medidas', rascunho.dados.medidaNumero);
      const canalMedida = medida && await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
      if (canalMedida) await canalMedida.send({ content: `Processo ${resultado.numero} aberto a partir desta medida: ${resultado.canal}` });
    }

    if (rascunho.tipo === 'penal-mp' && rascunho.dados.atoMpNumero) {
      db.atualizar('atosMp', rascunho.dados.atoMpNumero, { processoVinculado: resultado.numero });
      const ato = db.buscarPorNumero('atosMp', rascunho.dados.atoMpNumero);
      const canalAto = ato?.canalId && await interaction.guild.channels.fetch(ato.canalId).catch(() => null);
      if (canalAto) await canalAto.send({ content: `Processo ${resultado.numero} aberto a partir deste ato: ${resultado.canal}` });
    }

    return respostaSumindo(interaction, { content: `Processo penal ${resultado.numero} aberto em ${resultado.canal}.`, embeds: [], components: [] });
  } finally {
    // Sempre limpa o rascunho — sucesso ou erro — pra um clique repetido em "Finalizar"
    // nunca tentar criar o processo (e o canal) de novo com os mesmos dados.
    rascunhoCrimes.limpar(interaction.user.id);
  }
}

// A petição inicial em PDF é anexada depois, direto na conversa do canal — então abrir
// civil não precisa mais de slash command, cabe inteiro num modal.
function abrirModalProcessoCivil(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:processo:civil').setTitle('Abrir processo civil');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome_acao').setLabel('Nome da ação').setPlaceholder('Ex: Ação indenizatória de perdas e danos').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('autor_nome').setLabel('Nome completo do autor').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('autor_rg').setLabel('RG do autor').setPlaceholder('Ex: 12.345.678-9').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_nome').setLabel('Nome completo do réu').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_rg').setLabel('RG do réu').setPlaceholder('Ex: 98.765.432-1').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalVerNumero(interaction, modulo) {
  const rotulos = { processo: 'Número do processo', medida: 'Número da medida', mandado: 'Número do mandado' };
  const modal = new ModalBuilder().setCustomId(`painel:modal:${modulo}:ver`).setTitle('Consultar');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel(rotulos[modulo]).setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalHistoricoProcesso(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:processo:historico').setTitle('Autos do processo — histórico');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel('Número do processo').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// Certidão avulsa — não depende de nenhuma petição aberta, só de saber o RG de quem se quer
// requisitar a certidão (ex: parte de um processo, alguém sob investigação em andamento).
function abrirModalCertidaoLivre(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:ficha:certidao').setTitle('Requisitar certidão de antecedentes');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('finalidade').setLabel('Finalidade da certidão').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function processarModalCertidaoLivre(interaction) {
  if (!certidoes.podeSolicitarCertidao(interaction)) {
    return interaction.reply({ content: 'Só Juiz, Promotor, Desembargador ou Procurador podem requisitar certidão.', ephemeral: true });
  }
  const instituicao = papelInstitucional(interaction);
  const resultado = await certidoes.solicitarCertidao({
    guild: interaction.guild,
    rg: interaction.fields.getTextInputValue('rg'),
    nomeCliente: interaction.fields.getTextInputValue('nome'),
    finalidade: interaction.fields.getTextInputValue('finalidade'),
    executorId: interaction.user.id, instituicao,
  });
  return interaction.reply({ content: `✅ Certidão ${resultado.numero} requisitada em ${resultado.canal}.`, ephemeral: true });
}

function abrirModalRequisicaoMp(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:mp:requisicao').setTitle('Requisição do MP');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('destinatario').setLabel('Destinatário (pessoa/órgão)').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação (o que se requisita e por quê)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prazo').setLabel('Prazo para atendimento (opcional)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

function abrirModalRecomendacaoMp(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:mp:recomendacao').setTitle('Recomendação do MP');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('destinatario').setLabel('Destinatário (pessoa/órgão)').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fundamentacao').setLabel('Razões fáticas e jurídicas').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
  );
  return interaction.showModal(modal);
}

function abrirModalInqueritoCivil(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:mp:inqueritocivil').setTitle('Instaurar Inquérito Civil');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('objeto').setLabel('Objeto da apuração').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
  );
  return interaction.showModal(modal);
}

// processoDetectado vem do painel ciente de contexto (detectarProcessoDoCanal) — quando o
// botão "Emitir ofício" é clicado de dentro do canal de um processo, o número já é conhecido e
// o campo correspondente some do modal (Discord não permite modal condicional de outro jeito
// além de montar dois modais diferentes).
// destinatarioPreenchido vem do cadastro de instituições (spec-atualizacoes-bot-juridico.md,
// seção 6) quando o Promotor escolhe uma instituição cadastrada em vez de digitar na mão — o
// campo continua editável, só nasce preenchido.
function abrirModalOficio(interaction, processoDetectado, destinatarioPreenchido) {
  const modal = new ModalBuilder()
    .setCustomId(processoDetectado ? `painel:modal:oficio:criar:${processoDetectado.numero}` : 'painel:modal:oficio:criar')
    .setTitle(processoDetectado ? `Criar ofício — Processo ${processoDetectado.numero}` : 'Criar ofício');
  const campoDestinatario = new TextInputBuilder().setCustomId('destinatario').setLabel('Destinatário').setStyle(TextInputStyle.Short).setRequired(true);
  if (destinatarioPreenchido) campoDestinatario.setValue(destinatarioPreenchido.slice(0, 100));
  modal.addComponents(
    ...(processoDetectado ? [] : [new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('processo').setLabel('Nº do processo (vazio = ofício avulso)').setStyle(TextInputStyle.Short).setRequired(false))]),
    new ActionRowBuilder().addComponents(campoDestinatario),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('assunto').setLabel('Assunto').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('conteudo').setLabel('Conteúdo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
  );
  return interaction.showModal(modal);
}

// Select de instituição cadastrada (seção 6) — "Outro destinatário" mantém a digitação manual
// de sempre, pra não travar em nada que ainda não esteja no cadastro.
function selectInstituicaoOficio(customId) {
  const opcoes = instituicoes.listar().slice(0, 24).map(i => ({ label: i.nome.slice(0, 100), value: i.slug }));
  opcoes.push({ label: 'Outro destinatário (digitar manualmente)', value: 'outro' });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Destinatário do ofício').addOptions(opcoes),
  );
}

async function abrirSelectInstituicaoOficio(interaction, numeroProcesso) {
  return interaction.reply({
    content: 'Qual o destinatário do ofício?',
    components: [selectInstituicaoOficio(`painel:select:oficio:instituicao:${numeroProcesso || ''}`)],
    ephemeral: true,
  });
}

// "Solicitar documento externo" (spec-andamentos-processuais_4.md, seção 8.5) — porta de
// entrada única pra requisitar certidão OU expedir ofício livre, direto de qualquer processo,
// resolvendo tudo por select menu em vez de modal pesado. Mesmo espírito do TEOR_PRESETS_INTIMACAO
// que já existe pra intimação — o texto padrão de cada certidão vira as opções do 1º select.
const CERTIDOES_PRESET = {
  antecedentes_criminais: { label: 'Certidão de antecedentes criminais', assunto: 'Certidão de antecedentes criminais', conteudo: 'Requer-se certidão de antecedentes criminais, para instrução dos autos.' },
  bons_antecedentes: { label: 'Certidão de bons antecedentes', assunto: 'Certidão de bons antecedentes', conteudo: 'Requer-se certidão de bons antecedentes, para instrução dos autos.' },
  nao_investigado: { label: 'Certidão de não constar como investigado', assunto: 'Certidão de não constar como investigado', conteudo: 'Requer-se certidão de não constar como investigado(a) em inquérito ou processo em curso, para instrução dos autos.' },
  outro: { label: 'Ofício livre', assunto: null, conteudo: null },
};

async function abrirSelectTipoDocumentoExterno(interaction, numero) {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:processo:tipodocumentoexterno:${numero}`).setPlaceholder('Que tipo de documento externo?')
      .addOptions(Object.entries(CERTIDOES_PRESET).map(([value, { label }]) => ({ label, value }))),
  );
  return interaction.reply({ content: 'Que tipo de documento você quer solicitar?', components: [row], ephemeral: true });
}

// Só quando o tipo é "Ofício livre" E o órgão é "Outro" é que sobra algum campo de texto livre
// pra preencher de verdade — os outros três casos (preset+instituição, preset+outro,
// livre+instituição) já têm assunto/conteudo/destinatário resolvidos sem digitar nada.
function abrirModalDestinatarioLivre(interaction, chave) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:documentoexternodestino:${chave}`).setTitle('Destinatário do documento');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('destinatario').setLabel('Destinatário').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalCrime(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:crime:buscar').setTitle('Buscar crime');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('termo').setLabel('Nome ou artigo do crime').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// Delega pra oficio.js — evita duas cópias da mesma regra divergindo com o tempo (já
// aconteceu de esquecer de atualizar uma das duas ao adicionar o Procurador).
function podeEmitirOficio(interaction) {
  return oficioCmd.podeEmitirOficio(interaction);
}

// ---- Botões de ação (dentro de cada submódulo) ----

const TABELAS_ARQUIVAR = { processo: 'processos', medida: 'medidas', apelacao: 'apelacoes', peticao: 'peticoes', ficha: 'consultas', mp: 'atosMp', oficio: 'oficios', certidao: 'certidoes' };

// Arquivamento manual: independe do status jurídico do caso (não altera decisão nem prazo),
// só tira o canal de circulação — mesma trava de mensagens + mudança de categoria que já
// acontece automaticamente quando um processo/apelação/petição chega num status terminal.
// Existe pra dar um jeito de encerrar visualmente casos parados, abandonados ou já resolvidos
// antes dessa automação existir.
function podeArquivarManualmente(interaction, modulo, entidade) {
  if (isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  if (modulo === 'processo') return uid === entidade.juiz || temCargo(interaction, 'Desembargador');
  if (modulo === 'medida') return [entidade.delegado, entidade.promotor, entidade.juiz].includes(uid) || temCargo(interaction, 'Desembargador');
  if (modulo === 'apelacao') return uid === entidade.desembargadorId || temCargo(interaction, 'Desembargador');
  if (modulo === 'peticao') return [entidade.juiz, entidade.promotor].includes(uid) || temCargo(interaction, 'Procurador');
  if (modulo === 'ficha') return uid === entidade.executorId || fichaCmd.podeConsultar(interaction);
  // Ato do MP: quem expediu, ou Procurador (chefia institucional do MP, mesma lógica de
  // supervisão usada em "trocar Promotor"/"forçar denúncia" — nunca isAdmin genérico aqui).
  if (modulo === 'mp') return uid === entidade.executorId || temCargo(interaction, 'Procurador');
  if (modulo === 'oficio') return uid === entidade.emitidoPor;
  if (modulo === 'certidao') return uid === entidade.executorId;
  return false;
}

async function arquivarManual(interaction, modulo, numero) {
  const tabela = TABELAS_ARQUIVAR[modulo];
  if (!tabela) return interaction.reply({ content: 'Tipo inválido.', ephemeral: true });
  const entidade = db.buscarPorNumero(tabela, numero);
  if (!entidade) return interaction.reply({ content: `${numero} não encontrado.`, ephemeral: true });
  if (!podeArquivarManualmente(interaction, modulo, entidade)) {
    return interaction.reply({ content: 'Você não tem permissão pra arquivar isso — só quem está responsável pelo caso, um Desembargador/Procurador ou Staff.', ephemeral: true });
  }
  if (!entidade.canalId) return interaction.reply({ content: 'Esse item não tem canal associado.', ephemeral: true });

  const canal = await interaction.guild.channels.fetch(entidade.canalId).catch(() => null);
  if (!canal) return interaction.reply({ content: 'Canal não encontrado (já pode ter sido apagado).', ephemeral: true });

  await canais.arquivarCanal(canal);
  // Marca o arquivamento manual (independe do status jurídico) pra a varredura de responsável
  // fantasma NÃO ressuscitar um caso que a Staff fechou de propósito (ver utils/responsaveis.js).
  db.atualizar(tabela, numero, { arquivadoManual: true });
  await auditoria.registrar(interaction.guild, { acao: `Arquivado manualmente (${modulo})`, executorId: interaction.user.id, referencia: numero });

  return interaction.reply({ content: `📦 ${numero} arquivado — canal travado e movido pra categoria Arquivados.`, ephemeral: true });
}

async function executarAcaoBotao(interaction, modulo, acao, extra) {
  if (acao === 'arquivarmanual') return arquivarManual(interaction, modulo, extra);

  if (modulo === 'cargo') {
    if (acao === 'solicitar') {
      return interaction.reply({ content: 'Escolha o cargo que você quer solicitar:', components: [rhCmd.selectCargoDesejado()], ephemeral: true });
    }
    if (acao === 'aprovar') return rhCmd.aprovarSolicitacao(interaction, extra);
    if (acao === 'negar') return rhCmd.negarSolicitacao(interaction, extra);
    if (acao === 'ficha') return rhCmd.mostrarFichaFuncional(interaction);
  }

  // Update 3 — Gerenciar dados (global): botão → user-select → modal (nome/RG/OAB).
  if (modulo === 'dados') {
    if (acao === 'gerenciar') return rhCmd.abrirGerenciarDados(interaction);
  }

  // Edital: botão "📢 Abrir edital" do hub de staff → modal (mesma função do slash /abrir-edital).
  if (modulo === 'edital') {
    if (acao === 'abrir') return editalCmd.abrirModalEdital(interaction);
  }

  // Comunicado: botão "📢 Publicar comunicado" do hub de staff → modal.
  if (modulo === 'comunicado') {
    if (acao === 'abrir') return diarioOficialCmd.abrirModalComunicado(interaction);
  }

  // Carteiras: botão "🪪 Gerar carteiras" do hub → backfill (mesma função do /gerar-carteirinhas).
  if (modulo === 'carteiras') {
    if (acao === 'gerar') return gerarCarteirinhasCmd.rodarBackfill(interaction);
  }

  if (modulo === 'sentenca') {
    if (acao === 'revisar') return processoCmd.revisarSentencaTexto(interaction, extra);
    if (acao === 'publicar') return processoCmd.publicarSentenca(interaction, extra);
    if (acao === 'usarrevisado') return processoCmd.usarRevisadoSentenca(interaction, extra);
  }

  if (modulo === 'parecermp') {
    if (acao === 'revisar') return processoCmd.revisarParecerTexto(interaction, extra);
    if (acao === 'enviar') return processoCmd.publicarParecer(interaction, extra);
    if (acao === 'usarrevisado') return processoCmd.usarRevisadoParecer(interaction, extra);
  }

  if (modulo === 'acordao') {
    if (acao === 'revisar') return processoCmd.revisarAcordaoTexto(interaction, extra);
    if (acao === 'publicar') return processoCmd.publicarAcordao(interaction, extra);
    if (acao === 'usarrevisado') return processoCmd.usarRevisadoAcordao(interaction, extra);
  }

  if (modulo === 'razoes') {
    if (acao === 'revisar') return processoCmd.revisarRazoesTexto(interaction, extra);
    if (acao === 'enviar') return processoCmd.publicarRazoes(interaction, extra);
    if (acao === 'usarrevisado') return processoCmd.usarRevisadoRazoes(interaction, extra);
  }

  if (modulo === 'pessoal') {
    if (acao === 'pendencias') return minhasPendencias(interaction);
    if (acao === 'revisaoauto') {
      const ligada = preferencias.alternarRevisaoAutomatica(interaction.user.id);
      // Re-renderiza o próprio menu (mesma mensagem efêmera) pra o botão já refletir o novo estado.
      return interaction.update({
        content: ligada
          ? '✨ **Revisão automática LIGADA.** A partir de agora, quando você escrever uma fundamentação (sentença, parecer, acórdão, razões, decisão de medida), a IA já revisa a redação e publica automaticamente — sem a tela de "Revisar/Publicar". A IA só ajusta a **redação**, nunca o mérito; a decisão continua sua.'
          : '✨ **Revisão automática desligada.** Você volta a ver a tela de "Revisar/Publicar" pra escolher em cada fundamentação.',
        embeds: [], components: botoesMenuPrincipal(interaction), attachments: [], files: [],
      }).catch(async () => {
        // Se a mensagem original não puder ser editada (ex.: veio de outro contexto), responde solto.
        return interaction.reply({ content: ligada ? '✨ Revisão automática LIGADA.' : '✨ Revisão automática desligada.', ephemeral: true }).catch(() => {});
      });
    }
    if (acao === 'abrirmenu') {
      // Defer PRIMEIRO (ACK instantâneo, sem arquivo) e só depois editReply com o brasão: o
      // upload do anexo junto do reply passava dos 3s no host (Railway trial, latência US-West)
      // e o Discord marcava "não respondeu a tempo" (10062). Deferindo, a janela vira 15 min.
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply({ embeds: [embedMenuPrincipal()], components: botoesMenuPrincipal(interaction), files: anexoBrasao() });
    }
  }

  if (modulo === 'processo') {
    // Fase 4 — botões-hub por cargo abrem o submenu efêmero (só quem clicou vê).
    if (['hubjuiz', 'hubmp', 'hubadvogado', 'hubdelegado'].includes(acao)) return processoCmd.abrirHubProcesso(interaction, acao, extra);
    if (acao === 'penal') {
      if (!temCargo(interaction, 'Delegado')) return interaction.reply({ content: 'Só Delegados podem abrir processo penal.', ephemeral: true });
      return abrirModalProcessoPenal(interaction);
    }
    if (acao === 'civil') {
      if (!temCargo(interaction, 'Advogado')) return interaction.reply({ content: 'Só Advogados podem abrir processo civil.', ephemeral: true });
      return abrirModalProcessoCivil(interaction);
    }
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'processo');
    if (acao === 'historico') return abrirModalHistoricoProcesso(interaction);
    // Clicado direto de um botão dentro do próprio canal do processo — o número já vem
    // embutido no customId, não precisa perguntar de novo com modal.
    if (acao === 'historicoclique') return processoCmd.verHistoricoProcesso(interaction, extra);
    if (acao === 'solicitardocumento') return abrirSelectTipoDocumentoExterno(interaction, extra);
    if (acao === 'peticionar') return processoCmd.peticionar(interaction, extra);
    if (acao === 'anexarprova') return processoCmd.abrirModalAnexarProva(interaction, extra);
    if (acao === 'rolprovas') return processoCmd.verRolProvas(interaction, extra);
    if (acao === 'gerenciar') return processoCmd.abrirGerenciar(interaction, extra);
    if (acao === 'intimarreu') return processoCmd.intimarReu(interaction, extra);
    if (acao === 'intimarreucumprida') return processoCmd.marcarIntimacaoReuCumprida(interaction, extra);
    if (acao === 'voltarfase') return processoCmd.abrirModalVoltarFase(interaction, extra);
    if (acao === 'manifestacaomp') return processoCmd.abrirManifestacaoMp(interaction, extra);
    if (acao === 'deferirreqmp') return processoCmd.decidirRequerimentoMp(interaction, extra, true);
    if (acao === 'indeferirreqmp') return processoCmd.decidirRequerimentoMp(interaction, extra, false);
    if (acao === 'addadvogado') return processoCmd.abrirAdicionarAdvogado(interaction, extra);
    if (acao === 'removeradvogado') return processoCmd.abrirRemoverAdvogado(interaction, extra);
    if (acao === 'deferirpeticao') return processoCmd.decidirPeticao(interaction, extra, true);
    if (acao === 'indeferirpeticao') return processoCmd.decidirPeticao(interaction, extra, false);
    if (acao === 'listar') return processoCmd.listarProcessos(interaction, null);
    if (acao === 'partetardia') return processoCmd.abrirSelectPapelParteTardia(interaction, extra);
    if (acao === 'gerenciardefesa') return processoCmd.abrirGerenciarDefesa(interaction, extra);
    if (acao === 'intimar') return processoCmd.abrirSelectDestinatarioIntimacao(interaction, extra);
    if (acao === 'arquivarcivil') return processoCmd.arquivarCivil(interaction, extra);
    if (acao === 'recebereintimar') return processoCmd.abrirModalReceberEIntimar(interaction, extra);
    if (acao === 'pedirrevisao') return processoCmd.pedirRevisaoArquivamento(interaction, extra);
    if (acao === 'recorrer') return processoCmd.abrirModalRecorrer(interaction, extra);
    if (acao === 'anexarpeticaoinicial') return processoCmd.anexarPeticaoInicial(interaction, extra);
    if (acao === 'anexarrelatorio') return processoCmd.anexarRelatorioInquerito(interaction, extra);
    if (acao === 'anexarcontestacao') return processoCmd.anexarContestacao(interaction, extra);
    if (acao === 'decretarrevelia') return processoCmd.decretarRevelia(interaction, extra);
    if (acao === 'requererprovas') return processoCmd.requererNovasProvas(interaction, extra);
    if (acao === 'concluirinstrucao') return processoCmd.concluirInstrucaoNovamente(interaction, extra);
    if (acao === 'regdepoimento') return processoCmd.abrirSelectTestemunha(interaction, extra);
    if (acao === 'continuarsentencapenal') return processoCmd.continuarSentencaPenal(interaction, extra);
    if (acao === 'pularsentencapenal') return processoCmd.pularSentencaPenal(interaction, extra);
  }

  if (modulo === 'habilitacao') {
    if (acao === 'solicitar') return processoCmd.abrirModalHabilitacao(interaction, extra);
    if (acao === 'aprovar') return processoCmd.decidirHabilitacao(interaction, extra, true);
    if (acao === 'negar') return processoCmd.decidirHabilitacao(interaction, extra, false);
  }

  if (modulo === 'apelacao') {
    if (acao === 'manter' || acao === 'anular') return processoCmd.abrirModalFundamentacaoDecisao(interaction, extra, acao);
    if (acao === 'reformar') return processoCmd.abrirSelecaoResultadoReforma(interaction, extra);
  }

  if (modulo === 'supervisao') {
    // Parte 2 — troca universal: `ticket` é o botão 🛡️ Supervisão dentro do caso; `trocaresp` é a
    // escolha do papel (mesma tela vinda do ticket ou do painel central).
    if (acao === 'ticket') return supervisao.abrirSupervisaoTicket(interaction, extra);
    if (acao === 'trocarresponsavel') return supervisao.abrirModalTrocaGenerica(interaction);
    if (acao === 'trocaresp') return supervisao.abrirModalTrocaResponsavel(interaction, extra);
    if (acao === 'trocarjuiz') return supervisao.abrirModalTrocarJuiz(interaction);
    if (acao === 'trocarpromotor') return supervisao.abrirModalTrocarPromotor(interaction);
    if (acao === 'trocardelegado') return supervisao.abrirModalTrocarDelegado(interaction);
    if (acao === 'trocardesembargador') return supervisao.abrirModalTrocarDesembargador(interaction);
    if (acao === 'forcardenuncia') return supervisao.abrirModalForcarDenuncia(interaction);
    if (acao === 'forcardenunciadireto') return supervisao.abrirModalForcarDenunciaDireto(interaction, extra);
    if (acao === 'manterarquivamento') return supervisao.abrirModalManterArquivamento(interaction, extra);
    if (acao === 'designarjulgador') return supervisao.abrirModalDesignarJulgador(interaction, extra);
    if (acao === 'filas') return supervisao.filasPendentes(interaction);
  }

  if (modulo === 'peticao') {
    if (acao === 'deferir' || acao === 'indeferir' || acao === 'diligencia') {
      return peticaoCmd.decidir(interaction, extra, acao);
    }
    // Manifestação do MP (Parte 1)
    if (acao === 'manifestar') return peticaoCmd.abrirSelectPosicao(interaction, extra);
    if (acao === 'nadaaopor') return peticaoCmd.registrarNadaAOpor(interaction, extra);
    if (acao === 'revisarmanif') return peticaoCmd.revisarManifestacao(interaction, extra);
    if (acao === 'enviarmanif') return peticaoCmd.finalizarManifestacao(interaction, extra, false);
    if (acao === 'usarrevisadomanif') return peticaoCmd.finalizarManifestacao(interaction, extra, true);
    if (acao === 'abrirportearma') return peticaoCmd.abrirModalPorteArma(interaction);
    if (acao === 'abrirtrocanome') return peticaoCmd.abrirModalTrocaNome(interaction);
    if (acao === 'abrirlimpezaficha') return peticaoCmd.abrirModalLimpezaFicha(interaction);
    if (acao === 'abriralvaraevento') return peticaoCmd.abrirModalAlvaraEvento(interaction);
    if (acao === 'confirmardeferir') return peticaoCmd.confirmarDeferimento(interaction, extra);
    if (acao === 'cancelardecisao') return peticaoCmd.cancelarDecisao(interaction);
    if (acao === 'maisdados') return peticaoCmd.abrirModalMaisDados(interaction, extra);
    if (acao === 'vincularmanual') return peticaoCmd.abrirModalVincularManual(interaction, extra);
    if (acao === 'certidao') return peticaoCmd.solicitarCertidaoDaPeticao(interaction, extra);
    if (acao === 'anexardocumento') return peticaoCmd.anexarDocumentoPeticao(interaction, extra);
    if (acao === 'reabrir') return peticaoCmd.reabrirCaso(interaction, extra);
  }

  if (modulo === 'ficha') {
    if (acao === 'consultar') return fichaCmd.abrirConsulta(interaction);
    if (acao === 'consultarrg') return fichaCmd.abrirModalConsultaRG(interaction);
    if (acao === 'consultardiscordid') return fichaCmd.abrirModalConsultaDiscordId(interaction);
    if (acao === 'consultartermo') return fichaCmd.abrirModalConsultaTermo(interaction);
    if (acao === 'certidao') return abrirModalCertidaoLivre(interaction);
  }

  if (modulo === 'medida') {
    if (acao === 'solicitar') {
      if (!temCargo(interaction, 'Delegado')) return interaction.reply({ content: 'Só Delegados podem solicitar medida cautelar.', ephemeral: true });
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('painel:select:medida:tipo').setPlaceholder('Tipo de medida')
          .addOptions(medidaCmd.TIPOS_MEDIDA.map((t, i) => ({ label: t, value: String(i) }))),
      );
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0xe67e22).setDescription('Qual o tipo de medida?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'medida');
    if (acao === 'listar') return listarEResponder(interaction, 'medidas', medidaCmd.embedListaMedidas, medidaCmd.temAcessoMedida);
    if (acao === 'negarjuiz') return medidaCmd.abrirModalNegarJuiz(interaction, extra);
    if (acao === 'revisarfund') return medidaCmd.revisarFundMedida(interaction, extra);
    if (acao === 'publicarfund') return medidaCmd.executarDecisaoMedida(interaction, extra, false);
    if (acao === 'usarrevisadofund') return medidaCmd.executarDecisaoMedida(interaction, extra, true);
    if (acao === 'pedirreconsideracao') return medidaCmd.pedirReconsideracao(interaction, extra);
    if (acao === 'decidirreconsideracao') return medidaCmd.decidirReconsideracao(interaction, extra);
    if (acao === 'pedirreconsideracaojuiz') return medidaCmd.pedirReconsideracaoJuiz(interaction, extra);
    if (acao === 'decidirreconsideracaojuiz') return medidaCmd.decidirReconsideracaoJuiz(interaction, extra);
    if (acao === 'solicitardireta') return medidaCmd.abrirSolicitarMedidaDireta(interaction, extra);
    if (acao === 'deferirdireta') return medidaCmd.deferirMedidaDireta(interaction, extra);
    if (acao === 'indeferirdireta') return medidaCmd.indeferirMedidaDireta(interaction, extra);
  }

  if (modulo === 'mandado') {
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'mandado');
    if (acao === 'listar') return listarEResponder(interaction, 'mandados', mandadoCmd.embedListaMandados, mandadoCmd.temAcessoMandado);
    if (acao === 'emitir') return mandadoCmd.abrirSelectTipo(interaction, extra);
  }

  if (modulo === 'oficio') {
    if (acao === 'criar') {
      if (!podeEmitirOficio(interaction)) return interaction.reply({ content: 'Só Delegado, Promotor, Juiz ou Staff/Administração podem emitir ofício.', ephemeral: true });
      const processoDetectado = await detectarProcessoDoCanal(interaction.channelId);
      return abrirSelectInstituicaoOficio(interaction, processoDetectado?.numero);
    }
    if (acao === 'cumprir') return oficioCmd.cumprirOficio(interaction, extra);
  }

  if (modulo === 'crime') {
    if (acao === 'buscar') return abrirModalCrime(interaction);
  }

  if (modulo === 'mp') {
    if (!ministerioPublico.ehMembroDoMP(interaction)) {
      return interaction.reply({ content: 'Só Promotor ou Procurador — são atribuições exclusivas do Ministério Público (art. 129 da Constituição Federal).', ephemeral: true });
    }
    if (acao === 'requisicao') return abrirModalRequisicaoMp(interaction);
    if (acao === 'recomendacao') return abrirModalRecomendacaoMp(interaction);
    if (acao === 'inqueritocivil') return abrirModalInqueritoCivil(interaction);
    if (acao === 'abrirprocesso') return ministerioPublico.abrirProcessoDeAto(interaction, extra);
  }

  if (modulo === 'crimepick') {
    if (acao === 'buscar') return interaction.showModal(crimePicker.modalBusca());
    if (acao === 'cancelar') {
      rascunhoCrimes.limpar(interaction.user.id);
      return interaction.update({ content: 'Abertura de processo cancelada.', embeds: [], components: [] });
    }
    if (acao === 'finalizar') return finalizarProcessoPenal(interaction);
  }

  if (modulo === 'rh') {
    if (!isAdmin(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });

    if (acao === 'contratar') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:contratar').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem vai receber um cargo?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'demitir') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:demitir').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem vai perder o cargo?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'licenca') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:licenca').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem entra/sai de licença?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'listar') {
      const embed = new EmbedBuilder().setTitle('👥 Cargos jurídicos').setColor(0x3498db);
      for (const cargo of rh.CARGOS) {
        const lista = rh.listarPorCargo(cargo);
        embed.addFields({ name: cargo, value: lista.length ? lista.map(r => `<@${r.discordId}>${r.licenca ? ' *(licença)*' : ''}`).join('\n') : '—' });
      }
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (acao === 'licencaon' || acao === 'licencaoff') {
      const usuarioId = extra;
      const afastado = acao === 'licencaon';
      const atualizado = rh.setLicenca(usuarioId, afastado);
      if (atualizado) {
        await auditoria.registrar(interaction.guild, {
          acao: `RH: ${afastado ? 'licença' : 'retorno de licença'}`, executorId: interaction.user.id, referencia: `<@${usuarioId}>`,
        });
      }
      const embed = new EmbedBuilder()
        .setColor(atualizado ? 0x2ecc71 : 0xe74c3c)
        .setDescription(atualizado ? `<@${usuarioId}> agora está ${afastado ? '**de licença**' : '**ativo**'}.` : 'Essa pessoa não tem cargo jurídico ativo.');
      return interaction.update({ embeds: [embed], components: [botaoVoltar()] });
    }
  }
}

// ---- Select menus (string) ----

async function tratarSelect(interaction, modulo, campo, extra) {
  if (modulo === 'medida' && campo === 'tipo') {
    const tipoIndex = interaction.values[0];
    const tipo = medidaCmd.TIPOS_MEDIDA[Number(tipoIndex)];
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:solicitar:${tipoIndex}`).setTitle(`Solicitar medida — ${tipo}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('alvo').setLabel('Pessoa/local alvo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('alvo_discord').setLabel('Discord do alvo (@menção, se for pessoa)').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/indícios').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    );
    return interaction.showModal(modal);
  }

  // Seleção estruturada de tipo (painel-contexto-e-tipo-mandado.md, seção 2) — mandado.js e
  // medida.js resolvem cada um o próprio modal a seguir (teor pro Juiz, justificativa pro
  // Promotor), por isso delegam em vez de montar o modal aqui.
  if (modulo === 'mandado' && campo === 'tipo') {
    return mandadoCmd.processarSelecaoTipo(interaction, extra);
  }

  if (modulo === 'mandado' && campo === 'destinatario') {
    return mandadoCmd.processarSelecaoDestinatario(interaction, extra);
  }

  if (modulo === 'medida' && campo === 'tipodireta') {
    return medidaCmd.processarSelecaoTipoDireta(interaction, extra);
  }

  if (modulo === 'medida' && campo === 'destinatariodireta') {
    return medidaCmd.processarSelecaoDestinatarioDireta(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'testemunhadepoimento') {
    return processoCmd.processarSelecaoTestemunha(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'gerenciar') {
    return processoCmd.tratarGerenciar(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'gerenciarremovecrime') {
    return processoCmd.removerCrime(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'manifestacaomp') {
    return processoCmd.tratarManifestacaoMp(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'destinatariointimacao') {
    return processoCmd.processarSelecaoDestinatarioIntimacao(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'teorintimacao') {
    return processoCmd.processarSelecaoTeorIntimacao(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'papelpartetardia') {
    return processoCmd.processarSelecaoPapelParteTardia(interaction, extra);
  }

  if (modulo === 'oficio' && campo === 'instituicao') {
    const numeroProcesso = extra || null;
    const processoDetectado = numeroProcesso ? db.buscarPorNumero('processos', numeroProcesso) : null;
    const slug = interaction.values[0];
    const inst = slug !== 'outro' ? instituicoes.buscarPorSlug(slug) : null;
    return abrirModalOficio(interaction, processoDetectado, inst?.nome || null);
  }

  if (modulo === 'processo' && campo === 'tipodocumentoexterno') {
    const numero = extra;
    const tipo = interaction.values[0];
    return interaction.reply({
      content: 'Pra qual órgão?',
      components: [selectInstituicaoOficio(`painel:select:processo:orgaodocumentoexterno:${numero}#${tipo}`)],
      ephemeral: true,
    });
  }

  if (modulo === 'processo' && campo === 'orgaodocumentoexterno') {
    const [numero, tipo] = extra.split('#');
    const slug = interaction.values[0];
    const inst = slug !== 'outro' ? instituicoes.buscarPorSlug(slug) : null;
    const preset = CERTIDOES_PRESET[tipo];

    if (tipo === 'outro') {
      // Ofício livre — sempre precisa de assunto/conteúdo digitados; reaproveita o modal que
      // já existe pro fluxo geral de ofício, com destinatário pré-preenchido se veio de instituição.
      return abrirModalOficio(interaction, db.buscarPorNumero('processos', numero), inst?.nome || null);
    }
    if (!inst) {
      // Preset de certidão, mas destinatário "Outro" — só falta o nome do órgão pra completar.
      return abrirModalDestinatarioLivre(interaction, `${numero}#${tipo}`);
    }

    await interaction.deferUpdate();
    const resultado = await oficioCmd.criarOficio({
      guild: interaction.guild, processoNumero: numero, destinatario: inst.nome,
      assunto: preset.assunto, conteudo: preset.conteudo,
      emitidoPorId: interaction.user.id, emitidoPorTag: interaction.user.tag,
      instituicao: papelInstitucional(interaction), aguardaRetorno: true,
    });
    if (resultado.erro) return interaction.followUp({ content: resultado.erro, ephemeral: true });
    return interaction.followUp({ content: `✅ ${preset.label} solicitada — ofício ${resultado.numero} expedido em ${resultado.canal}.`, ephemeral: true });
  }

  if (modulo === 'apelacao' && campo === 'resultado') {
    return processoCmd.abrirModalFundamentacaoReforma(interaction, extra);
  }

  if (modulo === 'peticao' && campo === 'risco') {
    return peticaoCmd.processarDecisaoRisco(interaction, extra);
  }

  if (modulo === 'peticao' && campo === 'posicaomanif') {
    return peticaoCmd.processarSelectPosicao(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'resultado') {
    const numero = extra;
    const resultado = interaction.values[0];
    const processoResultado = db.buscarPorNumero('processos', numero);
    // Penal + Condenado passa pela tela de apoio (faixa de pena, fiança de referência e
    // checklist de atenuantes) antes do modal — as demais combinações (Absolvido, cível) vão
    // direto pro modal, como sempre foi.
    if (processoResultado && processoResultado.tipo === 'Penal' && resultado === 'Condenado') {
      return processoCmd.mostrarResumoSentencaPenal(interaction, numero);
    }
    return interaction.showModal(processoCmd.modalSentenca(numero, resultado));
  }

  if (modulo === 'processo' && campo === 'veredictocrimes') {
    return processoCmd.processarVeredictoCrimes(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'voltarfase') {
    return processoCmd.processarVoltarFaseEscolha(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'atenuantes') {
    return processoCmd.atualizarAtenuantesSentenca(interaction, extra);
  }

  // Auto-atendimento de contratação: escolheu o cargo desejado → abre o modal do nome do
  // personagem (showModal precisa vir direto do select, sem defer antes).
  if (modulo === 'cargo' && campo === 'desejado') {
    return interaction.showModal(rhCmd.modalSolicitacao(interaction.values[0]));
  }

  if (modulo === 'rh' && campo === 'cargo') {
    const usuarioId = extra;
    const cargo = interaction.values[0];
    // Passo novo: em vez de contratar direto, abre o modal que captura nome + RG (o RG alimenta o
    // impedimento da Fase 1). showModal precisa vir direto da interação do select, sem update antes.
    return interaction.showModal(rhCmd.modalContratarStaff(usuarioId, cargo));
  }

  if (modulo === 'crime' && campo === 'resultado') {
    const crime = crimes.find(c => c.id === interaction.values[0]);
    if (!crime) return interaction.update({ content: 'Crime não encontrado.', embeds: [], components: [botaoVoltar()] });
    return interaction.update({ content: null, embeds: [crimeCmd.embedCrime(crime)], components: [botaoVoltar()] });
  }

  if (modulo === 'crimepick' && campo === 'resultado') {
    const rascunho = rascunhoCrimes.adicionarCrimes(interaction.user.id, interaction.values);
    if (!rascunho) return interaction.update({ content: 'Sessão expirada, comece de novo pelo painel.', embeds: [], components: [] });
    return crimePicker.mostrarPainel(interaction, { novaMensagem: false });
  }

  if (modulo === 'habilitacao' && campo === 'remover') {
    return processoCmd.removerHabilitacao(interaction, extra, interaction.values[0]);
  }
}

// ---- Select menus (usuário) ----

async function tratarUserSelect(interaction, modulo, campo) {
  const usuarioId = interaction.values[0];

  if (modulo === 'rh' && campo === 'contratar') {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:rh:cargo:${usuarioId}`).setPlaceholder('Escolha o cargo')
        .addOptions(rh.CARGOS.map(c => ({ label: c, value: c }))),
    );
    const embed = new EmbedBuilder().setDescription(`Qual cargo para <@${usuarioId}>?`);
    return interaction.update({ embeds: [embed], components: [row, botaoVoltar()] });
  }

  if (modulo === 'rh' && campo === 'demitir') {
    const registro = await rhCmd.demitirComRole(interaction.guild, usuarioId);
    const embed = new EmbedBuilder().setColor(registro ? 0xe74c3c : 0x95a5a6)
      .setDescription(registro ? `<@${usuarioId}> foi removido do cargo jurídico.` : `<@${usuarioId}> não tinha cargo jurídico ativo.`);
    return interaction.update({ embeds: [embed], components: [botaoVoltar()] });
  }

  if (modulo === 'peticao' && campo.startsWith('vincularcliente#')) {
    const numero = campo.split('#')[1];
    return peticaoCmd.vincularClienteDiscord(interaction, numero);
  }

  if (modulo === 'processo' && campo.startsWith('addadvogado#')) {
    const numero = campo.split('#')[1];
    return processoCmd.adicionarAdvogadoSelecionado(interaction, numero);
  }

  if (modulo === 'ficha' && campo === 'consultarpessoa') {
    return fichaCmd.consultarPorPessoaSelecionada(interaction);
  }

  if (modulo === 'rh' && campo === 'licenca') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:rh:licencaon:${usuarioId}`).setLabel('Colocar de licença').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`painel:acao:rh:licencaoff:${usuarioId}`).setLabel('Tirar de licença').setStyle(ButtonStyle.Success),
    );
    const embed = new EmbedBuilder().setDescription(`O que fazer com <@${usuarioId}>?`);
    return interaction.update({ embeds: [embed], components: [row, botaoVoltar()] });
  }

  // Update 3 — escolheu de quem editar os dados → abre o modal (nome/RG/OAB).
  if (modulo === 'dados' && campo === 'usuario') {
    return rhCmd.abrirModalGerenciarDados(interaction, usuarioId);
  }
}

// ---- Envio dos modais ----

async function tratarModal(interaction, modulo, acao, extra) {
  if (modulo === 'rh' && acao === 'contratar') {
    // extra = `${usuarioId}#${cargo}` (o router só entrega partes[4], sem ':' interno — daí o '#').
    const [usuarioId, cargo] = String(extra || '').split('#');
    return rhCmd.contratarViaModal(interaction, usuarioId, cargo);
  }
  if (modulo === 'mandado' && acao === 'emitir') return mandadoCmd.emitirMandado(interaction, extra);
  if (modulo === 'medida' && acao === 'solicitardireta') return medidaCmd.criarSolicitacaoMedidaDireta(interaction, extra);
  if (modulo === 'processo' && acao === 'depoimento') return processoCmd.registrarDepoimentoHandler(interaction, extra);
  if (modulo === 'processo' && acao === 'anexarprova') return processoCmd.salvarProva(interaction, extra);
  if (modulo === 'processo' && acao === 'gerenciarrg') return processoCmd.salvarGerenciarCampo(interaction, extra, 'rg');
  if (modulo === 'processo' && acao === 'gerenciarnome') return processoCmd.salvarGerenciarCampo(interaction, extra, 'nome');
  if (modulo === 'processo' && acao === 'gerenciaraddcrime') return processoCmd.salvarAddCrime(interaction, extra);
  if (modulo === 'processo' && acao === 'voltarfase') return processoCmd.voltarFase(interaction, extra);
  if (modulo === 'processo' && acao === 'manifestacaomplivre') return processoCmd.salvarManifestacaoLivre(interaction, extra);

  if (modulo === 'processo' && acao === 'penal') {
    rascunhoCrimes.iniciar(interaction.user.id, {
      tipo: 'penal-direto',
      dados: {
        delegadoId: interaction.user.id,
        promotorId: null,
        motivo: interaction.fields.getTextInputValue('motivo'),
        reusTexto: interaction.fields.getTextInputValue('reus'),
        reuNome: interaction.fields.getTextInputValue('reu_nome') || null,
        reuRg: interaction.fields.getTextInputValue('reu_rg') || null,
        medidaNumero: interaction.fields.getTextInputValue('medida') || null,
      },
    });
    return crimePicker.mostrarPainel(interaction, { novaMensagem: true });
  }

  if (modulo === 'mp' && acao === 'denunciamodal') {
    return ministerioPublico.criarProcessoModal(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'civil') {
    // Registro principal da parte = Nome + RG (Parte 2). Discord fica opcional e é vinculado
    // depois (habilitação/parte tardia), pra não estourar o limite de 5 campos do modal.
    await interaction.deferReply({ ephemeral: true });
    const resultado = await processoCmd.criarProcessoCivil({
      guild: interaction.guild, advogadoId: interaction.user.id,
      nomeAcao: interaction.fields.getTextInputValue('nome_acao'),
      autorNome: interaction.fields.getTextInputValue('autor_nome'),
      autorRg: interaction.fields.getTextInputValue('autor_rg'),
      autorDiscordId: null,
      reuNome: interaction.fields.getTextInputValue('reu_nome'),
      reuRg: interaction.fields.getTextInputValue('reu_rg'),
      reuDiscordId: null,
    });
    return respostaSumindo(interaction, { content: `Processo civil ${resultado.numero} aberto em ${resultado.canal}.` });
  }

  if (modulo === 'crimepick' && acao === 'buscar') {
    const resultados = buscarCrimes(interaction.fields.getTextInputValue('termo'));
    if (resultados.length === 0) return interaction.reply({ content: 'Nenhum crime encontrado com esse termo. Tente de novo.', ephemeral: true });
    return interaction.reply({ content: `${resultados.length} resultado(s) — selecione um ou mais:`, components: [crimePicker.selectResultados(resultados)], ephemeral: true });
  }

  // Auto-atendimento de contratação: preencheu o nome do personagem → cria a solicitação
  // pendente e manda pro canal da staff. `acao` aqui é 'solicitar', `extra` é o cargo escolhido.
  if (modulo === 'cargo' && acao === 'solicitar') {
    return rhCmd.solicitarCargo(interaction, extra);
  }

  // Update 3 — submit do modal de edição global de dados (nome/RG/OAB). `extra` = usuarioId.
  if (modulo === 'dados' && acao === 'editar') {
    return rhCmd.salvarGerenciarDados(interaction, extra);
  }

  // Submit do modal "Publicar comunicado" (staff) → publica no Diário Oficial.
  if (modulo === 'comunicado' && acao === 'publicar') {
    return diarioOficialCmd.publicarComunicado(interaction);
  }

  if (modulo === 'processo' && acao === 'partetardia') {
    return processoCmd.confirmarParteTardia(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'intimar') {
    return processoCmd.emitirIntimacao(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'intimarforadestinatario') {
    return processoCmd.confirmarDestinatarioForaIntimacao(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'intimargenerico') {
    return processoCmd.confirmarIntimacaoGenerica(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'parecermp') {
    return processoCmd.confirmarParecerMp(interaction, extra);
  }

  if (modulo === 'instituicao' && acao === 'adicionar') {
    return instituicaoCmd.processarModalAdicionar(interaction);
  }

  if (modulo === 'processo' && acao === 'sentenca') {
    const [numero, resultado] = extra.split('#');
    return processoCmd.salvarSentenca(interaction, numero, resultado);
  }

  if (modulo === 'processo' && acao === 'sentencapocrime') {
    return processoCmd.salvarSentencaPorCrime(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'recorrer') {
    return processoCmd.confirmarRazoes(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'documentoexternodestino') {
    const [numero, tipo] = extra.split('#');
    const preset = CERTIDOES_PRESET[tipo];
    const destinatario = interaction.fields.getTextInputValue('destinatario');
    await interaction.deferReply({ ephemeral: true });
    const resultado = await oficioCmd.criarOficio({
      guild: interaction.guild, processoNumero: numero, destinatario,
      assunto: preset.assunto, conteudo: preset.conteudo,
      emitidoPorId: interaction.user.id, emitidoPorTag: interaction.user.tag,
      instituicao: papelInstitucional(interaction), aguardaRetorno: true,
    });
    if (resultado.erro) return interaction.editReply({ content: resultado.erro });
    return interaction.editReply({ content: `✅ ${preset.label} solicitada — ofício ${resultado.numero} expedido em ${resultado.canal}.` });
  }

  if (modulo === 'habilitacao' && acao === 'solicitar') {
    return processoCmd.criarHabilitacao(interaction, extra);
  }

  if (modulo === 'supervisao' && acao === 'trocaresp0') {
    return supervisao.trocaGenericaSubmit(interaction);
  }

  if (modulo === 'supervisao' && acao === 'trocaresp') {
    return supervisao.trocaResponsavelSubmit(interaction, extra);
  }

  if (modulo === 'supervisao' && acao === 'trocarjuiz') {
    return supervisao.trocarJuiz(interaction);
  }

  if (modulo === 'supervisao' && acao === 'designarjulgador') {
    return supervisao.designarJulgador(interaction, extra);
  }

  if (modulo === 'supervisao' && acao === 'trocarpromotor') {
    return supervisao.trocarPromotor(interaction);
  }

  if (modulo === 'supervisao' && acao === 'trocardelegado') {
    return supervisao.trocarDelegado(interaction);
  }

  if (modulo === 'supervisao' && acao === 'trocardesembargador') {
    return supervisao.trocarDesembargador(interaction);
  }

  if (modulo === 'supervisao' && acao === 'forcardenuncia') {
    return supervisao.forcarDenuncia(interaction);
  }

  if (modulo === 'supervisao' && acao === 'forcardenunciadireto') {
    return supervisao.forcarDenunciaDireto(interaction, extra);
  }

  if (modulo === 'supervisao' && acao === 'manterarquivamento') {
    return supervisao.manterArquivamento(interaction, extra);
  }

  if (modulo === 'peticao' && (acao === 'indeferir' || acao === 'diligencia')) {
    return peticaoCmd.processarModalDecisao(interaction, extra, acao);
  }

  if (modulo === 'apelacao' && acao === 'reformar') {
    const [numeroApelacao, novoResultado] = extra.split('#');
    // Não finaliza direto: oferece a revisão por IA da fundamentação antes de publicar o acórdão.
    return processoCmd.confirmarAcordao(interaction, numeroApelacao, 'reformar', { novoResultado });
  }

  if (modulo === 'apelacao' && acao === 'decidir') {
    const [numeroApelacao, decisao] = extra.split('#');
    return processoCmd.confirmarAcordao(interaction, numeroApelacao, decisao, {});
  }

  if (modulo === 'medida' && acao === 'aprovarmp') return medidaCmd.processarAprovacaoMP(interaction, extra);
  if (modulo === 'medida' && acao === 'referendar') return medidaCmd.confirmarDecisaoMedida(interaction, extra, 'referendo');
  if (modulo === 'medida' && acao === 'negarjuiz') return medidaCmd.confirmarDecisaoMedida(interaction, extra, 'negativa');

  if (modulo === 'peticao' && acao === 'porte-arma') return peticaoCmd.processarModalPorteArma(interaction);
  if (modulo === 'peticao' && acao === 'troca-nome') return peticaoCmd.processarModalTrocaNome(interaction);
  if (modulo === 'peticao' && acao === 'limpeza-ficha') return peticaoCmd.processarModalLimpezaFicha(interaction);
  if (modulo === 'peticao' && acao === 'alvara-evento') return peticaoCmd.processarModalAlvaraEvento(interaction);
  if (modulo === 'peticao' && acao === 'maisdados') return peticaoCmd.processarMaisDados(interaction, extra);
  if (modulo === 'peticao' && acao === 'vincularmanual') return peticaoCmd.processarVincularManual(interaction, extra);
  if (modulo === 'peticao' && acao === 'manifestacao') return peticaoCmd.processarModalManifestacao(interaction, extra);

  if (modulo === 'ficha' && acao === 'consultarrg') return fichaCmd.processarModalConsultaRG(interaction);
  if (modulo === 'ficha' && acao === 'consultardiscordid') return fichaCmd.processarModalConsultaDiscordId(interaction);
  if (modulo === 'ficha' && acao === 'consultartermo') return fichaCmd.processarModalConsultaTermo(interaction);
  if (modulo === 'ficha' && acao === 'certidao') return processarModalCertidaoLivre(interaction);

  if (modulo === 'processo' && acao === 'ver') {
    return processoCmd.verProcesso(interaction, interaction.fields.getTextInputValue('numero'));
  }

  if (modulo === 'processo' && acao === 'historico') {
    return processoCmd.verHistoricoProcesso(interaction, interaction.fields.getTextInputValue('numero'));
  }

  if (modulo === 'medida' && acao === 'ver') {
    const numero = interaction.fields.getTextInputValue('numero');
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!medidaCmd.temAcessoMedida(interaction, medida)) return interaction.reply({ content: 'Você não tem acesso ao teor desta medida — ela é sigilosa (fase de inquérito). Só as partes (Delegado/Promotor/Juiz) e a Staff podem consultá-la.', ephemeral: true });
    return interaction.reply({ embeds: [medidaCmd.embedMedida(medida)], ephemeral: true });
  }

  if (modulo === 'medida' && acao === 'solicitar') {
    await interaction.deferReply({ ephemeral: true });
    const tipo = medidaCmd.TIPOS_MEDIDA[Number(extra)];
    const resultado = await medidaCmd.solicitarMedida({
      guild: interaction.guild, delegadoId: interaction.user.id, promotorId: null,
      tipo,
      alvo: interaction.fields.getTextInputValue('alvo'),
      alvoDiscordId: processoCmd.extrairMencoes(interaction.fields.getTextInputValue('alvo_discord'))[0] || null,
      motivo: interaction.fields.getTextInputValue('motivo'),
    });
    if (resultado.erro) return interaction.editReply({ content: resultado.erro });
    return respostaSumindo(interaction, { content: `Medida ${resultado.numero} registrada em ${resultado.canal}.` });
  }

  if (modulo === 'mandado' && acao === 'ver') {
    const numero = interaction.fields.getTextInputValue('numero');
    const mandado = db.buscarPorNumero('mandados', numero);
    if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
    if (!mandadoCmd.temAcessoMandado(interaction, mandado)) return interaction.reply({ content: 'Você não tem acesso ao teor deste mandado — só quem o emitiu, as partes do caso vinculado e a Staff podem consultá-lo.', ephemeral: true });
    return interaction.reply({ embeds: [mandadoCmd.embedMandado(mandado)], ephemeral: true });
  }

  if (modulo === 'oficio' && acao === 'criar') {
    // extra vem preenchido quando o modal nasceu sem o campo "processo" (painel ciente de
    // contexto — ver abrirModalOficio) — sem isso, teria que chamar getTextInputValue num
    // campo que não existe nesse envio, o que lança erro.
    // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
    // Chromium sobe e a interação "falha" mesmo com o ofício sendo expedido com sucesso.
    await interaction.deferReply({ ephemeral: true });
    const resultado = await oficioCmd.criarOficio({
      guild: interaction.guild,
      processoNumero: extra || interaction.fields.getTextInputValue('processo'),
      destinatario: interaction.fields.getTextInputValue('destinatario'),
      assunto: interaction.fields.getTextInputValue('assunto'),
      conteudo: interaction.fields.getTextInputValue('conteudo'),
      emitidoPorId: interaction.user.id,
      emitidoPorTag: interaction.user.tag,
      instituicao: papelInstitucional(interaction),
    });
    if (resultado.erro) return interaction.editReply({ content: resultado.erro });
    return respostaSumindo(interaction, { content: `Ofício ${resultado.numero} expedido em ${resultado.canal}.` });
  }

  if (modulo === 'crime' && acao === 'buscar') {
    const resultados = buscarCrimes(interaction.fields.getTextInputValue('termo'));
    if (resultados.length === 0) return interaction.reply({ content: 'Nenhum crime encontrado.', ephemeral: true });
    if (resultados.length === 1) return interaction.reply({ embeds: [crimeCmd.embedCrime(resultados[0])], ephemeral: true });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('painel:select:crime:resultado').setPlaceholder('Selecione o crime')
        .addOptions(resultados.map(c => ({ label: crimeLabel(c).slice(0, 100), value: c.id }))),
    );
    return interaction.reply({ content: `${resultados.length} resultados encontrados:`, components: [row], ephemeral: true });
  }

  if (modulo === 'mp' && !ministerioPublico.ehMembroDoMP(interaction)) {
    return interaction.reply({ content: 'Só Promotor ou Procurador — são atribuições exclusivas do Ministério Público.', ephemeral: true });
  }

  if (modulo === 'mp' && acao === 'requisicao') {
    const resultado = await ministerioPublico.abrirRequisicao({
      guild: interaction.guild,
      destinatario: interaction.fields.getTextInputValue('destinatario'),
      fundamentacao: interaction.fields.getTextInputValue('fundamentacao'),
      prazo: interaction.fields.getTextInputValue('prazo') || null,
      executorId: interaction.user.id,
    });
    return interaction.reply({ content: `✅ Requisição ${resultado.numero} expedida e enviada ao canal do Ministério Público.`, ephemeral: true });
  }

  if (modulo === 'mp' && acao === 'recomendacao') {
    const resultado = await ministerioPublico.abrirRecomendacao({
      guild: interaction.guild,
      destinatario: interaction.fields.getTextInputValue('destinatario'),
      fundamentacao: interaction.fields.getTextInputValue('fundamentacao'),
      executorId: interaction.user.id,
    });
    return interaction.reply({ content: `✅ Recomendação ${resultado.numero} expedida e enviada ao canal do Ministério Público.`, ephemeral: true });
  }

  if (modulo === 'mp' && acao === 'inqueritocivil') {
    const resultado = await ministerioPublico.abrirInqueritoCivil({
      guild: interaction.guild,
      objeto: interaction.fields.getTextInputValue('objeto'),
      fundamentacao: interaction.fields.getTextInputValue('fundamentacao'),
      executorId: interaction.user.id,
    });
    return interaction.reply({ content: `✅ Inquérito Civil ${resultado.numero} instaurado e enviado ao canal do Ministério Público.`, ephemeral: true });
  }
}

// ---- Roteador central (chamado pelo index.js para tudo que começa com "painel:") ----

async function router(interaction) {
  const partes = interaction.customId.split(':');
  const tipo = partes[1];

  if (interaction.isButton()) {
    if (tipo === 'menu') {
      const alvo = partes[2];
      // deferUpdate + editReply (em vez de update direto) pelo mesmo motivo do abrirmenu: o
      // upload do brasão junto do update estoura os 3s no host lento. Deferir dá 15 min.
      if (alvo === 'home') {
        await interaction.deferUpdate();
        return interaction.editReply({ embeds: [embedMenuPrincipal()], components: botoesMenuPrincipal(interaction), files: anexoBrasao() });
      }
      return abrirSubmenu(interaction, alvo);
    }
    if (tipo === 'acao') {
      const [, , modulo, acao, extra] = partes;
      return executarAcaoBotao(interaction, modulo, acao, extra);
    }
  }

  if (interaction.isStringSelectMenu()) {
    const [, , modulo, campo, extra] = partes;
    return tratarSelect(interaction, modulo, campo, extra);
  }

  if (interaction.isUserSelectMenu()) {
    const [, , modulo, campo] = partes;
    return tratarUserSelect(interaction, modulo, campo);
  }

  if (interaction.isModalSubmit()) {
    const [, , modulo, acao, extra] = partes;
    return tratarModal(interaction, modulo, acao, extra);
  }
}

// Deixa uma única mensagem fixa no canal configurado, sempre a mesma (edita em vez de
// duplicar a cada restart) — os botões respondem sempre de forma ephemeral (só quem clicou
// vê), então o canal nunca enche de mensagem por trás de ninguém usando o painel.
async function postarPainelFixo(guild, client) {
  if (!config.canalPainelId) return;
  const canal = await guild.channels.fetch(config.canalPainelId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) {
    console.error(`CANAL_PAINEL_ID (${config.canalPainelId}) não é um canal de texto válido.`);
    return;
  }

  // Só um botão-portal aqui, de propósito: esta mensagem é fixa e compartilhada (todo mundo no
  // canal vê a mesma), então não dá pra já nascer com o menu de módulos — cada cargo vê um
  // conjunto diferente, e só existe "cargo de quem clicou" depois que a interação chega. O
  // clique sempre responde com `reply` ephemeral (nunca `update` nesta mensagem), pra nunca
  // reescrever o que todo mundo vê só porque uma pessoa navegou o próprio painel.
  const descricao = 'Clique abaixo pra abrir seu painel — o menu que aparece é montado na hora, de acordo com o seu cargo. Resposta sempre privada, só você vê.';
  const bannerPng = await gerarBannerPainel({ titulo: 'Bem-vindo(a) ao Painel Jurídico!', descricao })
    .catch(err => { console.error('Falha ao gerar banner do painel:', err.message); return null; });

  const payload = {
    // Sem thumbnail aqui: o banner grande logo abaixo já traz o brasão em destaque, então o
    // selo pequeno no canto (usado nas outras telas do painel) só duplicaria a marca à toa.
    embeds: [embedMenuPrincipal().setDescription(descricao).setThumbnail(null)
      .setImage(bannerPng ? 'attachment://banner-painel.png' : null)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('painel:acao:pessoal:abrirmenu').setLabel('🔓 Abrir meu painel').setStyle(ButtonStyle.Primary),
    )],
    ...(bannerPng ? { files: [{ attachment: bannerPng, name: 'banner-painel.png' }] } : {}),
  };

  // ID salvo é bem mais confiável que vasculhar as últimas mensagens do canal (que falhava
  // assim que o canal acumulava mais de 20 mensagens de outras origens).
  const idSalvo = estado.obter('painelMensagemId');
  let mensagemFixa = idSalvo ? await canal.messages.fetch(idSalvo).catch(() => null) : null;

  if (mensagemFixa) {
    await mensagemFixa.edit(payload).catch(() => {});
  } else {
    mensagemFixa = await canal.send(payload);
    estado.definir('painelMensagemId', mensagemFixa.id);
  }

  // Garante SÓ 1 painel: apaga qualquer OUTRO painel do próprio bot que tenha sobrado (ex.: um
  // painel antigo de antes do reset, quando o id salvo se perdeu e um novo foi postado). Só
  // apaga mensagem DO BOT que é painel (tem o botão "abrir meu painel") — nunca mensagem de
  // outra pessoa.
  const lote = await canal.messages.fetch({ limit: 50 }).catch(() => null);
  if (lote) {
    for (const m of lote.values()) {
      if (m.id === mensagemFixa.id) continue;
      if (m.author?.id !== client.user.id) continue;
      const ehPainel = (m.components || []).some(row => (row.components || []).some(c => c.customId === 'painel:acao:pessoal:abrirmenu'));
      if (ehPainel) await m.delete().catch(() => {});
    }
  }

  // A limpeza automática do canal (apagar tudo que não fosse a mensagem fixa, a cada restart e a
  // cada 10min) foi DESLIGADA a pedido do operador — apagava mensagem de verdade que alguém tinha
  // postado no canal. A dedup acima (apagar só painéis duplicados DO BOT) é o que sobrou.
}

module.exports = {
  data: new SlashCommandBuilder().setName('painel').setDescription('Abre o painel interativo com todos os módulos em botões'),

  async execute(interaction) {
    return interaction.reply({ embeds: [embedMenuPrincipal()], components: botoesMenuPrincipal(interaction), ephemeral: true });
  },

  router,
  postarPainelFixo,
};
