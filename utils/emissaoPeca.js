// EMISSÃO E RECEBIMENTO DE PEÇAS — a camada de UI da entrega in-game (SPEC §5.1, §6.1, §6.2, §6.4).
//
// Emissão: gerar a peça, renderizar o PNG com selo e abrir a janela de entrega. Recebimento: o
// botão `Receber` pede a captura de tela no canal, decodifica o QR (utils/lerSelo, puro-JS, sem
// Chromium) e chama pecas.receber() — ATIVADO em 18/08/2026 para o primeiro teste real in-game do
// selo (0008CV). Até então o botão era postado desabilitado de propósito (não se constrói handler
// sobre premissa não verificada); ver histórico do commit 73f9f89 para o racional original.
//
// A regra de negócio mora em utils/pecas.js, que não conhece discord.js. Aqui só há tradução:
// interação -> chamada -> resposta.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const pecas = require('./pecas');
const andamentos = require('./andamentos');
const permissoes = require('./permissoes');
const { gerarPecaPNG } = require('../services/gerarPecaPNG');
const { RascunhoTTL } = require('./rascunhoTtl');
const { nomeExibicao } = require('../services/gerarDocumentoPNG');
const servidorPecas = require('../services/servidorPecas');
const lerSelo = require('./lerSelo');

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
    emissor: 'Advogado',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 1
  },
  intimacao_juiz: {
    rotulo: 'Intimação (juiz)',
    titulo: 'INTIMAÇÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: ['Advogado'],
    tabela: 'processos',
    ativo: true, // FAIXA 1
  },

  // BLOCO D — atos do penal, aprovados em 18/08/2026. Todos entram por CONFIGURAÇÃO: nenhuma linha
  // de lógica de rito foi escrita para eles. `podeEmitir` resolve Promotor e Delegado pelo
  // TABELAS_TICKET que já existia, e o destinatário Juiz/Promotor é slot direto.
  denuncia_mp: {
    rotulo: 'Denúncia',
    titulo: 'DENÚNCIA',
    orgao: 'MINISTÉRIO PÚBLICO',
    emissor: 'Promotor',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 3 (SPEC §11)
  },
  manifestacao_mp_gated: {
    rotulo: 'Manifestação do MP',
    titulo: 'MANIFESTAÇÃO DO MINISTÉRIO PÚBLICO', // usado só quando o promotor não nomeia
    orgao: 'MINISTÉRIO PÚBLICO',
    emissor: 'Promotor',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 4 (SPEC §11)
    // PORTA ÚNICA DO MP (20/08/2026). Todo ato do Ministério Público dentro do processo sai por
    // aqui — denúncia, promoção de arquivamento, pedido de cautelar, manifestação simples. Não há
    // menu de classificação e não há tipo por ato: quem nomeia o documento é o promotor
    // (`tituloLivre`), e quem lê o teor e decide o que fazer é o Juiz, com as ferramentas do
    // processo penal que já existem.
    tituloLivre: true,
    documentoOpcional: true,
  },
  contestacao: {
    rotulo: 'Contestação / defesa',
    titulo: 'CONTESTAÇÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Advogado',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 3 (SPEC §11)
  },
  // NÃO está na tabela de exclusões da §11.1, e os dois lados são jogadores com papel resolvível
  // que vivem no fórum — por isso entra no gate. Único ato aprovado cujo destinatário é o Promotor.
  relatorio_inquerito: {
    rotulo: 'Relatório de inquérito',
    titulo: 'RELATÓRIO DE INQUÉRITO',
    orgao: 'POLÍCIA CIVIL',
    emissor: 'Delegado',
    destinatarios: ['Promotor'],
    tabela: 'processos',
    ativo: true,
  },

  // PETIÇÃO INICIAL CÍVEL (SPEC §11, Faixa 2) — a peça que ABRE o caso cível.
  //
  // Tipo PRÓPRIO, e não "petição incidental", por dois motivos concretos: o documento precisa sair
  // com o título PETIÇÃO INICIAL (é peça de abertura, não manifestação no meio dos autos), e o
  // botão "Anexar petição inicial" recusava em rito novo mandando o advogado usar "Peticionar"
  // noutro menu — dois caminhos para a mesma coisa, com o rótulo errado no fim.
  peticao_inicial_civel: {
    rotulo: 'Petição inicial',
    titulo: 'PETIÇÃO INICIAL',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Advogado',
    // O autor do cível é o advogado que abriu (campo `autor` do processo), não uma habilitação de
    // defesa — mesma mecânica do `requerenteId` da petição administrativa.
    emissorCampo: 'autor',
    destinatarios: ['Juiz'],
    tabela: 'processos',
    ativo: true, // FAIXA 2 (SPEC §11)
  },

  // PETIÇÃO ADMINISTRATIVA (SPEC §11, Faixa 2) — porte de arma, troca de nome, limpeza de ficha e
  // alvará de evento. Elas eram o último rito preso no anexo de PDF direto.
  //
  // Mora na tabela `peticoes`, não em `processos`, e é por isso que existe `emissorCampo`: o
  // emissor aqui não se resolve por habilitação (petição não tem defesa habilitada) nem por slot de
  // TABELAS_TICKET — é o ADVOGADO QUE PROTOCOLOU, gravado em `requerenteId`. Sem isso, `podeEmitir`
  // recusaria justamente quem abriu a petição.
  peticao_administrativa: {
    rotulo: 'Petição administrativa',
    titulo: 'PETIÇÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Advogado',
    emissorCampo: 'requerenteId',
    destinatarios: ['Juiz'],
    tabela: 'peticoes',
    ativo: true, // FAIXA 2 (SPEC §11)
  },

  // BLOCO E — a sentença. Destinatário é o ADVOGADO de cada parte (um token por habilitação
  // aprovada, SPEC §11.3): a sentença é entregue em mãos a cada defesa, e o ato só se cumpre por
  // inteiro quando todos receberam ou a válvula estourar.
  //
  // ACÓRDÃO FICOU DE FORA, e o motivo é estrutural, não de esquecimento: o emissor (Desembargador)
  // mora na tabela `apelacoes` e os destinatários (advogados habilitados) moram em `processos`. O
  // módulo resolve emissor e destinatário na MESMA tabela (`cfg.tabela`), então o acórdão não fecha
  // sem uma capacidade nova — resolução cruzada entre tabelas. Registrado, não improvisado.
  sentenca: {
    rotulo: 'Sentença',
    titulo: 'SENTENÇA',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: ['Advogado'],
    tabela: 'processos',
    ativo: true, // FAIXA 5 (SPEC §11)
  },

  // RAZÕES DE RECURSO — o recorrente (Advogado ou Promotor) entrega em mão do Desembargador.
  //
  // Antes as razões iam CRUAS no embed do canal da apelação, que tem o relator, o recorrente E a
  // parte contrária dentro. Agora seguem o mesmo rito de todo teor: peça, selo, entrega em cena.
  //
  // `emissor` é 'Advogado' só para o rodapé do documento; quem PODE recorrer continua decidido
  // por podeRecorrer (advogado da parte ou Promotor), como sempre foi.
  // DECISÃO DO JUIZ na petição administrativa (deferir / indeferir / diligência).
  //
  // Antes o teor da decisão — resultado E fundamentação, mais o PNG — era postado direto no
  // canal da petição, que tem o advogado requerente dentro. A decisão do juiz é o documento que
  // mais importa do rito inteiro, e era o único que não passava pela entrega em cena.
  //
  // Destinatário é o REQUERENTE (o advogado que protocolou), não um papel de ticket: petição não
  // tem habilitações, e quem recebe a decisão é sempre quem pediu.
  // ACÓRDÃO — a decisão do Desembargador, entregue às partes.
  //
  // Ia com teor E PNG direto para o canal do processo original, onde advogados e partes estão.
  // Achado em 19/08/2026 pelo inventário de anexos: era a mesma classe da sentença, e tinha
  // escapado de todas as varreduras por não estar em nenhum inventário.
  // REQUERIMENTO DE MEDIDA CAUTELAR — o MP pede, o Juiz recebe em cena.
  //
  // Antes a justificativa do MP ia CRUA no embed do canal do processo (que tem o advogado
  // dentro) junto com os botões de decidir. O Juiz decidia sem nunca ter recebido nada, e a
  // fundamentação do pedido era pública no instante da solicitação.
  solicitacao_medida: {
    rotulo: 'Requerimento de medida',
    titulo: 'REQUERIMENTO DE MEDIDA CAUTELAR',
    orgao: 'MINISTÉRIO PÚBLICO',
    emissor: 'Promotor',
    destinatarios: ['Juiz'],
    tabela: 'medidas',
    ativo: true,
  },

  // FUNDAMENTAÇÃO DO JUÍZO para emitir mandado. NÃO vira peça — vira o teor do próprio
  // mandado. Está aqui só para reusar o rascunho por trechos (ver FINALIZADORES): o Juiz monta
  // a decisão em partes, e o desfecho é a emissão dos mandados, não uma entrega com selo.
  //
  // `destinatarios: []` é declaração, não descuido: não há a quem entregar este texto.
  // FUNDAMENTAÇÃO DA SENTENÇA e do MANDADO DIRETO. Como a da medida: não viram peça por si —
  // são o CORPO de um ato que já tem pipeline próprio. Existem para que o Juiz monte a decisão
  // em trechos, com o mesmo painel do MP, em vez de caber tudo num campo de 4.000 caracteres.
  fundamentacao_sentenca: {
    rotulo: 'Fundamentação da sentença',
    titulo: 'SENTENÇA',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: [],
    tabela: 'processos',
    ativo: true,
    semPeca: true,
  },

  fundamentacao_mandado: {
    rotulo: 'Fundamentação do mandado',
    titulo: 'MANDADO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: [],
    tabela: 'processos',
    ativo: true,
    semPeca: true,
  },

  fundamentacao_medida: {
    rotulo: 'Fundamentação do Juízo',
    titulo: 'DECISÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: [],
    tabela: 'medidas',
    ativo: true,
    semPeca: true,
  },

  // ---- Atos do JUIZ que usam o rascunho por trechos mas NÃO viram peça (semPeca) ----
  // Os dois nasceram em 20/08/2026, do mesmo diagnóstico: o Juiz tinha como emitir documento
  // selado, mas não tinha como DIZER algo nos autos. Arquivava em silêncio e negava um pedido
  // simplesmente não emitindo o mandado — nos dois casos as partes ficavam sem saber o porquê.
  razoes_arquivamento: {
    rotulo: 'Razões do arquivamento',
    titulo: 'DECISÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: [],
    tabela: 'processos',
    ativo: true,
    semPeca: true,
  },
  despacho_juiz: {
    rotulo: 'Despacho / manifestação nos autos',
    titulo: 'DESPACHO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: [],
    tabela: 'processos',
    ativo: true,
    semPeca: true,
    // O despacho é o ato do Juiz que NÃO gera documento: sem PNG, sem selo, sem entrega. Ele vira
    // andamento nos autos, visível às partes no canal. Por isso `tituloLivre` — o Juiz nomeia o que
    // está decidindo ("Indeferimento do pedido de prisão temporária") — mas nenhum título fixo faz
    // sentido aqui além do genérico.
    tituloLivre: true,
  },

  acordao: {
    rotulo: 'Acórdão',
    titulo: 'ACÓRDÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Desembargador',
    destinatarios: ['Advogado'],
    tabela: 'processos',
    ativo: true,
  },

  decisao_peticao: {
    rotulo: 'Decisão',
    titulo: 'DECISÃO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Juiz',
    destinatarios: ['Requerente'],
    tabela: 'peticoes',
    ativo: true,
  },

  razoes_recurso: {
    rotulo: 'Razões de recurso',
    titulo: 'RAZÕES DE RECURSO',
    orgao: 'PODER JUDICIÁRIO',
    emissor: 'Advogado',
    destinatarios: ['Desembargador'],
    tabela: 'apelacoes',
    ativo: true,
  },
};

