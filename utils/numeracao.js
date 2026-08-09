// Formato novo: sigla embutida sem hífen, contagem própria por tipo — 0001PN, 0002CV, 0001MD, 0001MO...
// `filtro` restringe a contagem a um subconjunto da tabela (ex: só processos Penais dentro de 'processos').
function proximoNumero(db, tabela, sigla, filtro = null) {
  const total = filtro ? db.todos(tabela, filtro).length : db.contar(tabela);
  return `${String(total + 1).padStart(4, '0')}${sigla}`;
}

// Formato antigo, mantido só pra ofício (OFI-0001), por decisão explícita.
function proximoNumeroClassico(db, tabela, prefixo) {
  const total = db.contar(tabela);
  return `${prefixo}-${String(total + 1).padStart(4, '0')}`;
}

module.exports = { proximoNumero, proximoNumeroClassico };
