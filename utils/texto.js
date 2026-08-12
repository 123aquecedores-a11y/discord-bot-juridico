// Campo de embed do Discord aceita no máximo 1024 caracteres. Texto livre (motivo, petição,
// conteúdo etc.) fica salvo por inteiro no banco — isso só limita o que é exibido no embed.
function truncar(texto, max = 1000) {
  if (!texto) return texto;
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

// Extrai o ID de uma menção do Discord de DENTRO de um texto qualquer (ex.: campo de embed,
// input de modal onde o usuário colou "<@123>"). Não-ancorada de propósito: pega a 1ª menção
// que aparecer. Retorna null se não houver menção. NÃO aceita ID solto (sem <@>).
function extrairMencao(texto) {
  const m = texto && texto.match(/<@!?(\d+)>/);
  return m ? m[1] : null;
}

// Aceita menção completa (`<@123>`/`<@!123>`) OU um ID solto (snowflake de 15-25 dígitos),
// exigindo que o texto inteiro seja só isso (ancorado). Usado nos campos onde a pessoa pode
// digitar tanto @menção quanto o ID cru. Retorna null se não bater nenhum dos dois.
function extrairMencaoOuId(texto) {
  if (!texto) return null;
  const t = texto.trim();
  const m = t.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  return /^\d{15,25}$/.test(t) ? t : null;
}

module.exports = { truncar, extrairMencao, extrairMencaoOuId };
