const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isAdmin, isSuperStaff , podeAtuarNoCaso, recusaDoCaso } = require('../utils/permissoes');
const rh = require('../utils/rh');
const acumuloDePapeis = require('../utils/acumuloDePapeis');
const canais = require('../utils/canais');
const config = require('../config');
const rascunhoCrimes = require('../utils/rascunhoCrimes');
const crimePicker = require('../utils/crimePicker');
const { truncar } = require('../utils/texto');
const atosPorCargo = require('../utils/atosPorCargo');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
// resolverGuild não é desestruturado no topo de propósito: medida.js -> supervisao.js ->
// processo.js -> medida.js forma um ciclo, e desestruturar aqui pode capturar undefined se
// supervisao.js ainda não tiver terminado de carregar (depende da ordem de boot). Resolvendo na
// hora do uso, já está tudo carregado.
function resolverGuild(interaction) {
  return require('../utils/supervisao').resolverGuild(interaction);
}
const devolutivaPoliciaCivil = require('../utils/devolutivaPoliciaCivil');
const documentoPng = require('../services/gerarDocumentoPNG');
const diario = require('../utils/diarioOficial');
const diarioAtos = require('../utils/diarioAtos');
const { aguardarAnexoPDF, coletarAnexoPdf } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');
const dossie = require('../utils/dossie');
const { selectTipoMedidaCoercitiva, rotuloTipo, modalTipoDestinatario } = require('../utils/tiposMedidaCoercitiva');
const partesProcesso = require('../utils/partesProcesso');
const mandadoCmd = require('./mandado');
const andamentos = require('../utils/andamentos');
const responsaveis = require('../utils/responsaveis');
const cartorio = require('../utils/cartorio');
const preferencias = require('../utils/preferencias');
const { RascunhoTTL } = require('../utils/rascunhoTtl');
const revisaoIA = require('../utils/revisaoIA');
const analiseDocumento = require('../utils/analiseDocumento');

// Rascunho da fundamentação do Juiz (referendo/negativa) — guarda o texto entre o envio do modal
// e a decisão de revisar por IA ou publicar direto (mesmo padrão revisão-in-flow da sentença).
// Com TTL: entrada abandonada expira sozinha (não vaza em memória).
const rascunhoFundMedida = new RascunhoTTL();
const chaveFundMedida = (uid, numero) => `${uid}:fundmedida:${numero}`;

const TIPOS_MEDIDA = ['Busca e Apreensão', 'Prisão Preventiva', 'Interceptação Telefônica', 'Quebra de Sigilo Bancário', 'Outra'];

function embedMedida(medida) {
  return new EmbedBuilder()
    .setTitle(`📋 Medida Cautelar ${medida.numero}`)
    .setColor(0xe67e22)
    .addFields(
      { name: 'Tipo', value: medida.tipo, inline: true },
      { name: 'Status', value: medida.status, inline: true },
      { name: 'Alvo', value: truncar(medida.alvo), inline: true },
      // Identidade do alvo é NOME + RG (o Discord saiu em 19/08/2026 — alvo é personagem de RP e
      // não tem conta). RG vazio é normal quando o alvo é um local, não uma pessoa.
      { name: 'RG do alvo', value: medida.rgAlvo || '— (alvo é local, ou RG não informado)', inline: true },
      ...(medida.nomeAlvo ? [{ name: 'Nome civil do alvo', value: truncar(medida.nomeAlvo), inline: true }] : []),
      ...(medida.rgAlvo ? [{ name: 'RG do alvo', value: medida.rgAlvo, inline: true }] : []),
      { name: 'Motivo/Indícios', value: truncar(medida.motivo) },
      { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
      { name: 'Promotor', value: `<@${medida.promotor}>`, inline: true },
      ...(medida.juiz ? [{ name: 'Juiz sorteado', value: `<@${medida.juiz}>`, inline: true }] : []),
    );
}

// Frente 4a.5 — embed da listagem de medidas, fonte única (era duplicado no /painel e no /medida listar).
function embedListaMedidas(rows) {
  return new EmbedBuilder().setTitle('📋 Medidas cautelares').setColor(0xe67e22)
    .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
}

// Frente 2.2 — sigilo do inquérito: só as partes da medida (Delegado/Promotor/Juiz) e Staff podem
// ver o teor (tipo, alvo, RG, motivo/indícios). Sem isso, o `embedMedida` vazava dados sensíveis
// da fase pré-processual pra qualquer um que soubesse o número (o autocomplete lista todos).
function temAcessoMedida(interaction, medida) {
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
  return [medida.delegado, medida.promotor, medida.juiz].filter(Boolean).includes(interaction.user.id);
}

function botoesAnalise(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:aprovar:${numero}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`medida:negar:${numero}`).setLabel('Negar').setStyle(ButtonStyle.Danger),
    // Troca de Juiz/Promotor/Delegado da medida sem sair do ticket (Parte 2) — gate no clique.
    responsaveis.botaoSupervisaoTicket('medidas', numero),
  );
}

// Juiz recebe a medida já aprovada pelo MP e pode referendar (gera mandado) ou negar
// provimento (encerra sem mandado) — antes só existia a opção de referendar.
function botoesJuizMedida(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:referendar:${numero}`).setLabel('Referendar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:medida:negarjuiz:${numero}`).setLabel('Negar provimento').setStyle(ButtonStyle.Danger),
    botaoArquivarManual(numero),
    responsaveis.botaoSupervisaoTicket('medidas', numero),
  );
}

function botaoRecorrer(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:recorrer:${numero}`).setLabel('Juntar indícios e recorrer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:medida:pedirreconsideracao:${numero}`).setLabel('Pedir reconsideração (Procurador)').setStyle(ButtonStyle.Secondary),
  );
}

function botaoCumprir(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:cumprir:${numero}`).setLabel('Cumprir mandado').setStyle(ButtonStyle.Success),
  );
}

// Camada 2 dos indícios (seção 4.1): pedido chegou sem indicios_pdf_url no payload, então fica
// parado aqui até o Delegado de verdade anexar — só então entra na fila do MP (o botão de
// Aprovar/Negar nem existe ainda nesse estado).
function botaoAnexarIndicios(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:anexarindicios:${numero}`).setLabel('📎 Anexar indícios').setStyle(ButtonStyle.Primary),
  );
}

function botaoAbrirProcesso(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:abrirprocesso:${numero}`).setLabel('Abrir processo penal').setStyle(ButtonStyle.Primary),
  );
}

// Disponível pra Delegado/Promotor/Juiz da medida (ou Desembargador/Staff) em qualquer fase
// depois da análise inicial — move o canal pra categoria Arquivados e trava novas mensagens.
function botaoArquivarManual(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:medida:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary);
}

// ---- Solicitação direta de medida pelo Promotor, de dentro do processo
// (painel-contexto-e-tipo-mandado.md, 3.2) — caminho distinto do "Solicitar" clássico (que é
// o Delegado abrindo um ticket próprio, sem processo). Aqui o Promotor já está com o processo
// aberto e só pede uma medida coercitiva pro Juiz decidir ali mesmo, sem ticket separado.

function botaoSolicitarMedidaDireta(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:medida:solicitardireta:${numero}`).setLabel('📋 Solicitar medida').setStyle(ButtonStyle.Primary);
}

async function abrirSolicitarMedidaDireta(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeAtuarNoCaso(interaction, processo, 'promotor')) {
    return interaction.reply({ content: `Só um(a) Promotor(a) pode solicitar medida. Responsável registrado: <@${processo.promotor}>.`, ephemeral: true });
  }
  if (processo.tipo !== 'Penal') {
    return interaction.reply({ content: 'Medida coercitiva só se aplica a processo penal.', ephemeral: true });
  }
  return interaction.reply({
    content: 'Qual o tipo de medida?',
    components: [selectTipoMedidaCoercitiva(`painel:select:medida:tipodireta:${numero}`)],
    ephemeral: true,
  });
}

