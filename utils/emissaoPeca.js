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
const { RascunhoTTL } = require('./rascunhoTtl');
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
// Rascunho por trechos
// ---------------------------------------------------------------------------
// O teto de 4.000 é do CAMPO do modal, não da peça. Quem precisa de mais escreve em trechos, que se
// acumulam e viram uma peça só, paginada. Teto de 3 trechos: acima disso o documento passa de sete
// páginas, e sete impressões no jogo já é mais custo do que qualquer petição justifica.
const MAX_TRECHOS = 3;
const MAX_CHARS_TRECHO = 4000;

// Rascunho em memória com expiração — reaproveita o RascunhoTTL do fluxo de revisão in-flow, em vez
// de inventar mecanismo.
//
// DUAS HORAS, e não os 20 min do padrão da classe: quem escreve 12.000 caracteres em três trechos
// leva mais que isso, e o tempo digitando DENTRO do modal conta — o Discord não avisa o bot que a
// pessoa está escrevendo. Rascunho perdido no meio da redação é o pior erro possível deste fluxo:
// o texto não está em lugar nenhum, e não há como recuperá-lo.
const TTL_RASCUNHO_MS = 2 * 60 * 60 * 1000;
const rascunhos = new RascunhoTTL(TTL_RASCUNHO_MS);
const chaveRascunho = (userId, tipo, numero) => `${userId}:${tipo}:${numero}`;

// Ler RENOVA o prazo. O RascunhoTTL só marca a expiração no set, então reescrever a entrada a cada
// leitura é o que transforma as 2h em "2h de inatividade" em vez de "2h desde o primeiro trecho" —
// que era o comportamento que deixaria alguém perder o texto no meio da terceira parte.
function lerRascunho(userId, tipo, numero) {
  const chave = chaveRascunho(userId, tipo, numero);
  const atual = rascunhos.get(chave);
  if (!atual) return { trechos: [] };
  rascunhos.set(chave, atual);
  return atual;
}
const salvarRascunho = (userId, tipo, numero, r) => rascunhos.set(chaveRascunho(userId, tipo, numero), r);
const textoDoRascunho = (r) => r.trechos.join('\n\n');

// ESTIMATIVA DE PÁGINAS — medida no leiaute atual, não chutada.
//
// Medições depois da compactação (cabeçalho completo só na folha 1, selo reduzido ao QR nas demais,
// entrelinha 1,45): 2.739 chars = 1 página, 5.489 = 2, 8.239 = 3, 12.089 = 4. Média de 3.022 por
// página, contra 1.750 do leiaute anterior — o mesmo texto passou a custar quase metade das
// impressões no jogo.
//
// 3.050 é o divisor que reproduz todos os pontos medidos. A conta pode errar para MAIS quando um
// parágrafo grande cai perto da quebra, e errar para mais é o lado certo: o advogado vê o custo
// maior, nunca menor.
const CHARS_POR_PAGINA = 3050;
const estimarPaginas = (texto) => Math.max(1, Math.ceil((texto || '').length / CHARS_POR_PAGINA));

// O custo tem que ficar visível ENQUANTO ele escreve. Cada página é uma impressão separada no jogo e
// um espaço no arquivo físico — quem escreve muito precisa ver o que está criando, não descobrir
// depois com sete papéis na mão.
function linhaCusto(texto) {
  const chars = (texto || '').length;
  const pgs = estimarPaginas(texto);
  return `**${chars.toLocaleString('pt-BR')} caracteres ≈ ${pgs} página${pgs > 1 ? 's' : ''}** — ${pgs} impress${pgs > 1 ? 'ões' : 'ão'} no jogo`;
}

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
    // Esta mensagem quase nunca aparece: o botão "Peticionar" já bifurca por modo, e num processo
    // legado ele vai direto para o anexo de PDF sem passar por aqui. Ela existe como rede para o
    // caso de alguém clicar num botão de mensagem antiga — e por isso precisa dizer o que fazer,
    // não só o que não dá. Recusa sem saída é o que vira reclamação de "bug".
    return interaction.reply({
      content: '⚠️ **Este processo é anterior ao formulário de peças** e continua no rito em que nasceu — o procedimento não muda no meio dos autos.\n\n'
        + '**O que fazer:** peticione normalmente pelo botão **📄 Peticionar** do painel (hub *Advogado / Defesa*). '
        + 'Ele abre a janela para você anexar a petição em PDF, como sempre funcionou neste processo.\n\n'
        + 'O formulário novo vale para processos abertos a partir de agora.',
      ephemeral: true,
    });
  }

  // Quem emite é quem ocupa o papel AGORA. Emissor substituído assume o que o antecessor deixou.
  if (!podeEmitir(interaction, cfg, processo)) {
    return interaction.reply({ content: `Só quem ocupa o papel de **${cfg.emissor}** neste processo pode emitir esta peça.`, ephemeral: true });
  }

  return abrirModalTrecho(interaction, tipoChave, numeroProcesso);
}