const tipoAtivo = (chave) => !!(TIPOS[chave] && TIPOS[chave].ativo);

// ---------------------------------------------------------------------------
// Efeito do ato nos autos — o que muda no PROCESSO quando a peça nasce
// ---------------------------------------------------------------------------
// Declarado por tipo, num lugar só. Tipo sem entrada aqui não mexe no processo, e isso é o padrão
// correto: petição incidental e manifestação juntam-se aos autos sem mudar de fase.
//
// Por que uma tabela e não `if` no meio de criarPeca: cada ato novo do catálogo (Blocos D e E
// trouxeram cinco) traria a tentação de mais um `if`, e o que aconteceu com a contestação —
// alguém esquecer o efeito num dos caminhos — voltaria a acontecer.
const EFEITOS_POS_CRIACAO = {
  // A contestação encerra a fase de defesa: o processo fica pronto para o juiz julgar. Era isto que
  // o caminho gated não fazia, deixando o processo travado.
  contestacao: () => ({ status: 'Concluso para julgamento', contestacaoEm: new Date().toISOString() }),
};

// ---------------------------------------------------------------------------
// EFEITOS DO RECEBIMENTO — o elo "documento entregue → próxima etapa destravada"
// ---------------------------------------------------------------------------
// Espelha EFEITOS_POS_CRIACAO, mas dispara quando o selo é conferido, não quando a peça nasce.
//
// A SEPARAÇÃO QUE CONTINUA VALENDO (ver teste 9 em scripts/testes-intimacao-gated.js): receber o
// PAPEL não é receber a DENÚNCIA. O gate do QR prova que o documento chegou às mãos do Juiz e
// libera a leitura do teor — não é ato judicial, não julga nada.
//
// O que este efeito faz é DISTRIBUIÇÃO, não juízo de mérito: o Juiz que fisicamente recebeu a
// denúncia passa a ser o responsável pelo caso. É exatamente o que o sorteio automático já fazia
// (executarParecerMp → rh.sortearJuiz → status 'Instrução'), sem nenhuma decisão pelo caminho.
// Quando não havia Juiz elegível o sorteio falhava e o processo ficava em
// 'Denúncia oferecida - aguardando juiz', esperando um job de 10 em 10 minutos. Quem recebe o papel
// resolve isso na hora.
//
// POR ISSO A CONDIÇÃO É "processo SEM juiz". Com juiz já designado, o caso já foi distribuído e
// nada aqui tem o que fazer — é também a guarda de colisão: o segundo recebimento não reatribui.
const EFEITOS_POS_RECEBIMENTO = {
  // O Desembargador recebeu as razões em cena: só a partir daqui ele pode julgar. Antes, os
  // botões Manter/Reformar/Anular nasciam junto com o canal e ele decidia sem nunca ter
  // recebido nada — o recurso tinha documento, mas não tinha entrega.
  // O Juiz recebeu o requerimento do MP em cena: só a partir daqui ele decide. Antes, os botões
  // nasciam junto com o pedido e ele deferia sem ter recebido nada.
  solicitacao_medida: {
    aplicar: (medida, _peca, recebedorId) => {
      const rhLocal = require('./rh');
      if (medida.requerimentoRecebidoEm) return null;
      if (!rhLocal.cobreOPapel(recebedorId, 'Juiz')) {
        return { recusa: `ℹ️ Documento entregue. A decisão da medida **${medida.numero}** não foi liberada porque só o Juiz destrava o julgamento do requerimento.` };
      }

      // MEDIDA AVULSA (requerida pelo MP fora de um processo) nasce SEM juiz: não há processo de
      // onde herdá-lo, e sortear um na criação escolheria alguém que talvez nem esteja em cena.
      //
      // Quem RECEBE em mão assume — exatamente o mecanismo da denúncia (denuncia_mp, acima). É o que
      // faz "qualquer Juiz disponível pode assumir" funcionar sem fila nova: a peça é dirigida ao
      // PAPEL 'Juiz', `ocupaDestinatario` deixa qualquer um com o cargo receber, e a titularidade é
      // consequência da entrega. Medida que JÁ tem juiz (a de dentro do processo) não é reatribuída.
      const assumeOJuizo = !medida.juiz;
      return {
        campos: {
          requerimentoRecebidoEm: new Date().toISOString(),
          ...(assumeOJuizo ? { juiz: recebedorId, aguardandoJuizDesde: new Date().toISOString() } : {}),
          ...require('./atosPorCargo').carimboDeExecucao(recebedorId),
        },
        aviso: assumeOJuizo
          ? `⚖️ Requerimento recebido. Você assume a medida **${medida.numero}** como Juiz e pode decidi-la — os botões já estão no canal.`
          : `⚖️ Requerimento recebido. A medida **${medida.numero}** está liberada para decisão — os botões já estão no canal.`,
      };
    },
    aoAplicar: async (interaction, medida) => {
      await require('../commands/medida').repostarBotoesDecisaoMedida(interaction.guild, medida.numero).catch(() => {});
    },
  },

  razoes_recurso: {
    aplicar: (apelacao, _peca, recebedorId) => {
    const rhLocal = require('./rh');
    if (apelacao.razoesRecebidasEm) return null; // já liberado; segundo recebimento não repete
    if (!rhLocal.cobreOPapel(recebedorId, 'Desembargador')) {
      return { recusa: `ℹ️ Documento entregue. A instrução do recurso **${apelacao.numero}** não foi liberada porque só o Desembargador relator destrava o julgamento.` };
    }
      return {
        campos: { razoesRecebidasEm: new Date().toISOString(), ...require('./atosPorCargo').carimboDeExecucao(recebedorId) },
        aviso: `⚖️ Razões recebidas. O recurso **${apelacao.numero}** está liberado para julgamento — os botões **Manter / Reformar / Anular** já estão ativos no canal.`,
      };
    },
    // Reposta os botões de julgamento, agora destravados. Antes eles nasciam com o canal e o
    // relator decidia sem ter recebido nada.
    aoAplicar: async (interaction, apelacao) => {
      await require('../commands/processo').repostarBotoesApelacao(interaction.guild, apelacao.numero).catch(() => {});
    },
  },

  // ---------------------------------------------------------------------------
  // DISTRIBUIÇÃO PELO RECEBIMENTO — regra única, dois tipos a usam
  // ---------------------------------------------------------------------------
  // `denuncia_mp` (histórico: peças já emitidas continuam funcionando) e `manifestacao_mp_gated`
  // (a porta única do MP desde 20/08/2026) fazem A MESMA COISA quando recebidas num processo penal
  // sem Juiz: quem recebe assume o caso e ele segue para instrução. Uma função só, chamada pelos
  // dois — a alternativa era copiar quatro guardas e deixá-las divergir.
  //
  // NÃO É JUÍZO DE MÉRITO. É distribuição: o mesmo que `rh.sortearJuiz` já fazia, só que decidido
  // por quem apareceu em cena em vez de por sorteio. Receber o PAPEL nunca foi receber a DENÚNCIA
  // (teste 9 em scripts/testes-intimacao-gated.js trava essa separação).
  denuncia_mp: {
    aplicar: (processo, _peca, recebedorId, ctx) => distribuiPeloRecebimento(processo, recebedorId, ctx, 'a denúncia'),
    aoAplicar: (interaction, processo, peca) => lavrarDistribuicao(interaction, processo, peca, 'a denúncia'),
  },

  // A PORTA ÚNICA DO MP. Todo ato do Ministério Público no processo sai por aqui, e o efeito é o
  // mesmo — com DUAS guardas que o tipo antigo não precisava ter:
  //
  //   1. ESCOPO: só processo PENAL. `manifestacao_mp_gated` também é emitida em PETIÇÃO
  //      administrativa (commands/peticao.js sobrepõe a tabela) e pode rodar em cível. Distribuir
  //      juiz nesses ritos seria atropelar o fluxo deles, que já tem sorteio próprio.
  //   2. IDEMPOTÊNCIA: só quando NÃO há juiz. A partir da segunda manifestação o processo já tem
  //      titular, e `distribuiPeloRecebimento` devolve a recusa explicativa em vez de reatribuir.
  //
  // Efeito colateral desejado: a PRIMEIRA manifestação do MP num penal sem juiz é, na prática, a
  // denúncia — e é ela que tira o processo de 'Aguardando decisão do MP'. Sem isso o processo
  // aberto pelo MP não tinha NENHUM caminho para ganhar juiz (mapeamento de 20/08/2026).
  manifestacao_mp_gated: {
    aplicar: (registro, _peca, recebedorId, ctx) => {
      if (ctx.tabela !== 'processos') return null; // petição administrativa: só entrega
      if (registro.tipo !== 'Penal') return null;  // cível tem sorteio próprio
      if (registro.juiz) return null;              // já distribuído: entrega sem reatribuir, e calado
      return distribuiPeloRecebimento(registro, recebedorId, ctx, 'a manifestação do MP');
    },
    aoAplicar: (interaction, processo, peca) => lavrarDistribuicao(interaction, processo, peca, 'a manifestação do MP'),
  },
};

