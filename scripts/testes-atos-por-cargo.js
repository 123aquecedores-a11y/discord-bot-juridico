/* eslint-disable */
// ATOS POR CARGO, NÃO POR TITULARIDADE (19/08/2026). Rode com:
//   node scripts/testes-atos-por-cargo.js
//
// O PROBLEMA: o bot exigia que o ato fosse praticado pelo titular DAQUELE caso. Com poucos
// magistrados online, um documento endereçado ao Juiz não tinha quem recebesse e o processo parava
// — não por regra, por ausência.
//
// A ABERTURA: quem TEM o cargo pratica o ato no caso de qualquer colega. Cobertura de plantão.
//
// A METADE QUE IMPORTA TANTO QUANTO: o escopo é FECHADO em Juiz, Promotor, Desembargador e
// Procurador. Advogado e público NÃO entram — e este arquivo prova isso caso a caso, porque uma
// abertura mal contida vira exatamente o vazamento que passamos dias fechando.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-atos-cargo-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');
const atos = require('../utils/atosPorCargo');
const permissoes = require('../utils/permissoes');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ_TITULAR = '600000000000000001';
const JUIZ_OUTRO   = '600000000000000002';
const PROMOTOR_T   = '600000000000000003';
const PROMOTOR_O   = '600000000000000004';
const DESEMB       = '600000000000000005';
const PROCURADOR   = '600000000000000006';
const ADV_HABIL    = '600000000000000007';
const ADV_OUTRO    = '600000000000000008';
const DELEGADO     = '600000000000000009';
const ZE_NINGUEM   = '600000000000000010';

rh.contratar(JUIZ_TITULAR, 'Juiz', 'Juiz Titular');
rh.contratar(JUIZ_OUTRO, 'Juiz', 'Juiz Colega');
rh.contratar(PROMOTOR_T, 'Promotor', 'Promotor Titular');
rh.contratar(PROMOTOR_O, 'Promotor', 'Promotor Colega');
rh.contratar(DESEMB, 'Desembargador', 'Desembargador');
rh.contratar(PROCURADOR, 'Procurador', 'Procurador');
rh.contratar(ADV_HABIL, 'Advogado', 'Advogado Habilitado');
rh.contratar(ADV_OUTRO, 'Advogado', 'Advogado de Outro Caso');
rh.contratar(DELEGADO, 'Delegado', 'Delegado');

// interaction falsa SEM member (DM) — assim temCargo/isAdmin caem no RH puro, que é o que
// queremos exercitar: a decisão por cargo, não por role do Discord.
const fakeI = (userId) => ({ user: { id: userId }, member: null });

const processo = db.inserir('processos', {
  numero: '6001PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
  juiz: JUIZ_TITULAR, promotor: PROMOTOR_T, delegado: DELEGADO, autor: null,
  habilitacoes: [{ id: 1, advogadoId: ADV_HABIL, status: 'Aprovado' }],
  partes: [], canalId: 'c1',
});

console.log('\n=== Atos por cargo (abertura) e o que continua fechado ===\n');

console.log('1) A ABERTURA — qualquer titular do cargo pratica o ato');
{
  const pode = (uid, campo) => permissoes.podeAtuarNoCaso(fakeI(uid), processo, campo);
  ok(pode(JUIZ_TITULAR, 'juiz') === true, '1a: o juiz titular continua podendo (não quebrou o caminho antigo)');
  ok(pode(JUIZ_OUTRO, 'juiz') === true, '1b: OUTRO juiz também pode — é a abertura');
  ok(pode(PROMOTOR_T, 'promotor') === true, '1c: promotor titular pode');
  ok(pode(PROMOTOR_O, 'promotor') === true, '1d: OUTRO promotor também pode');
  ok(pode(DESEMB, 'juiz') === true, '1e: Desembargador cobre o Juiz (chefia da magistratura)');
  ok(pode(PROCURADOR, 'promotor') === true, '1f: Procurador cobre o Promotor (chefia do MP)');
}

console.log('\n2) O ESCOPO É FECHADO — quem não é magistratura/MP não entra');
{
  const pode = (uid, campo) => permissoes.podeAtuarNoCaso(fakeI(uid), processo, campo);
  ok(pode(ADV_HABIL, 'juiz') === false, '2a: advogado habilitado NÃO vira juiz');
  ok(pode(ADV_OUTRO, 'juiz') === false, '2b: advogado de outro caso NÃO vira juiz');
  ok(pode(ADV_HABIL, 'promotor') === false, '2c: advogado NÃO vira promotor');
  ok(pode(ZE_NINGUEM, 'juiz') === false, '2d: quem não tem cargo nenhum não age');
  ok(pode(DELEGADO, 'juiz') === false, '2e: delegado NÃO vira juiz');
  ok(pode(DELEGADO, 'promotor') === false, '2f: delegado NÃO vira promotor');
  // O campo `delegado` NÃO é compartilhável — segue por identidade estrita.
  ok(permissoes.podeAtuarNoCaso(fakeI(DELEGADO), processo, 'delegado') === true, '2g: o delegado titular age no que é dele');
  ok(permissoes.podeAtuarNoCaso(fakeI('600000000000000099'), processo, 'delegado') === false,
    '2h: mas OUTRO delegado não — `delegado` ficou de fora do compartilhamento, de propósito');
}

