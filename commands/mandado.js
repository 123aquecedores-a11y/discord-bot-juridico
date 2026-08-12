const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const { truncar } = require('../utils/texto');
const { proximoNumero } = require('../utils/numeracao');
const { isSuperStaff, isAdmin } = require('../utils/permissoes');
const documentos = require('../utils/documentos');
const documentoPng = require('../services/gerarDocumentoPNG');
const anexos = require('../utils/anexos');
const { selectTipoMedidaCoercitiva, rotuloTipo } = require('../utils/tiposMedidaCoercitiva');
const partesProcesso = require('../utils/partesProcesso');
const andamentos = require('../utils/andamentos');

// Mesmo customId que commands/medida.js usa pro botão "Cumprir mandado" de sempre (roteado no
// mapa "bare" do index.js, não no painel:) — reconstruído aqui em vez de importado de medida.js
// pra não criar dependência circular (medida.js precisa importar mandado.js pra Fase 4/seção
// 3.2, "Solicitar medida" deferindo -> emitir mandado).
function botaoCumprir(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:cumprir:${numero}`).setLabel('Cumprir mandado').setStyle(ButtonStyle.Success),
  );
}

function embedMandado(mandado) {
  return new EmbedBuilder()
    .setTitle(`📜 Mandado ${mandado.numero}`)
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Tipo', value: mandado.tipo, inline: true },
      { name: 'Status', value: mandado.status, inline: true },
      { name: 'Alvo', value: truncar(mandado.alvo) },
      ...(mandado.medidaNumero ? [{ name: 'Medida vinculada', value: mandado.medidaNumero, inline: true }] : []),
      ...(mandado.processoVinculado ? [{ name: 'Processo vinculado', value: mandado.processoVinculado, inline: true }] : []),
      { name: 'Emitido por (Juiz)', value: `<@${mandado.emitidoPor}>`, inline: true },
      { name: 'Cumprido por', value: mandado.cumpridoPor ? `<@${mandado.cumpridoPor}>` : '—', inline: true },
    );
}

// Frente 4a.5 — embed da listagem de mandados, fonte única (era duplicado no /painel e no /mandado listar).
function embedListaMandados(rows) {
  return new EmbedBuilder().setTitle('📜 Mandados').setColor(0x2ecc71)
    .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
}

// Frente 2.2 — sigilo: só quem emitiu, as partes da medida/processo vinculado e a Staff veem o
// teor do mandado. Sem isso o `embedMandado` (tipo + alvo) vazava pra qualquer um com o número.
function temAcessoMandado(interaction, mandado) {
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
  const uid = interaction.user.id;
  if (uid === mandado.emitidoPor) return true;
  if (mandado.medidaNumero) {
    const m = db.buscarPorNumero('medidas', mandado.medidaNumero);
    if (m && [m.delegado, m.promotor, m.juiz].filter(Boolean).includes(uid)) return true;
  }
  if (mandado.processoVinculado) {
    const p = db.buscarPorNumero('processos', mandado.processoVinculado);
    if (p) {
      if ([p.delegado, p.promotor, p.juiz, p.autor].filter(Boolean).includes(uid)) return true;
      if ((p.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === uid)) return true;
    }
  }
  return false;
}

// ---- Emissão direta pelo Juiz, de dentro do processo (painel-contexto-e-tipo-mandado.md, 3.1) ----
// Diferente do mandado nascido de medida cautelar (Delegado → MP → Juiz referenda): aqui o
// Juiz já tem autoridade e o processo já existe, então emite sem etapa de aprovação nenhuma.

function botaoEmitirMandado(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:mandado:emitir:${numero}`).setLabel('⚖️ Emitir mandado').setStyle(ButtonStyle.Primary);
}

async function abrirSelectTipo(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode emitir mandado — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.tipo !== 'Penal') {
    return interaction.reply({ content: 'Mandado só se aplica a processo penal.', ephemeral: true });
  }
  return interaction.reply({
    content: 'Qual o tipo de mandado?',
    components: [selectTipoMedidaCoercitiva(`painel:select:mandado:tipo:${numero}`)],
    ephemeral: true,
  });
}

// Tipo -> destinatário -> teor (spec-atualizacoes-bot-juridico.md, seção 3). "Outro" tipo e
// "pessoa fora do processo" só entram no MESMO modal final quando aplicável — Discord não
// encadeia modal depois de modal (só depois de botão/select), então o teor sempre fecha o fluxo.

