/* eslint-disable */
// QUEM VÊ O TEOR (19/08/2026 — decisão do operador). Rode com:
//   node scripts/testes-quem-ve-teor.js
//
// A REGRA, nas palavras do operador: gated = fechado para advogado e partes até a entrega
// registrada; aberto para Juiz, Promotor, Desembargador e Procurador. Delegado NÃO entra.
//
// POR QUE ISSO NÃO ESVAZIA O GATE: ele nunca existiu contra a magistratura e o MP. Existe para
// obrigar o ENCONTRO EM CENA com quem está fora do fórum — o advogado e as partes. É essa metade
// que sustenta a feature inteira, e é ela que este arquivo protege com mais asserções.
//
// A METADE PERIGOSA desta mudança é o alargamento: cada linha que abre visão para alguém é uma
// linha a menos de sigilo. Por isso cada bloco tem seu par negativo — quem NÃO vê é testado com o
// mesmo cuidado de quem vê.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-ve-teor-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ_CASO = '130000000000000001';
const JUIZ_OUTRO = '130000000000000002';
const PROMOTOR = '130000000000000003';
const PROCURADOR = '130000000000000004';
const DESEMB = '130000000000000005';
const ADV_HABIL = '130000000000000006';
const ADV_OUTRO = '130000000000000007';
const DELEGADO = '130000000000000008';
const REU = '130000000000000009';
const ZE_NINGUEM = '130000000000000010';

rh.contratar(JUIZ_CASO, 'Juiz', 'Juiz do caso');
rh.contratar(JUIZ_OUTRO, 'Juiz', 'Juiz colega');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(PROCURADOR, 'Procurador', 'Procurador');
rh.contratar(DESEMB, 'Desembargador', 'Desembargador');
rh.contratar(ADV_HABIL, 'Advogado', 'Advogado habilitado');
rh.contratar(ADV_OUTRO, 'Advogado', 'Advogado de outro caso');
rh.contratar(DELEGADO, 'Delegado', 'Delegado');

const processo = db.inserir('processos', {
  numero: '0600PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
  juiz: JUIZ_CASO, promotor: PROMOTOR, delegado: DELEGADO, reus: [REU], canalId: 'c1',
  habilitacoes: [{ id: 1, advogadoId: ADV_HABIL, reuId: REU, status: 'Aprovado' }],
});

// Sentença do Juiz, dirigida ao advogado habilitado — a peça mais sensível do rito.
const g = pecas.gerar({
  processoTabela: 'processos', processoNumero: '0600PN', tipo: 'sentenca',
  autorId: JUIZ_CASO, autorPapel: 'Juiz', texto: 'Fundamentação e dispositivo.',
  destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
});
const PECA = g.peca.numero;
const ve = (uid) => pecas.podeVerTeor(uid, PECA, null, { ehStaff: false });

console.log('\n=== Quem vê o teor de uma peça gated ===\n');

// ---------------------------------------------------------------------------
console.log('1) MAGISTRATURA E MP veem direto, sem cena');
// ---------------------------------------------------------------------------
{
  ok(g.ok && g.peca.gated, '1z: a peça de teste é gated (senão o resto não prova nada)');

  ok(ve(JUIZ_CASO) === true, '1a: o Juiz do caso vê (é o autor)');
  ok(ve(JUIZ_OUTRO) === true, '1b: OUTRO Juiz também vê — cobertura de plantão, sem entrega');
  ok(ve(PROMOTOR) === true, '1c: o Promotor vê a sentença sem precisar recebê-la');
  ok(ve(DESEMB) === true, '1d: o Desembargador vê');
  ok(ve(PROCURADOR) === true, '1e: o Procurador vê');
}

// ---------------------------------------------------------------------------
console.log('\n2) ADVOGADO E PARTES não veem até a entrega — a metade que sustenta o gate');
// ---------------------------------------------------------------------------
{
  ok(ve(ADV_HABIL) === false,
    '2a: o advogado DESTINATÁRIO não vê antes da entrega — é ele que precisa ir à cena');
  ok(ve(ADV_OUTRO) === false, '2b: advogado de outro caso não vê');
  ok(ve(REU) === false, '2c: o réu não vê');
  ok(ve(ZE_NINGUEM) === false, '2d: quem não é nada no processo não vê');

  // DELEGADO — decisão explícita do operador: fica de fora. Nos casos dele vale identidade estrita.
  ok(ve(DELEGADO) === false,
    '2e: o DELEGADO não vê o teor da decisão, mesmo sendo parte do inquérito');
  ok(rh.temCargo(DELEGADO, 'Delegado'), '2e-z: (e ele realmente tem o cargo — o teste não passou por engano)');

  // A entrega abre, e só para quem recebeu.
  pecas.abrirEntrega(PECA, JUIZ_CASO);
  const token = db.buscarPorNumero('pecas', PECA).destinatarios[0].token;
  const r = pecas.receber(PECA, ADV_HABIL, { tokenLido: token });
  ok(r.ok, '2f: o advogado recebe em cena, com o selo');
  ok(ve(ADV_HABIL) === true, '2g: e passa a ver o teor');
  ok(ve(ADV_OUTRO) === false, '2h: sem abrir para o advogado da outra parte');
  ok(ve(REU) === false, '2i: nem para o réu');
}

