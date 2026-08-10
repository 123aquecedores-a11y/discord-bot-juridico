const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const { proximoNumeroClassico } = require('../utils/numeracao');
const { temCargo, isAdmin, isSuperStaff } = require('../utils/permissoes');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const canais = require('../utils/canais');
const documentoPng = require('../services/gerarDocumentoPNG');
const devolutivaPoliciaCivil = require('../utils/devolutivaPoliciaCivil');
const { aguardarAnexoPDF } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');
const andamentos = require('../utils/andamentos');
const processoCmd = require('./processo');

const CATEGORIA_OFICIOS_CHAVE = 'categoriaOficiosId';
const CATEGORIA_OFICIOS_NOME = '✉️ Ofícios';

const ORGAO_POR_INSTITUICAO = {
  'PODER JUDICIÁRIO': 'judiciario', 'MINISTÉRIO PÚBLICO': 'ministerio_publico', 'POLÍCIA CIVIL': 'policia_civil',
};
const SUBUNIDADE_POR_INSTITUICAO = {
  'PODER JUDICIÁRIO': 'Comarca de São Paulo — Vara Criminal',
  'MINISTÉRIO PÚBLICO': '1ª Promotoria de Justiça Criminal',
  'POLÍCIA CIVIL': 'Delegacia Geral de Polícia Civil',
};
const CARGO_POR_INSTITUICAO = {
  'PODER JUDICIÁRIO': 'Juiz de Direito', 'MINISTÉRIO PÚBLICO': 'Membro do Ministério Público', 'POLÍCIA CIVIL': 'Delegado de Polícia',
};

// Ofício pode sair de três instituições diferentes — o cabeçalho do documento segue quem
// realmente assina, mesma lógica já usada em certidão (certidoes.js).
function instituicaoDoEmissor(interaction) {
  if (temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador')) return 'MINISTÉRIO PÚBLICO';
  if (temCargo(interaction, 'Delegado')) return 'POLÍCIA CIVIL';
  return 'PODER JUDICIÁRIO';
}

function podeEmitirOficio(interaction) {
  return temCargo(interaction, 'Delegado') || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador')
    || temCargo(interaction, 'Juiz') || isAdmin(interaction);
}

function botaoArquivarOficio(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:oficio:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary);
}

