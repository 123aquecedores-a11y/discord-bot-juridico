const config = require('../config');
const guildGuard = require('./guildGuard');

// Log de tudo que muda estado relevante no bot: RH, processos, medidas, habilitações,
// apelações, petições, ofícios, supervisão. Nunca derruba a ação principal se o canal
// estiver mal configurado, só avisa no console (mesmo padrão do canal "Advogar - Pegar Casos").
async function registrar(guild, { acao, executorId, referencia, motivo }) {
  // Camada de profundidade do isolamento (ver utils/guildGuard.js): escrever log de auditoria
  // no servidor errado é vazamento de dado processual. Lança de propósito — melhor estourar o
  // erro do que registrar ato de um tribunal no outro.
  guildGuard.exigirGuild(guild, 'auditoria.registrar');
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
