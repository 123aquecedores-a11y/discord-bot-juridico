// Engine de publicação no Diário Oficial POR NATUREZA DO ATO — não uma linha de lógica de publicação
// em cada handler. Cada natureza DECLARA: nível, um predicado publicavel(record) (o estado ATUAL do
// registro justifica publicar agora?) e um montador do card. O handler só diz "este ato aconteceu";
// a engine decide nível/card/idempotência/anexo.
//
// publicarAto é:
//  - IDEMPOTENTE: marca diarioPublicadoEm no registro; nunca republica o mesmo ato.
//  - BLINDADA: nunca lança — uma falha aqui não pode quebrar o ato principal (decisão/arquivamento).
//  - REUSÁVEL pela varredura (Etapa 5): a mesma publicarAto faz o backfill e pega transições de
//    estado (Nível 2 publica no cumprimento) — nada de lógica de publicação espalhada.
const db = require('../database/db');
const diario = require('./diarioOficial');

// Rótulo do tipo de petição administrativa no card. O Diário é dono da sua própria apresentação —
// não importamos TIPO_LABEL de commands/peticao.js pra evitar require circular (peticao ↔ diarioAtos).
const LABEL_PETICAO = {
  PorteArma: 'Porte de Arma',
  TrocaNome: 'Troca de Nome',
  LimpezaFicha: 'Limpeza de Ficha',
  AlvaraEvento: 'Alvará de Evento',
};

// ============================================================================================
// POLÍTICA DE SIGILO — QUE TIPO DE MANDADO PODE APARECER NO DIÁRIO
// ============================================================================================
// Isto é REGRA DE POLÍTICA (decisão do operador), não detalhe de implementação. Vive num lugar
// só, com os tipos escritos por extenso, pra que a resposta a "por que isso publicou?" seja
// sempre esta lista — e não um `if` perdido num handler.
//
// A decisão tem duas metades, e as duas estão aqui:
//
//   1) DENY-LIST DURA — estes tipos NUNCA publicam, em estado NENHUM (emitido, cumprido ou não
//      cumprido). Publicar diligência de busca, de sigilo bancário/telemático, de interceptação
//      ou de condução expõe investigação e pessoa mesmo DEPOIS de cumprida: o card no canal
//      público vira registro permanente, pesquisável, de quem foi alvo do quê.
//
//   2) ALLOW-LIST — só estes publicam, e só no CUMPRIMENTO (natureza mandadoCumprido). Prisão
//      preventiva/temporária é ato ostensivo por natureza: no momento em que se cumpre, a pessoa
//      já está presa e o fato é público.
//
// QUEM DECIDE É A ALLOW-LIST. Essa é a parte que faz "tipo novo nasce bloqueado por padrão"
// valer de verdade: se amanhã alguém acrescentar "Interceptação Ambiental" (ou o Promotor
// escrever qualquer coisa no campo livre do tipo "Outro"), ele NÃO está na allow-list e não
// publica — sem ninguém precisar lembrar de adicioná-lo à deny-list. A deny-list continua
// escrita porque é a política declarada: ela documenta a intenção e serve de segunda trava se
// alguém um dia mexer na allow-list sem pensar.
const MANDADOS_QUE_NUNCA_PUBLICAM = [
  'Busca e Apreensão',
  'Quebra de Sigilo',
  'Interceptação Telefônica',
  'Condução Coercitiva',
];
const MANDADOS_QUE_PUBLICAM_AO_CUMPRIR = [
  'Prisão Preventiva',
  'Prisão Temporária',
];

