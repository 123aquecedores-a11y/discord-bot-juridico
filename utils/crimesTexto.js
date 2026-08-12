// Formatação compartilhada do novo schema de crimes.json (codigo_artigo, pena_min_meses/
// pena_max_meses, apuracao) — usada em /crime, no crimePicker, no /painel e nos textos de
// documentos (processo.js, supervisao.js) pra não duplicar a mesma lógica de exibição em cada um.
function penaTexto(crime) {
  if (crime.apuracao === 'corregedoria') return 'A cargo do órgão corregedor';
  if (crime.sem_custodia) return 'Sem custódia';
  return `${crime.pena_min_meses} a ${crime.pena_max_meses} meses`;
}

function crimeLabel(crime) {
  return `${crime.nome} (Art. ${crime.codigo_artigo})`;
}

// Busca de crime por nome/artigo/id — mesma regra usada no autocomplete de /crime, no modal de
// busca do /painel e no crimePicker. Estava copiada em 3 lugares (Frente 4a.2); agora é fonte
// única. Retorna a lista (até `limite`) dos crimes que casam com o termo.
const crimes = require('../data/crimes.json');
function buscarCrimes(termo, limite = 25) {
  const t = (termo || '').toLowerCase();
  return crimes
    .filter(c => c.nome.toLowerCase().includes(t) || c.codigo_artigo.toLowerCase().includes(t) || c.id.includes(t))
    .slice(0, limite);
}

module.exports = { penaTexto, crimeLabel, buscarCrimes };
