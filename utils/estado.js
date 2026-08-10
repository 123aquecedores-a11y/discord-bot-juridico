// Estado simples do bot que precisa sobreviver a restart (chave/valor) — hoje só guarda o ID
// da mensagem fixa do painel, pra achar ela de novo com certeza em vez de vasculhar as últimas
// mensagens do canal (que falhava depois que o canal acumulava mais de 20 mensagens).
const db = require('../database/db');

function obter(chave) {
  const r = db.buscarUm('estado', e => e.chave === chave);
  return r ? r.valor : null;
}

function definir(chave, valor) {
  const existente = db.buscarUm('estado', e => e.chave === chave);
  if (existente) return db.atualizarPorFiltro('estado', e => e.chave === chave, { valor });
  return db.inserir('estado', { chave, valor });
}

module.exports = { obter, definir };
