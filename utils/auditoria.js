const config = require('../config');

// Log de tudo que muda estado relevante no bot: RH, processos, medidas, habilitações,
// apelações, petições, ofícios, supervisão. Nunca derruba a ação principal se o canal
// estiver mal configurado, só avisa no console (mesmo padrão do canal "Advogar - Pegar Casos").
async function registrar(guild, { acao, executorId, referencia, motivo }) {
  if (!config.canalAuditoriaId) return;
  const canal = await guild.channels.fetch(config.canalAuditoriaId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) {
    console.error(`CANAL_AUDITORIA_ID inválido — ação "${acao}" não foi registrada.`);
    return;
  }
  const linhas = [
    `📋 **${acao}**`,
    `Por: <@${executorId}>`,
    referencia ? `Referência: ${referencia}` : null,
    motivo && motivo !== '—' ? `Motivo: ${motivo}` : null,
  ].filter(Boolean);
  await canal.send({ content: linhas.join('\n') }).catch(err => console.error(`Falha ao registrar auditoria: ${err.message}`));
}

module.exports = { registrar };