async function processarSelecaoTipo(interaction, numero) {
  const valor = interaction.values[0];
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  return interaction.reply({
    content: 'Quem é o destinatário do mandado?',
    components: [partesProcesso.selectDestinatario(`painel:select:mandado:destinatario:${numero}#${valor}`, processo)],
    ephemeral: true,
  });
}

// chave carrega numero#tipoValue#destinatarioRef (destinatarioRef é o id da parte, ex: "p2",
// ou o literal "fora") — assim o handler final sabe exatamente quais campos ler do modal sem
// precisar adivinhar, e nunca chama getTextInputValue num campo que não foi criado.
function modalTeorMandado(chave, tipoValue, destinatarioRef) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:mandado:emitir:${chave}`).setTitle(`Mandado — ${rotuloTipo(tipoValue)}`.slice(0, 45));
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
  linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('teor').setLabel('Motivo / fundamentação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
  modal.addComponents(...linhas);
  return modal;
}

async function processarSelecaoDestinatario(interaction, chaveTipo) {
  const [numero, tipoValue] = chaveTipo.split('#');
  const destinatarioRef = interaction.values[0];
  return interaction.showModal(modalTeorMandado(`${numero}#${tipoValue}#${destinatarioRef}`, tipoValue, destinatarioRef));
}

// Resolve nome/discordId do destinatário — se "fora do processo", cria a parte na hora (papel
// terceiro, origem manual_mandado) pra já ficar disponível em mandados/intimações futuras.
function resolverDestinatario(interaction, numero, processo, destinatarioRef) {
  if (destinatarioRef === 'fora') {
    const nomeCompleto = interaction.fields.getTextInputValue('nomeCompleto');
    const idTexto = interaction.fields.getTextInputValue('idTexto');
    const { discordId, rg } = partesProcesso.classificarIdLivre(idTexto);
    partesProcesso.adicionarParte(numero, { papel: 'terceiro', nome: nomeCompleto, discordId, rg, origem: 'manual_mandado', adicionadoPor: interaction.user.id });
    return { nome: nomeCompleto, discordId };
  }
  const parte = (processo.partes || []).find(p => p.id === destinatarioRef);
  return parte ? { nome: parte.nome, discordId: parte.discordId } : { nome: 'destinatário não identificado', discordId: null };
}

async function emitirMandado(interaction, chave) {
  const [numero, tipoValue, destinatarioRef] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode emitir mandado — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }

  const tipoLivre = tipoValue === 'outro' ? interaction.fields.getTextInputValue('tipoLivre') : null;
  const teor = interaction.fields.getTextInputValue('teor');
  const destinatario = resolverDestinatario(interaction, numero, processo, destinatarioRef);

  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com o mandado sendo emitido com sucesso.
  await interaction.deferReply({ ephemeral: true });
  const resultado = await emitirMandadoNoProcesso({
    guild: interaction.guild, processo: db.buscarPorNumero('processos', numero), tipoRotulo: rotuloTipo(tipoValue, tipoLivre),
    teor, emitidoPorId: interaction.user.id, destinatario,
  });
  return interaction.editReply({ content: `Mandado ${resultado.numero} emitido e juntado ao processo ${numero}.` });
}

