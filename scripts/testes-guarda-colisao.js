/* eslint-disable */
// GUARDA DE COLISÃO NOS ATOS DECISÓRIOS (19/08/2026). Rode com:
//   node scripts/testes-guarda-colisao.js
//
// POR QUE ISSO EXISTE: enquanto só o titular decidia, dois cliques simultâneos eram improváveis.
// Ao abrir os atos por CARGO (qualquer Juiz decide o caso de qualquer colega), a corrida virou
// rotina — dois magistrados de plantão olham a mesma fila e clicam no mesmo botão.
//
// O QUE ESTE ARQUIVO PROVA, ato por ato:
//   1. o SEGUNDO clique não refaz nada (o estado gravado não muda);
//   2. a recusa NOMEIA quem executou — "já foi feito por @X", não um "já foi decidido" mudo;
//   3. o executor real fica gravado (executadoPorId / decididoPorId), não o titular do caso.
//
// O item 3 é o que impede a auditoria de mentir: o titular continua registrado como dono do caso,
// mas quem clicou pode ser outro, e é o clique que tem valor de ato.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-colisao-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const atos = require('../utils/atosPorCargo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ_A = '700000000000000001';
const JUIZ_B = '700000000000000002';
const PROMO_A = '700000000000000003';
const PROMO_B = '700000000000000004';

console.log('\n=== Guarda de colisão nos atos decisórios ===\n');

// ---------------------------------------------------------------------------
console.log('1) O primitivo: a mensagem nomeia quem fez');
// ---------------------------------------------------------------------------
{
  const msg = atos.mensagemJaFeito('O julgamento', { porId: JUIZ_A, em: '2026-08-19T12:00:00.000Z' });
  ok(msg.includes(`<@${JUIZ_A}>`), '1a: a recusa cita o Discord de quem executou');
  ok(/já foi feito/.test(msg), '1b: a recusa diz "já foi feito"');
  ok(/[Nn]ada foi refeito/.test(msg), '1c: a recusa afirma que nada foi refeito');
  ok(/<t:\d+:f>/.test(msg), '1d: a recusa carrega o horário em timestamp do Discord');

  // Sem executor gravado (ato antigo, anterior a esta rodada) a mensagem ainda precisa fazer
  // sentido — recusa que quebra por falta de dado velho é pior que a colisão.
  const semQuem = atos.mensagemJaFeito('O julgamento', { porId: null, em: null });
  ok(semQuem.includes('outro(a) magistrado(a)'), '1e: registro antigo sem executor degrada com elegância');
  ok(!semQuem.includes('<t:'), '1f: ...e não inventa horário que não existe');
}

// ---------------------------------------------------------------------------
console.log('\n2) bloqueioPorJaExecutado — marcador de horário gravado');
// ---------------------------------------------------------------------------
{
  const virgem = { numero: 'X1' };
  ok(atos.bloqueioPorJaExecutado(virgem, ['decisaoJuizEm'], 'A decisão') === null,
    '2a: registro sem marcador NÃO bloqueia (o primeiro clique passa)');

  const feito = { numero: 'X1', decisaoJuizEm: '2026-08-19T12:00:00.000Z', executadoPorId: JUIZ_A };
  const bloq = atos.bloqueioPorJaExecutado(feito, ['decisaoJuizEm'], 'A decisão');
  ok(typeof bloq === 'string' && bloq.includes(`<@${JUIZ_A}>`),
    '2b: registro com marcador bloqueia E nomeia o executor');

  ok(atos.bloqueioPorJaExecutado(null, ['decisaoJuizEm'], 'A decisão') === null,
    '2c: registro inexistente não bloqueia (quem trata "não encontrado" é o chamador)');
}

