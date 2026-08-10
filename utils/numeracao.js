// Formato novo: sigla embutida sem hífen, contagem própria por tipo — 0001PN, 0002CV, 0001MD, 0001MO...
// `filtro` restringe a contagem a um subconjunto da tabela (ex: só processos Penais dentro de 'processos').
//
// Baseado no MAIOR número já usado, não na contagem de registros sobreviventes — contagem
// reemite números já usados assim que algum registro anterior é apagado (ex: limpeza de teste),
// causando dois registros diferentes com o mesmo número (colisão real observada: dois processos
// "0007CV" — um de teste apagado e um posterior reaproveitando o mesmo número).
function proximoNumero(db, tabela, sigla, filtro = null) {
  const registros = filtro ? db.todos(tabela, filtro) : db.todos(tabela);
  const maiorAtual = registros.reduce((max, r) => {
    if (typeof r.numero !== 'string' || !r.numero.endsWith(sigla)) return max;
    const n = parseInt(r.numero.slice(0, -sigla.length), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${String(maiorAtual + 1).padStart(4, '0')}${sigla}`;
}

// Formato antigo, mantido só pra ofício (OFI-0001), por decisão explícita. Mesmo motivo do
// maiorAtual acima — contagem de sobreviventes reemite número já usado.
function proximoNumeroClassico(db, tabela, prefixo) {
  const registros = db.todos(tabela);
  const maiorAtual = registros.reduce((max, r) => {
    if (typeof r.numero !== 'string') return max;
    const [pfx, seq] = r.numero.split('-');
    if (pfx !== prefixo) return max;
    const n = parseInt(seq, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefixo}-${String(maiorAtual + 1).padStart(4, '0')}`;
}

module.exports = { proximoNumero, proximoNumeroClassico };
