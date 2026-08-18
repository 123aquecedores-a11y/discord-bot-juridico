/* eslint-disable */
// Testes do botão do interruptor "Modo Entrega In-Game" no painel da staff. Rode com:
//   node scripts/testes-botao-modoentrega.js
//
// utils/modoEntrega.js (ligar/desligar) sempre existiu e sempre passou nos testes isolados desde a
// Fase 1 — mas até 18/08/2026 não havia NENHUM jeito de chamar essas funções a partir do Discord.
// Achado durante o primeiro teste real de emissão em produção: nenhum processo novo conseguia
// nascer `ingame`, mesmo com a feature inteira pronta e no ar, porque não havia botão.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-botao-modo-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const modoEntrega = require('../utils/modoEntrega');
const painel = require('../commands/painel');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function fakeInteraction({ staff, userId = 'id_staff' }) {
  const rec = { updates: [], replies: [] };
  return {
    rec,
    customId: 'painel:acao:modoentrega:alternar',
    guild: { id: 'guild1' },
    user: { id: userId },
    member: {
      permissions: { has: () => !!staff },
      roles: { cache: { has: () => false } },
    },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
    update: async (o) => { rec.updates.push(o); },
    reply: async (o) => { rec.replies.push(o); },
  };
}

const textoDe = (o) => (o && (o.content || '')) || '';

(async () => {
console.log('\n=== Botão do interruptor Modo Entrega In-Game ===\n');

console.log('1) Só staff pode alternar');
{
  ok(modoEntrega.ligado('guild1') === false, '1a: nasce desligado, como sempre foi');
  const iNaoStaff = fakeInteraction({ staff: false, userId: 'id_jogador' });
  await painel.router(iNaoStaff);
  ok(!!iNaoStaff.rec.replies.length && /s[óo] staff/i.test(textoDe(iNaoStaff.rec.replies[0])), '1b: não-staff é recusado, com mensagem clara');
  ok(modoEntrega.ligado('guild1') === false, '1c: ...e o estado não muda');
}

console.log('\n2) Staff liga o interruptor pelo botão');
{
  const i = fakeInteraction({ staff: true, userId: 'id_staff_1' });
  await painel.router(i);
  ok(modoEntrega.ligado('guild1') === true, '2a: o clique liga de verdade — modoEntrega.ligado() vira true');
  ok(modoEntrega.modoParaNovoProcesso('guild1') === 'ingame', '2b: e processo NOVO passa a nascer ingame');
  ok(i.rec.updates.length === 1, '2c: responde re-renderizando o próprio menu (update, não reply solto)');
  ok(/LIGADO/.test(textoDe(i.rec.updates[0])), '2d: a mensagem confirma que ligou');
  ok(!/retroativ/i.test(textoDe(i.rec.updates[0])) || /não mudam/i.test(textoDe(i.rec.updates[0])),
    '2e: a mensagem avisa que processos existentes NÃO mudam (não é retroativo)');

  const hist = modoEntrega.historico('guild1');
  ok(hist.length === 1 && hist[0].porId === 'id_staff_1', '2f: fica registrado quem ligou (SPEC §11.2.3)');
}

console.log('\n3) Staff desliga de novo, mesmo botão');
{
  const i = fakeInteraction({ staff: true, userId: 'id_staff_2' });
  await painel.router(i);
  ok(modoEntrega.ligado('guild1') === false, '3a: alterna de volta para desligado');
  ok(modoEntrega.modoParaNovoProcesso('guild1') === 'aberto', '3b: processo novo volta a nascer aberto');
  ok(/desligado/i.test(textoDe(i.rec.updates[0])), '3c: a mensagem confirma que desligou');
  ok(modoEntrega.historico('guild1').length === 2, '3d: o histórico acumula os dois eventos');
}

console.log('\n4) NÃO é retroativo — processo já aberto não muda');
{
  db.inserir('processos', { numero: '0001CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'aberto' });
  const antesDoToggle = db.buscarPorNumero('processos', '0001CV').modoEntrega;

  await painel.router(fakeInteraction({ staff: true })); // liga
  ok(modoEntrega.ligado('guild1') === true, '4a: interruptor ligou');
  const depoisDoToggle = db.buscarPorNumero('processos', '0001CV').modoEntrega;
  ok(depoisDoToggle === antesDoToggle && depoisDoToggle === 'aberto', '4b: o processo que já existia continua `aberto` — o botão não retroage');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
