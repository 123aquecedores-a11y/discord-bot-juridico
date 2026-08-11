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

module.exports = { penaTexto, crimeLabel };
