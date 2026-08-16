// Parte 4 da spec (TROCA_UNIVERSAL_E_RESPONSAVEL_FANTASMA.md): fazer as funções novas valerem pros
// tickets que JÁ existiam, não só pros que nascerem depois do deploy.
//
// A troca manual (Parte 2) e a varredura de fantasma (Parte 3) já são retroativas por natureza —
// operam sobre o ticket como ele está, sem depender de campo criado depois. O que exige ação é UMA
// coisa: a trava das 24h da manifestação do MP, que só vale quando `sorteioPromotorEm` existe. Sem
// backfill, petição antiga cairia em cálculo indefinido (decisão registrada na spec: opção A).
const db = require('../database/db');
const estado = require('./estado');
const responsaveis = require('./responsaveis');

const CHAVE_BACKFILL = 'backfillSorteioPromotorEm';

// Petição "em curso" pra efeito de backfill: ainda não decidida/encerrada (mesmo predicado que o
// mapa de tickets usa) E com promotor atribuído — sem promotor não há quem se manifeste, e carimbar
// a data criaria uma trava sem dono.
function peticoesParaBackfill() {
  const cfg = responsaveis.TABELAS_TICKET.peticoes;
  return db.todos('peticoes', (p) => responsaveis.ticketAberto(cfg, p) && !!p.promotor && !p.sorteioPromotorEm);
}

/**
 * Backfill de uso único: carimba `sorteioPromotorEm` = agora nas petições abertas que não têm o
 * campo. Efeito: as antigas passam a exigir manifestação com as 24h contando do deploy — ninguém
 * trava retroativamente e todo mundo ganha a janela cheia. Marca no `estado` que já rodou, então
 * redeploy não recarimba (o que reiniciaria o prazo de quem já está correndo).
 */
function backfillSorteioPromotor({ forcar = false } = {}) {
  if (!forcar && estado.obter(CHAVE_BACKFILL)) return { jaRodou: true, backfilladas: 0, numeros: [] };
  const agora = new Date().toISOString();
  const alvos = peticoesParaBackfill();
  for (const p of alvos) db.atualizar('peticoes', p.numero, { sorteioPromotorEm: agora });
  estado.definir(CHAVE_BACKFILL, agora);
  return { jaRodou: false, backfilladas: alvos.length, numeros: alvos.map(p => p.numero) };
}

// Relatório pedido na spec ("sem esse número não dá pra saber se a retroatividade pegou tudo"):
// quantos tickets abertos existem por tipo e quantos têm responsável marcado. Os fantasmas em si
// são contados pela varredura da Parte 3 (varrerResponsaveisFantasma já loga os seus números).
function relatorioTicketsAbertos() {
  const porTipo = {};
  for (const [tabela, cfg] of Object.entries(responsaveis.TABELAS_TICKET)) {
    const abertos = db.todos(tabela, (r) => responsaveis.ticketAberto(cfg, r));
    porTipo[tabela] = {
      abertos: abertos.length,
      comResponsavel: abertos.filter(r => responsaveis.papeisTrocaveis(tabela, r).length > 0).length,
    };
  }
  return porTipo;
}

// Roda no boot, uma vez. Blindado: nada aqui pode derrubar a subida do bot.
function aplicarRetroatividade() {
  try {
    const r = backfillSorteioPromotor();
    const tickets = relatorioTicketsAbertos();
    const resumo = Object.entries(tickets).map(([t, n]) => `${t}: ${n.abertos} aberto(s), ${n.comResponsavel} com responsável`).join(' | ');
    console.log(`📦 [retroatividade] Tickets abertos — ${resumo}`);
    if (r.jaRodou) console.log('📦 [retroatividade] Backfill de sorteioPromotorEm já havia rodado (nada a fazer).');
    else console.log(`📦 [retroatividade] Backfill de sorteioPromotorEm: ${r.backfilladas} petição(ões) carimbada(s)${r.numeros.length ? ` (${r.numeros.join(', ')})` : ''}.`);
    return { ...r, tickets };
  } catch (e) {
    console.error('[retroatividade] falhou (ignorado, não derruba o boot):', e.message);
    return null;
  }
}

module.exports = { aplicarRetroatividade, backfillSorteioPromotor, relatorioTicketsAbertos, peticoesParaBackfill, CHAVE_BACKFILL };
