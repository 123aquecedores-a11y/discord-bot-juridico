// EMISSÃO DE PEÇAS — a camada de UI da entrega in-game (SPEC §5.1, §6.1 e §6.2).
//
// Só o lado da EMISSÃO: gerar a peça, renderizar o PNG com selo e abrir a janela de entrega. O
// recebimento (botão `Receber`, upload da captura, decodificação, lavratura) não está aqui de
// propósito — ele depende de o QR sobreviver ao caminho real dentro do jogo, e construir botão
// sobre premissa não verificada é o que se evita.
//
// A regra de negócio mora em utils/pecas.js, que não conhece discord.js. Aqui só há tradução:
// interação -> chamada -> resposta.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const pecas = require('./pecas');
const andamentos = require('./andamentos');
const permissoes = require('./permissoes');
const { gerarPecaPNG } = require('../services/gerarPecaPNG');
const { nomeExibicao } = require('../services/gerarDocumentoPNG');
const servidorPecas = require('../services/servidorPecas');

// CATÁLOGO DE TIPOS DE ATO, com a ativação por tipo que a SPEC §11 pede — a flag existe para
// reduzir raio de dano, não escopo. A arquitetura é universal desde já; o que a faixa controla é
// quais tipos estão ligados.
//
// `emissor` e `destinatarios` são PAPÉIS, nunca IDs (SPEC §6.2). Advogado exige habilitação
// específica, então quem emite para advogado precisa dizer qual — ver pecas.gerar.
// FAIXA 1 = petição INCIDENTAL + intimação do juiz. As duas ocorrem dentro de processo que já
// existe, e é isso que faz desta a faixa de menor raio de dano: ela não toca em criação de caso.
//
// Não existe "petição inicial penal" neste sistema — processo penal nasce de inquérito ou de ato do
// MP, nunca de petição de advogado. A peça que ABRE caso é fenômeno do cível (Faixa 2, com o
// formulário de qualificação); o equivalente penal de peça inicial é a denúncia do MP (Faixa 3).
const TIPOS = {
  peticao_incidental: {
    rotulo: 'Petição (nos autos)',
    titulo: 'PETIÇÃO',
    orgao: 'PODER JUDICIÁRIO',
    unidade: 'Comarca de São Paulo — Vara Criminal',
    emissor: 'Advogado',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 1
  },
  intimacao_juiz: {
    rotulo: 'Intimação (juiz)',
    titulo: 'INTIMAÇÃO',
    orgao: 'PODER JUDICIÁRIO',
    unidade: 'Comarca de São Paulo — Vara Criminal',
    emissor: 'Juiz',
    destinatarios: ['Advogado'],
    tabela: 'processos',
    ativo: true, // FAIXA 1
  },
};

const tipoAtivo = (chave) => !!(TIPOS[chave] && TIPOS[chave].ativo);

