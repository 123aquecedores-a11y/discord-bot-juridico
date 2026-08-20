const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const { truncar } = require('../utils/texto');
const atosPorCargo = require('../utils/atosPorCargo');
const { proximoNumero } = require('../utils/numeracao');
const { isSuperStaff, isAdmin , podeAtuarNoCaso, recusaDoCaso } = require('../utils/permissoes');
const documentos = require('../utils/documentos');
const documentoPng = require('../services/gerarDocumentoPNG');
const diario = require('../utils/diarioOficial');
const anexos = require('../utils/anexos');
const { selectTipoMedidaCoercitiva, rotuloTipo, modalTipoDestinatario, indicesDeValores, valoresDeIndices } = require('../utils/tiposMedidaCoercitiva');
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
  if (!podeAtuarNoCaso(interaction, processo, 'juiz')) {
    return interaction.reply({ content: `Só um(a) Juiz(a) pode emitir mandado. Responsável registrado: <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.tipo !== 'Penal') {
    return interaction.reply({ content: 'Mandado só se aplica a processo penal.', ephemeral: true });
  }
  return interaction.reply({
    content: 'Quais tipos de mandado? Pode marcar **mais de um** — sai um mandado para cada, com a mesma fundamentação e o mesmo destinatário.',
    components: [selectTipoMedidaCoercitiva(`painel:select:mandado:tipo:${numero}`, { multi: true })],
    ephemeral: true,
  });
}

// Tipo -> destinatário -> teor (spec-atualizacoes-bot-juridico.md, seção 3). "Outro" tipo e
// "pessoa fora do processo" só entram no MESMO modal final quando aplicável — Discord não
// encadeia modal depois de modal (só depois de botão/select), então o teor sempre fecha o fluxo.

async function processarSelecaoTipo(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  // Índices, não valores — ver a nota sobre o teto do customId em utils/tiposMedidaCoercitiva.js.
  const indices = indicesDeValores(interaction.values || []);
  return interaction.reply({
    content: 'Quem é o destinatário?',
    components: [partesProcesso.selectDestinatario(`painel:select:mandado:destinatario:${numero}#${indices}`, processo)],
    ephemeral: true,
  });
}

// chave carrega numero#indicesDeTipos#destinatarioRef (destinatarioRef é o id da parte, ex: "p2",
// ou o literal "fora") — assim o handler final sabe exatamente quais campos ler do modal sem
// precisar adivinhar, e nunca chama getTextInputValue num campo que não foi criado.
function modalTeorMandado(chave, tipoValues, destinatarioRef) {
  const titulo = tipoValues.length > 1 ? `Mandados (${tipoValues.length})` : `Mandado — ${rotuloTipo(tipoValues[0])}`;
  return modalTipoDestinatario({
    customId: `painel:modal:mandado:emitir:${chave}`, titulo,
    tipoValue: tipoValues, destinatarioRef, campoTeor: 'teor', labelTeor: 'Motivo / fundamentação',
  });
}

