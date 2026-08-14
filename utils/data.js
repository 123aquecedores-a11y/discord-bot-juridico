// db.inserir grava criado_em em pt-BR local ("DD/MM/AAAA, HH:mm:ss") — isso converte de
// volta pra Date, necessário pros cruzamentos automáticos que contam dias corridos.
function parseCriadoEm(str) {
  if (!str) return null;
  // Formato padrão gravado por db.inserir: pt-BR local "DD/MM/AAAA, HH:mm:ss". Mas um criado_em em
  // ISO ("2026-08-13T12:34:56.000Z" — registro importado/antigo, ou gravado por outro caminho)
  // cairia no parse pt-BR e viraria Invalid Date, derrubando os cruzamentos por dias corridos.
  // pt-BR sempre tem "/", ISO nunca tem — usa isso pra rotear e tolerar os dois.
  if (!str.includes('/')) {
    const iso = new Date(str);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }
  const [data, hora] = str.split(', ');
  const [d, m, y] = data.split('/').map(Number);
  const [h, min, s] = (hora || '0:0:0').split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

module.exports = { parseCriadoEm };
