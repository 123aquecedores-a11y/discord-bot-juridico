// Fonte ÚNICA da lógica "um Juiz entra num caso que estava sem julgador" — usada tanto pelo
// retry automático de sorteio (utils/prazos.js) quanto pela designação manual da Supervisão/Staff
// (utils/supervisao.js). Antes, essa lógica estava copiada nos 3 jobs de retry; centralizar aqui
// evita divergência (e é pré-requisito da reorganização/dedup planejada).
//
// processoCmd/peticaoCmd são requeridos SOB DEMANDA de propósito: há um ciclo de require
// (processo → medida → supervisao) e puxá-los no topo pegaria module.exports ainda incompleto.
const db = require('../database/db');
const canais = require('./canais');

// Distribui `juizId` ao caso `{tabela, numero}` (processo penal/civil ou petição administrativa),
// avançando o status correto, dando acesso ao canal e postando o painel de atuação. Idempotente:
// se o caso não existir ou já tiver Juiz, não faz nada e retorna false. `origem`: 'sorteio'
// (automático) | 'designacao' (manual). Retorna true se distribuiu.
async function distribuirJuizAoCaso(guild, { tabela, numero }, juizId, { origem = 'sorteio', designadoPor = null } = {}) {
  const processoCmd = require('../commands/processo');
  const peticaoCmd = require('../commands/peticao');
  const nota = origem === 'designacao'
    ? `designado(a) pela ${designadoPor ? `Supervisão (<@${designadoPor}>)` : 'Supervisão/Staff'}`
    : 'distribuído(a), por sorteio,';

  if (tabela === 'peticoes') {
    const p = db.buscarPorNumero('peticoes', numero);
    if (!p || p.juiz) return false;
    db.atualizar('peticoes', numero, { status: 'Pendente', juiz: juizId, avisoSemJuizEnviado: false });
    const canal = p.canalId ? await guild.channels.fetch(p.canalId).catch(() => null) : null;
    if (canal) {
      await canais.adicionarMembro(canal, juizId);
      await canal.send({
        content: `⚖️ **Comunicação do Tribunal** — <@${juizId}>, Vossa Senhoria foi ${nota} para esta petição (que aguardava julgador).`,
        embeds: [peticaoCmd.embedPeticao(db.buscarPorNumero('peticoes', numero))],
        components: peticaoCmd.botoesDecisao(numero),
      });
    }
    return true;
  }

  // processos (civil ou penal)
  const proc = db.buscarPorNumero('processos', numero);
  if (!proc || proc.juiz) return false;
  const novoStatus = proc.tipo === 'Penal' ? 'Instrução' : 'Aguardando defesa';
  db.atualizar('processos', numero, { status: novoStatus, juiz: juizId, juizDesde: new Date().toISOString(), avisoSemJuizEnviado: false });
  const canal = proc.canalId ? await guild.channels.fetch(proc.canalId).catch(() => null) : null;
  if (canal) {
    await canais.adicionarMembro(canal, juizId);
    const atual = db.buscarPorNumero('processos', numero);
    const citacao = proc.tipo === 'Penal'
      ? ` Cite-se ${(proc.reus || []).map(id => `<@${id}>`).join(', ') || 'o(s) réu(s)'} para instrução e julgamento.`
      : '';
    const msg = await canal.send({
      content: `⚖️ **Comunicação do Tribunal** — <@${juizId}>, Vossa Senhoria foi ${nota} para este processo (que aguardava julgador).${citacao}`,
      embeds: [processoCmd.embedProcesso(atual)],
      components: processoCmd.montarPainelAcoes(atual),
    });
    db.atualizar('processos', numero, { painelMsgId: msg.id });
  }
  await processoCmd.postarOuAtualizarCapaPublica(guild, numero);
  return true;
}

module.exports = { distribuirJuizAoCaso };