async function processarSelecaoDestinatario(interaction, chaveTipo) {
  const [numero, indices] = chaveTipo.split('#');
  const destinatarioRef = interaction.values[0];
  return interaction.showModal(modalTeorMandado(`${numero}#${indices}#${destinatarioRef}`, valoresDeIndices(indices), destinatarioRef));
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
  const [numero, indices, destinatarioRef] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeAtuarNoCaso(interaction, processo, 'juiz')) {
    return interaction.reply({ content: `Só um(a) Juiz(a) pode emitir mandado. Responsável registrado: <@${processo.juiz}>.`, ephemeral: true });
  }

  const tipoValues = valoresDeIndices(indices);
  if (!tipoValues.length) return interaction.reply({ content: 'Nenhum tipo de mandado foi selecionado — refaça a ação.', ephemeral: true });
  // "Outro" pode vir junto com tipos da lista; o nome livre vale só para ele.
  const tipoLivre = tipoValues.includes('outro') ? interaction.fields.getTextInputValue('tipoLivre') : null;
  const teor = interaction.fields.getTextInputValue('teor');
  const destinatario = resolverDestinatario(interaction, numero, processo, destinatarioRef);

  // SEM TRAVA DE DUPLICIDADE (decisão do operador, 19/08/2026).
  //
  // Havia aqui uma guarda contra "mesmo tipo + mesmo alvo com mandado ainda em aberto", que eu
  // tinha inferido como proteção contra duplo clique. O operador determinou que emitir VÁRIOS
  // mandados no mesmo processo é legítimo e não depende de o anterior estar cumprido — o Juiz
  // pode expedir busca, prisão e condução do mesmo alvo, e reexpedir quando a diligência falha.
  //
  // A guarda de colisão dos atos DECISÓRIOS continua onde faz sentido (sentença, referendo,
  // deferimento): lá o segundo clique desfaz o primeiro. Aqui ele só acrescenta um mandado.
  // FUNDAMENTAÇÃO EM TRECHOS (19/08/2026). O que o Juiz escreveu no modal vira o PRIMEIRO trecho;
  // daí em diante ele usa o MESMO painel do MP ("adicionar mais texto"). O teto de 4.000 caracteres
  // é do campo do Discord, não do mandado.
  //
  // O estado da emissão (tipos e destinatário) fica guardado até o "Enviar" — sem isso o finalizador
  // não saberia quais mandados expedir, já que ele nasce de um clique em outro componente.
  const emissaoPeca = require('../utils/emissaoPeca');
  pendentesDeFundamentacao.set(`${interaction.user.id}:${numero}`, { tipoValues, tipoLivre, destinatario });
  emissaoPeca.semearRascunho(interaction.user.id, 'fundamentacao_mandado', numero, teor);
  return interaction.reply({
    ...emissaoPeca.painelDeRascunho(interaction.user.id, 'fundamentacao_mandado', numero),
    ephemeral: true,
  });
}

// Estado da emissão entre o modal e o "Enviar" do painel de trechos. Em memória, como todo rascunho
// deste projeto: se o bot reinicia, o Juiz refaz — nada foi gravado nos autos ainda.
const pendentesDeFundamentacao = new Map();