// Reaproveitada por commands/medida.js quando o Promotor solicita medida e o Juiz defere
// (painel-contexto-e-tipo-mandado.md, seção 3.2) — mesmo resultado final nos dois caminhos.
// tipoRotulo já vem resolvido (rotuloTipo já aplicado por quem chama) — quem solicitou a
// medida já escolheu/descreveu o tipo antes, não faz sentido resolver de novo aqui.
async function emitirMandadoNoProcesso({ guild, processo, tipoRotulo, teor, emitidoPorId, destinatario }) {
  const numeroMandado = proximoNumero(db, 'mandados', 'MO');
  const alvoTexto = destinatario?.discordId ? `<@${destinatario.discordId}>` : (destinatario?.nome || 'destinatário não identificado');

  db.inserir('mandados', {
    numero: numeroMandado, medidaNumero: null, processoVinculado: processo.numero,
    tipo: tipoRotulo, alvo: alvoTexto, status: 'Emitido', emitidoPor: emitidoPorId, cumpridoPor: null,
  });

  const nomeJuiz = await documentoPng.nomeExibicao(guild, processo.juiz);
  const pngMandado = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'mandado_generico', orgaoEmissor: 'judiciario',
    subunidade: 'Comarca de São Paulo — Vara Criminal',
    tituloDocumento: `MANDADO DE ${tipoRotulo.toUpperCase()}`,
    numeroProcesso: numeroMandado, dataEmissao: documentos.dataExtenso(),
    destinatario: alvoTexto, corpoTexto: teor, nomeAssinante: nomeJuiz, cargoAssinante: 'Juiz de Direito',
  }).catch(err => { console.error('Falha ao gerar PNG do mandado:', err.message); return null; });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  let msgEnviada = null;
  if (canal) {
    msgEnviada = await canal.send({
      content: documentos.textoMandadoDireto({ numero: numeroMandado, processoNumero: processo.numero, tipoRotulo, alvo: alvoTexto, teor, juizId: processo.juiz }),
      components: [botaoCumprir(numeroMandado)],
      ...(pngMandado ? { files: [{ attachment: pngMandado, name: `Mandado-${numeroMandado}.png` }] } : {}),
    });
  }

  // Registra também como `documento` vinculado ao processo (autos) — mesma mecânica de
  // mecanicas-anexo-e-vinculo-processual.md (seção 4 desta spec pede exatamente isso).
  const anexoUrl = msgEnviada?.attachments?.first()?.url;
  if (anexoUrl) {
    anexos.criarDocumento({
      tipo: 'mandado', url: anexoUrl, nomeArquivo: `Mandado-${numeroMandado}.png`,
      autorId: emitidoPorId, atoOrigemId: numeroMandado, protocoloVinculado: processo.numero,
    });
  }

  await andamentos.registrar(guild, processo.numero, {
    tipo: 'mandado_emitido', titulo: `📜 Mandado de ${tipoRotulo} emitido`,
    detalhe: `Mandado ${numeroMandado} — alvo: ${alvoTexto}\nFundamentação: ${teor}`,
    executorId: emitidoPorId, anexoUrl, metadata: { mandadoNumero: numeroMandado, tipoMandado: tipoRotulo, alvoDiscordId: destinatario?.discordId || null },
  });
  // Lazy require pra evitar ciclo (processo.js já requer mandado.js no outro sentido) — só
  // resolve de verdade quando essa função roda, bem depois do boot inicial já ter terminado.
  await require('./processo').repostarPainel(guild, processo.numero);

  return { numero: numeroMandado };
}

// Mandados nascem de duas formas: automaticamente quando um Juiz referenda uma medida
// cautelar (commands/medida.js -> referendar), ou emitidos direto pelo Juiz de dentro de um
// processo penal já aberto (acima). Consulta e listagem seguem valendo pros dois casos.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('mandado')
    .setDescription('Consulta mandados (emitidos automaticamente ao referendar uma medida)')
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de um mandado')
      .addStringOption(o => o.setName('numero').setDescription('Número do mandado').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista mandados')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status').addChoices(
        { name: 'Emitido', value: 'Emitido' },
        { name: 'Cumprido', value: 'Cumprido' },
      ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'ver') {
      const numero = interaction.options.getString('numero');
      const mandado = db.buscarPorNumero('mandados', numero);
      if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
      if (!temAcessoMandado(interaction, mandado)) return interaction.reply({ content: 'Você não tem acesso ao teor deste mandado — só quem o emitiu, as partes do caso vinculado e a Staff podem consultá-lo.', ephemeral: true });
      return interaction.reply({ embeds: [embedMandado(mandado)], ephemeral: true });
    }

    if (sub === 'listar') {
      const status = interaction.options.getString('status');
      const rows = db.todos('mandados', status ? m => m.status === status : null).slice(0, 15);
      if (rows.length === 0) return interaction.reply({ content: 'Nenhum mandado encontrado.', ephemeral: true });
      return interaction.reply({ embeds: [embedListaMandados(rows)], ephemeral: true });
    }
  },

  embedMandado, temAcessoMandado, embedListaMandados,
  botaoEmitirMandado,
  abrirSelectTipo,
  processarSelecaoTipo,
  processarSelecaoDestinatario,
  emitirMandado,
  emitirMandadoNoProcesso,

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = db.todos('mandados', m => m.numero.toLowerCase().includes(foco))
      .slice(0, 25)
      .map(m => ({ name: `${m.numero} — ${m.tipo} — ${m.status}`.slice(0, 100), value: m.numero }));
    await interaction.respond(resultados);
  },
};
