const db = require('../database/db');
const config = require('../config');

async function registrar(guild, numeroProcesso, { tipo, titulo, detalhe, executorId, anexoUrl, metadata }) {
  const andamento = db.inserir('andamentos', {
    processoNumero: numeroProcesso,
    tipo, titulo, detalhe,
    executorId: executorId || null,
    anexoUrl: anexoUrl || null,
    metadata: metadata || {},
    criadoEm: new Date().toISOString(),
  });

  if (guild && config.canalAuditoriaId) {
    const canal = await guild.channels.fetch(config.canalAuditoriaId).catch(() => null);
    if (canal?.isTextBased?.()) {
      const linhas = [`📋 **${titulo}**`, executorId ? `Por: <@${executorId}>` : null, `Processo: ${numeroProcesso}`].filter(Boolean);
      await canal.send({ content: linhas.join('\n') }).catch(err => console.error('Falha ao espelhar andamento na auditoria:', err.message));
    }
  }

  return andamento;
}

function doProcesso(numeroProcesso) {
  return db.todos('andamentos', a => a.processoNumero === numeroProcesso)
    .sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));
}

module.exports = { registrar, doProcesso };