// Tipo -> destinatário -> justificativa (spec-atualizacoes-bot-juridico.md, seção 3, reaproveitada
// aqui — mesmo padrão do mandado.js: "Outro" tipo e "pessoa fora do processo" só entram no MESMO
// modal final quando aplicável, já que Discord não encadeia modal depois de modal).
async function processarSelecaoTipoDireta(interaction, numero) {
  const valor = interaction.values[0];
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  return interaction.reply({
    content: 'Quem é o alvo da medida?',
    components: [partesProcesso.selectDestinatario(`painel:select:medida:destinatariodireta:${numero}#${valor}`, processo)],
    ephemeral: true,
  });
}

// R6 — modal de fundamentação de campo único (aprovar MP / referendar / negar juiz): só mudam
// customId, título e rótulo; o campo `fundamentacao` (Paragraph, obrigatório, 1000) é idêntico.
function modalFundamentacao(customId, titulo, label) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(titulo);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('fundamentacao').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return modal;
}

function modalJustificativaMedidaDireta(chave, tipoValue, destinatarioRef) {
  return modalTipoDestinatario({ customId: `painel:modal:medida:solicitardireta:${chave}`, titulo: `Solicitar — ${rotuloTipo(tipoValue)}`, tipoValue, destinatarioRef, campoTeor: 'justificativa', labelTeor: 'Justificativa do pedido' });
}

async function processarSelecaoDestinatarioDireta(interaction, chaveTipo) {
  const [numero, tipoValue] = chaveTipo.split('#');
  const destinatarioRef = interaction.values[0];
  return interaction.showModal(modalJustificativaMedidaDireta(`${numero}#${tipoValue}#${destinatarioRef}`, tipoValue, destinatarioRef));
}

function botoesAnaliseDireta(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:medida:deferirdireta:${numero}`).setLabel('Deferir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:medida:indeferirdireta:${numero}`).setLabel('Indeferir').setStyle(ButtonStyle.Danger),
    responsaveis.botaoSupervisaoTicket('medidas', numero),
  );
}

// Cria o cartão de pendência já com status 'Aprovada - aguardando juiz' — reaproveita a MESMA
// fila que o fluxo clássico usa (Minhas pendências, Filas pendentes, job de prazo/escalonamento
// em utils/prazos.js), só que sem passar pelo Delegado nem pela aprovação do MP (o Promotor
// solicitando diretamente já É a manifestação do MP).
async function criarPendenciaMedidaDireta({ guild, processo, tipoRotulo, justificativa, promotorId, destinatario }) {
  const numero = proximoNumero(db, 'medidas', 'MD');
  const alvoTexto = destinatario?.discordId ? `<@${destinatario.discordId}>` : (destinatario?.nome || 'destinatário não identificado');

  db.inserir('medidas', {
    numero, tipo: tipoRotulo, alvo: alvoTexto, alvoDiscordId: destinatario?.discordId || null,
    motivo: justificativa, delegado: null, promotor: promotorId, juiz: processo.juiz,
    status: 'Aprovada - aguardando juiz', fundamentacaoPromotor: justificativa,
    aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false,
    canalId: processo.canalId, processoVinculado: processo.numero,
  });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    const embed = new EmbedBuilder()
      .setTitle(`📋 Solicitação de medida — ${tipoRotulo}`)
      .setColor(0xe67e22)
      .addFields(
        { name: 'Solicitado por', value: `<@${promotorId}>`, inline: true },
        { name: 'Alvo', value: truncar(alvoTexto), inline: true },
        { name: 'Justificativa', value: truncar(justificativa) },
      );
    await canal.send({ content: `<@${processo.juiz}>`, embeds: [embed], components: [botoesAnaliseDireta(numero)] });
  }

  await auditoria.registrar(guild, { acao: `Medida solicitada direto no processo — ${tipoRotulo}`, executorId: promotorId, referencia: `${numero} (Processo ${processo.numero})` });
  return { numero };
}

async function criarSolicitacaoMedidaDireta(interaction, chave) {
  const [numero, tipoValue, destinatarioRef] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeAtuarNoCaso(interaction, processo, 'promotor')) {
    return interaction.reply({ content: `Só um(a) Promotor(a) pode solicitar medida. Responsável registrado: <@${processo.promotor}>.`, ephemeral: true });
  }

  const tipoLivre = tipoValue === 'outro' ? interaction.fields.getTextInputValue('tipoLivre') : null;
  const justificativa = interaction.fields.getTextInputValue('justificativa');

  let destinatario;
  if (destinatarioRef === 'fora') {
    const nomeCompleto = interaction.fields.getTextInputValue('nomeCompleto');
    const idTexto = interaction.fields.getTextInputValue('idTexto');
    const { discordId, rg } = partesProcesso.classificarIdLivre(idTexto);
    partesProcesso.adicionarParte(numero, { papel: 'terceiro', nome: nomeCompleto, discordId, rg, origem: 'manual_mandado', adicionadoPor: interaction.user.id });
    destinatario = { nome: nomeCompleto, discordId };
  } else {
    const parte = (processo.partes || []).find(p => p.id === destinatarioRef);
    destinatario = parte ? { nome: parte.nome, discordId: parte.discordId } : { nome: 'destinatário não identificado', discordId: null };
  }

  const resultado = await criarPendenciaMedidaDireta({
    guild: interaction.guild, processo, tipoRotulo: rotuloTipo(tipoValue, tipoLivre), justificativa, promotorId: interaction.user.id, destinatario,
  });
  return interaction.reply({ content: `Solicitação de medida ${resultado.numero} enviada ao Juiz do processo ${numero}.`, ephemeral: true });
}

// Deferir reaproveita a MESMA geração de mandado do caminho direto do Juiz (3.1) — resultado
// final idêntico nos dois caminhos, como pede a seção 3.2 da spec.
async function deferirMedidaDireta(interaction, numero) {
  const medida = db.buscarPorNumero('medidas', numero);
  if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
  if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
    return interaction.reply({ content: `Só um(a) Juiz(a) pode decidir. Responsável registrado: <@${medida.juiz}>.`, ephemeral: true });
  }
  const jaDecidida = atosPorCargo.bloqueioPorStatusDecidido(medida, ['Aprovada - aguardando juiz'], 'A decisão desta medida');
  if (jaDecidida) return interaction.reply({ content: jaDecidida, ephemeral: true });
  const processo = db.buscarPorNumero('processos', medida.processoVinculado);
  if (!processo) return interaction.reply({ content: 'Processo vinculado não encontrado.', ephemeral: true });

  db.atualizar('medidas', numero, { status: 'Deferida', decisaoJuizEm: new Date().toISOString(), ...atosPorCargo.carimboDeExecucao(interaction.user.id) });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const resultadoMandado = await mandadoCmd.emitirMandadoNoProcesso({
    guild: interaction.guild, processo, tipoRotulo: medida.tipo, teor: medida.motivo, emitidoPorId: interaction.user.id,
    destinatario: { nome: medida.alvo, discordId: medida.alvoDiscordId },
  });

  await auditoria.registrar(interaction.guild, { acao: 'Medida deferida — mandado emitido', executorId: interaction.user.id, referencia: `${numero} → Mandado ${resultadoMandado.numero}` });
  // reply (não followUp) — diferente de cumprirMandado/anexarIndicios, aqui não passou por
  // aguardarAnexoPDF, então a interação ainda não foi reconhecida nenhuma vez até aqui.
  return interaction.reply({ content: `Medida ${numero} deferida. Mandado ${resultadoMandado.numero} emitido no processo ${processo.numero}.`, ephemeral: true });
}

