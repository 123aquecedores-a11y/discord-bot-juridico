const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isAdmin, isSuperStaff } = require('../utils/permissoes');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const config = require('../config');
const rascunhoCrimes = require('../utils/rascunhoCrimes');
const crimePicker = require('../utils/crimePicker');
const { truncar } = require('../utils/texto');
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
const { aguardarAnexoPDF } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');
const dossie = require('../utils/dossie');
const { selectTipoMedidaCoercitiva, rotuloTipo } = require('../utils/tiposMedidaCoercitiva');
const partesProcesso = require('../utils/partesProcesso');
const mandadoCmd = require('./mandado');
const andamentos = require('../utils/andamentos');
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
      { name: 'Discord do alvo', value: medida.alvoDiscordId ? `<@${medida.alvoDiscordId}>` : 'Não identificado', inline: true },
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
  );
}

// Juiz recebe a medida já aprovada pelo MP e pode referendar (gera mandado) ou negar
// provimento (encerra sem mandado) — antes só existia a opção de referendar.
function botoesJuizMedida(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:referendar:${numero}`).setLabel('Referendar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:medida:negarjuiz:${numero}`).setLabel('Negar provimento').setStyle(ButtonStyle.Danger),
    botaoArquivarManual(numero),
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
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor deste processo pode solicitar medida — no caso, <@${processo.promotor}>.`, ephemeral: true });
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

function modalJustificativaMedidaDireta(chave, tipoValue, destinatarioRef) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:medida:solicitardireta:${chave}`).setTitle(`Solicitar — ${rotuloTipo(tipoValue)}`.slice(0, 45));
  const linhas = [];
  if (tipoValue === 'outro') {
    linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipoLivre').setLabel('Descreva o tipo').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
  }
  if (destinatarioRef === 'fora') {
    linhas.push(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idTexto').setLabel('RG ou Discord ID').setStyle(TextInputStyle.Short).setRequired(true)),
    );
  }
  linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('justificativa').setLabel('Justificativa do pedido').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
  modal.addComponents(...linhas);
  return modal;
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
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor deste processo pode solicitar medida — no caso, <@${processo.promotor}>.`, ephemeral: true });
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
  if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decidir — no caso, <@${medida.juiz}>.`, ephemeral: true });
  }
  if (medida.status !== 'Aprovada - aguardando juiz') {
    return interaction.reply({ content: 'Esta solicitação já foi decidida.', ephemeral: true });
  }
  const processo = db.buscarPorNumero('processos', medida.processoVinculado);
  if (!processo) return interaction.reply({ content: 'Processo vinculado não encontrado.', ephemeral: true });

  db.atualizar('medidas', numero, { status: 'Deferida', decisaoJuizEm: new Date().toISOString() });
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
  if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decidir — no caso, <@${medida.juiz}>.`, ephemeral: true });
  }
  if (medida.status !== 'Aprovada - aguardando juiz') {
    return interaction.reply({ content: 'Esta solicitação já foi decidida.', ephemeral: true });
  }

  db.atualizar('medidas', numero, { status: 'Indeferida pelo Juiz', decisaoJuizEm: new Date().toISOString() });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  await auditoria.registrar(interaction.guild, { acao: 'Medida indeferida (solicitação direta)', executorId: interaction.user.id, referencia: numero });
  // Fica só registrado no histórico do processo (auditoria acima já cumpre isso) — sem gerar
  // mandado, exatamente como pede a spec.
  return interaction.reply({ content: `Medida ${numero} indeferida. Fica registrada no histórico do processo, sem mandado emitido.` });
}

async function solicitarMedida({ guild, delegadoId, promotorId, tipo, alvo, alvoDiscordId, rgAlvo = null, motivo, semIndicios = false }) {
  let promotorFinal = promotorId;
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
    membros: [delegadoId, promotorFinal],
  });

  db.inserir('medidas', {
    numero, tipo, alvo, alvoDiscordId: alvoDiscordId || null, rgAlvo: rgAlvo || null, motivo,
    status: semIndicios ? 'Aguardando anexo de indícios' : 'Aguardando MP',
    delegado: delegadoId, promotor: promotorFinal, juiz: null,
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
      .addStringOption(o => o.setName('alvo').setDescription('Nome/local do alvo').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Motivo/indícios que fundamentam o pedido').setRequired(true))
      .addStringOption(o => o.setName('alvo_rg').setDescription('RG do alvo (identidade civil, se for pessoa)'))
      .addUserOption(o => o.setName('alvo_discord').setDescription('Discord do alvo (opcional, se tiver conta)'))
      .addUserOption(o => o.setName('promotor').setDescription('Promotor responsável por analisar')))
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de uma medida')
      .addStringOption(o => o.setName('numero').setDescription('Número da medida').setRequired(true).setAutocomplete(true)))
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
        alvoDiscordId: interaction.options.getUser('alvo_discord')?.id || null,
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
    if (interaction.user.id !== medida.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:aprovarmp:${numero}`).setTitle('Aprovar pedido — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do MP').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  async processarAprovacaoMP(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    const fundamentacao = interaction.fields.getTextInputValue('fundamentacao');

    // Exclui também o alvo identificado — mesma lógica do processo: quem é alvo da medida não
    // pode ser sorteado pra julgar o próprio caso.
    const juizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor, medida.alvoDiscordId].filter(Boolean) });
    if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

    db.atualizar('medidas', numero, {
      status: 'Aprovada - aguardando juiz', juiz: juizId, fundamentacaoPromotor: fundamentacao,
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
    if (interaction.user.id !== medida.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { status: 'Negada' });
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
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.delegado && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Delegado que abriu esta medida pode pedir reconsideração — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }
    if (medida.status !== 'Negada') return interaction.reply({ content: 'Essa medida não está negada.', ephemeral: true });
    if (medida.reconsideracao === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de reconsideração pendente.', ephemeral: true });

    const procuradores = rh.listarPorCargo('Procurador').filter(p => !p.licenca);
    const canalRecon = await canais.criarCanalTicket(interaction.guild, {
      categoriaId: config.categoriaReconsideracoesId, prefixo: 'reconsideracao', numero,
      membros: [medida.delegado, medida.promotor, ...procuradores.map(p => p.discordId)],
    });

    db.atualizar('medidas', numero, { reconsideracao: 'Pendente', reconsideracaoCanalId: canalRecon.id });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Reconsideração — medida ${numero} negada`)
      .setColor(0xf39c12)
      .addFields(
        { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
        { name: 'Promotor que negou', value: `<@${medida.promotor}>`, inline: true },
        { name: 'Tipo', value: medida.tipo, inline: true },
        { name: 'Alvo', value: truncar(medida.alvo) },
        { name: 'Motivo/Indícios originais', value: truncar(medida.motivo) },
      );
    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracao:${numero}#aprovar`).setLabel('Aprovar e enviar a Juiz').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracao:${numero}#manter`).setLabel('Manter negativa').setStyle(ButtonStyle.Danger),
    );
    await canalRecon.send({
      content: procuradores.length ? procuradores.map(p => `<@${p.discordId}>`).join(' ') : 'Nenhum Procurador ativo cadastrado no momento — o pedido fica pendente até haver um.',
      embeds: [embed], components: [botoes],
    });

    await auditoria.registrar(interaction.guild, { acao: 'Reconsideração de medida solicitada', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Pedido de reconsideração aberto em ${canalRecon}.`, ephemeral: true });
  },

  // Decisão do Procurador acontece no ticket de reconsideração, mas o resultado também é
  // avisado no canal original da medida — é lá que o Juiz vai agir se for aprovada.
  async decidirReconsideracao(interaction, extra) {
    const [numero, decisao] = extra.split('#');
    if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Procuradores podem decidir um pedido de reconsideração.', ephemeral: true });
    }
    const guild = await resolverGuild(interaction);
    if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (medida.reconsideracao !== 'Pendente') return interaction.reply({ content: 'Esse pedido de reconsideração já foi decidido.', ephemeral: true });

    const canalMedida = await guild.channels.fetch(medida.canalId).catch(() => null);
    const canalRecon = medida.reconsideracaoCanalId ? await guild.channels.fetch(medida.reconsideracaoCanalId).catch(() => null) : null;

    if (decisao === 'aprovar') {
      const juizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor] });
      if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

      db.atualizar('medidas', numero, {
        status: 'Aprovada - aguardando juiz', juiz: juizId, reconsideracao: 'Aprovada',
        aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false,
      });
      if (canalMedida) {
        await canais.adicionarMembro(canalMedida, juizId);
        await canalMedida.send({
          content: `Reconsideração aprovada pelo Procurador <@${interaction.user.id}> — a negativa do MP foi revertida. <@${juizId}> foi sorteado para deliberar.`,
          embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
          components: [botoesJuizMedida(numero)],
        });
      }
      if (canalRecon) {
        await canalRecon.send({ content: `✅ Reconsideração **aprovada**. Medida encaminhada a <@${juizId}> no canal ${canalMedida || medida.canalId}.` });
        await canais.arquivarCanal(canalRecon);
      }
      await auditoria.registrar(guild, { acao: 'Reconsideração de medida aprovada', executorId: interaction.user.id, referencia: `${numero} → Juiz <@${juizId}>` });
      return interaction.reply({ content: `Reconsideração aprovada. Medida ${numero} encaminhada a <@${juizId}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { reconsideracao: 'Mantida' });
    if (canalMedida) {
      await canalMedida.send({ content: `O Procurador <@${interaction.user.id}> analisou o pedido de reconsideração e **manteve a negativa** do MP.` });
    }
    if (canalRecon) {
      await canalRecon.send({ content: `❌ Negativa **mantida** pelo Procurador <@${interaction.user.id}>.` });
      await canais.arquivarCanal(canalRecon);
    }
    await auditoria.registrar(guild, { acao: 'Reconsideração de medida mantida', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Negativa da medida ${numero} mantida.`, ephemeral: true });
  },

  // Mesmo padrão da reconsideração ao Procurador, só que pra quando é o JUIZ que nega
  // provimento (antes disso não existia nenhum recurso possível nesse ponto — beco sem saída).
  // Delegado ou Promotor podem pedir, já que os dois têm interesse no desfecho da medida.
  async pedirReconsideracaoJuiz(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (![medida.delegado, medida.promotor].includes(interaction.user.id) && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Delegado ou o Promotor desta medida podem pedir reconsideração — no caso, <@${medida.delegado}> ou <@${medida.promotor}>.`, ephemeral: true });
    }
    if (medida.status !== 'Indeferida pelo Juiz') return interaction.reply({ content: 'Essa medida não foi indeferida pelo Juiz.', ephemeral: true });
    if (medida.reconsideracaoJuiz === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de reconsideração pendente.', ephemeral: true });

    const desembargadores = rh.listarPorCargo('Desembargador').filter(d => !d.licenca);
    const canalRecon = await canais.criarCanalTicket(interaction.guild, {
      categoriaId: config.categoriaReconsideracoesId, prefixo: 'reconsideracaojuiz', numero,
      membros: [medida.delegado, medida.promotor, ...desembargadores.map(d => d.discordId)],
    });

    db.atualizar('medidas', numero, { reconsideracaoJuiz: 'Pendente', reconsideracaoJuizCanalId: canalRecon.id });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Reconsideração — medida ${numero} indeferida pelo Juiz`)
      .setColor(0xf39c12)
      .addFields(
        { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
        { name: 'Promotor', value: `<@${medida.promotor}>`, inline: true },
        { name: 'Juiz que indeferiu', value: `<@${medida.juiz}>`, inline: true },
        { name: 'Tipo', value: medida.tipo, inline: true },
        { name: 'Alvo', value: truncar(medida.alvo) },
        { name: 'Fundamentação do indeferimento', value: truncar(medida.fundamentacaoJuiz) },
      );
    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracaojuiz:${numero}#aprovar`).setLabel('Aprovar e sortear novo Juiz').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracaojuiz:${numero}#manter`).setLabel('Manter indeferimento').setStyle(ButtonStyle.Danger),
    );
    await canalRecon.send({
      content: desembargadores.length ? desembargadores.map(d => `<@${d.discordId}>`).join(' ') : 'Nenhum Desembargador ativo cadastrado no momento — o pedido fica pendente até haver um.',
      embeds: [embed], components: [botoes],
    });

    await auditoria.registrar(interaction.guild, { acao: 'Reconsideração de indeferimento judicial solicitada', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Pedido de reconsideração aberto em ${canalRecon}.`, ephemeral: true });
  },

  async decidirReconsideracaoJuiz(interaction, extra) {
    const [numero, decisao] = extra.split('#');
    if (!temCargo(interaction, 'Desembargador') && !isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Desembargadores podem decidir um pedido de reconsideração de indeferimento judicial.', ephemeral: true });
    }
    const guild = await resolverGuild(interaction);
    if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (medida.reconsideracaoJuiz !== 'Pendente') return interaction.reply({ content: 'Esse pedido de reconsideração já foi decidido.', ephemeral: true });

    const canalMedida = await guild.channels.fetch(medida.canalId).catch(() => null);
    const canalRecon = medida.reconsideracaoJuizCanalId ? await guild.channels.fetch(medida.reconsideracaoJuizCanalId).catch(() => null) : null;

    if (decisao === 'aprovar') {
      // Exclui o Juiz que já indeferiu e o alvo identificado — reconsideração vai pra um
      // julgador diferente, e nunca pro próprio alvo do pedido.
      const novoJuizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor, medida.juiz, medida.alvoDiscordId].filter(Boolean) });
      if (!novoJuizId) return interaction.reply({ content: 'Não há outro Juiz ativo disponível para sorteio.', ephemeral: true });

      db.atualizar('medidas', numero, {
        status: 'Aprovada - aguardando juiz', juiz: novoJuizId, reconsideracaoJuiz: 'Aprovada',
        aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false,
      });
      if (canalMedida) {
        await canais.adicionarMembro(canalMedida, novoJuizId);
        await canalMedida.send({
          content: `Reconsideração aprovada pelo Desembargador <@${interaction.user.id}> — o indeferimento foi revertido. <@${novoJuizId}> foi sorteado para novo julgamento.`,
          embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
          components: [botoesJuizMedida(numero)],
        });
      }
      if (canalRecon) {
        await canalRecon.send({ content: `✅ Reconsideração **aprovada**. Medida encaminhada a <@${novoJuizId}> no canal ${canalMedida || medida.canalId}.` });
        await canais.arquivarCanal(canalRecon);
      }
      await auditoria.registrar(guild, { acao: 'Reconsideração de indeferimento judicial aprovada', executorId: interaction.user.id, referencia: `${numero} → Juiz <@${novoJuizId}>` });
      return interaction.reply({ content: `Reconsideração aprovada. Medida ${numero} encaminhada a <@${novoJuizId}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { reconsideracaoJuiz: 'Mantida' });
    if (canalMedida) {
      await canalMedida.send({ content: `O Desembargador <@${interaction.user.id}> analisou o pedido de reconsideração e **manteve o indeferimento** do Juiz.` });
    }
    if (canalRecon) {
      await canalRecon.send({ content: `❌ Indeferimento **mantido** pelo Desembargador <@${interaction.user.id}>.` });
      await canais.arquivarCanal(canalRecon);
    }
    await auditoria.registrar(guild, { acao: 'Reconsideração de indeferimento judicial mantida', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Indeferimento da medida ${numero} mantido.`, ephemeral: true });
  },

  // Referendar (deferir) e negar provimento agora exigem a fundamentação do Juiz por escrito —
  // sem isso o mandado saía só com um embed genérico, sem nenhum texto jurídico de verdade.
  async referendar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:referendar:${numero}`).setTitle('Referendar — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do Juízo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  // fundamentacaoOverride vem do fluxo revisão-in-flow (texto já escolhido pelo Juiz, revisado
   // ou não). Só lê do modal quando chamado direto na submissão (compatibilidade).
  async processarReferendo(interaction, numero, fundamentacaoOverride) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = fundamentacaoOverride !== undefined ? fundamentacaoOverride : interaction.fields.getTextInputValue('fundamentacao');
    // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
    // Chromium sobe e a interação "falha" mesmo com o mandado sendo emitido com sucesso. Guard
    // idempotente: no modo "revisão automática" o executarDecisaoMedida já deu deferReply.
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    db.atualizar('medidas', numero, { status: 'Deferida', fundamentacaoJuiz, decisaoJuizEm: new Date().toISOString() });

    const numeroMandado = proximoNumero(db, 'mandados', 'MO');
    db.inserir('mandados', {
      numero: numeroMandado, medidaNumero: numero, tipo: medida.tipo, alvo: medida.alvo,
      status: 'Emitido', emitidoPor: medida.juiz, cumpridoPor: null,
    });
    // Dossiê do inquérito: registra o mandado sob o mesmo protocolo da medida que o originou,
    // independente de qual Juiz foi sorteado — é isso que deixa o dossiê completo quando a
    // denúncia nascer daqui (ver criarProcessoPenal).
    if (medida.codigoExterno) dossie.registrarMandado(medida.codigoExterno, numeroMandado);

    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});
    const medidaAtualizada = db.buscarPorNumero('medidas', numero);

    const nomeJuiz = await documentoPng.nomeExibicao(interaction.guild, medida.juiz);
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
      nomeAssinante: nomeJuiz,
      cargoAssinante: 'Juiz de Direito',
    }).catch(err => { console.error('Falha ao gerar PNG do mandado:', err.message); return null; });

    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) {
      await canal.send({
        content: `<@${medida.delegado}>\n\n${documentos.textoMandado({
          numero: numeroMandado, medida: medidaAtualizada,
          fundamentacaoPromotor: medida.fundamentacaoPromotor, fundamentacaoJuiz,
          codigoExterno: medida.codigoExterno,
        })}`,
        components: [botaoCumprir(numeroMandado)],
        ...(pngMandado ? { files: [{ attachment: pngMandado, name: `Mandado-${numeroMandado}.png` }] } : {}),
      });
      await canal.send({ content: `<@${medida.promotor}> quando quiser, pode transformar esta medida em processo penal formal, herdando os dados automaticamente.`, components: [botaoAbrirProcesso(numero)] });
    }
    // Só vira andamento se já existe processo pra pendurar o evento — nem toda medida referendada
    // tem um (pode ainda estar solta, virando processo só depois via botaoAbrirProcesso). Sem
    // processo vinculado, mantém o auditoria.registrar solto de antes como única saída.
    if (medida.processoVinculado) {
      await andamentos.registrar(interaction.guild, medida.processoVinculado, {
        tipo: 'mandado_emitido', titulo: `📜 Mandado de ${medida.tipo} emitido`,
        detalhe: `Mandado ${numeroMandado} — alvo: ${medida.alvo}\nFundamentação do Juízo: ${fundamentacaoJuiz}`,
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
    return interaction.editReply({ content: `Medida ${numero} referendada. Mandado ${numeroMandado} emitido.` });
  },

  async abrirModalNegarJuiz(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:negarjuiz:${numero}`).setTitle('Negar provimento — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do Juízo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  async negarJuiz(interaction, numero, fundamentacaoOverride) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = fundamentacaoOverride !== undefined ? fundamentacaoOverride : interaction.fields.getTextInputValue('fundamentacao');
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    db.atualizar('medidas', numero, { status: 'Indeferida pelo Juiz', fundamentacaoJuiz, decisaoJuizEm: new Date().toISOString() });

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
    if (interaction.user.id !== medida.juiz && !isSuperStaff(interaction)) {
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
    if (responsavelCumprimento && interaction.user.id !== responsavelCumprimento && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Delegado responsável por este mandado pode cumpri-lo — no caso, <@${responsavelCumprimento}>.`, ephemeral: true });
    }

    // aguardarAnexoPDF já consome a resposta inicial da interação (reply pedindo o PDF) — não
    // dá pra também chamar interaction.update() na mesma interação depois; o botão se apaga
    // editando a mensagem original diretamente.
    const anexo = await aguardarAnexoPDF(interaction);
    if (!anexo) return; // aguardarAnexoPDF já avisou o motivo (tempo esgotado ou não é PDF)

    const documentoCumprimento = anexos.criarDocumento({
      tipo: 'cumprimento_mandado', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
      atoOrigemId: numero, protocoloVinculado: medida?.codigoExterno || mandado.medidaNumero || mandado.processoVinculado,
    });
    if (medida?.codigoExterno) dossie.registrarDocumento(medida.codigoExterno, documentoCumprimento.id);

    db.atualizar('mandados', numero, { status: 'Cumprido', cumpridoPor: interaction.user.id });
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
        detalhe: `Mandado ${numero} cumprido por <@${interaction.user.id}> — [${anexo.nomeArquivo}](${anexo.url}) juntado aos autos.`,
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
    if (interaction.user.id !== medida.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode abrir o processo — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    if (medida.processoVinculado) {
      return interaction.reply({ content: `Essa medida já gerou o processo ${medida.processoVinculado}.`, ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(`medida:processomodal:${numero}`).setTitle(`Abrir processo — ${numero}`.slice(0, 45));

    const campoMotivo = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/fatos (edite se quiser)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(medida.motivo.slice(0, 4000));
    // Pré-preenche com o alvo já identificado na medida — sem isso, o Promotor precisava saber
    // de cor o ID do alvo pra digitar @menção, já que o alvo nunca entrou no canal da medida
    // (é investigativa) e não aparece na lista de membros pra selecionar.
    const campoReus = new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus, se já identificados')
      .setStyle(TextInputStyle.Short).setRequired(false);
    if (medida.alvoDiscordId) campoReus.setValue(`<@${medida.alvoDiscordId}>`);

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
      .slice(0, 25)
      .map(m => ({ name: `${m.numero} — ${m.tipo} — ${m.status}`.slice(0, 100), value: m.numero }));
    await interaction.respond(resultados);
  },
};