console.log('\n3) RECEBER PEÇA — o destravamento que motivou tudo');
{
  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: '6001PN', tipo: 'intimacao_juiz',
    autorId: PROMOTOR_T, autorPapel: 'Promotor', texto: 'teor',
    destinatarios: [{ papel: 'Juiz' }],
  });
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Juiz' }, JUIZ_TITULAR) === true,
    '3a: o juiz titular ocupa o papel de destinatário');
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Juiz' }, JUIZ_OUTRO) === true,
    '3b: OUTRO juiz também ocupa — era exatamente o travamento (documento sem quem receber)');
  ok(pecas.ocupaDestinatario('processos', processo, { papel: 'Juiz' }, ADV_HABIL) === false,
    '3c: advogado NÃO ocupa o papel de Juiz');

  // E o recebimento de verdade funciona pelo colega.
  pecas.abrirEntrega(g.peca.numero, PROMOTOR_T);
  const token = db.buscarPorNumero('pecas', g.peca.numero).destinatarios[0].token;
  const r = pecas.receber(g.peca.numero, JUIZ_OUTRO, { tokenLido: token });
  ok(r.ok === true, '3d: um juiz que NÃO é o titular consegue receber a peça de verdade');
  ok(r.destinatario.recebidoPorId === JUIZ_OUTRO, '3e: e fica registrado que foi ELE quem recebeu');
}

console.log('\n4) ADVOGADO CONTINUA PRESO À PRÓPRIA HABILITAÇÃO (sem regressão de vazamento)');
{
  const p2 = db.inserir('processos', {
    numero: '6002CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'ingame', juiz: JUIZ_TITULAR,
    habilitacoes: [{ id: 1, advogadoId: ADV_HABIL, status: 'Aprovado' }], partes: [], canalId: 'c2',
  });
  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: '6002CV', tipo: 'intimacao_juiz',
    autorId: JUIZ_TITULAR, autorPapel: 'Juiz', texto: 'teor secreto',
    destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
  });
  ok(pecas.ocupaDestinatario('processos', p2, { papel: 'Advogado', habilitacaoId: 1 }, ADV_HABIL) === true,
    '4a: o advogado habilitado ocupa o papel dele');
  ok(pecas.ocupaDestinatario('processos', p2, { papel: 'Advogado', habilitacaoId: 1 }, ADV_OUTRO) === false,
    '4b: advogado de OUTRO caso não ocupa — a intimação de uma parte não é recebível pela outra');
  ok(pecas.podeVerTeor(ADV_OUTRO, g.peca.numero, p2) === false,
    '4c: e ele não vê o teor (o vazamento que passamos dias fechando continua fechado)');
  ok(pecas.podeVerTeor(ZE_NINGUEM, g.peca.numero, p2) === false, '4d: público não vê nada');
}

console.log('\n5) GUARDA DE COLISÃO — o segundo clique não refaz o ato');
{
  const semSentenca = { numero: 'X', sentenca: null };
  ok(atos.jaExecutado(semSentenca, ['sentenca']) === null, '5a: ato ainda não praticado → segue o fluxo');

  const jaSentenciado = { numero: 'X', sentenca: 'texto da sentença', executadoPorId: JUIZ_OUTRO, sentencaEm: '2026-08-19T12:00:00.000Z' };
  const exec = atos.jaExecutado(jaSentenciado, ['sentenca']);
  ok(exec !== null, '5b: ato já praticado é detectado pelo ESTADO GRAVADO (não por lock em memória)');

  const msg = atos.mensagemJaFeito('O julgamento', { ...exec, porId: jaSentenciado.executadoPorId });
  ok(/já foi feito/i.test(msg), '5c: a mensagem diz que já foi feito');
  ok(msg.includes(JUIZ_OUTRO), '5d: ...e NOMEIA quem fez — é o que transforma "nada aconteceu" em informação');
  ok(/Nada foi refeito/i.test(msg), '5e: ...deixando explícito que não duplicou');
}

console.log('\n6) CARIMBO DE EXECUÇÃO — quem agiu, não só quem é o titular');
{
  const carimbo = atos.carimboDeExecucao(JUIZ_OUTRO);
  ok(carimbo.executadoPorId === JUIZ_OUTRO, '6a: grava quem executou');
  ok(!!carimbo.executadoEm, '6b: e quando');

  // O titular NÃO é sobrescrito: ele continua sendo o dono do caso para notificação e organização.
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  ok(/carimboDeExecucao\(interaction\.user\.id\)/.test(src), '6c: a sentença aplica o carimbo do executor real');
  ok(/status: 'Encerrado', sentenca: texto/.test(src), '6d: ...sem deixar de gravar a sentença (nada foi trocado por engano)');
}

console.log('\n7) A MIGRAÇÃO cobriu os atos, e os campos certos');
{
  const arquivos = ['commands/processo.js', 'commands/medida.js', 'commands/peticao.js', 'commands/mandado.js'];
  let porCargo = 0; let identidadeRemanescente = 0;
  for (const arq of arquivos) {
    const src = fs.readFileSync(path.join(__dirname, '..', arq), 'utf-8');
    porCargo += (src.match(/podeAtuarNoCaso\(interaction, [A-Za-z_$][\w$]*, '(juiz|promotor|desembargadorId)'\)/g) || []).length;
    // Travas de identidade que SOBRARAM nesses campos = migração incompleta.
    identidadeRemanescente += (src.match(/interaction\.user\.id !== [A-Za-z_$][\w$]*\.(juiz|promotor|desembargadorId) &&/g) || []).length;
  }
  ok(porCargo >= 40, '7a: as travas de magistratura/MP passaram a decidir por cargo', `${porCargo} travas`);
  ok(identidadeRemanescente === 0, '7b: nenhuma trava de juiz/promotor/desembargador ficou por identidade', `${identidadeRemanescente} sobraram`);

  // E as que DEVIAM ficar por identidade continuam lá — a migração não foi cega.
  const proc = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  ok(/interaction\.user\.id !== processo\.(delegado|autor)/.test(proc),
    '7c: delegado/autor continuam por IDENTIDADE (não são magistratura nem MP)');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