async function indeferirMedidaDireta(interaction, numero) {
  const medida = db.buscarPorNumero('medidas', numero);
  if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
  if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
    return interaction.reply({ content: `Só um(a) Juiz(a) pode decidir. Responsável registrado: <@${medida.juiz}>.`, ephemeral: true });
  }
  const jaDecidida = atosPorCargo.bloqueioPorStatusDecidido(medida, ['Aprovada - aguardando juiz'], 'A decisão desta medida');
  if (jaDecidida) return interaction.reply({ content: jaDecidida, ephemeral: true });

  db.atualizar('medidas', numero, { status: 'Indeferida pelo Juiz', decisaoJuizEm: new Date().toISOString(), ...atosPorCargo.carimboDeExecucao(interaction.user.id) });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  await auditoria.registrar(interaction.guild, { acao: 'Medida indeferida (solicitação direta)', executorId: interaction.user.id, referencia: numero });
  // Fica só registrado no histórico do processo (auditoria acima já cumpre isso) — sem gerar
  // mandado, exatamente como pede a spec.
  return interaction.reply({ content: `Medida ${numero} indeferida. Fica registrada no histórico do processo, sem mandado emitido.`, ephemeral: true });
}

async function solicitarMedida({ guild, delegadoId, promotorId, tipo, alvo, alvoDiscordId, rgAlvo = null, motivo, semIndicios = false }) {
  // MESMA regra de acúmulo do processo penal (utils/acumuloDePapeis.js — um módulo só, para os dois
  // fluxos não divergirem): promotor que abre sem delegado separado ocupa os dois papéis. Sem isso,
  // o promotor pedia a medida e o bot sorteava OUTRO promotor para analisar o próprio pedido dele.
  const acumulo = acumuloDePapeis.resolverDelegadoEPromotor({
    aberturaPorId: delegadoId || promotorId || null,
    delegadoId,
    promotorInformado: promotorId,
  });
  const delegadoFinal = acumulo.delegado;
  let promotorFinal = acumulo.promotor;

  if (!promotorFinal) {
    const promotores = rh.listarPorCargo('Promotor').filter(p => !p.licenca);
    if (promotores.length === 0) return { erro: 'Não há Promotor ativo cadastrado. Informe um manualmente na opção `promotor`.' };
    promotorFinal = promotores[Math.floor(Math.random() * promotores.length)].discordId;
  }

  const numero = proximoNumero(db, 'medidas', 'MD');

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaMedidasId,
    prefixo: 'medida',
    numero,
    membros: [delegadoFinal, promotorFinal].filter(Boolean),
  });

  db.inserir('medidas', {
    numero, tipo, alvo, alvoDiscordId: alvoDiscordId || null, rgAlvo: rgAlvo || null, motivo,
    status: semIndicios ? 'Aguardando anexo de indícios' : 'Aguardando MP',
    delegado: delegadoFinal || null, promotor: promotorFinal, juiz: null,
    canalId: canal.id,
    aguardandoMpDesde: semIndicios ? null : new Date().toISOString(), lembreteMpEnviado: false, escalonamentoMpEnviado: false,
  });
  // Diferente do réu num processo penal (que já é formal/público), o alvo de uma medida NÃO
  // entra no canal — a maioria das medidas (interceptação, quebra de sigilo, mandado ainda não
  // cumprido) é investigativa e perde o sentido se o próprio alvo conseguir ver o pedido.
  // O ID só fica registrado pra já vincular a identidade quando um processo formal nascer daqui.

  const medida = db.buscarPorNumero('medidas', numero);
  const componentesIniciais = semIndicios ? [botaoAnexarIndicios(numero)] : [botoesAnalise(numero)];
  await canal.send({ content: `<@${delegadoId}> <@${promotorFinal}>`, embeds: [embedMedida(medida)], components: componentesIniciais });

  await auditoria.registrar(guild, { acao: 'Medida cautelar solicitada', executorId: delegadoId, referencia: numero });
  return { numero, canal };
}