// FINALIZADOR do rascunho do mandado: junta os trechos e expede.
async function emitirMandadosComFundamentacao(interaction, tipoChave, numero) {
  const emissaoPeca = require('../utils/emissaoPeca');
  const pendente = pendentesDeFundamentacao.get(`${interaction.user.id}:${numero}`);
  if (!pendente) {
    return interaction.reply({ content: 'A emissão expirou — refaça pelo botão "Emitir mandado".', ephemeral: true }).catch(() => {});
  }
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true }).catch(() => {});
  if (!podeAtuarNoCaso(interaction, processo, 'juiz')) {
    return interaction.reply({ content: `Só um(a) Juiz(a) pode emitir mandado. Responsável registrado: <@${processo.juiz}>.`, ephemeral: true }).catch(() => {});
  }

  const teor = emissaoPeca.textoDoRascunho(emissaoPeca.lerRascunho(interaction.user.id, tipoChave, numero));
  if (!teor.trim()) {
    return interaction.reply({ content: 'Não há texto na fundamentação — refaça pelo botão "Emitir mandado".', ephemeral: true }).catch(() => {});
  }
  const { tipoValues, tipoLivre, destinatario } = pendente;
  pendentesDeFundamentacao.delete(`${interaction.user.id}:${numero}`);
  emissaoPeca.limparRascunho(interaction.user.id, tipoChave, numero);

  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com o mandado sendo emitido com sucesso. Com vários
  // tipos são vários PNGs, então a margem importa ainda mais.
  await interaction.deferReply({ ephemeral: true });

  // UM MANDADO POR TIPO MARCADO. Cada um é um documento próprio, com número próprio — é assim que
  // funciona no papel: busca e prisão são mandados distintos, cumpridos e baixados separadamente.
  // O que eles compartilham é a fundamentação e o destinatário, que o Juiz escreveu uma vez só.
  //
  // Sequencial de propósito: `proximoNumero` lê e grava o contador, e em paralelo dois mandados
  // sairiam com o mesmo número.
  const emitidos = [];
  const falhas = [];
  for (const tipoValue of tipoValues) {
    const tipoRotulo = rotuloTipo(tipoValue, tipoLivre);
    try {
      const r = await emitirMandadoNoProcesso({
        guild: interaction.guild, processo: db.buscarPorNumero('processos', numero), tipoRotulo,
        teor, emitidoPorId: interaction.user.id, destinatario,
      });
      emitidos.push(`**${r.numero}** — ${tipoRotulo}`);
    } catch (err) {
      // Um tipo que falha não pode levar os outros junto: cada mandado é um ato autônomo.
      console.error(`Falha ao emitir mandado (${tipoRotulo}) no processo ${numero}:`, err.message);
      falhas.push(`${tipoRotulo} (${err.message})`);
    }
  }

  if (!emitidos.length) {
    return interaction.editReply({ content: `❌ Nenhum mandado pôde ser emitido: ${falhas.join('; ')}` });
  }
  return interaction.editReply({
    content: `${emitidos.length > 1 ? `${emitidos.length} mandados emitidos` : 'Mandado emitido'} e juntado(s) ao processo ${numero}:\n${emitidos.join('\n')}`
      + (falhas.length ? `\n\n⚠️ Não saiu: ${falhas.join('; ')}` : ''),
  });
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

  // Assinatura = quem gerou o documento (quem clicou/emitiu), não o titular fixo do processo.
  const nomeAssinante = await documentoPng.nomeExibicao(guild, emitidoPorId);
  const pngMandado = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'mandado_generico', orgaoEmissor: 'judiciario',
    subunidade: 'Comarca de São Paulo — Vara Criminal',
    tituloDocumento: `MANDADO DE ${tipoRotulo.toUpperCase()}`,
    numeroProcesso: numeroMandado, dataEmissao: documentos.dataExtenso(),
    destinatario: alvoTexto, corpoTexto: teor, nomeAssinante, cargoAssinante: 'Juiz de Direito',
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
    detalhe: require('../utils/pecas').detalheDeAndamento(processo.numero,
      `Mandado ${numeroMandado} — alvo: ${alvoTexto}\nFundamentação: ${teor}`,
      `Mandado ${numeroMandado} — alvo: ${alvoTexto}. A fundamentação fica restrita até a entrega pessoal.`),
    executorId: emitidoPorId, anexoUrl, metadata: { mandadoNumero: numeroMandado, tipoMandado: tipoRotulo, alvoDiscordId: destinatario?.discordId || null },
  });
  // Lazy require pra evitar ciclo (processo.js já requer mandado.js no outro sentido) — só
  // resolve de verdade quando essa função roda, bem depois do boot inicial já ter terminado.
  await require('./processo').repostarPainel(guild, processo.numero);

  // NÍVEL 2 — NÃO publica no Diário na emissão: publicar antes do cumprimento avisaria o alvo e
  // queimaria a diligência. A publicação sai SÓ no cumprimento (cumprirMandado → mandadoCumprido),
  // e mesmo lá só para os tipos da allow-list (prisão preventiva/temporária) — ver a política de
  // sigilo em utils/diarioAtos.js. Mandado não cumprido não publica nunca, em gatilho nenhum.

  return { numero: numeroMandado };
}

// Mandados nascem de duas formas: automaticamente quando um Juiz referenda uma medida
// cautelar (commands/medida.js -> referendar), ou emitidos direto pelo Juiz de dentro de um
// processo penal já aberto (acima). Consulta e listagem seguem valendo pros dois casos.
// Registrado no load: o "Enviar" do painel de trechos expede os mandados.
require('../utils/emissaoPeca').registrarFinalizador('fundamentacao_mandado', emitirMandadosComFundamentacao);

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
      .filter(m => temAcessoMandado(interaction, m)) // não sugere mandados sigilosos a quem não tem acesso
      .slice(0, 25)
      .map(m => ({ name: `${m.numero} — ${m.tipo} — ${m.status}`.slice(0, 100), value: m.numero }));
    await interaction.respond(resultados);
  },
};
