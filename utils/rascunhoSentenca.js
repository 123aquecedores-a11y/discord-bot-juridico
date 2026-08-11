// Estado em memória (por Juiz + processo) das atenuantes marcadas na tela de apoio à sentença
// condenatória, entre o select menu (que não guarda estado sozinho) e a submissão do modal de
// pena/regime/texto. Mesma ideia de rascunhoCrimes.js: se o bot reiniciar no meio, o Juiz só
// reabre "Julgar" e recomeça.
const rascunhos = new Map();

function chave(userId, numero) {
  return `${userId}#${numero}`;
}

function definir(userId, numero, atenuantes) {
  rascunhos.set(chave(userId, numero), atenuantes);
}

function obter(userId, numero) {
  return rascunhos.get(chave(userId, numero)) || [];
}

function limpar(userId, numero) {
  rascunhos.delete(chave(userId, numero));
}

module.exports = { definir, obter, limpar };