function botaoCumprirOficio(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:oficio:cumprir:${numero}`).setLabel('✅ Cumprir').setStyle(ButtonStyle.Success);
}

// Diferente de ofício/mandado num sentido clássico de peça judicial: aqui `destinatario` é
// texto livre (uma instituição externa sem conta no Discord — "Instituto de Criminalística",
// "Secretaria de Saúde"), então não tem @menção pra checar quem é "o destinatário" de verdade.
// Quem registra o cumprimento é quem expediu o ofício (é quem recebe a resposta da instituição
// e junta aos autos) — ou Staff Salve.
function podeRegistrarCumprimento(interaction, oficio) {
  return interaction.user.id === oficio.emitidoPor || isSuperStaff(interaction);
}

async function cumprirOficio(interaction, numero) {
  const oficio = db.buscarPorNumero('oficios', numero);
  if (!oficio) return interaction.reply({ content: 'Ofício não encontrado.', ephemeral: true });
  if (!podeRegistrarCumprimento(interaction, oficio)) {
    return interaction.reply({ content: `Só quem expediu este ofício pode registrar o cumprimento — no caso, <@${oficio.emitidoPor}>.`, ephemeral: true });
  }
  if (oficio.status === 'Cumprido') {
    return interaction.reply({ content: 'Este ofício já foi marcado como cumprido.', ephemeral: true });
  }

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  anexos.criarDocumento({
    tipo: 'cumprimento_oficio', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: oficio.processoNumero || numero,
  });

  db.atualizar('oficios', numero, { status: 'Cumprido', cumpridoPor: interaction.user.id, cumpridoEm: new Date().toISOString() });
  await interaction.followUp({ content: `📎 Ofício ${numero} cumprido por <@${interaction.user.id}> — PDF juntado aos autos.` });

  // O ticket do ofício já sabe que foi cumprido, mas quem acompanha o processo (Juiz, defesa
  // habilitada) só ficava sabendo se fosse conferir o canal do ofício à parte — sem isso, o
  // cumprimento não "chegava" nos autos de quem realmente usa o processo no dia a dia.
  if (oficio.processoNumero) {
    const processo = db.buscarPorNumero('processos', oficio.processoNumero);
    const canalProcesso = processo?.canalId ? await interaction.guild.channels.fetch(processo.canalId).catch(() => null) : null;
    if (canalProcesso) {
      const embedCumprimento = new EmbedBuilder()
        .setTitle(`📎 Ofício ${numero} cumprido`)
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Destinatário', value: truncar(oficio.destinatario), inline: true },
          { name: 'Cumprido por', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Documento', value: `[${anexo.nomeArquivo}](${anexo.url})` },
        );
      await canalProcesso.send({ embeds: [embedCumprimento] });
    }
    await andamentos.registrar(interaction.guild, oficio.processoNumero, {
      tipo: 'oficio_respondido', titulo: '📥 Resposta de ofício anexada aos autos',
      detalhe: `Resposta ao ofício ${numero} juntada como prova por <@${interaction.user.id}>.`,
      executorId: interaction.user.id, anexoUrl: anexo.url, metadata: { oficioNumero: numero },
    });
    await processoCmd.repostarPainel(interaction.guild, oficio.processoNumero);
  } else {
    await auditoria.registrar(interaction.guild, { acao: 'Ofício cumprido', executorId: interaction.user.id, referencia: numero });
  }
}

async function criarOficio({ guild, processoNumero, destinatario, assunto, conteudo, emitidoPorId, emitidoPorTag, instituicao, aguardaRetorno = true }) {
  const processo = db.buscarPorNumero('processos', processoNumero);
  if (!processo) return { erro: 'Processo não encontrado.' };

  const numero = proximoNumeroClassico(db, 'oficios', 'OFI');
  const texto = documentos.textoOficio({
    numero, processoNumero, destinatario, assunto, conteudo,
    autorId: emitidoPorId, instituicao: instituicao || 'PODER JUDICIÁRIO',
  });

  const nomeEmissor = await documentoPng.nomeExibicao(guild, emitidoPorId);
  const orgaoEmissor = ORGAO_POR_INSTITUICAO[instituicao] || 'judiciario';
  const pngOficio = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'oficio',
    orgaoEmissor,
    subunidade: SUBUNIDADE_POR_INSTITUICAO[instituicao] || '',
    tituloDocumento: `OFÍCIO Nº ${numero}`,
    numeroProcesso: numero,
    dataEmissao: documentos.dataExtenso(),
    destinatario,
    corpoTexto: `Assunto: ${assunto}\n\n${conteudo}`,
    nomeAssinante: nomeEmissor,
    cargoAssinante: CARGO_POR_INSTITUICAO[instituicao] || 'Autoridade',
  }).catch(err => { console.error('Falha ao gerar PNG do ofício:', err.message); return null; });

  // Ticket próprio pro acompanhamento da correspondência em si — antes o ofício só existia
  // como embed dentro do canal do processo, sem lugar dedicado pra tratar dele isoladamente.
  const categoriaId = await canais.obterOuCriarCategoria(guild, CATEGORIA_OFICIOS_CHAVE, CATEGORIA_OFICIOS_NOME);
  const canal = await canais.criarCanalTicket(guild, { categoriaId, prefixo: 'oficio', numero, membros: [emitidoPorId] });
  // Ofício puramente informativo (aguardaRetorno: false) não ganha botão de "Cumprir" — não
  // faz sentido pedir PDF de resposta pra algo que não espera resposta nenhuma.
  const botoesOficio = aguardaRetorno ? [botaoCumprirOficio(numero), botaoArquivarOficio(numero)] : [botaoArquivarOficio(numero)];
  await canal.send({
    content: `<@${emitidoPorId}>\n\n${texto}`,
    components: [new ActionRowBuilder().addComponents(botoesOficio)],
    ...(pngOficio ? { files: [{ attachment: pngOficio, name: `Oficio-${numero}.png` }] } : {}),
  });

  // Ofício de Delegado é correspondência da própria Polícia Civil — a delegacia deles recebe
  // uma cópia automática, igual já acontece com a devolutiva de mandado.
  if (orgaoEmissor === 'policia_civil') {
    await devolutivaPoliciaCivil.enviarOficioPoliciaCivil({ numero, destinatario, assunto, texto, pngBuffer: pngOficio });
  }

  db.inserir('oficios', { numero, processoNumero, destinatario, assunto, conteudo, emitidoPor: emitidoPorId, canalId: canal.id, status: 'Pendente', aguardaRetorno });

  // Continua registrado nos autos do processo — o ofício é parte do caso, mesmo tendo agora um
  // canal próprio só pra acompanhar a correspondência.
  const embed = new EmbedBuilder()
    .setTitle(`✉️ Ofício ${numero}`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Destinatário', value: truncar(destinatario), inline: true },
      { name: 'Acompanhamento', value: `<#${canal.id}>`, inline: true },
      { name: 'Assunto', value: truncar(assunto) },
    )
    .setFooter({ text: `Emitido por ${emitidoPorTag}` });
  const canalProcesso = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canalProcesso) await canalProcesso.send({ embeds: [embed] });

  await andamentos.registrar(guild, processoNumero, {
    tipo: 'oficio_emitido', titulo: `📜 Ofício ${numero} emitido`,
    detalhe: `Para: ${destinatario}\nAssunto: ${assunto}`,
    executorId: emitidoPorId, metadata: { oficioNumero: numero, instituicao: instituicao || null },
  });
  await processoCmd.repostarPainel(guild, processoNumero);
  return { numero, canal };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('oficio')
    .setDescription('Emite ofícios vinculados a um processo')
    .addSubcommand(sub => sub.setName('criar').setDescription('Cria um ofício')
      .addStringOption(o => o.setName('processo').setDescription('Número do processo vinculado').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('destinatario').setDescription('Destinatário').setRequired(true))
      .addStringOption(o => o.setName('assunto').setDescription('Assunto').setRequired(true))
      .addStringOption(o => o.setName('conteudo').setDescription('Conteúdo').setRequired(true))
      .addBooleanOption(o => o.setName('aguarda_retorno').setDescription('Esse ofício espera resposta/documento de volta? (padrão: sim)').setRequired(false))),

  async execute(interaction) {
    if (!podeEmitirOficio(interaction)) {
      return interaction.reply({ content: 'Só Delegado, Promotor, Procurador, Juiz ou Staff/Administração podem emitir ofício.', ephemeral: true });
    }

    const resultado = await criarOficio({
      guild: interaction.guild,
      processoNumero: interaction.options.getString('processo'),
      destinatario: interaction.options.getString('destinatario'),
      assunto: interaction.options.getString('assunto'),
      conteudo: interaction.options.getString('conteudo'),
      emitidoPorId: interaction.user.id,
      emitidoPorTag: interaction.user.tag,
      instituicao: instituicaoDoEmissor(interaction),
      aguardaRetorno: interaction.options.getBoolean('aguarda_retorno') ?? true,
    });

    if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
    return interaction.reply({ content: `Ofício ${resultado.numero} expedido em ${resultado.canal}.`, ephemeral: true });
  },

  criarOficio,
  podeEmitirOficio,
  instituicaoDoEmissor,
  cumprirOficio,

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = db.todos('processos', p => p.numero.toLowerCase().includes(foco))
      .slice(0, 25)
      .map(p => ({ name: `${p.numero} — ${p.tipo} — ${p.status}`.slice(0, 100), value: p.numero }));
    await interaction.respond(resultados);
  },
};
