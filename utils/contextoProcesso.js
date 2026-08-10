// Painel ciente de contexto (seção 1 de painel-contexto-e-tipo-mandado.md) — quando um botão
// do painel é acionado de dentro do canal de um processo, o bot detecta isso e pula a etapa de
// digitar/buscar o número manualmente. Fica num util próprio (não em processo.js) porque
// medida.js e oficio.js também precisam chamar isso sem criar dependência circular com processo.js.
const db = require('../database/db');

async function detectarProcessoDoCanal(channelId) {
  if (!channelId) return null;
  return db.buscarUm('processos', p => p.canalId === channelId);
}

module.exports = { detectarProcessoDoCanal };
