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
    const files = Array.isArray(opts.files) && opts.files.length ? opts.files : undefined;
    const enviada = await diario.publicarNoDiario(guild, tipo, { ...dados, ...(files ? { files } : {}) });
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

module.exports = { publicarAto, NATUREZAS, LABEL_PETICAO };
