// Lista fixa de atenuantes (spec-atualizacao-codigo-penal-e-sentenca.md, seção 4) — puramente
// qualitativo, sem cálculo automático de redução de pena. O Juiz continua digitando pena e
// regime na mão; marcar um item aqui só acrescenta a frase padrão na sentença gerada.
const ATENUANTES = [
  { value: 'confissao', label: 'Confissão espontânea' },
  { value: 'colaboracao', label: 'Colaboração efetiva' },
  { value: 'entrega', label: 'Entrega voluntária' },
  { value: 'reparacao', label: 'Reparação integral do dano' },
  { value: 'devolucao', label: 'Devolução de bens' },
  { value: 'antecedentes', label: 'Ausência de antecedentes' },
  { value: 'desentendimento', label: 'Desentendimento momentâneo sem arma, lesão ou prejuízo' },
  { value: 'vitima', label: 'Vítima contribuiu para o conflito' },
];

function labelsDe(values) {
  return ATENUANTES.filter(a => (values || []).includes(a.value)).map(a => a.label);
}

module.exports = { ATENUANTES, labelsDe };
