// Campo de embed do Discord aceita no máximo 1024 caracteres. Texto livre (motivo, petição,
// conteúdo etc.) fica salvo por inteiro no banco — isso só limita o que é exibido no embed.
function truncar(texto, max = 1000) {
  if (!texto) return texto;
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

module.exports = { truncar };
