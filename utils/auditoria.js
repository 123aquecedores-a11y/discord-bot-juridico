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

/**
 * Aviso livre no mesmo canal — para o que NÃO é "ato praticado por alguém", e sim falha do próprio
 * sistema que um humano precisa ver. O formato fixo de registrar() não serve: aviso de falha tem
 * corpo próprio e precisa caber inteiro, com os dados do resgate manual junto.
 *
 * Mesma disciplina do resto do módulo, e um grau a mais: NUNCA lança. registrar() pode estourar de
 * propósito no guildGuard porque log no servidor errado é vazamento; aqui o estouro seria pior que
 * o silêncio — derrubaria justamente o caminho que existe para denunciar uma falha.
 */
async function avisar(guild, texto) {
  try {
    guildGuard.exigirGuild(guild, 'auditoria.avisar');
    if (!config.canalAuditoriaId) {
      console.error('[auditoria] sem CANAL_AUDITORIA_ID — aviso ficou só no console:', String(texto).slice(0, 300));
      return false;
    }
    const canal = await guild.channels.fetch(config.canalAuditoriaId).catch(() => null);
    if (!canal || !canal.isTextBased?.()) {
      console.error('[auditoria] CANAL_AUDITORIA_ID inválido — aviso ficou só no console:', String(texto).slice(0, 300));
      return false;
    }
    // 2000 é o teto do Discord; 1900 deixa folga para não perder o aviso por um caractere.
    await canal.send({ content: String(texto).slice(0, 1900) });
    return true;
  } catch (e) {
    console.error('[auditoria] falha ao publicar aviso (o aviso em si segue no console):', e.message);
    console.error(String(texto).slice(0, 300));
    return false;
  }
}

/**
 * BOOT: o .bak está sendo escrito de verdade? (21/08/2026)
 *
 * A cópia de segurança falhando é invisível por natureza — só se descobre no dia em que ela é
 * necessária, que é exatamente o pior dia possível para descobrir. Esta checagem existe para que a
 * descoberta aconteça num dia qualquer, em que ainda dá para consertar.
 *
 * Compara o atraso do .bak em relação ao dados.json (ver database/db.js). Silêncio é a resposta
 * normal: só fala quando há o que dizer.
 */
async function avisarBackupAtrasado(guild) {
  const db = require('../database/db');
  const saude = db.saudeDoBackup();
  if (!saude.ausente && !saude.atrasado) return { avisou: false, saude };

  const minutos = saude.atrasoMs === null ? null : Math.round(saude.atrasoMs / 60000);
  const linhas = saude.ausente
    ? [
      '🛑 **O backup do banco NÃO EXISTE.**',
      'O `dados.json` está no disco, mas não há `.bak` nenhum ao lado dele. Se o banco corromper agora, não há de onde recuperar.',
    ]
    : [
      '⚠️ **O backup do banco está ATRASADO.**',
      'O `.bak` ficou ' + minutos + ' minutos para trás do `dados.json` — num sistema sadio essa distância é de milissegundos.',
      'O banco continua sendo gravado normalmente; o que parou foi a rede de segurança.',
    ];
  if (saude.ultimoErro) linhas.push('Último erro da cópia: `' + saude.ultimoErro + '`');
  linhas.push('Verifique espaço em disco e permissão de escrita no volume.');

  await avisar(guild, linhas.join(String.fromCharCode(10)));
  console.error('[db] ' + (saude.ausente ? 'backup .bak AUSENTE' : 'backup .bak ATRASADO em ' + minutos + ' min'));
  return { avisou: true, saude };
}

module.exports = { registrar, avisar, avisarBackupAtrasado };
