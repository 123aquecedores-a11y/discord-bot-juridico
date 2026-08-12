// Cruzamento automático com os próprios processos penais do bot — usado pelas petições
// administrativas antes da decisão do Juiz. Não integra com o MDT ainda (sem acesso à base).
//
// Identidade do cliente = nome + RG (Frente 7); o @ do Discord é OPCIONAL. Por isso o cruzamento
// casa PRIMARIAMENTE por RG (contra reuRg e partes[].rg dos processos), e TAMBÉM por qualquer conta
// de Discord já vinculada a esse RG (a mesma pessoa pode ter usado contas diferentes) — assim um
// cliente com RG mas SEM Discord ainda é cruzado normalmente.
const db = require('../database/db');
const { parseCriadoEm } = require('./data');
const ficha = require('./ficha');

// Processos penais em que a pessoa (identificada por RG e/ou pelas contas de Discord conhecidas)
// figura como RÉU. db.todos retorna cada processo uma vez, então não há duplicação mesmo quando
// casa por mais de um critério.
function processosPenaisDoRG(rg, ids = []) {
  return db.todos('processos', p => {
    if (p.tipo !== 'Penal') return false;
    if (ids.length && (p.reus || []).some(r => ids.includes(r))) return true;   // por conta de Discord
    if (rg && p.reuRg === rg) return true;                                       // por RG (réu da abertura)
    if (rg && (p.partes || []).some(x => x.papel === 'reu' && x.rg === rg)) return true; // por RG (parte)
    return false;
  });
}

function idsConhecidosDoRG(rg, discordIdInformado) {
  const registro = ficha.buscarPorRG(rg);
  return [...new Set([...(registro?.discordIds || []), discordIdInformado].filter(Boolean))];
}

function verificarAntecedentesPorRG(rg, discordIdInformado) {
  const ids = idsConhecidosDoRG(rg, discordIdInformado);
  const processos = processosPenaisDoRG(rg, ids);
  const condenacoes = processos.filter(p => p.resultado === 'Condenado');
  const abertos = processos.filter(p => ['Aguardando decisão do MP', 'Instrução'].includes(p.status));
  return { temCondenacao: condenacoes.length > 0, temProcessoAberto: abertos.length > 0, condenacoes, abertos };
}

function resumoTextoPorRG(rg, discordIdInformado) {
  const r = verificarAntecedentesPorRG(rg, discordIdInformado);
  if (!r.temCondenacao && !r.temProcessoAberto) return '✅ Nenhuma condenação ou processo penal em andamento encontrado nos registros do bot.';
  const linhas = [];
  if (r.temCondenacao) linhas.push(`⚠️ Condenação(ões) registrada(s): ${r.condenacoes.map(p => p.numero).join(', ')}`);
  if (r.temProcessoAberto) linhas.push(`⚠️ Processo(s) penal(is) em andamento: ${r.abertos.map(p => p.numero).join(', ')}`);
  return linhas.join('\n');
}

// Usado por Limpeza de Ficha: novo antecedente (processo penal aberto) nos últimos N dias, casando
// por RG e pelas contas de Discord já vinculadas a esse RG.
function temNovoAntecedenteEmPorRG(rg, discordIdInformado, dias) {
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const ids = idsConhecidosDoRG(rg, discordIdInformado);
  return processosPenaisDoRG(rg, ids).some(p => {
    const data = parseCriadoEm(p.criado_em);
    return data && data.getTime() >= limite;
  });
}

module.exports = { verificarAntecedentesPorRG, resumoTextoPorRG, temNovoAntecedenteEmPorRG };
