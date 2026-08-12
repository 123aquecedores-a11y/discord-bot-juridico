// Cruzamento automático com os próprios processos penais do bot — usado pelas petições
// administrativas antes da decisão do Juiz. Não integra com o MDT ainda (sem acesso à base).
//
// Petição é protocolada pelo Advogado em nome do cliente — o cruzamento precisa olhar pro
// Discord do CLIENTE, não de quem preencheu. Por isso tudo aqui é indexado por RG: usa todo
// ID de Discord já vinculado à ficha desse RG (a mesma pessoa pode ter usado contas
// diferentes ao longo do tempo), mais o ID informado agora, se houver.
const db = require('../database/db');
const { parseCriadoEm } = require('./data');
const ficha = require('./ficha');

function processosPenaisDoRequerente(requerenteId) {
  return db.todos('processos', p => p.tipo === 'Penal' && (p.reus || []).includes(requerenteId));
}

function idsConhecidosDoRG(rg, discordIdInformado) {
  const registro = ficha.buscarPorRG(rg);
  return [...new Set([...(registro?.discordIds || []), discordIdInformado].filter(Boolean))];
}

function verificarAntecedentesPorRG(rg, discordIdInformado) {
  const ids = idsConhecidosDoRG(rg, discordIdInformado);
  if (ids.length === 0) {
    return { temCondenacao: false, temProcessoAberto: false, condenacoes: [], abertos: [], semDiscordVinculado: true };
  }
  const processos = ids.flatMap(id => processosPenaisDoRequerente(id));
  const condenacoes = processos.filter(p => p.resultado === 'Condenado');
  const abertos = processos.filter(p => ['Aguardando decisão do MP', 'Instrução'].includes(p.status));
  return { temCondenacao: condenacoes.length > 0, temProcessoAberto: abertos.length > 0, condenacoes, abertos, semDiscordVinculado: false };
}

function resumoTextoPorRG(rg, discordIdInformado) {
  const r = verificarAntecedentesPorRG(rg, discordIdInformado);
  if (r.semDiscordVinculado) return '⚠️ Cliente sem conta de Discord vinculada à ficha — não foi possível cruzar antecedentes automaticamente.';
  if (!r.temCondenacao && !r.temProcessoAberto) return '✅ Nenhuma condenação ou processo penal em andamento encontrado nos registros do bot.';
  const linhas = [];
  if (r.temCondenacao) linhas.push(`⚠️ Condenação(ões) registrada(s): ${r.condenacoes.map(p => p.numero).join(', ')}`);
  if (r.temProcessoAberto) linhas.push(`⚠️ Processo(s) penal(is) em andamento: ${r.abertos.map(p => p.numero).join(', ')}`);
  return linhas.join('\n');
}

// Usado por Limpeza de Ficha: novo antecedente (processo penal aberto) nos últimos N dias,
// em qualquer conta de Discord já vinculada a esse RG.
function temNovoAntecedenteEmPorRG(rg, discordIdInformado, dias) {
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const ids = idsConhecidosDoRG(rg, discordIdInformado);
  return ids.some(id => processosPenaisDoRequerente(id).some(p => {
    const data = parseCriadoEm(p.criado_em);
    return data && data.getTime() >= limite;
  }));
}

module.exports = { verificarAntecedentesPorRG, resumoTextoPorRG, temNovoAntecedenteEmPorRG };
