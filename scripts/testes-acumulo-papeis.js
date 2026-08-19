/* eslint-disable */
// ACÚMULO DE PAPÉIS NA ABERTURA (regra do operador, 19/08/2026). Rode com:
//   node scripts/testes-acumulo-papeis.js
//
// A REGRA: quem abre processo penal ou medida, tendo cargo de PROMOTOR e sem delegado separado,
// consta como DELEGADO **e** PROMOTOR. No RP os dois estão do mesmo lado da mesa (persecução
// penal), e exigir um delegado que não existe trava o caso esperando alguém que ninguém vai chamar.
//
// O DEFEITO QUE ISSO CONSERTA, e que é pior que o incômodo: sem a regra, o promotor pedia a medida
// e o bot SORTEAVA OUTRO PROMOTOR para analisar o pedido dele — ou, no penal, sorteava um promotor
// qualquer para um caso que o próprio promotor tinha acabado de abrir.
//
// O QUE CONTINUA PROIBIDO, e o teste trava: Juiz+Promotor (quem acusa não julga) e
// Promotor+Advogado de defesa (quem acusa não defende).

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-acumulo-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const acumulo = require('../utils/acumuloDePapeis');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const PROMOTOR = '900000000000000001';
const DELEGADO = '900000000000000002';
const OUTRO_PROMOTOR = '900000000000000003';
const JUIZ = '900000000000000004';
const ADVOGADO = '900000000000000005';

rh.contratar(PROMOTOR, 'Promotor', 'Promotor Um');
rh.contratar(DELEGADO, 'Delegado', 'Delegado Um');
rh.contratar(OUTRO_PROMOTOR, 'Promotor', 'Promotor Dois');
rh.contratar(JUIZ, 'Juiz', 'Juiz Um');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado Um');

console.log('\n=== Acúmulo Delegado + Promotor na abertura ===\n');

console.log('1) Promotor abrindo SEM delegado separado acumula os dois papéis');
{
  // Caso do painel: ele passa sempre `delegadoId: interaction.user.id`, sem olhar o cargo de quem
  // clicou. Se quem clicou é promotor, é ele nos dois lados.
  const r = acumulo.resolverDelegadoEPromotor({ aberturaPorId: PROMOTOR, delegadoId: PROMOTOR, promotorInformado: null });
  ok(r.delegado === PROMOTOR && r.promotor === PROMOTOR, '1a: promotor que abre pelo painel vira Delegado E Promotor');
  ok(r.acumulou === true, '1b: ...e o acúmulo é sinalizado (para o chamador poder avisar nos autos)');

  // Caso do MP direto (Requisição / Inquérito Civil): não vem delegado nenhum.
  const r2 = acumulo.resolverDelegadoEPromotor({ aberturaPorId: PROMOTOR, delegadoId: null, promotorInformado: null });
  ok(r2.delegado === PROMOTOR && r2.promotor === PROMOTOR, '1c: abertura direta do MP (sem delegado) também acumula');
}

console.log('\n2) Quando HÁ delegado de verdade, nada muda');
{
  const r = acumulo.resolverDelegadoEPromotor({ aberturaPorId: DELEGADO, delegadoId: DELEGADO, promotorInformado: null });
  ok(r.delegado === DELEGADO, '2a: delegado abrindo continua só delegado');
  ok(r.promotor === null && r.acumulou === false, '2b: ...e o promotor segue para o sorteio, como antes');
}

console.log('\n3) Promotor informado explicitamente é RESPEITADO (o acúmulo não sobrescreve escolha)');
{
  const r = acumulo.resolverDelegadoEPromotor({ aberturaPorId: DELEGADO, delegadoId: DELEGADO, promotorInformado: OUTRO_PROMOTOR });
  ok(r.delegado === DELEGADO && r.promotor === OUTRO_PROMOTOR, '3a: delegado + promotor informado ficam como vieram');
  ok(r.acumulou === false, '3b: ...sem acúmulo');

  // Mas se o promotor informado É quem abriu, e não há delegado, acumula igual.
  const r2 = acumulo.resolverDelegadoEPromotor({ aberturaPorId: PROMOTOR, delegadoId: null, promotorInformado: PROMOTOR });
  ok(r2.delegado === PROMOTOR && r2.acumulou === true, '3c: promotor que abre indicando a si mesmo acumula');
}

console.log('\n4) Quem NÃO é promotor não vira promotor por acidente');
{
  const r = acumulo.resolverDelegadoEPromotor({ aberturaPorId: ADVOGADO, delegadoId: ADVOGADO, promotorInformado: null });
  ok(r.promotor === null, '4a: advogado abrindo não vira Promotor');
  const r2 = acumulo.resolverDelegadoEPromotor({ aberturaPorId: JUIZ, delegadoId: JUIZ, promotorInformado: null });
  ok(r2.promotor === null, '4b: juiz abrindo não vira Promotor');
}

console.log('\n5) Os acúmulos PROIBIDOS continuam bloqueados');
{
  ok(acumulo.conflitoDePapeis({ Juiz: PROMOTOR, Promotor: PROMOTOR }) !== null,
    '5a: Juiz + Promotor na mesma pessoa é recusado — quem acusa não julga');
  ok(acumulo.conflitoDePapeis({ Promotor: PROMOTOR, Advogado: PROMOTOR }) !== null,
    '5b: Promotor + Advogado de defesa é recusado — quem acusa não defende');
  ok(acumulo.conflitoDePapeis({ Delegado: PROMOTOR, Promotor: PROMOTOR }) === null,
    '5c: Delegado + Promotor é PERMITIDO (é a regra nova) — não pode ser barrado junto');
  ok(acumulo.conflitoDePapeis({ Juiz: JUIZ, Promotor: PROMOTOR }) === null,
    '5d: pessoas diferentes em papéis diferentes seguem normalmente');
  // Canário: se PROIBIDOS esvaziar, 5a/5b passariam por vacuidade parecendo aprovação.
  ok(acumulo.PROIBIDOS.length >= 2, '5z: a lista de pares proibidos não está vazia');
}

console.log('\n6) O caminho REAL usa o helper (não é regra copiada solta)');
{
  for (const arq of ['commands/processo.js', 'commands/medida.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', arq), 'utf-8');
    ok(/acumuloDePapeis\.resolverDelegadoEPromotor\(/.test(src), `6-${arq}: chama o helper compartilhado`);
    ok(/delegadoFinal/.test(src), `6-${arq}: ...e grava o delegado RESOLVIDO, não o que veio cru`);
  }
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
