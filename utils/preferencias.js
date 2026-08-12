// Preferências por pessoa (por Discord ID). Hoje guarda só o "revisão automática da IA":
// quando LIGADA, os fluxos de fundamentação (sentença, parecer, acórdão, razões, medida) pulam
// a tela de "Revisar/Publicar" e já publicam o texto revisado pela IA automaticamente. Continua
// fiel ao princípio do bot — a IA só corrige a REDAÇÃO (gramática/clareza), nunca o mérito; a
// decisão em si continua sendo do jogador (foi ele quem escreveu e quem ligou o modo).
const db = require('../database/db');

function revisaoAutomaticaLigada(userId) {
  const p = db.buscarUm('preferencias', r => r.discordId === userId);
  return !!(p && p.revisaoAutomatica);
}

// Alterna o modo e devolve o novo estado (true = ligada).
function alternarRevisaoAutomatica(userId) {
  const atual = db.buscarUm('preferencias', r => r.discordId === userId);
  if (atual) {
    db.atualizarPorFiltro('preferencias', r => r.discordId === userId, { revisaoAutomatica: !atual.revisaoAutomatica });
    return !atual.revisaoAutomatica;
  }
  db.inserir('preferencias', { discordId: userId, revisaoAutomatica: true });
  return true;
}

module.exports = { revisaoAutomaticaLigada, alternarRevisaoAutomatica };