// ---------------------------------------------------------------------------
// Passo 1 — conferência dos dados que o sistema preenche
// ---------------------------------------------------------------------------
// SPEC §5.1: o formulário já vem com número do processo, classe, partes, órgão e data. Nada disso é
// digitado — mostrar antes do modal serve para o emissor conferir, não para preencher. O modal em
// si fica com UM campo: a tese. É o que cabe e é o que muda de peça para peça.
async function abrirEmissao(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  if (!cfg || !cfg.ativo) {
    return interaction.reply({ content: 'Este tipo de ato ainda não está ativado.', ephemeral: true });
  }
  const processo = db.buscarPorNumero(cfg.tabela, numeroProcesso);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const modo = pecas.modoDoProcesso(processo);
  if (modo === pecas.MODOS.LEGADO) {
    return interaction.reply({
      content: '⚠️ Este processo nasceu no fluxo antigo (petição em PDF anexado) e continua nele até o fim — o rito não muda no meio dos autos. Use o anexo de sempre.',
      ephemeral: true,
    });
  }

  // Quem emite é quem ocupa o papel AGORA. Emissor substituído assume o que o antecessor deixou.
  if (!podeEmitir(interaction, cfg, processo)) {
    return interaction.reply({ content: `Só quem ocupa o papel de **${cfg.emissor}** neste processo pode emitir esta peça.`, ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`peca:criar:${tipoChave}:${numeroProcesso}`)
    .setTitle(`${cfg.rotulo}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tese')
        .setLabel('Tese / fundamentação')
        .setPlaceholder('Separe os parágrafos com uma linha em branco.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000), // teto de produto; coincide com o do campo (SPEC §12)
    ),
  );
  return interaction.showModal(modal);
}

function podeEmitir(interaction, cfg, processo) {
  if (permissoes.isAdmin(interaction) || pecas.isSupervisao(interaction.user.id)) return true;
  if (cfg.emissor === 'Advogado') {
    return (processo.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === interaction.user.id);
  }
  return pecas.ocupaDestinatario(cfg.tabela, processo, { papel: cfg.emissor }, interaction.user.id);
}

// Para quem vai a peça, resolvido no momento da emissão. Advogado precisa de habilitação
// específica: `advogados[]` é coleção e não identifica quem recebe (SPEC §6.2).
function resolverDestinatarios(cfg, processo) {
  const out = [];
  for (const papel of cfg.destinatarios) {
    if (papel !== 'Advogado') { out.push({ papel }); continue; }
    for (const h of (processo.habilitacoes || [])) {
      if (h.status === 'Aprovado') out.push({ papel: 'Advogado', habilitacaoId: h.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passo 2 — gerar a peça
// ---------------------------------------------------------------------------
async function criarPeca(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  if (!cfg || !cfg.ativo) return interaction.reply({ content: 'Tipo de ato não ativado.', ephemeral: true });

  const processo = db.buscarPorNumero(cfg.tabela, numeroProcesso);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeEmitir(interaction, cfg, processo)) {
    return interaction.reply({ content: 'Você não ocupa o papel de emissor deste ato.', ephemeral: true });
  }

  const texto = interaction.fields.getTextInputValue('tese');
  const destinatarios = resolverDestinatarios(cfg, processo);
  if (!destinatarios.length) {
    return interaction.reply({
      content: `⚠️ Não há quem ocupe o papel de **${cfg.destinatarios.join(' / ')}** neste processo agora. A peça não foi criada — assim que houver destinatário, emita novamente.`,
      ephemeral: true,
    });
  }

  // Renderizar leva alguns segundos (Chromium). Sem o defer, a interação expira em 3s.
  await interaction.deferReply({ ephemeral: true });

  // Qualificação e assinante são congelados na emissão: documento assinado não muda de partes nem
  // de assinante depois, e é isso que permite regerá-lo idêntico anos depois, sem Discord.
  const r = pecas.gerar({
    processoTabela: cfg.tabela, processoNumero: numeroProcesso, tipo: tipoChave,
    autorId: interaction.user.id, autorPapel: cfg.emissor, texto,
    qualificacao: qualificacao(processo),
    assinante: await nomeExibicao(interaction.guild, interaction.user.id),
    destinatarios,
  });
  if (!r.ok) return interaction.editReply({ content: `Não consegui criar a peça: ${r.razao}` });
  const peca = r.peca;

  // O PNG vai para o EMISSOR, não para o canal: o canal do processo é compartilhado com o
  // destinatário, e postar ali entregaria o teor antes da cena (SPEC §6.1). Arquivo único —
  // a URL fica guardada e é ela que será liberada no recebimento, sem gerar segunda cópia (§3.7).
  // O teor sai pela camada, não do registro: renderizar é um ponto de saída como qualquer outro, e
  // quem acabou de escrever a peça é o autor — a permissão é conferida do mesmo jeito.
  const acesso = pecas.paraRenderizacao(peca.numero, interaction.user.id, { ehStaff: permissoes.isAdmin(interaction) });
  const renderizados = acesso.ok
    ? await renderizar(interaction.guild, { ...acesso.peca, qualificacao: peca.qualificacao, assinante: peca.assinante, codigoArquivo: peca.codigoArquivo }, cfg).catch(err => {
      console.error(`[peca] falha ao renderizar ${peca.numero}:`, err.message);
      return null;
    })
    : null;

  let entregue = false;
  if (renderizados) {
    entregue = await enviarAoEmissor(interaction, peca, renderizados).catch(() => false);
    // Registra METADADO da entrega, nunca a URL do anexo: URL do CDN do Discord é link assinado e
    // expira em 24h. O original é o registro no banco; o PNG se regera do texto quando precisar.
    if (entregue) pecas.registrarEnvio(peca.numero, { totalPaginas: renderizados[0].paginas.length });
  }
  const paginas = renderizados;

  await postarNoCanal(interaction, peca, processo, cfg);
  await andamentos.registrar(interaction.guild, numeroProcesso, {
    tipo: 'peca_emitida',
    // Título genérico por tipo: descritivo demais entregaria o teor sem abrir o documento (SPEC §10).
    titulo: `📄 ${cfg.rotulo} — ${peca.numero}`,
    detalhe: peca.gated
      ? 'Aguardando entrega pessoal. O teor fica restrito ao emissor até o recebimento.'
      : 'Documento disponível às partes.',
    executorId: interaction.user.id,
    metadata: { peca: peca.numero, tipo: tipoChave, modo: peca.modoEntrega },
  }).catch(() => {});

  const aviso = !paginas
    ? '\n⚠️ O documento foi criado, mas o PNG não pôde ser renderizado agora. O texto está salvo — peça à staff para reemitir a imagem.'
    : (entregue ? '' : '\n⚠️ Não consegui te mandar o documento por DM (talvez suas DMs estejam fechadas). Abra as DMs e peça reenvio à staff — o teor NÃO pode ir para o canal do processo.');

  return interaction.editReply({
    content: `✅ **${cfg.rotulo} ${peca.numero}** criada.${aviso}\n\n${peca.gated
      ? 'Só você vê o teor por enquanto. Quando estiver na cena com o destinatário, clique em **Entregar agora** no canal do processo para abrir a janela de 60 minutos.'
      : 'Este processo está em modo aberto: o documento já está visível às partes.'}`,
  });
}

// Qualificação das partes, no formato dos autos. Uma petição que não identifica as partes não é
// peça, é bilhete — e todos estes dados já existem no registro do processo (SPEC §5.1: os campos
// vêm preenchidos pelo sistema, não digitados).
function qualificacao(processo) {
  const linhas = [`**Classe:** ${processo.tipo === 'Penal' ? 'Ação Penal' : 'Ação Cível'} nº ${processo.numero}`];
  const autor = processo.autorNome || (processo.tipo === 'Penal' ? 'Ministério Público' : null);
  if (autor) linhas.push(`**${processo.tipo === 'Penal' ? 'Autor' : 'Requerente'}:** ${autor}${processo.autorRg ? ` — RG ${processo.autorRg}` : ''}`);
  if (processo.reuNome) linhas.push(`**${processo.tipo === 'Penal' ? 'Réu' : 'Requerido'}:** ${processo.reuNome}${processo.reuRg ? ` — RG ${processo.reuRg}` : ''}`);
  return linhas.join('\n');
}

// Um token por destinatário significa um PNG por destinatário — cada um precisa receber o selo que
// é dele, senão o token do outro destravaria a peça errada.
async function renderizar(guild, peca, cfg) {
  const porDestinatario = [];
  for (const dest of peca.destinatarios) {
    porDestinatario.push({
      dest,
      paginas: await gerarPecaPNG({
        token: dest.token,
        digitos: peca.digitos,
        codigoArquivo: peca.codigoArquivo,
        numeroPeca: peca.numero,
        numeroProcesso: peca.processoNumero,
        titulo: cfg.titulo,
        orgao: cfg.orgao,
        unidade: cfg.unidade,
        data: new Date().toLocaleDateString('pt-BR'),
        qualificacao: peca.qualificacao,
        texto: peca.texto,
        assinante: peca.assinante,
        cargoAssinante: peca.autorPapel,
      }),
    });
  }
  return porDestinatario;
}

// Por DM, e não no canal do processo: o canal é compartilhado com o destinatário, e postar ali
// entregaria o teor antes da cena.
//
// NENHUMA URL É GUARDADA. O anexo do Discord é conveniência de exibição, não o arquivo dos autos —
// as URLs do CDN expiram em 24h e produziriam link morto. O original é o registro no banco, e o PNG
// é regerado do texto sempre que precisar (SPEC §3.7).
async function enviarAoEmissor(interaction, peca, renderizados) {
  const dm = await interaction.user.createDM().catch(() => null);
  if (!dm) return false;

  for (const { dest, paginas } of renderizados) {
    const sufixo = dest.papel === 'Advogado' ? `${dest.papel}-hab${dest.habilitacaoId}` : dest.papel;

    // Endereço permanente, uma URL por página — é o que a impressora do jogo recebe. O anexo vai
    // junto só como pré-visualização; ele expira em 24h e o link não.
    const registro = pecas.registrarPaginasPublicas(peca.numero, dest.papel, dest.habilitacaoId, paginas.length);
    const links = registro.ok
      ? registro.paginas.map(p => ({ pagina: p.pagina, url: servidorPecas.urlPublica(p.token) })).filter(l => l.url)
      : [];

    const blocoLinks = links.length
      ? '\n\n**Para imprimir no jogo** — cada página tem seu próprio link:\n'
        + links.map(l => `\`${l.url}\``).join('\n')
        + '\n⚠️ Quem tiver o link vê o documento. O link **é** o papel: não poste em canal, não mande para quem não deve ver.'
      : '\n\n⚠️ O endereço para impressão no jogo não está configurado neste servidor (BASE_URL_PECAS). Avise a staff.';

    const msg = await dm.send({
      content: `📄 **${peca.numero}** — via de **${dest.papel}**, ${paginas.length} página(s).\n`
        + 'O selo está em **todas** as páginas: na cena, o destinatário pode capturar qualquer uma.\n'
        + '⚠️ Repassar este documento fora dos autos é sujeito a sanção administrativa.'
        + blocoLinks,
      files: paginas.map((buf, i) => ({ attachment: buf, name: `${peca.numero}-${sufixo}-fls${i + 1}.png` })),
    }).catch(() => null);
    if (!msg) return false;
  }
  return true;
}

// O canal vê METADADOS, nunca o teor (SPEC §8). O botão `Receber` aparece inativo — é o que diz ao
// destinatário que existe algo dirigido a ele, sem entregar o conteúdo (SPEC §6.1).
async function postarNoCanal(interaction, peca, processo, cfg) {
  const canal = processo.canalId ? await interaction.guild.channels.fetch(processo.canalId).catch(() => null) : null;
  if (!canal) return;

  const embed = new EmbedBuilder()
    .setTitle(`📄 ${cfg.rotulo} — ${peca.numero}`)
    .setColor(peca.gated ? 0x8B6914 : 0x2E7D32)
    .addFields(
      { name: 'Processo', value: peca.processoNumero, inline: true },
      { name: 'Emitida por', value: `<@${peca.autorId}> (${peca.autorPapel})`, inline: true },
      { name: 'Destinatário', value: cfg.destinatarios.join(', '), inline: true },
    );

  if (peca.gated) {
    embed.setDescription(
      '🔒 **Teor restrito até a entrega pessoal.**\n'
      + 'O documento existe e está nos autos, mas só se abre ao destinatário quando a entrega for registrada — '
      + 'em cena, dentro do jogo, com o selo de autenticação conferido pelo sistema.\n\n'
      + `Se não houver entrega em 24 horas, o cartório distribui automaticamente e o prazo passa a correr.`,
    ).setFooter({ text: 'Entrega in-game — o mecanismo é público e a captura fica registrada para a staff.' });
  } else {
    embed.setDescription('Documento gerado no modo aberto: visível às partes desde a criação.');
  }

  const linha = new ActionRowBuilder();
  if (peca.gated) {
    linha.addComponents(
      new ButtonBuilder().setCustomId(`peca:entregar:${peca.numero}`).setLabel('Entregar agora').setEmoji('📤').setStyle(ButtonStyle.Primary),
      // Inativo de propósito: o recebimento só entra depois do teste in-game do selo.
      new ButtonBuilder().setCustomId(`peca:receber:${peca.numero}`).setLabel('Receber').setEmoji('📥').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
  }
  await canal.send({ embeds: [embed], ...(linha.components.length ? { components: [linha] } : {}) }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Passo 3 — janela de entrega
// ---------------------------------------------------------------------------
async function entregarAgora(interaction, numeroPeca) {
  const meta = pecas.metadados(numeroPeca);
  if (!meta) return interaction.reply({ content: 'Peça não encontrada.', ephemeral: true });

  const r = pecas.abrirEntrega(numeroPeca, interaction.user.id);
  if (!r.ok) return interaction.reply({ content: `❌ ${r.razao}`, ephemeral: true });

  const expira = Math.floor(new Date(r.janela.expiraEm).getTime() / 1000);
  const processo = db.buscarPorNumero(meta.processoTabela, meta.processoNumero);
  const canal = processo && processo.canalId ? await interaction.guild.channels.fetch(processo.canalId).catch(() => null) : null;

  if (canal) {
    const linha = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`peca:encerrar:${numeroPeca}`).setLabel('Encerrar entrega').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`peca:receber:${numeroPeca}`).setLabel('Receber').setEmoji('📥').setStyle(ButtonStyle.Success).setDisabled(true),
    );
    await canal.send({
      content: `📤 **Entrega aberta — ${numeroPeca}**\n`
        + `A janela fica aberta por **${r.minutos} minutos**, até <t:${expira}:t> (<t:${expira}:R>).\n`
        + 'O destinatário deve receber o documento **em cena**, dentro do jogo, e enviar a captura da tela mostrando o selo.\n'
        + '⚠️ A captura fica registrada e é avaliada pela staff. Receber sem o encontro é sujeito a sanção.',
      components: [linha],
    }).catch(() => {});
  }

  const alerta = r.semOcupante && r.semOcupante.length
    ? `\n\n⚠️ Atenção: ninguém ocupa o papel de **${r.semOcupante.join(', ')}** neste processo agora, então não há quem clique em Receber. O ato vai cair na distribuição automática em 24h.`
    : '';
  return interaction.reply({
    content: `✅ Janela de entrega aberta por ${r.minutos} minutos (até <t:${expira}:t>).${alerta}`,
    ephemeral: true,
  });
}

async function encerrarEntrega(interaction, numeroPeca) {
  const r = pecas.encerrarEntrega(numeroPeca, interaction.user.id);
  if (!r.ok) return interaction.reply({ content: `❌ ${r.razao}`, ephemeral: true });

  const meta = pecas.metadados(numeroPeca);
  const processo = db.buscarPorNumero(meta.processoTabela, meta.processoNumero);
  const canal = processo && processo.canalId ? await interaction.guild.channels.fetch(processo.canalId).catch(() => null) : null;
  if (canal) {
    await canal.send({ content: `🔒 **Entrega encerrada — ${numeroPeca}.** A janela foi fechada pelo emissor; novas tentativas de recebimento serão recusadas até que ele reabra.` }).catch(() => {});
  }
  return interaction.reply({ content: '✅ Janela encerrada.', ephemeral: true });
}

// ---------------------------------------------------------------------------
// Router — prefixo `peca:`, no mesmo padrão do `edital:` (ver index.js)
// ---------------------------------------------------------------------------
async function router(interaction) {
  const partes = interaction.customId.split(':');
  const acao = partes[1];

  if (interaction.isModalSubmit() && acao === 'criar') {
    return criarPeca(interaction, partes[2], partes.slice(3).join(':'));
  }
  if (!interaction.isButton()) return;

  switch (acao) {
    case 'emitir': return abrirEmissao(interaction, partes[2], partes.slice(3).join(':'));
    case 'entregar': return entregarAgora(interaction, partes.slice(2).join(':'));
    case 'encerrar': return encerrarEntrega(interaction, partes.slice(2).join(':'));
    case 'receber':
      // O botão existe desabilitado para anunciar o mecanismo; se algum caminho o disparar mesmo
      // assim, responde em vez de falhar calado. O recebimento entra depois do teste in-game.
      return interaction.reply({ content: '📥 O recebimento ainda não está ativado neste servidor.', ephemeral: true });
    default: return;
  }
}

module.exports = { router, TIPOS, tipoAtivo, abrirEmissao, criarPeca, entregarAgora, encerrarEntrega };
