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
const anexos = require('./anexos');

// Rótulo do tipo de petição administrativa no card. O Diário é dono da sua própria apresentação —
// não importamos TIPO_LABEL de commands/peticao.js pra evitar require circular (peticao ↔ diarioAtos).
const LABEL_PETICAO = {
  PorteArma: 'Porte de Arma',
  TrocaNome: 'Troca de Nome',
  LimpezaFicha: 'Limpeza de Ficha',
  AlvaraEvento: 'Alvará de Evento',
};

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
    // TEXTO LONGO: o relatório do inquérito (Polícia Civil) chega a 12-20k chars e NÃO cabe inline
    // (embed corta em 4096). Vai como ANEXO — o PDF já existe em documentosAnexados (tipo
    // relatorio_inquerito), buscado pelo número do processo. O card fica curto; o teor íntegro no PDF.
    files: (p) => {
      const docs = anexos.listarPorProtocolo(p.numero) || [];
      const rel = docs.find(d => d.tipo === 'relatorio_inquerito' && d.url);
      return rel ? [{ attachment: rel.url, name: rel.nomeArquivo || `Relatorio-Inquerito-${p.numero}.pdf` }] : null;
    },
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
  mandadoCumprido: {
    tabela: 'mandados',
    nivel: 2,
    publicavel: (m) => !!m && m.status === 'Cumprido',
    montar: (m) => ({ tipo: 'mandado_cumprido', dados: { numero: m.numero, tipoMandado: m.tipo, alvo: m.alvo, processoNumero: m.processoVinculado || null, cumpridoPorId: m.cumpridoPor || null } }),
  },

  // NÍVEL 2 (escape) — mandado que NUNCA foi cumprido e cujo caso já encerrou. Publica com resultado
  // "não cumprido" pra fechar o sigilo (nunca indefinido). Quem decide QUANDO chamar é a varredura
  // (varrerDiario) — só quando a medida/processo encerra; o predicado aqui só impede republicar um
  // mandado que na verdade foi cumprido.
  mandadoNaoCumprido: {
    tabela: 'mandados',
    nivel: 2,
    publicavel: (m) => !!m && m.status === 'Emitido',
    montar: (m) => ({ tipo: 'mandado_nao_cumprido', dados: { numero: m.numero, tipoMandado: m.tipo, alvo: m.alvo, processoNumero: m.processoVinculado || null } }),
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

// Um mandado está "abandonado" (escape do Nível 2) quando foi emitido, NUNCA cumprido, e o caso já
// encerrou — aí publica-se "não cumprido" pra o sigilo nunca ser indefinido. Conservador: na dúvida
// (caso ainda em curso) NÃO publica; o mandado segue sigiloso até encerrar de verdade.
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
// está refletida no estado do registro. mandadoNaoCumprido NÃO entra aqui — o escape tem gatilho
// próprio (o caso precisa ter encerrado), tratado à parte.
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
  // Escape do Nível 2: mandado emitido, nunca cumprido, de caso já encerrado → publica "não cumprido".
  const abandonados = db.todos('mandados', (m) => mandadoAbandonado(m) && !jaPublicou(m, 'mandadoNaoCumprido'));
  for (const m of abandonados) {
    if (await publicarAto(guild, 'mandadoNaoCumprido', m, { silencioso: true })) publicados++;
  }
  if (publicados) console.log(`📜 [diario] Varredura: ${publicados} ato(s) publicado(s) em silêncio (backfill/escape).`);
  return { publicados };
}

module.exports = { publicarAto, varrerDiario, mandadoAbandonado, NATUREZAS, LABEL_PETICAO };