// ---------------------------------------------------------------------------
console.log('\n3) bloqueioPorStatusDecidido — marcador de status, com estado reversível');
// ---------------------------------------------------------------------------
{
  // Diligência é a razão desta variante existir: a petição JÁ foi decidida uma vez e ainda pode
  // ser decidida de novo. Um marcador de horário sozinho travaria o que é legítimo.
  ok(atos.bloqueioPorStatusDecidido({ status: 'Pendente' }, ['Pendente', 'Diligência'], 'A decisão') === null,
    '3a: status "Pendente" está aberto — não bloqueia');
  ok(atos.bloqueioPorStatusDecidido({ status: 'Diligência' }, ['Pendente', 'Diligência'], 'A decisão') === null,
    '3b: status "Diligência" está aberto — NÃO bloqueia (é reversível de propósito)');

  const dec = atos.bloqueioPorStatusDecidido(
    { status: 'Deferido', executadoPorId: JUIZ_B, decisaoJuizEm: '2026-08-19T12:00:00.000Z' },
    ['Pendente', 'Diligência'], 'A decisão desta petição',
  );
  ok(typeof dec === 'string' && dec.includes(`<@${JUIZ_B}>`),
    '3c: status terminal bloqueia E nomeia quem decidiu');
}

// ---------------------------------------------------------------------------
console.log('\n4) COMPORTAMENTAL: o segundo clique não muda o estado gravado');
// ---------------------------------------------------------------------------
// Simula a corrida com o banco de verdade: dois magistrados, o mesmo registro, o mesmo botão.
// Cada bloco imita o ponto de commit real — releitura fresca, guarda, gravação.
{
  // --- petição administrativa (finalizarDecisao) ---
  db.inserir('peticoes', { numero: 'C001PA', tipo: 'PorteArma', status: 'Pendente', juiz: JUIZ_A });

  function commitPeticao(numero, status, executorId) {
    const atual = db.buscarPorNumero('peticoes', numero);
    const colisao = atos.bloqueioPorStatusDecidido(atual, ['Pendente', 'Diligência'], 'A decisão desta petição');
    if (colisao) return { colisao };
    db.atualizar('peticoes', numero, {
      status, decisaoJuizEm: new Date().toISOString(), ...atos.carimboDeExecucao(executorId),
    });
    return { ok: true };
  }

  const r1 = commitPeticao('C001PA', 'Deferido', JUIZ_A);
  const r2 = commitPeticao('C001PA', 'Indeferido', JUIZ_B);
  const final = db.buscarPorNumero('peticoes', 'C001PA');

  ok(r1.ok === true, '4a: o primeiro clique executa');
  ok(!!r2.colisao, '4b: o segundo clique é recusado');
  ok(r2.colisao.includes(`<@${JUIZ_A}>`), '4c: a recusa nomeia o JUIZ_A, que decidiu de fato');
  ok(final.status === 'Deferido', '4d: o estado é o do PRIMEIRO — o segundo não sobrescreveu');
  ok(final.executadoPorId === JUIZ_A, '4e: o executor gravado é quem clicou');

  // --- diligência é reversível: decidir de novo depois dela precisa CONTINUAR funcionando ---
  db.inserir('peticoes', { numero: 'C002PA', tipo: 'PorteArma', status: 'Pendente', juiz: JUIZ_A });
  const d1 = commitPeticaoDiligencia('C002PA', JUIZ_A);
  const d2 = commitPeticao('C002PA', 'Deferido', JUIZ_B);
  ok(d1.ok === true && d2.ok === true,
    '4f: diligência não trava a decisão seguinte (a trava não pode matar o fluxo legítimo)');
  ok(db.buscarPorNumero('peticoes', 'C002PA').status === 'Deferido',
    '4g: ...e a decisão pós-diligência grava normalmente');

  function commitPeticaoDiligencia(numero, executorId) {
    const atual = db.buscarPorNumero('peticoes', numero);
    const colisao = atos.bloqueioPorStatusDecidido(atual, ['Pendente', 'Diligência'], 'A decisão desta petição');
    if (colisao) return { colisao };
    db.atualizar('peticoes', numero, { status: 'Diligência', ...atos.carimboDeExecucao(executorId) });
    return { ok: true };
  }
}