// Quem recebeu em cena vira o titular — ou a razão pela qual não virou. Nunca fica mudo: cada
// recusa diz o que aconteceu com o documento (entregue) e o que falta para o processo andar.
function distribuiPeloRecebimento(processo, recebedorId, ctx, rotuloAto) {
  const rh = require('./rh');
  const acumulo = require('./acumuloDePapeis');

  // GUARDA DE COLISÃO — processo já distribuído não é redistribuído. Vale tanto para o segundo
  // Juiz que recebe quanto para o caso em que o sorteio automático chegou primeiro.
  if (processo.juiz) {
    return processo.juiz === recebedorId
      ? null
      : { recusa: `ℹ️ O processo **${processo.numero}** já tem Juiz responsável: <@${processo.juiz}>. Você recebeu o documento e pode ler o teor, mas a titularidade não muda.` };
  }

  // Recebeu pelo papel de Juiz mas não tem o cargo (staff, supervisão): entrega o documento,
  // não vira titular. Designar Juiz sem cargo de Juiz seria pior que o processo parado.
  if (!rh.temCargo(recebedorId, 'Juiz') && !rh.temCargo(recebedorId, 'Desembargador')) {
    return { recusa: `ℹ️ Documento entregue. A titularidade do processo **${processo.numero}** não foi atribuída a você porque o cargo de Juiz não consta no seu registro do **/rh** — outro Juiz precisa receber para assumir o caso.` };
  }

  // ACÚMULO PROIBIDO — quem acusa não julga. Alguém com cargo de Juiz E Promotor cobre o papel de
  // destinatário "Juiz" e chega até aqui; se for o promotor DESTE caso, entregar o papel é certo,
  // mas designá-lo juiz do próprio caso não. Mudo seria o pior: a pessoa acharia que destravou.
  const conflito = acumulo.conflitoDePapeis({ Juiz: recebedorId, Promotor: processo.promotor })
    || acumulo.conflitoDePapeis({ Juiz: recebedorId, Advogado: processo.advogadoId });
  if (conflito) {
    return { recusa: `⚠️ **Você é o Promotor deste caso e não pode ser o Juiz dele.** ${conflito}\n\nO documento está entregue e você pode ler o teor, mas **outro Juiz precisa recebê-lo** para o processo seguir para instrução.` };
  }
  // O réu do próprio processo julgando a si mesmo — mesma razão de rh.sortearJuiz excluí-lo.
  if ((processo.reus || []).includes(recebedorId) || processo.autor === recebedorId) {
    return { recusa: `⚠️ **Você é parte neste processo e não pode julgá-lo.** O documento está entregue, mas outro Juiz precisa recebê-lo para o caso seguir.` };
  }

  return {
    campos: {
      juiz: recebedorId,
      juizDesde: new Date().toISOString(),
      status: 'Instrução',
      distribuidoPorRecebimento: true,
    },
    aviso: `⚖️ Você recebeu ${rotuloAto} e passa a ser o **Juiz responsável** pelo processo **${processo.numero}**, que segue para instrução.`,
  };
}

// Abre o canal ao novo titular, repõe o painel (agora com o hub do Juiz) e lavra o andamento.
async function lavrarDistribuicao(interaction, processo, peca, rotuloAto) {
  const processoCmd = require('../commands/processo');
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  await require('./canais').adicionarMembro(canal, interaction.user.id).catch(() => {});
  await processoCmd.repostarPainel(interaction.guild, processo.numero).catch(() => {});
  await andamentos.registrar(interaction.guild, processo.numero, {
    tipo: 'juiz_designado',
    titulo: '⚖️ Juiz designado pelo recebimento',
    detalhe: `<@${interaction.user.id}> recebeu ${rotuloAto} em cena e assumiu o processo, que segue para instrução.`,
    executorId: interaction.user.id,
    metadata: { peca: peca.numero, juiz: interaction.user.id },
  }).catch(() => {});
}

// Devolve { campos, aviso } aplicado, { recusa } explicando por que não aplicou, ou null (nada a
// fazer). Nunca lança: falha aqui não pode derrubar uma entrega que já foi lavrada nos autos.
//
// `tabela` vem de quem chama (meta.processoTabela da PEÇA), não de TIPOS[tipo].tabela. A diferença
// importa: `manifestacao_mp_gated` roda em `processos` E em `peticoes` (commands/peticao.js
// sobrepõe a tabela na emissão), e gravar pela tabela do catálogo escreveria a petição dentro de
// `processos` — atualizando um número que existe nas duas, ou nenhum.
function aplicarEfeitoDoRecebimento(tipoChave, processo, peca, recebedorId, tabela = null) {
  const efeito = EFEITOS_POS_RECEBIMENTO[tipoChave];
  if (!efeito || !processo) return null;
  const alvo = tabela || TIPOS[tipoChave].tabela;
  const r = efeito.aplicar(processo, peca, recebedorId, { tabela: alvo });
  if (!r || !r.campos) return r || null;
  db.atualizar(alvo, processo.numero, r.campos);
  console.log(`[pecas] ${peca.numero} (${tipoChave}) recebida por ${recebedorId}: ${alvo}/${processo.numero} → ${r.campos.status || 'campos atualizados'}.`);
  return r;
}

async function aplicarEfeitoNoProcesso(tipoChave, processo, peca) {
  const efeito = EFEITOS_POS_CRIACAO[tipoChave];
  if (!efeito) return null;
  const campos = efeito(processo, peca);
  if (!campos) return null;
  const cfg = TIPOS[tipoChave];
  db.atualizar(cfg.tabela, processo.numero, campos);
  console.log(`[pecas] ${peca.numero} (${tipoChave}): processo ${processo.numero} → ${campos.status || 'campos atualizados'}.`);
  return campos;
}

// ---------------------------------------------------------------------------
// Rascunho por trechos
// ---------------------------------------------------------------------------
// O teto de 4.000 é do CAMPO do modal, não da peça. Quem precisa de mais escreve em trechos, que se
// acumulam e viram uma peça só, paginada. Teto de 3 trechos: acima disso o documento passa de sete
// páginas, e sete impressões no jogo já é mais custo do que qualquer petição justifica.
const MAX_TRECHOS = 3;
const MAX_CHARS_TRECHO = 4000;
// Teto do título livre: 80 é o que cabe no cabeçalho do PNG em UMA linha na fonte atual. Acima
// disso o título quebra e empurra o corpo para baixo — e a paginação mede a altura do cabeçalho
// como fixa, então a última linha da página sairia coberta pelo selo, sem erro nenhum aparecer.
const MAX_CHARS_TITULO = 80;
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
// Consome o rascunho: quem finaliza precisa apagá-lo, senão o texto fica em memória e um segundo
// clique em "Enviar" reemite o mesmo conteúdo.
function limparRascunho(userId, tipo, numero) {
  rascunhos.delete(chaveRascunho(userId, tipo, numero));
}

// SEMEAR o rascunho com um texto que veio de outro lugar — tipicamente o primeiro trecho, digitado
// num modal antes de o painel existir. É o que permite a uma decisão do Juiz começar como sempre
// começou (um modal) e SÓ ENTÃO ganhar o "adicionar mais texto": ele escreve o primeiro bloco no
// modal, e daí em diante usa o mesmo painel do MP.
function semearRascunho(userId, tipo, numero, texto) {
  rascunhos.set(chaveRascunho(userId, tipo, numero), { trechos: [String(texto || '')].filter(Boolean) });
}

// O painel de trechos, montado para quem não passou por `abrirEmissao`. Mesmo componente, mesmos
// botões, mesmo roteador — só o ponto de entrada é outro.
function painelDeRascunho(userId, tipoChave, numero) {
  const cfg = TIPOS[tipoChave];
  return painelRascunho(tipoChave, numero, lerRascunho(userId, tipoChave, numero), cfg);
}

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
// `destinatario` (opcional) fixa a via de ESTE ato — ver resolverDestinatarios. Fica guardado no
// rascunho, e não no customId, porque o rascunho já é o estado que atravessa modal→trechos→envio;
// enfiá-lo no customId significaria carregá-lo por quatro botões e perdê-lo em qualquer um.
async function abrirEmissao(interaction, tipoChave, numeroProcesso, { destinatario = null } = {}) {
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

  if (destinatario) {
    const r = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
    salvarRascunho(interaction.user.id, tipoChave, numeroProcesso, { ...r, destinatario });
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

  // NOMENCLATURA LIVRE, só no PRIMEIRO trecho (20/08/2026). O ato que admite `tituloLivre` é
  // nomeado por quem o escreve: o promotor digita "Denúncia", "Pedido de prisão temporária",
  // "Promoção de arquivamento". Vai como RÓTULO no cabeçalho do documento e nada mais — não
  // aciona efeito, não roteia, nenhuma regra lê esse campo. Só no trecho 1 porque a continuação é
  // do MESMO documento: repetir o campo convidaria a renomear no meio da escrita.
  if (cfg.tituloLivre && n === 1) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tituloLivre')
          .setLabel('O que é este documento?')
          .setPlaceholder('Ex.: Denúncia · Pedido de prisão temporária · Promoção de arquivamento')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(MAX_CHARS_TITULO),
      ),
    );
  }

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
  // O título só existe no modal do primeiro trecho, então só há o que ler quando ele veio. Guardo
  // no rascunho e não numa variável à parte: o rascunho JÁ é o estado que sobrevive entre os
  // cliques, e um segundo lugar de estado seria um segundo lugar para esquecer de limpar.
  if (cfg.tituloLivre && rascunho.trechos.length === 1) {
    rascunho.tituloLivre = (interaction.fields.getTextInputValue('tituloLivre') || '').trim() || null;
  }
  salvarRascunho(interaction.user.id, tipoChave, numeroProcesso, rascunho);

  return interaction.reply({ ...painelRascunho(tipoChave, numeroProcesso, rascunho, cfg), ephemeral: true });
}

