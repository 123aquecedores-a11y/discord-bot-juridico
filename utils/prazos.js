// Job diário: prazo de 7 dias corridos pro Juiz julgar um processo em Instrução, contado a
// partir da distribuição (juizDesde). Não mexe em revelia — isso continua manual do Juiz.
const db = require('../database/db');
const canais = require('./canais');
const rh = require('./rh');
const processoCmd = require('../commands/processo');

const PRAZO_JULGAMENTO_DIAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;

// Status que tiram um processo do prazo de julgamento (o caso já teve um desfecho).
const STATUS_TERMINAIS = ['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'];

function partesDoProcesso(p) {
  const ids = new Set();
  if (p.juiz) ids.add(p.juiz);
  if (p.autor) ids.add(p.autor);
  for (const r of p.reus || []) ids.add(r);
  for (const h of p.habilitacoes || []) if (h.status === 'Aprovado') ids.add(h.advogadoId);
  return [...ids];
}

async function dmSeguro(client, userId, content) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content });
  } catch (err) {
    console.error(`Não foi possível enviar DM pra ${userId}: ${err.message}`);
  }
}

// Pega qualquer processo (penal OU civil) com Juiz distribuído e ainda sem desfecho — não só
// status==='Instrução', porque processo civil nunca passa por esse status (fica em "Aguardando
// defesa"/"Aguardando sorteio de juiz" até Julgar/Arquivar), e o prazo vale pros dois tipos.
async function verificarPrazosJulgamento(client, guild) {
  const processos = db.todos('processos', p => p.juiz && p.juizDesde && !STATUS_TERMINAIS.includes(p.status));
  const agora = Date.now();

  for (const p of processos) {
    const dias = Math.floor((agora - new Date(p.juizDesde).getTime()) / DIA_MS);
    const restante = PRAZO_JULGAMENTO_DIAS - dias;

    if (restante > 0) {
      const aviso = `⏰ Processo **${p.numero}** — faltam **${restante} dia(s)** pro prazo de julgamento (7 dias corridos desde a distribuição).`;
      for (const uid of partesDoProcesso(p)) await dmSeguro(client, uid, aviso);
      continue;
    }

    // Prazo estourado — arquiva sem julgamento de mérito
    db.atualizar('processos', p.numero, { status: 'Arquivado sem julgamento de mérito' });
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    if (canal) {
      await canais.arquivarCanal(canal);
      await canal.send({ content: '⏰ Prazo de 7 dias corridos pra julgamento esgotado sem sentença. Processo arquivado sem julgamento de mérito.' });
    }

    const avisoSupervisao = `⏰ Processo **${p.numero}** foi arquivado sem julgamento de mérito (prazo de 7 dias esgotado). Use \`/painel\` > Supervisão > Trocar Juiz pra reabrir com um novo Juiz.`;
    const desembargadores = rh.listarPorCargo('Desembargador').filter(d => !d.licenca);
    const procuradores = rh.listarPorCargo('Procurador').filter(pr => !pr.licenca);
    for (const d of desembargadores) await dmSeguro(client, d.discordId, avisoSupervisao);
    for (const pr of procuradores) await dmSeguro(client, pr.discordId, avisoSupervisao);

    await processoCmd.postarOuAtualizarDiario(guild, p.numero);
  }
}

// Renovação do porte de arma — mesma infra de job diário, 15 dias de validade, aviso 3 dias
// antes de vencer. Renovação em si é feita rodando /peticao porte-arma de novo.
async function verificarRenovacoesPorteArma(client) {
  const peticoes = db.todos('peticoes', p => p.tipo === 'PorteArma' && p.status === 'Deferido' && p.validadeAte);
  const agora = Date.now();

  for (const p of peticoes) {
    const restanteMs = new Date(p.validadeAte).getTime() - agora;
    const diasRestantes = Math.ceil(restanteMs / DIA_MS);

    if (diasRestantes === 3) {
      await dmSeguro(client, p.requerenteId, `🔫 Seu porte de arma (petição ${p.numero}) vence em 3 dias. Renove com \`/peticao porte-arma\`.`);
    }

    if (restanteMs <= 0) {
      db.atualizar('peticoes', p.numero, { status: 'Vencido' });
      await dmSeguro(client, p.requerenteId, `🔫 Seu porte de arma (petição ${p.numero}) **venceu**. Portar arma sem porte válido volta a ser porte ilegal (Código Penal).`);
    }
  }
}

module.exports = { verificarPrazosJulgamento, verificarRenovacoesPorteArma, PRAZO_JULGAMENTO_DIAS, DIA_MS, dmSeguro };