{
  // --- medida: referendar (emite mandado + PNG) vs negar provimento ---
  db.inserir('medidas', { numero: 'C001MD', status: 'Aprovada - aguardando juiz', juiz: JUIZ_A, promotor: PROMO_A });

  function commitMedida(numero, status, executorId) {
    const atual = db.buscarPorNumero('medidas', numero);
    const colisao = atos.bloqueioPorJaExecutado(atual, ['decisaoJuizEm'], 'A decisão desta medida');
    if (colisao) return { colisao };
    db.atualizar('medidas', numero, {
      status, decisaoJuizEm: new Date().toISOString(), ...atos.carimboDeExecucao(executorId),
    });
    return { ok: true };
  }

  const m1 = commitMedida('C001MD', 'Deferida', JUIZ_A);
  const m2 = commitMedida('C001MD', 'Indeferida pelo Juiz', JUIZ_B);
  const fim = db.buscarPorNumero('medidas', 'C001MD');

  ok(m1.ok === true, '4h: referendo executa na primeira vez');
  ok(!!m2.colisao && m2.colisao.includes(`<@${JUIZ_A}>`),
    '4i: negar provimento depois do referendo é recusado, nomeando quem referendou');
  ok(fim.status === 'Deferida',
    '4j: a medida continua Deferida — o mandado já emitido não vira medida negada nos autos');
}

{
  // --- sub-registro: requerimento do MP dentro do processo ---
  db.inserir('processos', {
    numero: 'C001PN', tipo: 'Penal', juiz: JUIZ_A, promotor: PROMO_A,
    requerimentosMp: [{ id: 1, status: 'Pendente', texto: 'quebra de sigilo' }],
  });

  function commitRequerimento(numero, reqId, novoStatus, executorId) {
    const p = db.buscarPorNumero('processos', numero);
    const reqs = p.requerimentosMp || [];
    const alvo = reqs.find(r => r.id === reqId);
    if (!alvo) return { erro: 'sumiu' };
    if (alvo.status !== 'Pendente') {
      return { colisao: atos.mensagemJaFeito('A decisão deste requerimento', { porId: alvo.decididoPorId || null, em: alvo.decididoEm || null }) };
    }
    db.atualizar(numero === null ? '' : 'processos', numero, {
      requerimentosMp: reqs.map(r => r.id === reqId
        ? { ...r, status: novoStatus, decididoPorId: executorId, decididoEm: new Date().toISOString() }
        : r),
    });
    return { ok: true };
  }

  const q1 = commitRequerimento('C001PN', 1, 'Deferido', JUIZ_A);
  const q2 = commitRequerimento('C001PN', 1, 'Indeferido', JUIZ_B);
  const req = db.buscarPorNumero('processos', 'C001PN').requerimentosMp[0];

  ok(q1.ok === true, '4k: requerimento do MP é decidido na primeira vez');
  ok(!!q2.colisao && q2.colisao.includes(`<@${JUIZ_A}>`),
    '4l: a segunda decisão do mesmo requerimento é recusada, nomeando quem decidiu');
  ok(req.status === 'Deferido', '4m: o sub-registro guarda a PRIMEIRA decisão');
  ok(req.decididoPorId === JUIZ_A,
    '4n: o carimbo vive no item, não no processo — cada requerimento tem seu executor');
}

{
  // --- claim síncrono: o parecer do MP marca ANTES do trabalho lento (PNG, sorteio de Juiz) ---
  db.inserir('processos', { numero: 'C002PN', tipo: 'Penal', promotor: PROMO_A, status: 'Aguardando MP' });

  function claimParecer(numero, executorId) {
    const p = db.buscarPorNumero('processos', numero);
    const colisao = atos.bloqueioPorJaExecutado(p, ['parecerMpEm'], 'O parecer do Ministério Público');
    if (colisao) return { colisao };
    db.atualizar('processos', numero, {
      parecerMpEm: new Date().toISOString(), ...atos.carimboDeExecucao(executorId),
    });
    return { ok: true };
  }

  const p1 = claimParecer('C002PN', PROMO_A);
  const p2 = claimParecer('C002PN', PROMO_B);
  ok(p1.ok === true, '4o: o primeiro Promotor reserva o parecer');
  ok(!!p2.colisao && p2.colisao.includes(`<@${PROMO_A}>`),
    '4p: o segundo Promotor é barrado ANTES de gerar PNG e sortear Juiz');
  ok(db.buscarPorNumero('processos', 'C002PN').executadoPorId === PROMO_A,
    '4q: o parecer fica creditado a quem reservou');
}