// Um modal por TRECHO. O teto de 4.000 é do campo do Discord; a peça pode ter até MAX_TRECHOS deles,
// que se acumulam no rascunho e viram um documento só, paginado.
function abrirModalTrecho(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  const n = rascunho.trechos.length + 1;
  if (n > MAX_TRECHOS) {
    return interaction.reply({ content: `Você já escreveu os ${MAX_TRECHOS} trechos. Revise e envie, ou apague o último.`, ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`peca:trecho:${tipoChave}:${numeroProcesso}`)
    .setTitle(`${cfg.rotulo} — trecho ${n}/${MAX_TRECHOS}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tese')
        .setLabel(n === 1 ? 'Tese / fundamentação' : `Continuação (trecho ${n})`)
        .setPlaceholder('Separe os parágrafos com uma linha em branco.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(MAX_CHARS_TRECHO),
    ),
  );
  return interaction.showModal(modal);
}

// Recebe um trecho e devolve o painel de acumulação. Nada é gerado ainda — a peça só nasce quando o
// advogado clicar em enviar.
async function receberTrecho(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  if (!cfg || !cfg.ativo) return interaction.reply({ content: 'Tipo de ato não ativado.', ephemeral: true });

  const processo = db.buscarPorNumero(cfg.tabela, numeroProcesso);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeEmitir(interaction, cfg, processo)) {
    return interaction.reply({ content: 'Você não ocupa o papel de emissor deste ato.', ephemeral: true });
  }

  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  rascunho.trechos.push(interaction.fields.getTextInputValue('tese'));
  salvarRascunho(interaction.user.id, tipoChave, numeroProcesso, rascunho);

  return interaction.reply({ ...painelRascunho(tipoChave, numeroProcesso, rascunho, cfg), ephemeral: true });
}

// O painel é o lugar onde o custo fica visível e onde o erro tem conserto: dá para ver o texto
// inteiro e apagar o último trecho antes de enviar.
function painelRascunho(tipoChave, numeroProcesso, rascunho, cfg) {
  const texto = textoDoRascunho(rascunho);
  const n = rascunho.trechos.length;
  const podeMais = n < MAX_TRECHOS;

  const embed = new EmbedBuilder()
    .setTitle(`✍️ ${cfg.rotulo} — rascunho`)
    .setColor(0x4A6FA5)
    .setDescription(
      `${linhaCusto(texto)}\n\n`
      + `Trecho${n > 1 ? 's' : ''} escrito${n > 1 ? 's' : ''}: **${n} de ${MAX_TRECHOS}**\n`
      + (podeMais
        ? 'Você pode **enviar agora** ou **adicionar mais texto** — tudo vira uma peça só, paginada.'
        : `Você chegou ao limite de ${MAX_TRECHOS} trechos. Revise e envie, ou apague o último.`),
    )
    .setFooter({ text: 'O rascunho fica guardado por 2 horas sem atividade — o prazo renova a cada clique.' });

  const linha = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`peca:enviar:${tipoChave}:${numeroProcesso}`).setLabel('Enviar peça').setEmoji('📄').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`peca:add:${tipoChave}:${numeroProcesso}`).setLabel('Adicionar mais texto').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(!podeMais),
    new ButtonBuilder().setCustomId(`peca:ver:${tipoChave}:${numeroProcesso}`).setLabel('Ver texto').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`peca:undo:${tipoChave}:${numeroProcesso}`).setLabel('Apagar último trecho').setEmoji('↩️').setStyle(ButtonStyle.Danger).setDisabled(n === 0),
  );
  return { embeds: [embed], components: [linha] };
}

// Ver o acumulado antes de enviar. Sem isto, um erro no primeiro pedaço fica sem conserto — o
// advogado não teria como saber o que escreveu vinte minutos atrás.
async function verRascunho(interaction, tipoChave, numeroProcesso) {
  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  if (!rascunho.trechos.length) return interaction.reply({ content: 'Não há rascunho — ele pode ter expirado.', ephemeral: true });

  // Uma mensagem por trecho: o acumulado passa dos 2.000 do Discord com facilidade, e cortar o texto
  // justamente na tela de conferência derrotaria o propósito dela.
  const partes = rascunho.trechos.map((t, i) => `**— Trecho ${i + 1} (${t.length} caracteres) —**\n${t}`);
  await interaction.reply({ content: partes[0].slice(0, 1990), ephemeral: true });
  for (const p of partes.slice(1)) await interaction.followUp({ content: p.slice(0, 1990), ephemeral: true }).catch(() => {});
  return null;
}

async function desfazerTrecho(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  if (!rascunho.trechos.length) return interaction.reply({ content: 'Não há trecho a apagar.', ephemeral: true });

  const removido = rascunho.trechos.pop();
  salvarRascunho(interaction.user.id, tipoChave, numeroProcesso, rascunho);
  const painel = painelRascunho(tipoChave, numeroProcesso, rascunho, cfg);
  return interaction.reply({
    content: `↩️ Último trecho apagado (${removido.length} caracteres).`,
    ...painel, ephemeral: true,
  });
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

  // O teor vem do RASCUNHO acumulado, não de um campo de modal: a peça pode ter sido escrita em até
  // MAX_TRECHOS partes, e é aqui que elas viram um documento só.
  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  const texto = textoDoRascunho(rascunho);
  if (!texto.trim()) {
    return interaction.reply({ content: 'Não há texto para enviar — o rascunho pode ter expirado (2 horas sem atividade). Comece de novo.', ephemeral: true });
  }

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

  // Rascunho consumido: a peça existe, e deixar o texto em memória permitiria reenviar o mesmo
  // conteúdo como uma segunda peça por engano.
  rascunhos.delete(chaveRascunho(interaction.user.id, tipoChave, numeroProcesso));

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

  if (interaction.isModalSubmit() && acao === 'trecho') {
    return receberTrecho(interaction, partes[2], partes.slice(3).join(':'));
  }
  if (!interaction.isButton()) return;

  switch (acao) {
    case 'emitir': return abrirEmissao(interaction, partes[2], partes.slice(3).join(':'));
    case 'add': return abrirModalTrecho(interaction, partes[2], partes.slice(3).join(':'));
    case 'ver': return verRascunho(interaction, partes[2], partes.slice(3).join(':'));
    case 'undo': return desfazerTrecho(interaction, partes[2], partes.slice(3).join(':'));
    case 'enviar': return criarPeca(interaction, partes[2], partes.slice(3).join(':'));
    case 'entregar': return entregarAgora(interaction, partes.slice(2).join(':'));
    case 'encerrar': return encerrarEntrega(interaction, partes.slice(2).join(':'));
    case 'receber':
      // O botão existe desabilitado para anunciar o mecanismo; se algum caminho o disparar mesmo
      // assim, responde em vez de falhar calado. O recebimento entra depois do teste in-game.
      return interaction.reply({ content: '📥 O recebimento ainda não está ativado neste servidor.', ephemeral: true });
    default: return;
  }
}

// ---------------------------------------------------------------------------
// Varredura periódica — válvula de 24h e revogação de links de processo encerrado
// ---------------------------------------------------------------------------
// Chamada a cada 10 min pelo boot (ver index.js), mesmo padrão das demais checagens frequentes do
// projeto (utils/prazos.js). Nunca setTimeout: os horários-limite ficam persistidos no banco
// (SPEC §12) e é aqui que eles são conferidos.
//
// Mora neste arquivo, e não em utils/pecas.js, porque lavrar nos autos e logar exigem Discord
// (guild) — pecas.js não importa discord.js de propósito, para a camada de visibilidade continuar
// testável sem subir bot.
async function verificarValvulaEEncerramento(client, guild) {
  // VÁLVULA DE 24H (SPEC §7). pecas.varrerValvula() só atualiza o banco; lavrar nos autos é
  // responsabilidade de quem chama.
  const destravadas = pecas.varrerValvula();
  for (const d of destravadas) {
    await andamentos.registrar(guild, d.processoNumero, {
      // Título genérico por tipo, não descritivo (SPEC §10) — o índice não pode entregar o que
      // aconteceu além de "a válvula estourou".
      tipo: 'peca_valvula_24h',
      titulo: '⏰ Distribuição automática pelo cartório',
      detalhe: `${d.peca}: passadas 24h sem entrega pessoal, o cartório distribuiu automaticamente. Não houve encontro registrado.`,
      executorId: null,
      metadata: { peca: d.peca },
    }).catch(err => console.error(`[pecas] falha ao lavrar válvula de ${d.peca}:`, err.message));
  }
  if (destravadas.length) console.log(`[pecas] válvula de 24h: ${destravadas.length} peça(s) destravada(s) automaticamente.`);

  // REVOGAÇÃO DE LINKS PÚBLICOS de processos que encerraram — ver utils/pecas.js. O motivo de
  // existir: resolverTokenPublico nunca checava prazo nem estado, e um processo ARQUIVADO (sem
  // sentença) mantinha o teor fechado pela camada para sempre, enquanto o link cru continuava
  // servindo a imagem pra qualquer um que o tivesse.
  //
  // DUAS METADES, sempre juntas: apagar a entrada no banco não bastava, porque a rota HTTP consulta
  // o CACHE EM DISCO antes do banco (ver services/servidorPecas.js) — um token revogado aqui mas já
  // cacheado continuaria sendo servido do arquivo para sempre. Por isso o retorno de
  // revogarLinksDeProcessosEncerrados agora traz os TOKENS, e cada um tem seu arquivo de cache
  // apagado logo em seguida.
  const revogadas = pecas.revogarLinksDeProcessosEncerrados();
  if (revogadas.length) {
    let arquivosApagados = 0;
    for (const r of revogadas) for (const token of r.tokens) if (servidorPecas.apagarCache(token)) arquivosApagados++;
    console.log(`[pecas] links públicos revogados (processo encerrado): ${revogadas.map(r => r.peca).join(', ')} `
      + `— ${arquivosApagados} arquivo(s) de cache apagado(s) junto.`);
  }

  // LOG INCONDICIONAL — de propósito, mesmo quando não há nada a fazer. As duas linhas acima só
  // imprimem quando destravam ou revogam algo; enquanto a tabela `pecas` estiver vazia (como está
  // hoje em produção), a varredura roda a cada 10 min em silêncio total, e silêncio não distingue
  // "rodou e não achou nada" de "não está agendada". Esta linha é a prova de execução: se ela
  // aparecer no log a cada ~10 min, a varredura está de fato rodando, não só presente no código.
  console.log(`[pecas] varredura periódica (válvula + revogação) executada às ${new Date().toISOString()} — ${destravadas.length} destravada(s), ${revogadas.length} revogação(ões).`);
}

module.exports = {
  router, TIPOS, tipoAtivo, abrirEmissao, criarPeca, entregarAgora, encerrarEntrega,
  receberTrecho, verRascunho, desfazerTrecho, abrirModalTrecho,
  estimarPaginas, linhaCusto, MAX_TRECHOS, MAX_CHARS_TRECHO, CHARS_POR_PAGINA, TTL_RASCUNHO_MS,
  verificarValvulaEEncerramento,
};