// O painel é o lugar onde o custo fica visível e onde o erro tem conserto: dá para ver o texto
// inteiro e apagar o último trecho antes de enviar.
function painelRascunho(tipoChave, numeroProcesso, rascunho, cfg) {
  const texto = textoDoRascunho(rascunho);
  const n = rascunho.trechos.length;
  const podeMais = n < MAX_TRECHOS;
  const anexados = (rascunho.anexos || []).length;

  const embed = new EmbedBuilder()
    .setTitle(`✍️ ${cfg.rotulo} — rascunho`)
    .setColor(0x4A6FA5)
    .setDescription(
      // O título escolhido aparece no painel porque é ele que vai no cabeçalho do documento: quem
      // escreveu "Denúncia" precisa ver isso antes de enviar, não descobrir no PNG.
      (cfg.tituloLivre ? `📄 Documento: **${rascunho.tituloLivre || '(sem título)'}**\n` : '')
      + `${linhaCusto(texto)}\n\n`
      + `Trecho${n > 1 ? 's' : ''} escrito${n > 1 ? 's' : ''}: **${n} de ${MAX_TRECHOS}**\n`
      + (cfg.documentoOpcional
        ? `Documento(s) anexado(s): **${anexados}** — opcional.\n`
        : '')
      + (podeMais
        ? 'Você pode **enviar agora** ou **adicionar mais texto** — tudo vira uma peça só, paginada.'
        : `Você chegou ao limite de ${MAX_TRECHOS} trechos. Revise e envie, ou apague o último.`),
    )
    .setFooter({ text: 'O rascunho fica guardado por 2 horas sem atividade — o prazo renova a cada clique.' });

  const botoes = [
    new ButtonBuilder().setCustomId(`peca:enviar:${tipoChave}:${numeroProcesso}`).setLabel('Enviar peça').setEmoji('📄').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`peca:add:${tipoChave}:${numeroProcesso}`).setLabel('Adicionar mais texto').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(!podeMais),
    new ButtonBuilder().setCustomId(`peca:ver:${tipoChave}:${numeroProcesso}`).setLabel('Ver texto').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`peca:undo:${tipoChave}:${numeroProcesso}`).setLabel('Apagar último trecho').setEmoji('↩️').setStyle(ButtonStyle.Danger).setDisabled(n === 0),
  ];
  // O anexo é a MESMA janela de upload do resto do bot (anexoPdf.aguardarAnexos), num botão
  // próprio porque `aguardarAnexos` responde à interação — não cabe dentro do "Enviar", que já
  // faz deferReply antes do Chromium. O documento é PROVA juntada aos autos, não o teor da peça:
  // o teor continua sendo o texto, e é dele que o PNG selado é gerado.
  if (cfg.documentoOpcional) {
    botoes.push(new ButtonBuilder().setCustomId(`peca:anexar:${tipoChave}:${numeroProcesso}`)
      .setLabel(anexados ? `Anexar mais (${anexados})` : 'Anexar documento').setEmoji('📎').setStyle(ButtonStyle.Secondary));
  }
  // Cinco botões cabem numa linha; o teto do Discord é 5 por ActionRow (ver testes-limite-componentes).
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(botoes)] };
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

// Janela de upload do documento OPCIONAL. Reusa `anexoPdf.aguardarAnexos` — a mesma janela do
// resto do bot, não uma segunda — e `anexos.criarDocumento` para a juntada.
//
// O QUE ESTE DOCUMENTO É, e o que não é: é PROVA anexada aos autos, como qualquer outra. NÃO é o
// teor da peça. O teor continua sendo o texto escrito nos trechos, e é só dele que o PNG selado é
// gerado — anexar um arquivo não coloca conteúdo dentro do documento entregue em cena.
//
// `require` local: anexoPdf e anexos puxam a cadeia de canais/permissões, e emissaoPeca é
// carregado no boot por index.js. Manter no topo criaria ciclo.
async function anexarAoRascunho(interaction, tipoChave, numeroProcesso) {
  const cfg = TIPOS[tipoChave];
  if (!cfg || !cfg.documentoOpcional) {
    return interaction.reply({ content: 'Este ato não aceita documento anexo.', ephemeral: true });
  }
  const processo = db.buscarPorNumero(cfg.tabela, numeroProcesso);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeEmitir(interaction, cfg, processo)) {
    return interaction.reply({ content: 'Você não ocupa o papel de emissor deste ato.', ephemeral: true });
  }

  const rascunho = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  if (!rascunho.trechos.length) {
    return interaction.reply({ content: 'Escreva o texto antes de anexar — o rascunho pode ter expirado.', ephemeral: true });
  }

  const { aguardarAnexos } = require('./anexoPdf');
  const resultado = await aguardarAnexos(interaction, {
    timeoutMs: 60 * 1000, idleMs: 15 * 1000, silenciarVazio: true,
    mensagem: '📎 Envie o(s) documento(s) como anexo neste canal (~60s). Se não houver documento, é só aguardar a janela fechar — o texto já basta.',
  });
  const novos = resultado ? resultado.arquivos : [];
  // Lido de novo: a janela ficou aberta até 60s e o rascunho pode ter mudado (ou expirado) nesse vão.
  const atual = lerRascunho(interaction.user.id, tipoChave, numeroProcesso);
  if (!atual.trechos.length) {
    return interaction.followUp({ content: '⚠️ O rascunho expirou enquanto a janela estava aberta — os arquivos não foram juntados. Comece de novo.', ephemeral: true }).catch(() => null);
  }
  atual.anexos = [...(atual.anexos || []), ...novos];
  salvarRascunho(interaction.user.id, tipoChave, numeroProcesso, atual);

  return interaction.followUp({
    content: novos.length
      ? `📎 ${novos.length} documento(s) juntado(s) ao rascunho. Eles vão aos autos quando você enviar a peça.`
      : 'Nenhum documento enviado — o ato segue só com o texto.',
    ...painelRascunho(tipoChave, numeroProcesso, atual, cfg),
    ephemeral: true,
  }).catch(() => null);
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

  // `emissorCampo` — o emissor está gravado num campo do PRÓPRIO registro, não em habilitação nem
  // em slot de TABELAS_TICKET. É o caso da petição administrativa, onde quem emite é o advogado que
  // protocolou (`requerenteId`). Configuração, não código novo por rito.
  if (cfg.emissorCampo) return processo[cfg.emissorCampo] === interaction.user.id;

  if (cfg.emissor === 'Advogado') {
    return (processo.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === interaction.user.id);
  }
  return pecas.ocupaDestinatario(cfg.tabela, processo, { papel: cfg.emissor }, interaction.user.id);
}

// Para quem vai a peça, resolvido no momento da emissão. Advogado precisa de habilitação
// específica: `advogados[]` é coleção e não identifica quem recebe (SPEC §6.2).
// `escolhido` (opcional) vem de quem emite tendo apontado UMA pessoa — é o caso da intimação, em
// que o juiz seleciona o destinatário e pecas.classificarDestinatarioIntimacao já decidiu o papel.
// Sem ele, vale o catálogo: todos os papéis declarados no tipo. Manter os dois caminhos é o que
// permite a mesma máquina servir ato dirigido (intimação) e ato de destinatário fixo (petição).
function resolverDestinatarios(cfg, processo, escolhido = null) {
  if (escolhido) return [escolhido];
  const out = [];
  for (const papel of cfg.destinatarios) {
    if (papel !== 'Advogado') { out.push({ papel }); continue; }
    for (const h of (processo.habilitacoes || [])) {
      if (h.status === 'Aprovado') out.push({ papel: 'Advogado', habilitacaoId: h.id });
    }
  }
  return out;
}

// ANEXO QUE NÃO ENTROU NOS AUTOS (21/08/2026).
//
// POR QUE NÃO ABORTA A EMISSÃO — a decisão é estrutural, não preferência: quando a juntada roda, o
// `finalizarPeca` JÁ criou a peça, renderizou o PNG, mandou ao emissor, postou o card no canal do
// processo e lavrou o andamento `peca_emitida`. Não há emissão a desfazer; há um documento assinado
// e já publicado a destruir. E o `aplicarEfeitoNoProcesso` ainda não rodou — abortar aqui deixaria o
// processo travado, que é exatamente o defeito de 19/08 anotado na chamada dele.
//
// MAS TAMBÉM NÃO PODE SUMIR. O anexo é PROVA juntada aos autos; perdê-lo em silêncio é perder prova.
//
// SEM O NOME DO ARQUIVO AQUI, e este é o ponto delicado: o andamento é visível a QUEM LÊ O
// PROCESSO, e nome de arquivo costuma descrever o conteúdo ("laudo-cadaverico-vitima.pdf"). Gravá-lo
// no andamento furaria o `podeVerTeor` por um caminho novo — e logo numa peça gated, cujo teor só
// deveria abrir na entrega em cena. Quantidade e POSIÇÃO bastam para saber que falta algo e quanto.
// O nome vai só para o emissor, na resposta efêmera, que ninguém mais lê.
async function lavrarPendenciaDeAnexo(interaction, peca, falhos) {
  const posicoes = falhos.map(f => f.posicao).join(', ');
  await andamentos.registrar(interaction.guild, peca.processoNumero, {
    tipo: 'anexo_nao_juntado',
    titulo: `📎 ${falhos.length} anexo(s) NÃO juntado(s) — ${peca.numero}`,
    detalhe: `A peça vale e está nos autos; ${falhos.length} documento(s) que a acompanhavam `
      + `(posição ${posicoes}) NÃO foram juntados por falha técnica. `
      + 'Podem ser juntados de novo pelo botão **🧾 Anexar prova** no canal do processo.',
    executorId: interaction.user.id,
    // Metadado é número, nunca nome: o registro do banco é lido por outras telas.
    metadata: { peca: peca.numero, quantidade: falhos.length, posicoes: falhos.map(f => f.posicao) },
  }).catch(err => console.error(`[pecas] a pendência de anexo de ${peca.numero} não pôde ser lavrada:`, err.message));
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

  const destinatarios = resolverDestinatarios(cfg, processo, rascunho.destinatario || null);
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
    qualificacao: qualificacao(processo, cfg.tabela),
    assinante: await nomeExibicao(interaction.guild, interaction.user.id),
    // Rótulo do documento quando o ato admite nomenclatura própria. Congelado junto com o resto,
    // pelo mesmo motivo: o PNG tem que sair idêntico daqui a um ano, sem Discord.
    tituloLivre: cfg.tituloLivre ? (rascunho.tituloLivre || null) : null,
    destinatarios,
  });
  if (!r.ok) return interaction.editReply({ content: `Não consegui criar a peça: ${r.razao}` });
  const peca = r.peca;
  const { paginas, entregue } = await finalizarPeca(interaction, peca, processo, cfg, tipoChave);


  // JUNTADA DOS DOCUMENTOS OPCIONAIS. Depois de a peça existir, não antes: se a criação falhasse,
  // ficariam documentos nos autos apontando para um ato que nunca nasceu. `atoOrigemId` é o número
  // da PEÇA — é o que amarra o anexo ao documento selado que o Juiz vai receber em cena.
  const anexosFalhos = [];
  for (const [i, a] of (rascunho.anexos || []).entries()) {
    try {
      require('./anexos').criarDocumento({
        tipo: `anexo_${tipoChave}`, url: a.url, nomeArquivo: a.nomeArquivo,
        autorId: interaction.user.id, atoOrigemId: peca.numero, protocoloVinculado: numeroProcesso,
      });
    } catch (e) {
      // O loop NÃO para no primeiro erro: um anexo ruim não pode impedir os outros de entrarem.
      anexosFalhos.push({ posicao: i + 1, nomeArquivo: a.nomeArquivo || null });
      console.error(`[pecas] falha ao juntar o anexo ${i + 1} de ${peca.numero}:`, e.message);
    }
  }
  if (anexosFalhos.length) await lavrarPendenciaDeAnexo(interaction, peca, anexosFalhos);

  // Rascunho consumido: a peça existe, e deixar o texto em memória permitiria reenviar o mesmo
  // conteúdo como uma segunda peça por engano.
  rascunhos.delete(chaveRascunho(interaction.user.id, tipoChave, numeroProcesso));

  // EFEITO DO ATO NO PROCESSO — aqui, e não no clique do botão.
  //
  // Achado em produção (19/08/2026): a contestação em processo gated criava a peça mas NÃO avançava
  // o status, porque a bifurcação para o formulário dava `return` antes da linha que avançava. O
  // processo ficava preso em "Aguardando contestação" e o juiz não conseguia julgar, mesmo com a
  // contestação nos autos.
  //
  // A lição estrutural: emitir uma peça é um ATO PROCESSUAL, e o efeito dele nos autos tem que
  // acontecer quando a peça NASCE — não quando o formulário abre (pode ser abandonado) nem
  // espalhado por cada botão que chama o módulo (é assim que um deles fica sem o efeito).
  await aplicarEfeitoNoProcesso(tipoChave, processo, peca);

  const aviso = !paginas
    ? '\n⚠️ O documento foi criado, mas o PNG não pôde ser renderizado agora. O texto está salvo — peça à staff para reemitir a imagem.'
    : (entregue ? '' : '\n⚠️ Não consegui te mandar o documento por DM (talvez suas DMs estejam fechadas). Abra as DMs e peça reenvio à staff — o teor NÃO pode ir para o canal do processo.');

  // AQUI o nome do arquivo PODE aparecer — e só aqui. Esta resposta é efêmera e vai a quem emitiu:
  // ninguém mais lê. O andamento correspondente, que fica nos autos à vista de todos, leva só a
  // quantidade e a posição (ver lavrarPendenciaDeAnexo).
  //
  // Sobre o caminho de conserto: **🧾 Anexar prova** existe e é o único disponível depois da
  // emissão. Ele NÃO é equivalente — junta o documento ao PROCESSO (`atoOrigemId` vira
  // `<numero>#provaN`), não preso à peça. A frase diz isso em vez de prometer restauração igual.
  const avisoAnexo = anexosFalhos.length
    ? `\n⚠️ **${anexosFalhos.length} anexo(s) NÃO entraram nos autos:** `
      + anexosFalhos.map(f => f.nomeArquivo || `arquivo na posição ${f.posicao}`).join(', ') + '.'
      + '\nA peça vale e está nos autos — falhou só a juntada. Para juntar de novo, use o botão '
      + '**🧾 Anexar prova** no canal do processo (ele grava o documento nos autos pelo processo, '
      + 'não preso a esta peça).'
    : '';

  return interaction.editReply({
    content: `✅ **${cfg.rotulo} ${peca.numero}** criada.${aviso}${avisoAnexo}\n\n${peca.gated
      ? 'Só você vê o teor por enquanto. Quando estiver na cena com o destinatário, clique em **Entregar agora** no canal do processo para abrir a janela de 60 minutos.'
      : 'Este processo está em modo aberto: o documento já está visível às partes.'}`,
  });
}