// R3 — os dois pares de reconsideração (negativa do MP → Procurador; indeferimento do Juiz →
// Desembargador) eram ~180 linhas espelhadas. Cada diferença vira um campo do config; o fluxo
// (pedir: gate → cria ticket → embed → 2 botões → grava pendente; decidir: gate → aprovar sorteia
// Juiz + reencaminha / manter) é o mesmo. Comportamento idêntico ao das 4 funções originais.
const RECON_CONFIG = {
  procurador: {
    campoStatus: 'reconsideracao', campoCanal: 'reconsideracaoCanalId', prefixoCanal: 'reconsideracao',
    cargoConvocado: 'Procurador', cargoDecisor: 'Procurador', customIdBase: 'decidirreconsideracao',
    statusNecessario: 'Negada', msgStatusFail: 'Essa medida não está negada.',
    gateBloqueia: (interaction, medida) => interaction.user.id !== medida.delegado && !isSuperStaff(interaction),
    msgGatePedir: (medida) => `Só o Delegado que abriu esta medida pode pedir reconsideração — no caso, <@${medida.delegado}>.`,
    msgGateDecisor: 'Só Procuradores podem decidir um pedido de reconsideração.',
    embedTitulo: (numero) => `📋 Reconsideração — medida ${numero} negada`,
    embedCampos: (medida) => [
      { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
      { name: 'Promotor que negou', value: `<@${medida.promotor}>`, inline: true },
      { name: 'Tipo', value: medida.tipo, inline: true },
      { name: 'Alvo', value: truncar(medida.alvo) },
      { name: 'Motivo/Indícios originais', value: truncar(medida.motivo) },
    ],
    labelAprovar: 'Aprovar e enviar a Juiz', labelManter: 'Manter negativa',
    sortearExcluir: (medida) => [medida.delegado, medida.promotor],
    msgSemJuiz: 'Não há Juiz ativo disponível para sorteio.',
    msgAprovarCanalMedida: (interaction, juizId) => `Reconsideração aprovada pelo Procurador <@${interaction.user.id}> — a negativa do MP foi revertida. <@${juizId}> foi sorteado para deliberar.`,
    msgManterCanalMedida: (interaction) => `O Procurador <@${interaction.user.id}> analisou o pedido de reconsideração e **manteve a negativa** do MP.`,
    msgManterCanalRecon: (interaction) => `❌ Negativa **mantida** pelo Procurador <@${interaction.user.id}>.`,
    replyManter: (numero) => `Negativa da medida ${numero} mantida.`,
    auditoriaPedir: 'Reconsideração de medida solicitada',
    auditoriaAprovar: 'Reconsideração de medida aprovada',
    auditoriaManter: 'Reconsideração de medida mantida',
  },
  juiz: {
    campoStatus: 'reconsideracaoJuiz', campoCanal: 'reconsideracaoJuizCanalId', prefixoCanal: 'reconsideracaojuiz',
    cargoConvocado: 'Desembargador', cargoDecisor: 'Desembargador', customIdBase: 'decidirreconsideracaojuiz',
    statusNecessario: 'Indeferida pelo Juiz', msgStatusFail: 'Essa medida não foi indeferida pelo Juiz.',
    gateBloqueia: (interaction, medida) => ![medida.delegado, medida.promotor].includes(interaction.user.id) && !isSuperStaff(interaction),
    msgGatePedir: (medida) => `Só o Delegado ou o Promotor desta medida podem pedir reconsideração — no caso, <@${medida.delegado}> ou <@${medida.promotor}>.`,
    msgGateDecisor: 'Só Desembargadores podem decidir um pedido de reconsideração de indeferimento judicial.',
    embedTitulo: (numero) => `📋 Reconsideração — medida ${numero} indeferida pelo Juiz`,
    embedCampos: (medida) => [
      { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
      { name: 'Promotor', value: `<@${medida.promotor}>`, inline: true },
      { name: 'Juiz que indeferiu', value: `<@${medida.juiz}>`, inline: true },
      { name: 'Tipo', value: medida.tipo, inline: true },
      { name: 'Alvo', value: truncar(medida.alvo) },
      { name: 'Fundamentação do indeferimento', value: truncar(medida.fundamentacaoJuiz) },
    ],
    labelAprovar: 'Aprovar e sortear novo Juiz', labelManter: 'Manter indeferimento',
    sortearExcluir: (medida) => [medida.delegado, medida.promotor, medida.juiz, medida.alvoDiscordId].filter(Boolean),
    msgSemJuiz: 'Não há outro Juiz ativo disponível para sorteio.',
    msgAprovarCanalMedida: (interaction, juizId) => `Reconsideração aprovada pelo Desembargador <@${interaction.user.id}> — o indeferimento foi revertido. <@${juizId}> foi sorteado para novo julgamento.`,
    msgManterCanalMedida: (interaction) => `O Desembargador <@${interaction.user.id}> analisou o pedido de reconsideração e **manteve o indeferimento** do Juiz.`,
    msgManterCanalRecon: (interaction) => `❌ Indeferimento **mantido** pelo Desembargador <@${interaction.user.id}>.`,
    replyManter: (numero) => `Indeferimento da medida ${numero} mantido.`,
    auditoriaPedir: 'Reconsideração de indeferimento judicial solicitada',
    auditoriaAprovar: 'Reconsideração de indeferimento judicial aprovada',
    auditoriaManter: 'Reconsideração de indeferimento judicial mantida',
  },
};

async function pedirReconsideracaoGenerica(interaction, numero, cfg) {
  const medida = db.buscarPorNumero('medidas', numero);
  if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
  if (cfg.gateBloqueia(interaction, medida)) return interaction.reply({ content: cfg.msgGatePedir(medida), ephemeral: true });
  if (medida.status !== cfg.statusNecessario) return interaction.reply({ content: cfg.msgStatusFail, ephemeral: true });
  if (medida[cfg.campoStatus] === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de reconsideração pendente.', ephemeral: true });

  const convocados = rh.listarPorCargo(cfg.cargoConvocado).filter(p => !p.licenca);
  const canalRecon = await canais.criarCanalTicket(interaction.guild, {
    categoriaId: config.categoriaReconsideracoesId, prefixo: cfg.prefixoCanal, numero,
    membros: [medida.delegado, medida.promotor, ...convocados.map(p => p.discordId)],
  });

  db.atualizar('medidas', numero, { [cfg.campoStatus]: 'Pendente', [cfg.campoCanal]: canalRecon.id });

  const embed = new EmbedBuilder().setTitle(cfg.embedTitulo(numero)).setColor(0xf39c12).addFields(...cfg.embedCampos(medida));
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:medida:${cfg.customIdBase}:${numero}#aprovar`).setLabel(cfg.labelAprovar).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:medida:${cfg.customIdBase}:${numero}#manter`).setLabel(cfg.labelManter).setStyle(ButtonStyle.Danger),
  );
  await canalRecon.send({
    content: convocados.length ? convocados.map(p => `<@${p.discordId}>`).join(' ') : `Nenhum ${cfg.cargoConvocado} ativo cadastrado no momento — o pedido fica pendente até haver um.`,
    embeds: [embed], components: [botoes],
  });

  await auditoria.registrar(interaction.guild, { acao: cfg.auditoriaPedir, executorId: interaction.user.id, referencia: numero });
  return interaction.reply({ content: `Pedido de reconsideração aberto em ${canalRecon}.`, ephemeral: true });
}

async function decidirReconsideracaoGenerica(interaction, extra, cfg) {
  const [numero, decisao] = extra.split('#');
  if (!temCargo(interaction, cfg.cargoDecisor) && !isAdmin(interaction)) {
    return interaction.reply({ content: cfg.msgGateDecisor, ephemeral: true });
  }
  const guild = await resolverGuild(interaction);
  if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

  const medida = db.buscarPorNumero('medidas', numero);
  if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
  if (medida[cfg.campoStatus] !== 'Pendente') {
    return interaction.reply({
      content: atosPorCargo.mensagemJaFeito('A decisão desta reconsideração', { porId: medida.executadoPorId || null, em: null }),
      ephemeral: true,
    });
  }

  const canalMedida = await guild.channels.fetch(medida.canalId).catch(() => null);
  const canalRecon = medida[cfg.campoCanal] ? await guild.channels.fetch(medida[cfg.campoCanal]).catch(() => null) : null;

  if (decisao === 'aprovar') {
    const juizId = rh.sortearJuiz({ excluirIds: cfg.sortearExcluir(medida) });
    if (!juizId) return interaction.reply({ content: cfg.msgSemJuiz, ephemeral: true });

    db.atualizar('medidas', numero, {
      status: 'Aprovada - aguardando juiz', juiz: juizId, [cfg.campoStatus]: 'Aprovada',
      ...atosPorCargo.carimboDeExecucao(interaction.user.id),
      aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false,
    });
    if (canalMedida) {
      await canais.adicionarMembro(canalMedida, juizId);
      await canalMedida.send({
        content: cfg.msgAprovarCanalMedida(interaction, juizId),
        embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
        components: [botoesJuizMedida(numero)],
      });
    }
    if (canalRecon) {
      await canalRecon.send({ content: `✅ Reconsideração **aprovada**. Medida encaminhada a <@${juizId}> no canal ${canalMedida || medida.canalId}.` });
      await canais.arquivarCanal(canalRecon);
    }
    await auditoria.registrar(guild, { acao: cfg.auditoriaAprovar, executorId: interaction.user.id, referencia: `${numero} → Juiz <@${juizId}>` });
    return interaction.reply({ content: `Reconsideração aprovada. Medida ${numero} encaminhada a <@${juizId}>.`, ephemeral: true });
  }

  db.atualizar('medidas', numero, { [cfg.campoStatus]: 'Mantida', ...atosPorCargo.carimboDeExecucao(interaction.user.id) });
  if (canalMedida) {
    await canalMedida.send({ content: cfg.msgManterCanalMedida(interaction) });
  }
  if (canalRecon) {
    await canalRecon.send({ content: cfg.msgManterCanalRecon(interaction) });
    await canais.arquivarCanal(canalRecon);
  }
  await auditoria.registrar(guild, { acao: cfg.auditoriaManter, executorId: interaction.user.id, referencia: numero });
  return interaction.reply({ content: cfg.replyManter(numero), ephemeral: true });
}

// Emissão do mandado a partir de uma medida deferida. Vivia inline no processarReferendo; foi
// extraída porque o passo é REEXECUTÁVEL: quando o `canal.send` falha (foi o caso do estouro de
// 2000 caracteres em utils/documentos.js), a medida já ficou gravada como Deferida e o mandado já
// existe no banco, mas nada apareceu no canal e o botão de referendar sumiu — sem um caminho de
// reemissão o ato morria ali, gravado e invisível.
//
// Idempotente no número: se a medida já tem mandado, reaproveita em vez de emitir um segundo.
// Devolve { numeroMandado, postado, erro } — o send é capturado de propósito, pra uma falha de
// postagem virar estado recuperável e visível, nunca exceção no meio de um ato já gravado.
async function emitirMandadoDaMedida(interaction, medida, fundamentacaoJuiz, { reemissao = false } = {}) {
  const numero = medida.numero;
  const mandadoExistente = db.todos('mandados', m => m.medidaNumero === numero)[0];
  const numeroMandado = mandadoExistente?.numero || proximoNumero(db, 'mandados', 'MO');
  if (!mandadoExistente) {
    // Schema unificado com o mandado direto (mandado.js): grava também processoVinculado (quando a
    // medida já está atrelada a um processo), senão temAcessoMandado/embed não enxergam o processo.
    db.inserir('mandados', {
      numero: numeroMandado, medidaNumero: numero, processoVinculado: medida.processoVinculado || null,
      tipo: medida.tipo, alvo: medida.alvo,
      status: 'Emitido', emitidoPor: medida.juiz, cumpridoPor: null,
    });
    // Dossiê do inquérito: registra o mandado sob o mesmo protocolo da medida que o originou,
    // independente de qual Juiz foi sorteado — é isso que deixa o dossiê completo quando a
    // denúncia nascer daqui (ver criarProcessoPenal).
    if (medida.codigoExterno) dossie.registrarMandado(medida.codigoExterno, numeroMandado);
  }

  const medidaAtualizada = db.buscarPorNumero('medidas', numero);
  // Assinatura = quem clicou (o Juiz que referenda a medida, ou superstaff no lugar dele).
  const nomeAssinante = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const pngMandado = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'mandado_generico',
    orgaoEmissor: 'judiciario',
    subunidade: 'Comarca de São Paulo — Vara Criminal',
    tituloDocumento: `MANDADO DE ${medida.tipo.toUpperCase()}`,
    numeroProcesso: numeroMandado,
    dataEmissao: documentos.dataExtenso(),
    destinatario: medida.alvo,
    corpoTexto: [
      `Fundamentação do Ministério Público:\n${medida.fundamentacaoPromotor || '—'}`,
      '',
      `Fundamentação do Juízo:\n${fundamentacaoJuiz}`,
      ...(medida.codigoExterno ? ['', `Pedido advindo do Inquérito Policial nº ${medida.codigoExterno}.`] : []),
    ].join('\n'),
    nomeAssinante,
    cargoAssinante: 'Juiz de Direito',
  }).catch(err => { console.error('Falha ao gerar PNG do mandado:', err.message); return null; });

  const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
  if (!canal) return { numeroMandado, postado: false, erro: 'canal da medida não encontrado' };

  try {
    const msgMandado = await canal.send({
      content: `<@${medida.delegado}>\n\n${documentos.textoMandado({
        numero: numeroMandado, medida: medidaAtualizada,
        fundamentacaoPromotor: medida.fundamentacaoPromotor, fundamentacaoJuiz,
        codigoExterno: medida.codigoExterno,
      })}`,
      components: [botaoCumprir(numeroMandado)],
      ...(pngMandado ? { files: [{ attachment: pngMandado, name: `Mandado-${numeroMandado}.png` }] } : {}),
    });
    // Registra o PNG do referendo em documentosAnexados — o mandado direto (mandado.js) já fazia
    // isso; sem isto a rastreabilidade do mandado ficava só no direto. Protocolo = processo
    // vinculado quando existe, senão a própria medida.
    const anexoUrlMandado = msgMandado?.attachments?.first()?.url;
    if (anexoUrlMandado) {
      anexos.criarDocumento({
        tipo: 'mandado', url: anexoUrlMandado, nomeArquivo: `Mandado-${numeroMandado}.png`,
        autorId: medida.juiz, atoOrigemId: numeroMandado, protocoloVinculado: medida.processoVinculado || numero,
      });
    }
    await canal.send({ content: `<@${medida.promotor}> quando quiser, pode transformar esta medida em processo penal formal, herdando os dados automaticamente.`, components: [botaoAbrirProcesso(numero)] });
  } catch (err) {
    console.error(`Falha ao postar o mandado ${numeroMandado} da medida ${numero}:`, err.message);
    return { numeroMandado, postado: false, erro: err.message };
  }

  // Na reemissão os atos abaixo já foram lavrados no referendo original — relavrar duplicaria o
  // andamento nos autos e reenviaria a devolutiva pro servidor da Polícia Civil.
  if (reemissao) {
    await auditoria.registrar(interaction.guild, { acao: 'Mandado reemitido no canal da medida', executorId: interaction.user.id, referencia: `${numero} → Mandado ${numeroMandado}` });
    return { numeroMandado, postado: true };
  }

  // Só vira andamento se já existe processo pra pendurar o evento — nem toda medida referendada
  // tem um (pode ainda estar solta, virando processo só depois via botaoAbrirProcesso). Sem
  // processo vinculado, mantém o auditoria.registrar solto de antes como única saída.
  if (medida.processoVinculado) {
    await andamentos.registrar(interaction.guild, medida.processoVinculado, {
      tipo: 'mandado_emitido', titulo: `📜 Mandado de ${medida.tipo} emitido`,
      detalhe: require('../utils/pecas').detalheDeAndamento(medida.processoVinculado,
        `Mandado ${numeroMandado} — alvo: ${medida.alvo}\nFundamentação do Juízo: ${fundamentacaoJuiz}`,
        `Mandado ${numeroMandado} — alvo: ${medida.alvo}. A fundamentação do Juízo fica restrita até a entrega pessoal.`),
      executorId: interaction.user.id, metadata: { mandadoNumero: numeroMandado, tipoMandado: medida.tipo, medidaNumero: numero },
    });
    // Sem repostarPainel aqui de propósito: a narrativa acima foi postada no canal DA MEDIDA
    // (medida.canalId), não necessariamente no canal do processo — repostar lá enterraria o
    // painel no canal errado, sem relação com a mensagem nova.
  } else {
    await auditoria.registrar(interaction.guild, { acao: 'Medida referendada — mandado emitido', executorId: interaction.user.id, referencia: `${numero} → Mandado ${numeroMandado}` });
  }
  await devolutivaPoliciaCivil.enviarDevolutivaMandado(medidaAtualizada, {
    decisao: 'Deferido', fundamentacao: fundamentacaoJuiz, juizId: medida.juiz, numeroMandado, pngBuffer: pngMandado,
  });
  // NÍVEL 2 — NÃO publica no Diário aqui (no deferimento/emissão): publicar antes do cumprimento
  // avisaria o alvo e queimaria a diligência. A publicação acontece só no cumprimento
  // (cumprirMandado → mandadoCumprido), e só para os tipos da allow-list (utils/diarioAtos.js).
  // Mandado não cumprido não publica em gatilho nenhum.
  // OBS: a devolutiva acima (enviarDevolutivaMandado) é OUTRA coisa — vai por webhook pro servidor
  // da Polícia Civil que pediu a diligência, leva Tipo/Alvo e NÃO passa pela política do Diário.
  return { numeroMandado, postado: true };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('medida')
    .setDescription('Pedidos de medida cautelar (fase de inquérito, antes de processo formal)')
    .addSubcommand(sub => sub.setName('solicitar').setDescription('Solicita uma medida cautelar ao MP')
      .addStringOption(o => {
        o.setName('tipo').setDescription('Tipo de medida').setRequired(true);
        TIPOS_MEDIDA.forEach(t => o.addChoices({ name: t, value: t }));
        return o;
      })
      .addStringOption(o => o.setName('alvo').setDescription('Nome do alvo (pessoa ou local)').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Motivo/indícios que fundamentam o pedido').setRequired(true))
      .addStringOption(o => o.setName('alvo_rg').setDescription('RG do alvo — deixe vazio se o alvo for um local'))
      .addUserOption(o => o.setName('promotor').setDescription('Promotor responsável por analisar')))
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de uma medida')
      .addStringOption(o => o.setName('numero').setDescription('Número da medida').setRequired(true).setAutocomplete(true)))
    // Reparo: republica no canal o mandado de uma medida já deferida cuja postagem falhou.
    .addSubcommand(sub => sub.setName('reemitir').setDescription('Republica no canal o mandado de uma medida já deferida')
      .addStringOption(o => o.setName('numero').setDescription('Número da medida (ex: 0009MD)').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista medidas cautelares')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status').addChoices(
        { name: 'Aguardando MP', value: 'Aguardando MP' },
        { name: 'Negada', value: 'Negada' },
        { name: 'Deferida', value: 'Deferida' },
      ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solicitar') {
      if (!temCargo(interaction, 'Delegado')) {
        return interaction.reply({ content: 'Só Delegados podem solicitar medida cautelar.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resultado = await solicitarMedida({
        guild: interaction.guild,
        delegadoId: interaction.user.id,
        promotorId: interaction.options.getUser('promotor')?.id || null,
        tipo: interaction.options.getString('tipo'),
        alvo: interaction.options.getString('alvo'),
        rgAlvo: interaction.options.getString('alvo_rg') || null,
        motivo: interaction.options.getString('motivo'),
      });

      if (resultado.erro) return interaction.editReply({ content: resultado.erro });
      return interaction.editReply({ content: `Medida ${resultado.numero} registrada em ${resultado.canal}.` });
    }

    if (sub === 'ver') {
      const numero = interaction.options.getString('numero');
      const medida = db.buscarPorNumero('medidas', numero);
      if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
      // Gate de sigilo + resposta SEMPRE privada (antes era pública, vazava o teor no canal).
      if (!temAcessoMedida(interaction, medida)) return interaction.reply({ content: 'Você não tem acesso ao teor desta medida — ela é sigilosa (fase de inquérito). Só as partes (Delegado/Promotor/Juiz) e a Staff podem consultá-la.', ephemeral: true });
      return interaction.reply({ embeds: [embedMedida(medida)], ephemeral: true });
    }

    if (sub === 'reemitir') {
      return module.exports.reemitirMandado(interaction, interaction.options.getString('numero').trim().toUpperCase());
    }

    if (sub === 'listar') {
      const status = interaction.options.getString('status');
      const rows = db.todos('medidas', status ? m => m.status === status : null).slice(0, 15);
      if (rows.length === 0) return interaction.reply({ content: 'Nenhuma medida encontrada.', ephemeral: true });
      return interaction.reply({ embeds: [embedListaMedidas(rows)], ephemeral: true });
    }
  },

  // ---- Handlers de botão (chamados pelo roteador central em interactions/botoes.js) ----

  // Aprovar exige que o Promotor escreva a fundamentação do pedido — sem isso o Juiz recebia
  // só um "aprovado" sem nenhum texto pra deliberar em cima.
  async aprovar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'promotor')) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    return interaction.showModal(modalFundamentacao(`painel:modal:medida:aprovarmp:${numero}`, 'Aprovar pedido — fundamentação', 'Fundamentação do MP'));
  },

  async processarAprovacaoMP(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'promotor')) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    const jaTriada = atosPorCargo.bloqueioPorStatusDecidido(medida, ['Aguardando MP'], 'A triagem desta medida pelo MP');
    if (jaTriada) return interaction.reply({ content: jaTriada, ephemeral: true });
    const fundamentacao = interaction.fields.getTextInputValue('fundamentacao');

    // Exclui também o alvo identificado — mesma lógica do processo: quem é alvo da medida não
    // pode ser sorteado pra julgar o próprio caso.
    const juizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor, medida.alvoDiscordId].filter(Boolean) });
    if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

    db.atualizar('medidas', numero, {
      status: 'Aprovada - aguardando juiz', juiz: juizId, fundamentacaoPromotor: fundamentacao,
      ...atosPorCargo.carimboDeExecucao(interaction.user.id),
      aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false,
    });
    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) await canais.adicionarMembro(canal, juizId);
    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

    if (canal) {
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: medida.tipo, titulo: 'MANIFESTAÇÃO DO MINISTÉRIO PÚBLICO — PELO DEFERIMENTO',
          texto: fundamentacao, autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça',
          referenciaExterna: medida.codigoExterno,
        }),
      });
      await canal.send({ content: `<@${juizId}> você foi sorteado para deliberar sobre esta medida.`, embeds: [embedMedida(db.buscarPorNumero('medidas', numero))], components: [botoesJuizMedida(numero)] });
    }
    await auditoria.registrar(interaction.guild, { acao: 'Medida aprovada pelo MP', executorId: interaction.user.id, referencia: `${numero} → Juiz <@${juizId}>` });
    return interaction.reply({ content: `Medida ${numero} aprovada e encaminhada a <@${juizId}>.`, ephemeral: true });
  },

  async negar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'promotor')) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }

    const jaTriada = atosPorCargo.bloqueioPorStatusDecidido(medida, ['Aguardando MP'], 'A triagem desta medida pelo MP');
    if (jaTriada) return interaction.reply({ content: jaTriada, ephemeral: true });

    db.atualizar('medidas', numero, { status: 'Negada', ...atosPorCargo.carimboDeExecucao(interaction.user.id) });
    await interaction.update({
      embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
      components: [botaoRecorrer(numero), new ActionRowBuilder().addComponents(botaoArquivarManual(numero))],
    });
    await auditoria.registrar(interaction.guild, { acao: 'Medida negada pelo MP', executorId: interaction.user.id, referencia: numero });
  },

  async recorrer(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.delegado && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Delegado que abriu esta medida pode juntar indícios e recorrer — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }

    // Reinicia o relógio do prazo — senão o recurso reentraria em "Aguardando MP" já contando
    // como se estivesse parado desde a abertura original da medida.
    db.atualizar('medidas', numero, {
      status: 'Aguardando MP',
      aguardandoMpDesde: new Date().toISOString(), lembreteMpEnviado: false, escalonamentoMpEnviado: false,
    });
    await interaction.update({ embeds: [embedMedida(db.buscarPorNumero('medidas', numero))], components: [botoesAnalise(numero)] });
  },

  // Pedido de reconsideração ao Procurador ganha um ticket próprio, mesmo critério da apelação
  // ao Desembargador: canal dedicado numa categoria própria, não uma mensagem no canal da medida.
  async pedirReconsideracao(interaction, numero) {
    return pedirReconsideracaoGenerica(interaction, numero, RECON_CONFIG.procurador);
  },

  // Decisão do Procurador acontece no ticket de reconsideração, mas o resultado também é
  // avisado no canal original da medida — é lá que o Juiz vai agir se for aprovada.
  async decidirReconsideracao(interaction, extra) {
    return decidirReconsideracaoGenerica(interaction, extra, RECON_CONFIG.procurador);
  },

  // Mesmo padrão da reconsideração ao Procurador, só que pra quando é o JUIZ que nega
  // provimento (antes disso não existia nenhum recurso possível nesse ponto — beco sem saída).
  // Delegado ou Promotor podem pedir, já que os dois têm interesse no desfecho da medida.
  async pedirReconsideracaoJuiz(interaction, numero) {
    return pedirReconsideracaoGenerica(interaction, numero, RECON_CONFIG.juiz);
  },

  async decidirReconsideracaoJuiz(interaction, extra) {
    return decidirReconsideracaoGenerica(interaction, extra, RECON_CONFIG.juiz);
  },

  // Referendar (deferir) e negar provimento agora exigem a fundamentação do Juiz por escrito —
  // sem isso o mandado saía só com um embed genérico, sem nenhum texto jurídico de verdade.
  async referendar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    return interaction.showModal(modalFundamentacao(`painel:modal:medida:referendar:${numero}`, 'Referendar — fundamentação', 'Fundamentação do Juízo'));
  },

  // fundamentacaoOverride vem do fluxo revisão-in-flow (texto já escolhido pelo Juiz, revisado
   // ou não). Só lê do modal quando chamado direto na submissão (compatibilidade).
  async processarReferendo(interaction, numero, fundamentacaoOverride) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = fundamentacaoOverride !== undefined ? fundamentacaoOverride : interaction.fields.getTextInputValue('fundamentacao');
    // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
    // Chromium sobe e a interação "falha" mesmo com o mandado sendo emitido com sucesso. Guard
    // idempotente: no modo "revisão automática" o executarDecisaoMedida já deu deferReply.
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

    // GUARDA DE COLISÃO — relê depois do defer. O referendo emite mandado e gera PNG; sem esta
    // trava dois Juízes referendando ao mesmo tempo publicavam o documento duas vezes no canal.
    const jaDecidida = atosPorCargo.bloqueioPorJaExecutado(
      db.buscarPorNumero('medidas', numero), ['decisaoJuizEm'], 'A decisão desta medida',
    );
    if (jaDecidida) return interaction.editReply({ content: jaDecidida });

    db.atualizar('medidas', numero, { status: 'Deferida', fundamentacaoJuiz, decisaoJuizEm: new Date().toISOString(), ...atosPorCargo.carimboDeExecucao(interaction.user.id) });

    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

    const { numeroMandado, postado, erro } = await emitirMandadoDaMedida(interaction, medida, fundamentacaoJuiz);
    if (!postado) {
      return interaction.editReply({ content: `Medida ${numero} referendada e Mandado ${numeroMandado} emitido, mas **não consegui postar no canal da medida** (${erro}). O ato está gravado — use \`/medida reemitir numero:${numero}\` para publicá-lo.` });
    }
    return interaction.editReply({ content: `Medida ${numero} referendada. Mandado ${numeroMandado} emitido.` });
  },

  // Reemissão do mandado de uma medida JÁ deferida cuja publicação no canal falhou. Não redecide
  // nada: reaproveita a fundamentação do Juízo gravada nos autos e o número de mandado que já
  // existe, só refaz o PNG e a postagem.
  async reemitirMandado(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode reemitir o mandado — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    if (medida.status !== 'Deferida') {
      return interaction.reply({ content: `A medida ${numero} está como "${medida.status}" — só medida deferida tem mandado a reemitir.`, ephemeral: true });
    }
    if (!medida.fundamentacaoJuiz) {
      return interaction.reply({ content: `A medida ${numero} está deferida mas sem fundamentação do Juízo gravada — não dá pra reemitir o mandado sem o teor da decisão.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const { numeroMandado, postado, erro } = await emitirMandadoDaMedida(interaction, medida, medida.fundamentacaoJuiz, { reemissao: true });
    if (!postado) return interaction.editReply({ content: `Não consegui postar o Mandado ${numeroMandado} no canal da medida: ${erro}` });
    return interaction.editReply({ content: `Mandado ${numeroMandado} publicado no canal da medida ${numero}.` });
  },

  async abrirModalNegarJuiz(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    return interaction.showModal(modalFundamentacao(`painel:modal:medida:negarjuiz:${numero}`, 'Negar provimento — fundamentação', 'Fundamentação do Juízo'));
  },

  async negarJuiz(interaction, numero, fundamentacaoOverride) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = fundamentacaoOverride !== undefined ? fundamentacaoOverride : interaction.fields.getTextInputValue('fundamentacao');
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

    // Mesma guarda do referendo: negar depois que o colega já referendou apagaria dos autos um
    // mandado que já foi emitido e publicado no canal.
    const jaDecidida = atosPorCargo.bloqueioPorJaExecutado(
      db.buscarPorNumero('medidas', numero), ['decisaoJuizEm'], 'A decisão desta medida',
    );
    if (jaDecidida) return interaction.editReply({ content: jaDecidida });

    db.atualizar('medidas', numero, { status: 'Indeferida pelo Juiz', fundamentacaoJuiz, decisaoJuizEm: new Date().toISOString(), ...atosPorCargo.carimboDeExecucao(interaction.user.id) });

    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) {
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: medida.tipo, titulo: 'DECISÃO — INDEFERIMENTO DA MEDIDA',
          texto: fundamentacaoJuiz, autorId: interaction.user.id, cargoAutor: 'Juiz(a) de Direito',
          referenciaExterna: medida.codigoExterno,
        }),
        // Sem isso, negativa do Juiz era beco sem saída — nenhum recurso existia (só a do MP
        // tinha "pedir reconsideração"). Agora dá pra escalar pro Desembargador também.
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`painel:acao:medida:pedirreconsideracaojuiz:${numero}`).setLabel('Pedir reconsideração (Desembargador)').setStyle(ButtonStyle.Secondary),
          botaoArquivarManual(numero),
        )],
      });
    }
    await auditoria.registrar(interaction.guild, { acao: 'Medida indeferida pelo Juiz', executorId: interaction.user.id, referencia: numero });
    await devolutivaPoliciaCivil.enviarDevolutivaMandado(db.buscarPorNumero('medidas', numero), {
      decisao: 'Indeferido', fundamentacao: fundamentacaoJuiz, juizId: medida.juiz, numeroMandado: null,
    });
    return interaction.editReply({ content: `Medida ${numero} indeferida.` });
  },

  // Submissão do modal de decisão do Juiz (referendo/negativa): guarda o rascunho e oferece a
  // revisão por IA antes de publicar — mesmo padrão da sentença/acórdão. `tipo` ∈ referendo|negativa.
  async confirmarDecisaoMedida(interaction, numero, tipo) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'juiz')) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacao = interaction.fields.getTextInputValue('fundamentacao');
    rascunhoFundMedida.set(chaveFundMedida(interaction.user.id, numero), { tipo, fundamentacao });
    // Revisão automática ligada: pula a tela de escolha e já publica o texto revisado pela IA.
    if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return module.exports.executarDecisaoMedida(interaction, `${numero}#${tipo}`, 'auto');
    const rotulo = tipo === 'referendo' ? 'referendar — emitir mandado' : 'negar provimento';
    return interaction.reply(revisaoIA.telaEscolha('medida', { extra: `${numero}#${tipo}`, titulo: 'Fundamentação do Juízo', rotulo, texto: fundamentacao }));
  },

  async revisarFundMedida(interaction, chave) {
    const [numero] = chave.split('#');
    const d = rascunhoFundMedida.get(chaveFundMedida(interaction.user.id, numero));
    if (!d) return interaction.update({ content: 'A prévia da decisão expirou. Refaça a ação.', components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const revisado = await cartorio.revisarTexto(d.fundamentacao).catch(() => null);
    if (!revisado) return interaction.editReply(revisaoIA.telaFallbackIA('medida', chave));
    d.textoRevisado = revisado;
    return interaction.editReply(revisaoIA.telaAntesDepois('medida', { extra: chave, textoOriginal: d.fundamentacao, textoRevisado: revisado }));
  },

  async executarDecisaoMedida(interaction, chave, modo) {
    const [numero, tipo] = chave.split('#');
    const chaveD = chaveFundMedida(interaction.user.id, numero);
    const d = rascunhoFundMedida.get(chaveD);
    if (!d) return interaction.reply({ content: 'A prévia da decisão expirou. Refaça a ação.', ephemeral: true }).catch(() => {});
    rascunhoFundMedida.delete(chaveD);
    // Modo automático: defer aqui e revisa antes de processarReferendo/negarJuiz (que reutilizam
    // este defer via guard). Fallback pro texto original se a IA não responder.
    if (modo === 'auto') {
      await interaction.deferReply({ ephemeral: true });
      if (!d.textoRevisado) d.textoRevisado = await cartorio.revisarTexto(d.fundamentacao).catch(() => null);
    }
    const usarRevisado = modo === 'auto' ? !!d.textoRevisado : modo;
    const fundamentacao = usarRevisado && d.textoRevisado ? d.textoRevisado : d.fundamentacao;
    if (tipo === 'referendo') return module.exports.processarReferendo(interaction, numero, fundamentacao);
    return module.exports.negarJuiz(interaction, numero, fundamentacao);
  },

  async cumprirMandado(interaction, numero) {
    const mandado = db.buscarPorNumero('mandados', numero);
    if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
    const medida = db.buscarPorNumero('medidas', mandado.medidaNumero);
    // Mandado emitido direto de um processo (painel-contexto-e-tipo-mandado.md) não tem medida
    // por trás — o responsável pelo cumprimento nesse caso é o Delegado do próprio processo.
    const processoDoMandado = mandado.processoVinculado ? db.buscarPorNumero('processos', mandado.processoVinculado) : null;
    const responsavelCumprimento = medida?.delegado || processoDoMandado?.delegado;
    // Sem Delegado responsável definido a checagem NÃO pode curto-circuitar (senão qualquer um
    // cumpriria o mandado) — nesse caso exige Staff. Com responsável, só ele (ou SuperStaff).
    if (responsavelCumprimento) {
      if (interaction.user.id !== responsavelCumprimento && !isSuperStaff(interaction)) {
        return interaction.reply({ content: `Só o Delegado responsável por este mandado pode cumpri-lo — no caso, <@${responsavelCumprimento}>.`, ephemeral: true });
      }
    } else if (!isAdmin(interaction) && !isSuperStaff(interaction)) {
      return interaction.reply({ content: 'Este mandado não tem Delegado responsável definido — só a Staff pode registrar o cumprimento.', ephemeral: true });
    }

    // aguardarAnexoPDF já consome a resposta inicial da interação (reply pedindo o PDF) — não
    // dá pra também chamar interaction.update() na mesma interação depois; o botão se apaga
    // editando a mensagem original diretamente.
    const coletado = await coletarAnexoPdf(interaction, {
      numero, tipo: 'cumprimento_mandado',
      protocolo: medida?.codigoExterno || mandado.medidaNumero || mandado.processoVinculado,
    });
    if (!coletado) return; // coletarAnexoPdf já avisou o motivo (tempo esgotado ou não é PDF)
    const { anexo, documento: documentoCumprimento } = coletado;
    if (medida?.codigoExterno) dossie.registrarDocumento(medida.codigoExterno, documentoCumprimento.id);

    db.atualizar('mandados', numero, { status: 'Cumprido', cumpridoPor: interaction.user.id });
    // NÍVEL 2 — é AQUI que o mandado publica no Diário (no cumprimento, não no deferimento). Efeito
    // automático por natureza; blindado. O alvo já foi alcançado, então publicar não vaza mais nada.
    await diarioAtos.publicarAto(interaction.guild, 'mandadoCumprido', db.buscarPorNumero('mandados', numero));
    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});
    const componentesArquivar = mandado.medidaNumero
      ? [new ActionRowBuilder().addComponents(botaoArquivarManual(mandado.medidaNumero))]
      : [];
    // IA "cartório" faz a análise estruturada do auto de cumprimento (best-effort).
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'cumprimento_mandado', pdfUrl: anexo.url });
    await interaction.followUp({ content: `📎 Mandado ${numero} cumprido por <@${interaction.user.id}> — PDF juntado aos autos.`, embeds: embedAnalise ? [embedAnalise] : [], components: componentesArquivar });
    if (mandado.processoVinculado) {
      await andamentos.registrar(interaction.guild, mandado.processoVinculado, {
        tipo: 'mandado_cumprido', titulo: `✅ Mandado cumprido`,
        // Link da mensagem, não do anexo: a URL do CDN expira em 24h (ver utils/anexos.js).
        detalhe: `Mandado ${numero} cumprido por <@${interaction.user.id}> — ${anexos.rotuloComLink(anexo)} juntado aos autos.`,
        executorId: interaction.user.id, anexoUrl: anexo.url, metadata: { mandadoNumero: numero },
      });
      // Aqui sim o followUp acima foi postado no canal do processo (mandado novo sempre nasce
      // lá) — pode repostar o painel com segurança.
      await require('./processo').repostarPainel(interaction.guild, mandado.processoVinculado);
    } else {
      await auditoria.registrar(interaction.guild, { acao: 'Mandado cumprido', executorId: interaction.user.id, referencia: numero });
    }
  },

  // Camada 2 dos indícios (seção 4.1) — só existe quando o pedido chegou da Polícia Civil sem
  // indicios_pdf_url no payload. Só o delegado_solicitante consegue anexar (é o único com uma
  // interação de verdade nesse momento — o pedido em si veio de webhook, sem humano clicando).
  // A medida só entra na fila do MP depois que o documento existir, por essa via ou pela
  // Camada 1 (payload já vinha com o PDF).
  async anexarIndicios(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.delegado && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Delegado que solicitou esta medida pode anexar os indícios — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }
    if (medida.status !== 'Aguardando anexo de indícios') {
      return interaction.reply({ content: 'Esta medida já tem indícios anexados e está na fila do MP.', ephemeral: true });
    }

    const anexo = await aguardarAnexoPDF(interaction);
    if (!anexo) return;

    const documentoIndicios = anexos.criarDocumento({
      tipo: 'indicios_pedido_medida', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
      atoOrigemId: numero, protocoloVinculado: medida.codigoExterno || numero,
    });
    if (medida.codigoExterno) {
      dossie.registrarMedida(medida.codigoExterno, numero);
      dossie.registrarDocumento(medida.codigoExterno, documentoIndicios.id);
    }

    db.atualizar('medidas', numero, { status: 'Aguardando MP', aguardandoMpDesde: new Date().toISOString() });
    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});
    const medidaAtualizada = db.buscarPorNumero('medidas', numero);
    // IA "cartório" analisa os indícios pro Promotor (best-effort). Vai como 2º embed junto do card.
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'indicios_medida', pdfUrl: anexo.url });
    await interaction.followUp({
      content: `📎 Indícios anexados por <@${interaction.user.id}> — a medida ${numero} agora está na fila do Ministério Público.`,
      embeds: [embedMedida(medidaAtualizada), ...(embedAnalise ? [embedAnalise] : [])], components: [botoesAnalise(numero)],
    });
    await auditoria.registrar(interaction.guild, { acao: 'Indícios anexados ao pedido de medida', executorId: interaction.user.id, referencia: numero });
  },

  async abrirProcesso(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (!podeAtuarNoCaso(interaction, medida, 'promotor')) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode abrir o processo — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    if (medida.processoVinculado) {
      return interaction.reply({ content: `Essa medida já gerou o processo ${medida.processoVinculado}.`, ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(`medida:processomodal:${numero}`).setTitle(`Abrir processo — ${numero}`.slice(0, 45));

    const campoMotivo = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/fatos (edite se quiser)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(medida.motivo.slice(0, 4000));
    // Pré-preenche com o alvo já identificado na medida — sem isso, o Promotor precisava saber
    // de cor o ID do alvo pra digitar @menção, já que o alvo nunca entrou no canal da medida
    // (é investigativa) e não aparece na lista de membros pra selecionar.
    const campoReus = new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus, se já identificados')
      .setStyle(TextInputStyle.Short).setRequired(false);
    // Antes pré-preenchia com a menção do alvo; sem Discord do alvo, o que serve é o nome.
    if (medida.alvo) campoReus.setValue(String(medida.alvo).slice(0, 100));

    modal.addComponents(
      new ActionRowBuilder().addComponents(campoMotivo),
      new ActionRowBuilder().addComponents(campoReus),
    );
    await interaction.showModal(modal);
  },

  async criarProcessoModal(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });

    rascunhoCrimes.iniciar(interaction.user.id, {
      tipo: 'penal-medida',
      dados: {
        delegadoId: medida.delegado,
        promotorId: medida.promotor,
        motivo: interaction.fields.getTextInputValue('motivo'),
        reusTexto: interaction.fields.getTextInputValue('reus'),
        medidaNumero: numero,
      },
    });

    return crimePicker.mostrarPainel(interaction, { novaMensagem: true });
  },

  TIPOS_MEDIDA,
  embedMedida, temAcessoMedida, embedListaMedidas,
  solicitarMedida,
  botaoSolicitarMedidaDireta,
  abrirSolicitarMedidaDireta,
  processarSelecaoTipoDireta,
  criarSolicitacaoMedidaDireta,
  processarSelecaoDestinatarioDireta,
  deferirMedidaDireta,
  indeferirMedidaDireta,

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = db.todos('medidas', m => m.numero.toLowerCase().includes(foco))
      .filter(m => temAcessoMedida(interaction, m)) // não sugere medidas sigilosas a quem não é parte
      .slice(0, 25)
      .map(m => ({ name: `${m.numero} — ${m.tipo} — ${m.status}`.slice(0, 100), value: m.numero }));
    await interaction.respond(resultados);
  },
};
