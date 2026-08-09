// Estado em memória (por usuário) enquanto alguém monta a lista de crimes de um processo
// penal ainda não criado. Não precisa persistir em disco: se o bot reiniciar no meio do
// fluxo, a pessoa só recomeça pelo painel.
const rascunhos = new Map();

function iniciar(userId, { tipo, dados }) {
  rascunhos.set(userId, { tipo, dados, crimes: [] });
}

function obter(userId) {
  return rascunhos.get(userId) || null;
}

function adicionarCrimes(userId, ids) {
  const r = rascunhos.get(userId);
  if (!r) return null;
  r.crimes = [...new Set([...r.crimes, ...ids])];
  return r;
}

function limpar(userId) {
  rascunhos.delete(userId);
}

module.exports = { iniciar, obter, adicionarCrimes, limpar };