// UNIDADE derivada do processo, nunca hardcoded no catálogo (corrigido em 18/08/2026).
//
// A IMPLEMENTAÇÃO MORA EM utils/catalogoAtos.js desde 19/08/2026: o servidor HTTP das páginas
// públicas precisa da MESMA regra e não pode importar este arquivo (discord.js). Ter duas cópias
// foi o que produziu o bug crítico da página impressa sem selo — ver o cabeçalho de catalogoAtos.
// Aqui fica só o reexport, para não quebrar quem já importava daqui.
const unidadeDoProcesso = require('./catalogoAtos').unidadeDoProcesso;

// Qualificação das partes, no formato dos autos. Uma petição que não identifica as partes não é
// peça, é bilhete — e todos estes dados já existem no registro do processo (SPEC §5.1: os campos
// vêm preenchidos pelo sistema, não digitados).
// Classe do procedimento por TABELA — não por `if` empilhado sobre `processo.tipo`.
//
// A petição administrativa entrou na Faixa 2 e quebrou a premissa antiga de que só existiam dois
// ritos: nela, `tipo` é 'PorteArma' / 'TrocaNome' / 'LimpezaFicha' / 'AlvaraEvento', não 'Penal' nem
// 'Civil' — o `if` binário classificaria um porte de arma como "Ação Cível". É a conversão para
// tabela que ficou anotada como pendência quando o terceiro rito chegasse; ele chegou.
const CLASSE_PETICAO = {
  PorteArma: 'Pedido de Porte de Arma',
  TrocaNome: 'Pedido de Retificação de Nome Civil',
  LimpezaFicha: 'Pedido de Reabilitação (limpeza de ficha)',
  AlvaraEvento: 'Pedido de Alvará de Evento',
};

function qualificacao(processo, processoTabela = 'processos') {
  // PETIÇÃO ADMINISTRATIVA: a parte é o CLIENTE (nome + RG), e quem assina é o advogado que
  // protocolou. Não há "réu" nem "autor" — é procedimento de jurisdição voluntária.
  if (processoTabela === 'peticoes') {
    const linhas = [`**Classe:** ${CLASSE_PETICAO[processo.tipo] || 'Petição administrativa'} nº ${processo.numero}`];
    const nome = processo.nomeCliente || processo.nomeNovo || processo.nomeAtual;
    if (nome) linhas.push(`**Requerente:** ${nome}${processo.rgCliente ? ` — RG ${processo.rgCliente}` : ''}`);
    if (processo.enderecoCliente) linhas.push(`**Endereço:** ${processo.enderecoCliente}`);
    return linhas.join('\n');
  }

  const linhas = [`**Classe:** ${processo.tipo === 'Penal' ? 'Ação Penal' : 'Ação Cível'} nº ${processo.numero}`];
  const autor = processo.autorNome || (processo.tipo === 'Penal' ? 'Ministério Público' : null);
  if (autor) linhas.push(`**${processo.tipo === 'Penal' ? 'Autor' : 'Requerente'}:** ${autor}${processo.autorRg ? ` — RG ${processo.autorRg}` : ''}`);
  if (processo.reuNome) linhas.push(`**${processo.tipo === 'Penal' ? 'Réu' : 'Requerido'}:** ${processo.reuNome}${processo.reuRg ? ` — RG ${processo.reuRg}` : ''}`);
  return linhas.join('\n');
}

// Um token por destinatário significa um PNG por destinatário — cada um precisa receber o selo que
// é dele, senão o token do outro destravaria a peça errada.
// ---------------------------------------------------------------------------
// TUDO O QUE ACONTECE DEPOIS DE pecas.gerar
// ---------------------------------------------------------------------------
// `pecas.gerar` só INSERE o registro. Sozinho ele não rende PNG, não manda nada a ninguém e — o
// que mais dói — não posta o card com o botão **Entregar agora**, sem o qual a entrega em cena é
// literalmente inalcançável.
//
// EXTRAÍDO EM 19/08/2026 porque a SENTENÇA chamava `pecas.gerar` direto e parava aí: a peça
// nascia, o juiz recebia um card dizendo "use Entregar agora" e o botão não existia em lugar
// nenhum. O documento existia no banco e não havia como entregá-lo.
//
// Quem cria peça chama ISTO, nunca `pecas.gerar` sozinho.
// CONTEXTO DE EMISSÃO — nem toda peça nasce de um clique.
//
// A decisão do Juiz sobre uma petição também é proferida AUTOMATICAMENTE, por decurso de prazo
// (utils/prazos.js): não há interaction, não há quem clicou. Exigir uma interaction aqui obrigaria
// a duplicar o pipeline para o caminho automático — que é exatamente como nasce a segunda cópia
// que depois diverge da primeira.
//
// Aceita uma interaction do discord.js OU `{ guild, autorId }` cru. Devolve sempre a mesma forma.
function contextoDeEmissao(ctx) {
  const guild = ctx.guild;
  const autorId = (ctx.user && ctx.user.id) || ctx.autorId || null;
  return {
    guild,
    autorId,
    ehStaff: ctx.member ? permissoes.isAdmin(ctx) : false,
    // Quem recebe a via para imprimir. No caminho automático não há `ctx.user`: busca pelo id.
    async usuario() {
      if (ctx.user) return ctx.user;
      if (!guild || !autorId) return null;
      const membro = await guild.members.fetch(autorId).catch(() => null);
      return membro ? membro.user : null;
    },
  };
}

async function finalizarPeca(ctx, peca, processo, cfg, tipoChave) {
  const ctxo = contextoDeEmissao(ctx);
  // O PNG vai para o EMISSOR, não para o canal: o canal do processo é compartilhado com o
  // destinatário, e postar ali entregaria o teor antes da cena (SPEC §6.1). Arquivo único —
  // a URL fica guardada e é ela que será liberada no recebimento, sem gerar segunda cópia (§3.7).
  // O teor sai pela camada, não do registro: renderizar é um ponto de saída como qualquer outro, e
  // quem acabou de escrever a peça é o autor — a permissão é conferida do mesmo jeito.
  const acesso = pecas.paraRenderizacao(peca.numero, ctxo.autorId, { ehStaff: ctxo.ehStaff });
  const renderizados = acesso.ok
    ? await renderizar(ctxo.guild, { ...acesso.peca, qualificacao: peca.qualificacao, assinante: peca.assinante, codigoArquivo: peca.codigoArquivo }, cfg).catch(err => {
      console.error(`[peca] falha ao renderizar ${peca.numero}:`, err.message);
      return null;
    })
    : null;

  let entregue = false;
  if (renderizados) {
    entregue = await enviarAoEmissor(ctxo, peca, renderizados).catch(() => false);
    // Registra METADADO da entrega, nunca a URL do anexo: URL do CDN do Discord é link assinado e
    // expira em 24h. O original é o registro no banco; o PNG se regera do texto quando precisar.
    if (entregue) pecas.registrarEnvio(peca.numero, { totalPaginas: renderizados[0].paginas.length });
  }

  await postarNoCanal(ctxo, peca, processo, cfg);
  await andamentos.registrar(ctxo.guild, peca.processoNumero, {
    tipo: 'peca_emitida',
    // Título genérico por tipo: descritivo demais entregaria o teor sem abrir o documento (SPEC §10).
    titulo: `📄 ${cfg.rotulo} — ${peca.numero}`,
    detalhe: peca.gated
      ? 'Aguardando entrega pessoal. O teor fica restrito ao emissor até o recebimento.'
      : 'Documento disponível às partes.',
    executorId: ctxo.autorId,
    metadata: { peca: peca.numero, tipo: tipoChave, modo: peca.modoEntrega },
  }).catch(() => {});

  return { paginas: renderizados, entregue };
}