// ---------------------------------------------------------------------------
console.log('\n5) VARREDURA: os atos decisórios de produção têm a trava no código');
// ---------------------------------------------------------------------------
// Estático de propósito — os blocos acima provam o COMPORTAMENTO com o banco real, mas não provam
// que os arquivos de produção chamam a guarda. Sem isto, a trava poderia ser removida de um
// handler sem nenhum teste ficar vermelho.
{
  const raiz = path.join(__dirname, '..');
  const ATOS_ESPERADOS = [
    ['commands/peticao.js', 'finalizarDecisao', 'deferir/indeferir/diligência de petição administrativa'],
    ['commands/medida.js', 'processarReferendo', 'referendar medida (emite mandado)'],
    ['commands/medida.js', 'negarJuiz', 'negar provimento à medida'],
    ['commands/medida.js', 'deferirMedidaDireta', 'deferir medida solicitada direto pelo MP'],
    ['commands/medida.js', 'indeferirMedidaDireta', 'indeferir medida solicitada direto pelo MP'],
    ['commands/medida.js', 'processarAprovacaoMP', 'triagem do MP — aprovar medida'],
    ['commands/medida.js', 'decidirReconsideracaoGenerica', 'decidir reconsideração (Procurador/Desembargador)'],
    ['commands/mandado.js', 'emitirMandado', 'emitir mandado avulso no processo'],
    ['commands/processo.js', 'decidirRequerimentoMp', 'decidir requerimento do MP'],
    ['commands/processo.js', 'decidirHabilitacao', 'decidir habilitação de advogado'],
    ['commands/processo.js', 'decidirPeticao', 'decidir petição incidental do processo'],
    ['commands/processo.js', 'arquivarCivil', 'arquivar a petição inicial cível'],
    ['commands/processo.js', 'executarParecerMp', 'parecer do MP (oferecer denúncia / arquivar)'],
    ['commands/processo.js', 'emitirIntimacao', 'citação cível (abre o prazo de contestação)'],
    ['commands/processo.js', 'finalizarApelacao', 'julgar apelação (acórdão)'],
    ['commands/processo.js', 'executarSentenca', 'sentença — o padrão que os demais copiam'],
  ];

  // Delimita o corpo da função pela PRÓXIMA declaração de função no mesmo arquivo, em vez de um
  // número fixo de linhas: recorte por tamanho fixo já produziu varredura vazia neste projeto e
  // teste vazio dá confiança falsa.
  // Ancora na DECLARAÇÃO, nunca numa chamada: `executarParecerMp(...)` aparece antes no roteador
  // de botões, e casar com a primeira ocorrência recortava o corpo errado — verde falso garantido.
  function corpoDaFuncao(fonte, nome) {
    const decl = new RegExp(`^(?:async function ${nome}\\s*\\(|  async ${nome}\\s*\\(|function ${nome}\\s*\\()`, 'm');
    const i = fonte.search(decl);
    if (i < 0) return null;
    const resto = fonte.slice(i + 1);
    const prox = resto.search(/\n(?:async function |function |  async [a-zA-Z]+\(|module\.exports)/);
    return prox < 0 ? resto : resto.slice(0, prox);
  }

  let examinados = 0;
  for (const [arquivo, funcao, rotulo] of ATOS_ESPERADOS) {
    const fonte = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    const corpo = corpoDaFuncao(fonte, funcao);
    if (corpo === null) { ok(false, `5.${examinados}: ${rotulo}`, `função ${funcao} não encontrada em ${arquivo}`); continue; }
    examinados++;
    const temGuarda = /bloqueioPorJaExecutado|bloqueioPorStatusDecidido|jaExecutado\(|mensagemJaFeito/.test(corpo);
    ok(temGuarda, `5.${examinados}: ${rotulo} (${arquivo} → ${funcao}) tem guarda de colisão`);
  }

  // CANÁRIO — varredura que lê zero passa verde e mente. Já aconteceu três vezes neste projeto.
  ok(examinados === ATOS_ESPERADOS.length,
    `5z: a varredura examinou os ${ATOS_ESPERADOS.length} atos (não passou vazia)`,
    `examinou ${examinados}`);
}

// ---------------------------------------------------------------------------
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
