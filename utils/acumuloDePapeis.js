// ACÚMULO DE PAPÉIS NA ABERTURA — decisão do operador, 19/08/2026.
//
// A REGRA: quando quem abre o processo penal (ou a medida) tem cargo de PROMOTOR e não há delegado
// separado, a pessoa consta como DELEGADO **e** PROMOTOR. Acumular esses dois é permitido — no RP
// eles estão do mesmo lado da mesa (persecução penal), e exigir um delegado que não existe só trava
// o caso esperando alguém que ninguém vai chamar.
//
// O QUE NÃO PODE ACUMULAR, e por quê:
//   Juiz + Promotor            — quem acusa não julga. É a separação que sustenta o processo.
//   Promotor + Advogado (defesa) — quem acusa não defende. Conflito de interesse direto.
// Estes dois ficam BLOQUEADOS aqui, e o bloqueio é explícito para ninguém "consertar" mais tarde
// achando que foi esquecimento.
//
// Mora num módulo próprio porque penal e medida precisam da MESMA regra — duplicar seria garantir
// que um dia divergem, que é exatamente o defeito que a auditoria achou no catálogo de rótulos.
const rh = require('./rh');

// Pares que NUNCA podem ser a mesma pessoa, mesmo que alguém peça.
const PROIBIDOS = [
  ['Juiz', 'Promotor'],
  ['Promotor', 'Advogado'],
];

// Quem abre é `aberturaPorId`. Devolve { delegado, promotor, acumulou } já resolvidos.
//
// `promotorInformado` tem prioridade: se a abertura escolheu um promotor explicitamente, respeita —
// o acúmulo é para o caso de NÃO haver ninguém do outro lado, não para sobrescrever escolha.
function resolverDelegadoEPromotor({ aberturaPorId, delegadoId = null, promotorInformado = null }) {
  const abridorEhPromotor = !!aberturaPorId && rh.temCargo(aberturaPorId, 'Promotor');

  // CASO 1 — abertura direta pelo MP (sem inquérito policial por trás): não veio delegado, e quem
  // abriu é promotor. Ele ocupa os dois papéis.
  if (!delegadoId && abridorEhPromotor && !promotorInformado) {
    return { delegado: aberturaPorId, promotor: aberturaPorId, acumulou: true };
  }

  // CASO 2 — o "delegado" informado é, na verdade, um promotor abrindo pelo painel (o painel passa
  // sempre `delegadoId: interaction.user.id`, sem olhar o cargo). Sem promotor informado, acumula.
  if (delegadoId && !promotorInformado && rh.temCargo(delegadoId, 'Promotor')) {
    return { delegado: delegadoId, promotor: delegadoId, acumulou: true };
  }

  // CASO 3 — veio promotor informado e não veio delegado, e quem abriu é o próprio promotor
  // informado: mesma pessoa dos dois lados, acumula igual.
  if (!delegadoId && promotorInformado && promotorInformado === aberturaPorId && abridorEhPromotor) {
    return { delegado: promotorInformado, promotor: promotorInformado, acumulou: true };
  }

  return { delegado: delegadoId || null, promotor: promotorInformado || null, acumulou: false };
}

// Trava dos pares proibidos. Devolve null se estiver tudo certo, ou a mensagem do impedimento.
//
// `papeis` é um mapa { Juiz: id, Promotor: id, Advogado: id, ... } — só compara os que existirem.
function conflitoDePapeis(papeis = {}) {
  for (const [a, b] of PROIBIDOS) {
    const ida = papeis[a];
    const idb = papeis[b];
    if (ida && idb && ida === idb) {
      return `A mesma pessoa não pode ser **${a}** e **${b}** no mesmo caso — ${a === 'Juiz' ? 'quem acusa não julga' : 'quem acusa não defende'}.`;
    }
  }
  return null;
}

module.exports = { resolverDelegadoEPromotor, conflitoDePapeis, PROIBIDOS };