// PORTA DE ENTRADA para atos que JÁ TÊM o próprio texto — sentença e razões de recurso nascem de
// modal próprio, com fluxo de revisão-IA próprio, e não passam pelo rascunho por trechos do
// `criarPeca`. Daqui para a frente é o mesmo caminho de sempre: mesmo selo, mesma janela, mesmo
// botão de entrega. Sem isto, cada ato desses reinventaria a entrega — e o primeiro já reinventou
// pela metade.
//
// Devolve { ok, peca, paginas, entregue } ou { ok:false, razao }.
// `tabela` sobrepõe a do catálogo quando o MESMO ato existe em ritos diferentes. A manifestação
// do MP é o caso: é o mesmo documento, com o mesmo destinatário (o Juiz), no processo penal e na
// petição administrativa — só muda em que tabela o registro de origem vive. Um segundo tipo no
// catálogo seria uma cópia esperando divergir do original.
async function emitirAtoComoPeca(ctx, { tipo, processoNumero, texto, destinatarios, assinante, tabela = null }) {
  const ctxo = contextoDeEmissao(ctx);
  const cfg = TIPOS[tipo];
  if (!cfg) return { ok: false, razao: `tipo de peça desconhecido: ${tipo}` };
  if (!destinatarios || !destinatarios.length) return { ok: false, razao: 'sem destinatário para a entrega' };

  const tabelaAlvo = tabela || cfg.tabela;
  const processo = db.buscarPorNumero(tabelaAlvo, processoNumero);
  if (!processo) return { ok: false, razao: 'registro de origem não encontrado' };

  const r = pecas.gerar({
    processoTabela: tabelaAlvo, processoNumero, tipo,
    autorId: ctxo.autorId, autorPapel: cfg.emissor, texto,
    qualificacao: qualificacao(processo, tabelaAlvo),
    assinante: assinante || await nomeExibicao(ctxo.guild, ctxo.autorId),
    destinatarios,
  });
  if (!r.ok) return r;

  const { paginas, entregue } = await finalizarPeca(ctx, r.peca, processo, cfg, tipo);
  return { ok: true, peca: r.peca, paginas, entregue };
}