// Comparação normalizada (sem acento, minúscula, espaços colapsados) porque o `tipo` do mandado é
// TEXTO — vem do rótulo do select, mas também do campo livre do tipo "Outro". "PRISAO PREVENTIVA",
// "Prisão  Preventiva" e "prisao preventiva" são o mesmo tipo; e a deny-list não pode ser furada
// por uma variação de acento.
function normalizarTipoMandado(tipo) {
  return String(tipo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const DENY = new Set(MANDADOS_QUE_NUNCA_PUBLICAM.map(normalizarTipoMandado));
const ALLOW = new Set(MANDADOS_QUE_PUBLICAM_AO_CUMPRIR.map(normalizarTipoMandado));

// Fail-closed: sem tipo, tipo desconhecido ou tipo na deny-list → NÃO publica.
function mandadoPodePublicar(mandado) {
  const tipo = normalizarTipoMandado(mandado && mandado.tipo);
  if (!tipo) return false;      // mandado sem tipo: bloqueado (não dá pra afirmar que é ostensivo)
  if (DENY.has(tipo)) return false;
  return ALLOW.has(tipo);
}

// Registro data-driven das naturezas de ato que publicam. Cresce por etapa (arquivamento de
// inquérito, indeferimento inicial, mandado cumprido...) sem tocar em publicarAto. "Ato novo herda
// o critério": basta declarar a natureza aqui.
const NATUREZAS = {
  // NÍVEL 1 — decisão de pedido administrativo do cidadão (porte de arma, troca de nome, limpeza de
  // ficha, alvará). Publica NA HORA, deferido OU indeferido. A Diligência (Nível 3) nunca chega aqui:
  // o handler só chama esta natureza no ramo de decisão final, não no de diligência.
  peticaoAdministrativa: {
    tabela: 'peticoes',
    nivel: 1,
    publicavel: (p) => !!p && (p.status === 'Deferido' || p.status === 'Indeferido'),
    montar: (p) => ({
      tipo: 'peticao_administrativa',
      dados: {
        numero: p.numero,
        tipoPeticao: LABEL_PETICAO[p.tipo] || p.tipo,
        resultado: p.status,
        parte: p.nomeCliente || p.nomeNovo || null,
        validadeAte: p.validadeAte || null,
        magistradoId: p.juiz || null,
      },
    }),
  },

  // NÍVEL 1 — arquivamento de inquérito (MP promove o arquivamento). Penal. Publica na decisão.
  // Predicado casa por tipo pra ser mutuamente exclusivo com indeferimentoInicial (a varredura da
  // Etapa 5 nunca publica os dois pro mesmo processo).
  arquivamentoInquerito: {
    tabela: 'processos',
    nivel: 1,
    publicavel: (p) => !!p && p.status === 'Arquivado' && p.tipo === 'Penal',
    montar: (p) => ({ tipo: 'arquivamento_inquerito', dados: { numero: p.numero, promotorId: p.promotor || null } }),
    // POLÍTICA: o card publica número, decisão e fundamento resumido — e SÓ. O PDF do relatório da
    // Polícia Civil NÃO é anexado. Ele traz o inquérito inteiro (indiciado, testemunhas, teor das
    // diligências); anexá-lo ao canal público transformava "arquivei o inquérito" em publicação
    // integral dos autos. Quem tem direito ao teor continua acessando pelo ticket do processo, onde
    // o PDF segue guardado em documentosAnexados. Antes existia aqui um `files:` que buscava o
    // relatorio_inquerito — removido de propósito; não reintroduza sem decisão explícita.
  },

  // NÍVEL 1 — indeferimento/arquivamento da petição inicial cível (Juiz indefere a inicial). Cível.
  indeferimentoInicial: {
    tabela: 'processos',
    nivel: 1,
    publicavel: (p) => !!p && p.status === 'Arquivado' && p.tipo !== 'Penal',
    montar: (p) => ({ tipo: 'indeferimento_inicial', dados: { numero: p.numero, juizId: p.juiz || null } }),
  },

  // NÍVEL 1 — desarquivamento (Procurador força a denúncia em revisão): reverte um arquivamento já
  // publicado e muda o status PÚBLICO do caso (arquivado → em curso). Publica pra o Diário não ficar
  // mostrando "arquivado" pra sempre. revisaoArquivamento='Decidida' + status 'Instrução' distingue
  // forçar (reabre) de manter (segue arquivado, Nível 3).
  desarquivamento: {
    tabela: 'processos',
    nivel: 1,
    publicavel: (p) => !!p && p.status === 'Instrução' && p.revisaoArquivamento === 'Decidida',
    montar: (p) => ({ tipo: 'desarquivamento', dados: { numero: p.numero, juizId: p.juiz || null } }),
  },

  // NÍVEL 2 — mandado CUMPRIDO. A cautelar (busca/prisão/quebra) só publica AQUI, no cumprimento,
  // nunca no deferimento (publicar antes avisaria o alvo e queimaria a diligência). O alvo já sabe
  // no momento em que o mandado é cumprido — daí publicar deixa de ser vazamento.
  // Filtrado pela política de sigilo acima: mesmo cumprido, só publica o que está na allow-list
  // (prisão preventiva/temporária). Busca, quebra de sigilo, interceptação, condução e qualquer
  // tipo novo/livre não publicam nunca — ver MANDADOS_QUE_PUBLICAM_AO_CUMPRIR.
  mandadoCumprido: {
    tabela: 'mandados',
    nivel: 2,
    publicavel: (m) => !!m && m.status === 'Cumprido' && mandadoPodePublicar(m),
    montar: (m) => ({ tipo: 'mandado_cumprido', dados: { numero: m.numero, tipoMandado: m.tipo, alvo: m.alvo, processoNumero: m.processoVinculado || null, cumpridoPorId: m.cumpridoPor || null } }),
  },

  // NÍVEL 2 (escape) — DESLIGADO POR POLÍTICA. Antes, mandado emitido e nunca cumprido de caso já
  // encerrado publicava um card "não cumprido" pra o sigilo não ficar indefinido. Não publica mais
  // NADA — nem o tipo, nem o alvo, nem a existência do mandado.
  //
  // Por quê: o card de "não cumprido" era o pior dos dois mundos. Ele não informava nada de útil ao
  // público e ainda revelava, de forma permanente, que existiu diligência contra aquela pessoa — que
  // sequer chegou a acontecer. "Fechar o sigilo" nunca foi um bem em si; o silêncio já fecha.
  //
  // A natureza continua declarada aqui, e não apagada, pra que a regra fique visível ao lado das
  // outras: publicavel é SEMPRE false, e a varredura não chama mais o escape. Reativar exige decisão
  // explícita, não um descuido.
  mandadoNaoCumprido: {
    tabela: 'mandados',
    nivel: 2,
    publicavel: () => false,
    montar: () => ({ tipo: 'mandado_nao_cumprido', dados: {} }), // inalcançável — publicavel é false
  },
};

/**
 * Publica um ato no Diário Oficial pela sua NATUREZA. Idempotente e blindada.
 * @param {import('discord.js').Guild} guild
 * @param {string} natureza  chave de NATUREZAS
 * @param {Object} record    o registro do ato (peticao/processo/medida...)
 * @param {Object} [opts]    opts.files: anexos já prontos (ex.: PNG da sentença, PDF do relatório)
 * @returns {Promise<boolean>} true se publicou agora
 */
async function publicarAto(guild, natureza, record, opts = {}) {
  try {
    const def = NATUREZAS[natureza];
    if (!def || !guild || !record) return false;
    // Idempotência POR NATUREZA (não por registro): um mesmo processo pode publicar atos distintos
    // ao longo da vida (arquivamento de inquérito → depois desarquivamento → depois sentença). Cada
    // natureza ocupa um slot próprio no mapa; só não se republica o MESMO ato.
    if (record.diarioPublicado && record.diarioPublicado[natureza]) return false;
    if (!def.publicavel(record)) return false;         // o estado atual ainda não justifica publicar
    const { tipo, dados } = def.montar(record, guild);
    // Anexo: usa o que o handler passou; senão deixa a natureza buscar (ex.: PDF do relatório do
    // inquérito). Blindado — anexo que falhe não impede a publicação do card.
    let files = Array.isArray(opts.files) && opts.files.length ? opts.files : null;
    if (!files && typeof def.files === 'function') {
      files = await Promise.resolve(def.files(record, guild)).catch(() => null);
    }
    files = Array.isArray(files) && files.length ? files : undefined;
    // silencioso: a varredura/backfill publica SEM @everyone (senão o backlog floodaria pings); o
    // ato em tempo real (chamado do handler) mantém o ping.
    const enviada = await diario.publicarNoDiario(guild, tipo, { ...dados, ...(files ? { files } : {}), silencioso: !!opts.silencioso });
    // Diário não configurado / canal sumiu / sem permissão → publicarNoDiario devolve false. NÃO
    // marca: assim a varredura (Etapa 5) tenta de novo depois, em vez de perder a publicação.
    if (!enviada) return false;
    const diarioPublicado = {
      ...(record.diarioPublicado || {}),
      [natureza]: { em: new Date().toISOString(), messageId: enviada.id || null }, // messageId p/ o card evoluir (Etapa 5)
    };
    db.atualizar(def.tabela, record.numero, { diarioPublicado });
    return true;
  } catch (e) {
    console.error(`[diarioAtos] falha ao publicar ato "${natureza}" (ignorado, não quebra o ato):`, e.message);
    return false;
  }
}

// Um mandado está "abandonado" quando foi emitido, NUNCA cumprido, e o caso já encerrou.
// ATENÇÃO: isto NÃO dispara mais publicação nenhuma — o escape do Nível 2 foi desligado por
// política (ver a natureza mandadoNaoCumprido). A função continua aqui só como CONSULTA (saber
// quais mandados ficaram para trás, para conferência interna/diagnóstico). Se voltar a ser usada,
// que seja para relatório privado — nunca para alimentar o Diário.
function mandadoAbandonado(m) {
  if (!m || m.status !== 'Emitido') return false;
  if (m.medidaNumero) {
    const med = db.buscarPorNumero('medidas', m.medidaNumero);
    if (med && (med.arquivadoManual || ['Negada', 'Indeferida', 'Indeferida pelo Juiz'].includes(med.status))) return true;
  }
  if (m.processoVinculado) {
    const proc = db.buscarPorNumero('processos', m.processoVinculado);
    if (proc && (proc.arquivadoManual || ['Arquivado', 'Encerrado'].includes(proc.status))) return true;
  }
  return false;
}

// Naturezas que a varredura publica automaticamente (backfill + rede de segurança): a decisão já
// está refletida no estado do registro. mandadoNaoCumprido NÃO entra aqui — não publica mais nada,
// em nenhum gatilho (política de sigilo).
const NATUREZAS_VARREDURA = ['peticaoAdministrativa', 'arquivamentoInquerito', 'indeferimentoInicial', 'desarquivamento', 'mandadoCumprido'];

function jaPublicou(record, natureza) {
  return !!(record && record.diarioPublicado && record.diarioPublicado[natureza]);
}

// Varredura do Diário — roda no job diário. Publica, EM SILÊNCIO (sem @everyone), todo ato decisório
// que já deveria ter publicado e não publicou: é o BACKFILL retroativo (ex.: o porte de arma decidido
// antes desta feature) e a rede de segurança pra qualquer handler que tenha falhado. Idempotente
// (marcador por natureza). Fecha também o escape do Nível 2 (mandado nunca cumprido de caso encerrado).
async function varrerDiario(guild) {
  if (!guild) return { publicados: 0 };
  let publicados = 0;
  for (const natureza of NATUREZAS_VARREDURA) {
    const def = NATUREZAS[natureza];
    // Cronológico: publica o backlog na ordem em que os casos nasceram (proxy da ordem dos atos).
    const pendentes = db.todos(def.tabela, (r) => def.publicavel(r) && !jaPublicou(r, natureza))
      .sort((a, b) => String(a.criadoEm || '').localeCompare(String(b.criadoEm || '')));
    for (const r of pendentes) {
      if (await publicarAto(guild, natureza, r, { silencioso: true })) publicados++;
    }
  }
  // O escape do Nível 2 (publicar "não cumprido" quando o caso encerrava sem cumprimento) foi
  // REMOVIDO por política — ver a natureza mandadoNaoCumprido acima. Mandado não cumprido não vira
  // publicação nenhuma; o silêncio é o resultado desejado, não uma lacuna a ser preenchida.
  if (publicados) console.log(`📜 [diario] Varredura: ${publicados} ato(s) publicado(s) em silêncio (backfill/escape).`);
  return { publicados };
}

module.exports = {
  publicarAto, varrerDiario, mandadoAbandonado, NATUREZAS, LABEL_PETICAO,
  // Política de sigilo exposta pra ser testada e consultada por nome (não recopie as listas).
  mandadoPodePublicar, MANDADOS_QUE_NUNCA_PUBLICAM, MANDADOS_QUE_PUBLICAM_AO_CUMPRIR,
};
