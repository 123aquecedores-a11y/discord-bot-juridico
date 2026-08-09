// db.inserir grava criado_em em pt-BR local ("DD/MM/AAAA, HH:mm:ss") — isso converte de
// volta pra Date, necessário pros cruzamentos automáticos que contam dias corridos.
function parseCriadoEm(str) {
  if (!str) return null;
  const [data, hora] = str.split(', ');
  const [d, m, y] = data.split('/').map(Number);
  const [h, min, s] = (hora || '0:0:0').split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

module.exports = { parseCriadoEm };