async function renderizar(guild, peca, cfg) {
  const porDestinatario = [];
  for (const dest of peca.destinatarios) {
    porDestinatario.push({
      dest,
      paginas: await gerarPecaPNG({
        gated: peca.gated,
        token: dest.token,
        digitos: peca.digitos,
        codigoArquivo: peca.codigoArquivo,
        numeroPeca: peca.numero,
        numeroProcesso: peca.processoNumero,
        titulo: peca.tituloLivre || cfg.titulo,
        orgao: cfg.orgao,
        // Do PROCESSO, não do catálogo — ver unidadeDoProcesso.
        unidade: unidadeDoProcesso(db.buscarPorNumero(peca.processoTabela || 'processos', peca.processoNumero)),
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

// ---------------------------------------------------------------------------
// ATO PUBLICADO NOS AUTOS — documento sem selo, postado no canal (20/08/2026)
// ---------------------------------------------------------------------------
// Terceira coisa que se pode fazer com o rascunho por trechos, ao lado de "virar peça" e "virar o
// corpo de outro ato": PUBLICAR. O ato do Juízo que fala nos autos — despacho, razões do
// arquivamento — é documento de verdade, com brasão e paginação, mas NÃO é peça entregue:
//
//   - sem selo, sem token, sem janela de entrega (`gated: false`);
//   - postado NO canal do processo, visível às partes na hora;
//   - registrado em `andamentos`, que é o histórico dos autos.
//
// POR QUE ESTA FUNÇÃO EXISTE (bug de 20/08/2026, pego em teste pelo operador): eu escrevi
// `publicarDespacho` e `arquivarComRazoes` chamando só `andamentos.registrar`, com um comentário
// afirmando que ele "já posta no canal do processo". NÃO POSTA — `andamentos.registrar` grava no
// banco e espelha apenas o TÍTULO no canal de auditoria. O texto ficava nos autos (recuperável
// pelo botão "📜 Histórico"), truncado em 300 caracteres, e o canal não recebia nada. A mensagem
// dizia "as partes já o veem no canal" e não havia nada para ver.
//
// A lição: afirmação sobre o comportamento de uma função tem que ser verificada, não lembrada.
//
// REUSA `gerarPecaPNG` — o gerador PAGINADO, o mesmo das peças. Não `gerarDocumentoPNG`, que é
// página única: um despacho de três trechos sairia com o texto escorrendo para fora da folha, que
// foi exatamente o bug do mandado.
async function publicarAtoNoCanal(guild, { tipoChave, numeroProcesso, tabela = null, texto, tituloDocumento = null, autorId, andamento = null, componentes = [] }) {
  const cfg = TIPOS[tipoChave];
  if (!cfg) return { ok: false, razao: 'tipo desconhecido' };
  const alvo = tabela || cfg.tabela;
  const processo = db.buscarPorNumero(alvo, numeroProcesso);
  if (!processo) return { ok: false, razao: 'processo não encontrado' };

  let paginas = null;
  try {
    paginas = await gerarPecaPNG({
      gated: false,            // sem selo: não há entrega a destravar
      token: null, digitos: null, codigoArquivo: null,
      numeroPeca: null,        // não é peça: não tem número de peça
      numeroProcesso,
      titulo: tituloDocumento || cfg.titulo,
      orgao: cfg.orgao,
      unidade: unidadeDoProcesso(processo),
      data: new Date().toLocaleDateString('pt-BR'),
      qualificacao: qualificacao(processo, alvo),
      texto,
      assinante: await nomeExibicao(guild, autorId),
      cargoAssinante: cfg.emissor,
    });
  } catch (e) {
    // O documento não sair NÃO pode impedir o ato: o texto é a fonte da verdade, o PNG é a via.
    console.error(`[ato] falha ao renderizar ${tipoChave} de ${numeroProcesso}:`, e.message);
  }

  // O ANDAMENTO PRIMEIRO. No arquivamento o canal é travado logo depois, e um andamento que não
  // conseguisse ser lavrado deixaria o ato tão mudo quanto o bug que esta função corrige.
  if (andamento) {
    await andamentos.registrar(guild, numeroProcesso, { ...andamento, executorId: autorId })
      .catch(e => console.error(`[ato] falha ao lavrar ${tipoChave} de ${numeroProcesso}:`, e.message));
  }

  const canal = processo.canalId ? await guild.channels.fetch(processo.canalId).catch(() => null) : null;
  if (!canal) return { ok: true, paginas, postado: false };

  // Nome do anexo num template ÚNICO, sem aninhar e sem ternário no `name:`: a varredura de
  // scripts/testes-anexos-em-canal.js identifica o ponto pelo literal do `name:`. Template dentro
  // de template trunca a captura, e um ternário faz ela capturar o nome da VARIÁVEL — nos dois
  // casos o inventário passa a vigiar um nome que não existe.
  const arquivos = (paginas || []).map((buf, i) => {
    const folha = (paginas || []).length > 1 ? `-fl${i + 1}` : '';
    return { attachment: buf, name: `ato-${numeroProcesso}${folha}.png` };
  });
  const mensagem = await canal.send({
    content: andamento ? `📋 **${andamento.titulo}** — processo ${numeroProcesso}, por <@${autorId}>.` : null,
    ...(arquivos.length ? { files: arquivos } : {}),
    ...(componentes.length ? { components: componentes } : {}),
  }).catch(e => { console.error(`[ato] falha ao postar ${tipoChave} em ${numeroProcesso}:`, e.message); return null; });

  return { ok: true, paginas, postado: !!mensagem, mensagem };
}


// Por DM, e não no canal do processo: o canal é compartilhado com o destinatário, e postar ali
// entregaria o teor antes da cena.
//
// NENHUMA URL É GUARDADA. O anexo do Discord é conveniência de exibição, não o arquivo dos autos —
// as URLs do CDN expiram em 24h e produziriam link morto. O original é o registro no banco, e o PNG
// é regerado do texto sempre que precisar (SPEC §3.7).
async function enviarAoEmissor(ctxo, peca, renderizados) {
  const usuario = await ctxo.usuario();
  const dm = usuario ? await usuario.createDM().catch(() => null) : null;
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
async function postarNoCanal(ctxo, peca, processo, cfg) {
  const canal = processo.canalId ? await ctxo.guild.channels.fetch(processo.canalId).catch(() => null) : null;
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
    // O prazo exibido DERIVA dos destinatários reais (a válvula é POR PAPEL desde o Bloco C:
    // 6h fórum, 48h externos) — o texto fixo "24 horas" mentia para os dois lados. E o vocabulário
    // é o do processo eletrônico real: PRAZO PARA CIÊNCIA (tempo para receber) é uma coisa;
    // PRAZO PARA MANIFESTAÇÃO (tempo para agir depois de receber) é outra, e só corre da ciência.
    const horas = [...new Set(peca.destinatarios.map(d => Math.round(pecas.valvulaMsPara(d) / 3600000)))].sort((a, b) => a - b);
    const prazoTexto = horas.length === 1 ? `${horas[0]}h` : horas.map(h => `${h}h`).join(' / ');
    embed.setDescription(
      '🔒 **Teor restrito até a entrega pessoal.**\n'
      + 'O documento existe e está nos autos, mas só se abre ao destinatário quando a entrega for registrada — '
      + 'em cena, dentro do jogo, com o selo de autenticação conferido pelo sistema.\n\n'
      + `**Prazo para ciência: ${prazoTexto}** (conforme o papel do destinatário). Vencido sem entrega, `
      + 'considera-se recebido por **ciência tácita** e o prazo para manifestação passa a correr.',
    ).setFooter({ text: 'Entrega in-game — o mecanismo é público e a captura fica registrada para a staff.' });
  } else {
    embed.setDescription('Documento gerado no modo aberto: visível às partes desde a criação.');
  }

  const linha = new ActionRowBuilder();
  if (peca.gated) {
    linha.addComponents(
      new ButtonBuilder().setCustomId(`peca:entregar:${peca.numero}`).setLabel('Entregar agora').setEmoji('📤').setStyle(ButtonStyle.Primary),
      // Inativo de propósito NESTA mensagem: a janela de entrega ainda nem foi aberta, então não há
      // o que receber ainda. Fica ativo só na mensagem de "Entrega aberta" (entregarAgora, abaixo).
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
      // ATIVO aqui: é exatamente nesta janela que o destinatário deve clicar, depois do encontro em
      // cena. abrirRecebimento() (abaixo) que pede a captura, decodifica e chama pecas.receber().
      new ButtonBuilder().setCustomId(`peca:receber:${numeroPeca}`).setLabel('Receber').setEmoji('📥').setStyle(ButtonStyle.Success),
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
    ? `\n\n⚠️ Atenção: ninguém ocupa o papel de **${r.semOcupante.join(', ')}** neste processo agora, então não há quem clique em Receber. Vencido o prazo para ciência, o ato cai em **ciência tácita** sozinho.`
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
// Passo 4 — recebimento (upload da captura, decodificação do selo, lavratura)
// ---------------------------------------------------------------------------
// Um coletor por (peça, destinatário) — clique duplo no botão não abre um segundo coletor
// concorrente escutando a mesma captura, só lembra que já está esperando.
const coletoresRecebimento = new Map();
const chaveColetor = (numeroPeca, userId) => `${numeroPeca}:${userId}`;

async function abrirRecebimento(interaction, numeroPeca) {
  const meta = pecas.metadados(numeroPeca);
  if (!meta) return interaction.reply({ content: 'Peça não encontrada.', ephemeral: true });
  if (!meta.gated) return interaction.reply({ content: 'Esta peça não exige recebimento — o teor já está visível desde a criação.', ephemeral: true });

  const processo = db.buscarPorNumero(meta.processoTabela, meta.processoNumero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  // Checagens de LEITURA, sem chamar pecas.receber() ainda: chamar com tokenLido=null contaria como
  // uma tentativa ilegível de verdade (SPEC §6.4) e incrementaria o contador — aqui ainda não houve
  // captura nenhuma, só o clique no botão.
  const idx = meta.destinatarios.findIndex(d => pecas.ocupaDestinatario(meta.processoTabela, processo, d, interaction.user.id));
  if (idx === -1) return interaction.reply({ content: '❌ Você não ocupa o papel de destinatário desta peça.', ephemeral: true });
  const dest = meta.destinatarios[idx];
  if (dest.recebidoEm) return interaction.reply({ content: '✅ Esta peça já foi recebida.', ephemeral: true });
  if (dest.travado) return interaction.reply({ content: '🔒 O selo está travado por tentativas anteriores — só desembargador ou staff destrava.', ephemeral: true });
  if (!pecas.janelaAberta({ janela: meta.janela })) return interaction.reply({ content: '⏰ Não há janela de entrega aberta neste momento.', ephemeral: true });

  const chave = chaveColetor(numeroPeca, interaction.user.id);
  if (coletoresRecebimento.has(chave)) {
    return interaction.reply({ content: '📸 Já estou esperando sua captura — cole a imagem aqui no canal.', ephemeral: true });
  }

  const expira = Math.floor(new Date(meta.janela.expiraEm).getTime() / 1000);
  await interaction.reply({
    content: '📸 Cole aqui no canal a captura de tela **inteira**, tirada agora direto do jogo — sem cortar, sem editar, '
      + 'sem salvar-e-reenviar depois. Precisa mostrar o documento com o selo visível.\n'
      + `Você tem até <t:${expira}:t> (<t:${expira}:R>).`,
    ephemeral: true,
  });

  const coletor = interaction.channel.createMessageCollector({
    filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
    time: Math.max(new Date(meta.janela.expiraEm).getTime() - Date.now(), 0),
  });
  coletoresRecebimento.set(chave, coletor);
  coletor.on('end', () => coletoresRecebimento.delete(chave));

  coletor.on('collect', async (msg) => {
    const anexo = msg.attachments.find(a => (a.contentType || '').startsWith('image/')) || msg.attachments.first();
    let r; let lido;
    try {
      const resp = await fetch(anexo.url);
      const buffer = Buffer.from(await resp.arrayBuffer());
      lido = lerSelo.lerToken(buffer);
      r = pecas.receber(numeroPeca, interaction.user.id, {
        tokenLido: lido.ok ? lido.token : null,
        capturaUrl: anexo.url,
        capturaMensagemId: msg.id,
      });
    } catch (e) {
      await msg.reply({ content: `⚠️ Não consegui processar essa imagem (${e.message}). Tente enviar de novo.` }).catch(() => {});
      return;
    }

    if (r.ok) {
      coletor.stop('recebido');
      await msg.reply({ content: `✅ **Recebido.** Selo conferido — a entrega de **${numeroPeca}** está lavrada nos autos.` }).catch(() => {});
      await andamentos.registrar(interaction.guild, meta.processoNumero, {
        tipo: 'peca_recebida',
        titulo: '📥 Documento recebido em cena',
        detalhe: `${numeroPeca}: entrega pessoal confirmada pelo selo, recebida por <@${interaction.user.id}>.`,
        executorId: interaction.user.id,
        metadata: { peca: numeroPeca },
      }).catch(err => console.error(`[pecas] falha ao lavrar recebimento de ${numeroPeca}:`, err.message));

      // ELO DE DESTRAVAMENTO — a entrega já está lavrada acima. O que vem abaixo é o efeito no
      // processo, e é blindado de propósito: se falhar, a entrega continua válida. Perder a
      // lavratura por causa do efeito seria trocar um problema por um pior.
      try {
        const processoAtual = db.buscarPorNumero(meta.processoTabela, meta.processoNumero);
        const efeito = aplicarEfeitoDoRecebimento(meta.tipo, processoAtual, { numero: numeroPeca }, interaction.user.id, meta.processoTabela);
        if (efeito && efeito.recusa) {
          await msg.reply({ content: efeito.recusa }).catch(() => {});
        } else if (efeito && efeito.campos) {
          await msg.reply({ content: efeito.aviso }).catch(() => {});
          // O que acontece DEPOIS é do efeito, não daqui: cada elo mexe numa tabela diferente e tem
          // a própria narrativa. Deixar isso no coletor obrigaria a reescrevê-lo a cada elo novo.
          const efeitoCfg = EFEITOS_POS_RECEBIMENTO[meta.tipo];
          if (efeitoCfg && efeitoCfg.aoAplicar) {
            await efeitoCfg.aoAplicar(
              interaction, db.buscarPorNumero(meta.processoTabela, meta.processoNumero), { numero: numeroPeca },
            ).catch(err => console.error(`[pecas] pós-efeito de ${numeroPeca}:`, err.message));
          }
        }
      } catch (e) {
        console.error(`[pecas] efeito do recebimento de ${numeroPeca} falhou (entrega segue válida):`, e.message);
      }
      return;
    }

    // Ilegível é falha TÉCNICA (imagem ruim) — não conta para a trava, o destinatário tenta de novo.
    // lerSelo.mensagemDeFalha dá o motivo específico (formato/corrompida/sem_qr); pecas.js só sabe
    // dizer "ilegível" de forma genérica.
    if (r.motivo === 'ilegivel') {
      const razao = lido && !lido.ok ? lerSelo.mensagemDeFalha(lido.motivo) : r.razao;
      const aviso = r.avisarStaff ? '\n⚠️ Já são várias capturas ilegíveis seguidas — avise a staff se o problema persistir.' : '';
      await msg.reply({ content: `❌ ${razao}${aviso}` }).catch(() => {});
      return;
    }

    // Trava atingida agora mesmo (r.travou) OU já estava travado/já recebido/papel errado por uma
    // condição de corrida — nos dois casos não adianta insistir, encerra o coletor.
    if (r.travou || r.motivo === 'travado' || r.motivo === 'ja_recebido' || r.motivo === 'papel') {
      coletor.stop(r.motivo || 'travado');
      const sufixo = r.travou
        ? ` — depois de ${pecas.MAX_RECUSAS_TOKEN} tentativas, o selo travou. Só desembargador ou staff destrava.`
        : '';
      // Selo travado ganha o BOTÃO de destravamento na própria mensagem do canal (SPEC §6.4, teste
      // 14) — era o beco sem saída da auditoria: pecas.destravarSelo existia, testado, e NENHUM
      // clique chegava nele. O botão fica no canal (a supervisão enxerga ali); o gate de staff é no
      // clique, não na exibição — o mecanismo é público e anunciado (SPEC §2).
      const componentes = r.travou
        ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`peca:destravar:${numeroPeca}#${dest.papel}#${dest.habilitacaoId || ''}`)
              .setLabel('🔓 Destravar selo (supervisão)').setStyle(ButtonStyle.Danger),
          )]
        : [];
      await msg.reply({ content: `🔒 ${r.razao}${sufixo}`, ...(componentes.length ? { components: componentes } : {}) }).catch(() => {});
      return;
    }

    // token_invalido / token_usado / janela: recusa que CONTA para a trava, mas ainda não travou.
    await msg.reply({ content: `❌ ${r.razao} (tentativa ${r.recusasToken}/${pecas.MAX_RECUSAS_TOKEN} antes de travar).` }).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Destravamento do selo pela supervisão (SPEC §6.4, teste 14) — ligado em 19/08/2026
// ---------------------------------------------------------------------------
// Era o NONO código órfão: a função pura existia e era testada, mas selo travado era beco sem
// saída — nenhum clique chegava em pecas.destravarSelo. O fluxo: botão na mensagem de trava do
// canal → modal com motivo OBRIGATÓRIO → destrava, renova o token, limpa o cache das páginas
// públicas (o PNG impresso carrega o QR antigo) e lavra nos autos.
const gateSupervisao = (interaction) =>
  permissoes.isAdmin(interaction) || pecas.isSupervisao(interaction.user.id);

async function abrirDestravarSelo(interaction, chave) {
  if (!gateSupervisao(interaction)) {
    return interaction.reply({ content: '🔒 Só desembargador, procurador ou staff pode destravar um selo. Se você é o destinatário, chame a supervisão.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`peca:destravarmodal:${chave}`).setTitle('🔓 Destravar selo');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('motivo').setLabel('Motivo (obrigatório — vai para os autos)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400),
  ));
  return interaction.showModal(modal);
}

async function executarDestravarSelo(interaction, chave) {
  if (!gateSupervisao(interaction)) {
    return interaction.reply({ content: '🔒 Só desembargador, procurador ou staff pode destravar um selo.', ephemeral: true });
  }
  const [numeroPeca, papel, habIdTexto] = chave.split('#');
  const habilitacaoId = habIdTexto ? Number(habIdTexto) : null;
  const motivo = interaction.fields.getTextInputValue('motivo');

  const r = pecas.destravarSelo(numeroPeca, papel, interaction.user.id, motivo, { habilitacaoId });
  if (!r.ok) return interaction.reply({ content: `❌ ${r.razao}`, ephemeral: true });

  // O selo ganhou TOKEN NOVO (o anterior pode ter vazado — é o que motivou as recusas). O PNG já
  // impresso carrega o QR antigo, então o cache das páginas públicas deste destinatário é apagado:
  // o próximo acesso ao MESMO link regenera a imagem com o selo novo. O link em si não muda — o
  // endereço é permanente de propósito.
  let paginasLimpas = 0;
  for (const p of (r.destinatario.paginasPublicas || [])) {
    if (servidorPecas.apagarCache(p.token)) paginasLimpas++;
  }

  const meta = pecas.metadados(numeroPeca);
  if (meta) {
    await andamentos.registrar(interaction.guild, meta.processoNumero, {
      tipo: 'selo_destravado',
      titulo: '🔓 Selo destravado pela supervisão',
      detalhe: `${numeroPeca} (${papel}): selo destravado por <@${interaction.user.id}> — motivo: ${motivo}. Token renovado; o documento precisa ser reimpresso pelo link (a via antiga não autentica mais).`,
      executorId: interaction.user.id,
      metadata: { peca: numeroPeca, papel },
    }).catch(err => console.error('[pecas] falha ao lavrar destravamento de selo:', err.message));
  }

  return interaction.reply({
    content: `🔓 **Selo de ${numeroPeca} destravado** (${papel}). Recusas zeradas e token renovado — o destinatário pode tentar de novo, mas a captura tem que ser do documento **reimpresso pelo link** (o QR da via antiga não vale mais).`,
  });
}

// ---------------------------------------------------------------------------
// Router — prefixo `peca:`, no mesmo padrão do `edital:` (ver index.js)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FINALIZADORES — o mesmo rascunho, finais diferentes
// ---------------------------------------------------------------------------
// O componente de rascunho por trechos (modal → painel → "adicionar mais texto" → enviar) foi
// escrito acoplado a `criarPeca`: escrever em partes e virar peça eram a mesma coisa.
//
// Nem toda decisão do Juiz termina em peça. A fundamentação que ele escreve para EMITIR MANDADO,
// por exemplo, vira o teor do próprio mandado — não um documento entregue com selo. Duplicar a UI
// do rascunho para esses casos seria a segunda cópia que depois diverge da primeira.
//
// Aqui o final é injetável: quem tem um desfecho próprio registra o seu; quem não registra cai no
// `criarPeca` de sempre. Tudo antes do botão "Enviar" é idêntico nos dois caminhos.
const FINALIZADORES = new Map();
function registrarFinalizador(tipoChave, fn) { FINALIZADORES.set(tipoChave, fn); }

async function router(interaction) {
  const partes = interaction.customId.split(':');
  const acao = partes[1];

  if (interaction.isModalSubmit() && acao === 'trecho') {
    return receberTrecho(interaction, partes[2], partes.slice(3).join(':'));
  }
  if (interaction.isModalSubmit() && acao === 'destravarmodal') {
    return executarDestravarSelo(interaction, partes.slice(2).join(':'));
  }
  if (!interaction.isButton()) return;

  switch (acao) {
    case 'emitir': return abrirEmissao(interaction, partes[2], partes.slice(3).join(':'));
    case 'add': return abrirModalTrecho(interaction, partes[2], partes.slice(3).join(':'));
    case 'ver': return verRascunho(interaction, partes[2], partes.slice(3).join(':'));
    case 'undo': return desfazerTrecho(interaction, partes[2], partes.slice(3).join(':'));
    case 'anexar': return anexarAoRascunho(interaction, partes[2], partes.slice(3).join(':'));
    case 'enviar': {
      const tipoChave = partes[2];
      const alvo = partes.slice(3).join(':');
      const finalizar = FINALIZADORES.get(tipoChave) || criarPeca;
      return finalizar(interaction, tipoChave, alvo);
    }
    case 'entregar': return entregarAgora(interaction, partes.slice(2).join(':'));
    case 'encerrar': return encerrarEntrega(interaction, partes.slice(2).join(':'));
    case 'receber': return abrirRecebimento(interaction, partes.slice(2).join(':'));
    case 'destravar': return abrirDestravarSelo(interaction, partes.slice(2).join(':'));
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
      // aconteceu além de "a válvula estourou". "Ciência tácita" é o termo do PJe real (renomeado
      // em 19/08/2026): decorrido o prazo para ciência sem consulta, considera-se intimado.
      // O `tipo` interno fica como está — é chave de dado, não texto exibido, e mudá-lo quebraria
      // consultas sobre andamentos antigos.
      tipo: 'peca_valvula_24h',
      titulo: '⏰ Ciência tácita',
      detalhe: `${d.peca}: decorrido o prazo para ciência sem entrega pessoal, considera-se recebido (ciência tácita). Não houve encontro registrado; o prazo para manifestação passa a correr.`,
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

  await publicarRelatorioSemanal(guild).catch(err => console.error('[pecas] relatório semanal:', err.message));
}

// ---------------------------------------------------------------------------
// Relatório semanal da válvula — a métrica obrigatória da SPEC §7, EMPURRADA
// ---------------------------------------------------------------------------
// POR QUE AUTOMÁTICO E NÃO BOTÃO: métrica que só existe para quem sabe que ela existe é código
// órfão de outro tipo — construída, testada e nunca acionada. Já aconteceu cinco vezes neste
// projeto. Botão no painel depende de alguém LEMBRAR de clicar; relatório empurrado chega sozinho.
//
// Cadência semanal porque é a unidade que a SPEC pede ("contar atos por semana") e porque é o
// intervalo em que o número significa alguma coisa: diário oscilaria com o fim de semana e viraria
// ruído que a staff aprende a ignorar — que é como uma métrica morre sem ninguém desligar.
//
// O marcador vai para `estado` (persistido): sem isso o relatório sairia de novo a cada boot, e
// spam é a outra forma de a staff parar de ler.
const CHAVE_ULTIMO_RELATORIO = 'valvulaRelatorioSemanalEm';
const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

async function publicarRelatorioSemanal(guild, { agora = Date.now() } = {}) {
  const estado = require('./estado');
  const ultimo = estado.obter(CHAVE_ULTIMO_RELATORIO);
  if (ultimo && agora - new Date(ultimo).getTime() < SEMANA_MS) return null;

  // Primeira execução: marca sem publicar. Publicar na estreia mandaria um relatório de "desde o
  // começo dos tempos", que não é uma semana e induziria leitura errada logo no primeiro contato.
  if (!ultimo) { estado.definir(CHAVE_ULTIMO_RELATORIO, new Date(agora).toISOString()); return null; }

  const desde = new Date(agora - SEMANA_MS).toISOString();
  const rel = pecas.relatorioValvula({ desde, ate: new Date(agora).toISOString() });
  estado.definir(CHAVE_ULTIMO_RELATORIO, new Date(agora).toISOString());

  const canalId = config.canalAuditoriaId;
  const canal = guild && canalId ? await guild.channels.fetch(canalId).catch(() => null) : null;
  if (!canal || !canal.isTextBased?.()) return null;

  const pct = (n) => `${Math.round(n * 100)}%`;
  const linhas = [
    '📊 **Entrega in-game — relatório semanal (SPEC §7)**',
    '',
  ];

  if (!rel.total) {
    linhas.push('Nenhum ato foi recebido nesta semana. **Não há número a interpretar** — não é "está tudo bem".');
  } else {
    linhas.push(`**${rel.total}** ato(s) recebido(s): **${rel.pessoal}** em cena, **${rel.valvula}** por ciência tácita.`);
    linhas.push(`Proporção por ciência tácita: **${pct(rel.proporcaoValvula)}**.`);
    if (rel.pendentes) linhas.push(`Pendentes agora: ${rel.pendentes}.`);
    linhas.push('');

    // TETO na lista por tipo: mensagem do Discord estoura em 2000 caracteres, e esta lista é a
    // única parte que cresce sem limite (um tipo novo = uma linha nova, papéis dentro dela). Corta
    // nos 12 primeiros e DIZ quantos ficaram de fora — truncamento silencioso leria como "cobri
    // tudo" quando não cobriu (mesma regra dos scans da suíte).
    const tipos = Object.entries(rel.porTipo);
    for (const [tipo, d] of tipos.slice(0, 12)) {
      const t = d.valvula + d.pessoal;
      const porPapel = Object.entries(d.porPapel)
        .map(([papel, v]) => `${papel} ${v.valvula}/${v.valvula + v.pessoal}`).join(', ');
      linhas.push(`• \`${tipo}\` — ${d.valvula}/${t} por ciência tácita (${porPapel})`);
    }
    if (tipos.length > 12) linhas.push(`…e mais ${tipos.length - 12} tipo(s) — veja o botão 📊 no painel de Administração.`);

    // A leitura que a dimensão de horário permite, escrita por extenso: sem isso o leitor vê a
    // proporção alta e conclui "ninguém se encontra", que pode ser a conclusão errada.
    if (rel.faixaCritica && rel.faixaCritica.concentrado) {
      linhas.push('');
      linhas.push(`⏰ **${pct(rel.faixaCritica.proporcao)} dos disparos** se concentram entre `
        + `**${rel.faixaCritica.inicio}h e ${rel.faixaCritica.fim}h** (horário local).`);
      linhas.push('Isso tem cara de **intervalo entre sessões comendo o prazo**, não de gente que não se encontra — '
        + 'o ajuste seria no relógio da válvula, não no desenho da entrega.');
    } else if (rel.valvula >= 5) {
      linhas.push('');
      linhas.push('⏰ Os disparos estão **espalhados pelo dia** — não é o intervalo entre sessões. '
        + 'Se a proporção estiver alta, o encontro é que não está acontecendo.');
    }

    if (rel.proporcaoValvula >= 0.5) {
      linhas.push('');
      linhas.push('⚠️ **Metade ou mais dos atos destravou sozinho.** É o gatilho de recuo da SPEC §11.2.2 — '
        + 'olhe a faixa de horário acima antes de decidir, porque as duas causas pedem ajustes opostos.');
    }
  }

  await canal.send({ content: linhas.join('\n') }).catch(() => {});
  console.log(`[pecas] relatório semanal da válvula publicado — ${rel.total} ato(s), ${rel.valvula} pela válvula.`);
  return rel;
}

module.exports = {
  router, TIPOS, tipoAtivo, abrirEmissao, criarPeca, entregarAgora, encerrarEntrega,
  receberTrecho, verRascunho, desfazerTrecho, abrirModalTrecho, abrirRecebimento, anexarAoRascunho,
  publicarAtoNoCanal, // ato do Juízo publicado nos autos: PNG paginado, sem selo, postado no canal
  estimarPaginas, linhaCusto, MAX_TRECHOS, MAX_CHARS_TRECHO, CHARS_POR_PAGINA, TTL_RASCUNHO_MS,
  verificarValvulaEEncerramento, publicarRelatorioSemanal, unidadeDoProcesso,
  qualificacao, // exportada para teste: e ela que classifica o rito no cabecalho do documento
  lavrarPendenciaDeAnexo, // exportada para teste: e ela que NAO pode escrever nome de arquivo nos autos
  aplicarEfeitoDoRecebimento, EFEITOS_POS_RECEBIMENTO, // elo "documento entregue -> proxima etapa"
  finalizarPeca, emitirAtoComoPeca, // pipeline de emissao reusado por sentenca e recurso
  registrarFinalizador, lerRascunho, textoDoRascunho, limparRascunho, // rascunho por trechos, reusavel
  semearRascunho, painelDeRascunho, MAX_TRECHOS,
};