// ---------------------------------------------------------------------------
console.log('\n3) O ALARGAMENTO NÃO VAZOU para outros papéis');
// ---------------------------------------------------------------------------
{
  // Peça dirigida AO ADVOGADO continua sendo assunto entre juiz e aquele advogado. Um cargo de
  // magistratura não pode fazer alguém "ocupar" o papel de Advogado — seria o vazamento entre
  // defesas que a separação órgão/parte existe para impedir.
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Advogado', habilitacaoId: 1 }, DESEMB) === false,
    '3a: Desembargador NÃO ocupa o papel de Advogado (ver teor ≠ ser destinatário)');
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Advogado', habilitacaoId: 1 }, PROMOTOR) === false,
    '3b: nem o Promotor');
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Juiz' }, DELEGADO) === false,
    '3c: e o Delegado não cobre o papel de Juiz');

  // O REQUERENTE da petição administrativa é PARTE: nenhum cargo o cobre.
  const pet = db.inserir('peticoes', {
    numero: '0600PA', tipo: 'PorteArma', status: 'Pendente', modoEntrega: 'ingame',
    requerenteId: ADV_HABIL, juiz: JUIZ_CASO, canalId: 'c2',
  });
  ok(pecas.ocupaDestinatario('peticoes', pet, { papel: 'Requerente' }, ADV_HABIL) === true,
    '3d: o requerente ocupa o próprio papel');
  ok(pecas.ocupaDestinatario('peticoes', pet, { papel: 'Requerente' }, ADV_OUTRO) === false,
    '3e: outro advogado NÃO ocupa o papel de requerente');
  ok(pecas.ocupaDestinatario('peticoes', pet, { papel: 'Requerente' }, DESEMB) === false,
    '3f: nenhum cargo cobre o requerente — é parte, não órgão');
}

// ---------------------------------------------------------------------------
console.log('\n4) A DECISÃO DA PETIÇÃO segue a mesma regra');
// ---------------------------------------------------------------------------
{
  const pet = db.buscarPorNumero('peticoes', '0600PA');
  const gd = pecas.gerar({
    processoTabela: 'peticoes', processoNumero: '0600PA', tipo: 'decisao_peticao',
    autorId: JUIZ_CASO, autorPapel: 'Juiz', texto: 'Resultado: Deferido\n\nFundamentação.',
    destinatarios: [{ papel: 'Requerente' }],
  });
  ok(gd.ok && gd.peca.gated, '4z: a decisão da petição nasce gated em modo ingame');
  const veD = (uid) => pecas.podeVerTeor(uid, gd.peca.numero, null, { ehStaff: false });

  ok(veD(JUIZ_CASO) === true, '4a: o Juiz que decidiu vê');
  ok(veD(PROMOTOR) === true, '4b: o MP vê (é órgão, despacha no fórum)');
  ok(veD(ADV_HABIL) === false,
    '4c: o ADVOGADO REQUERENTE não vê a decisão até receber — era exatamente isto que vazava');
  ok(veD(ADV_OUTRO) === false, '4d: nem advogado nenhum de fora');
  ok(veD(DELEGADO) === false, '4e: nem o Delegado');

  pecas.abrirEntrega(gd.peca.numero, JUIZ_CASO);
  const tk = db.buscarPorNumero('pecas', gd.peca.numero).destinatarios[0].token;
  ok(pecas.receber(gd.peca.numero, ADV_HABIL, { tokenLido: tk }).ok, '4f: ele recebe em cena');
  ok(veD(ADV_HABIL) === true, '4g: e aí passa a ver a decisão');
}

// ---------------------------------------------------------------------------
console.log('\n5) MODO ABERTO não é afetado — o rito não muda no meio');
// ---------------------------------------------------------------------------
{
  db.inserir('processos', {
    numero: '0601CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'aberto',
    juiz: JUIZ_CASO, autor: ADV_HABIL, reus: [], canalId: 'c3', habilitacoes: [],
  });
  const ga = pecas.gerar({
    processoTabela: 'processos', processoNumero: '0601CV', tipo: 'sentenca',
    autorId: JUIZ_CASO, autorPapel: 'Juiz', texto: 'Sentença aberta.', destinatarios: [{ papel: 'Juiz' }],
  });
  ok(ga.ok && !ga.peca.gated, '5a: em modo aberto a peça não é gated');
  ok(pecas.podeVerTeor(ADV_OUTRO, ga.peca.numero, null, { ehStaff: false }) === true,
    '5b: e o teor é visível às partes desde a criação, como sempre foi');
}

// ---------------------------------------------------------------------------
console.log('\n6) A REGRA está declarada em UM lugar');
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'pecas.js'), 'utf-8');
  ok(src.length > 1000, '6z: o arquivo foi lido (scan não vazio)');
  ok(/CARGOS_QUE_VEEM_TEOR/.test(src), '6a: existe uma lista nomeada de quem vê o teor');
  const lista = src.slice(src.indexOf('const CARGOS_QUE_VEEM_TEOR'), src.indexOf('const CARGOS_QUE_VEEM_TEOR') + 200);
  ok(!/Delegado|Advogado|Autor/.test(lista),
    '6b: e Delegado, Advogado e Autor NÃO estão nela', lista.split('\n')[0]);
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
