/* eslint-disable */
// ELO "DENÚNCIA RECEBIDA → DESTRAVA O JUIZ" (19/08/2026). Rode com:
//   node scripts/testes-destravamento-denuncia.js
//
// O QUE ESTAVA QUEBRADO EM PRODUÇÃO: o Juiz recebia a denúncia em cena, o QR era lido, a entrega
// era lavrada nos autos — e nada acontecia. O processo continuava sem Juiz, o painel continuava
// sem o menu do Juiz, e a corrente de destravamento parava ali.
//
// A LINHA QUE ESTE ARQUIVO NÃO DEIXA CRUZAR: receber o PAPEL não é receber a DENÚNCIA. O gate do
// QR prova entrega e libera leitura; aceitar a acusação é ato judicial, com peça própria. O que o
// recebimento faz aqui é DISTRIBUIÇÃO — a mesma coisa que rh.sortearJuiz já fazia sozinho, sem
// nenhuma decisão de mérito pelo caminho. O teste 9 de testes-intimacao-gated.js guarda o outro
// lado dessa mesma linha e continua verde.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-destrava-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const emissao = require('../utils/emissaoPeca');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ_A = '800000000000000001';
const JUIZ_B = '800000000000000002';
const PROMOTOR = '800000000000000003';
// O caso real do acúmulo NÃO é alguém com dois cargos: `rh.temCargo` lê um único cargo ativo por
// pessoa, então isso não existe. É o EX-PROMOTOR PROMOVIDO A JUIZ — cargo Juiz hoje, mas ainda
// gravado no campo `promotor` dos processos que ele acusou antes da promoção. Esse chega até o
// efeito, porque cobre o papel de destinatário "Juiz".
const EX_PROMOTOR_HOJE_JUIZ = '800000000000000004';
const STAFF_SEM_CARGO = '800000000000000005';
const REU = '800000000000000006';

rh.contratar(JUIZ_A, 'Juiz', 'Juiz A');
rh.contratar(JUIZ_B, 'Juiz', 'Juiz B');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(EX_PROMOTOR_HOJE_JUIZ, 'Promotor', 'Promovido');
rh.contratar(EX_PROMOTOR_HOJE_JUIZ, 'Juiz', 'Promovido'); // a promoção: cargo Juiz agora
rh.contratar(REU, 'Juiz', 'Réu com toga');

let seq = 0;
function processoPenal(campos = {}) {
  const numero = `09${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Denúncia oferecida - aguardando juiz', modoEntrega: 'ingame',
    juiz: null, promotor: PROMOTOR, delegado: PROMOTOR, reus: [], canalId: 'c1', ...campos,
  });
  return db.buscarPorNumero('processos', numero);
}
const receber = (proc, quemId) =>
  emissao.aplicarEfeitoDoRecebimento('denuncia_mp', proc, { numero: `${proc.numero}-P1` }, quemId);

console.log('\n=== Elo: denúncia recebida → destrava o juiz ===\n');

// ---------------------------------------------------------------------------
console.log('1) O CAMINHO FELIZ — Juiz recebe e assume o caso');
// ---------------------------------------------------------------------------
{
  const p = processoPenal();
  const r = receber(p, JUIZ_A);
  const depois = db.buscarPorNumero('processos', p.numero);

  ok(!!r && !!r.campos, '1a: o recebimento produz efeito (antes não produzia nenhum)');
  ok(depois.juiz === JUIZ_A, '1b: quem recebeu vira o Juiz responsável');
  ok(depois.status === 'Instrução', '1c: o processo avança para instrução');
  ok(!!depois.juizDesde, '1d: fica gravado desde quando ele é o Juiz (o relógio dos prazos)');
  ok(depois.distribuidoPorRecebimento === true,
    '1e: fica marcado que a distribuição veio do recebimento, não do sorteio');
  ok(typeof r.aviso === 'string' && r.aviso.includes(p.numero),
    '1f: o Juiz é avisado do que aconteceu, com o número do processo');

  // REQUISITO 3 — o painel passa a mostrar o menu do Juiz. Não basta gravar o campo: o que o
  // jogador vê é o painel, e é ele que estava travado na fase do MP.
  const processoCmd = require('../commands/processo');
  const antes = processoCmd.montarPainelAcoes({ ...p, juiz: null });
  const agora = processoCmd.montarPainelAcoes(db.buscarPorNumero('processos', p.numero));
  const ids = (linhas) => JSON.stringify(linhas.map(l => l.toJSON()));
  ok(ids(antes) !== ids(agora), '1g: o painel MUDA depois do recebimento (não é o mesmo menu)');
  ok(/juiz/i.test(ids(agora)), '1h: ...e o menu agora traz as ações do Juiz');
  ok(agora.length > 0, '1i: o painel não ficou vazio');
}

// ---------------------------------------------------------------------------
console.log('\n2) GUARDA DE COLISÃO — processo com Juiz não é redistribuído');
// ---------------------------------------------------------------------------
{
  const p = processoPenal({ juiz: JUIZ_A, status: 'Instrução' });
  const r = receber(p, JUIZ_B);
  const depois = db.buscarPorNumero('processos', p.numero);

  ok(depois.juiz === JUIZ_A, '2a: o segundo recebimento NÃO reatribui o processo');
  ok(!!r && !!r.recusa, '2b: e o segundo Juiz recebe explicação, não silêncio');
  ok(r.recusa.includes(`<@${JUIZ_A}>`), '2c: a explicação NOMEIA quem já é o responsável');
  ok(!r.campos, '2d: nada foi gravado');

  // O próprio titular recebendo de novo não é erro nem recusa — é só um não-evento.
  const p2 = processoPenal({ juiz: JUIZ_A, status: 'Instrução' });
  const r2 = receber(p2, JUIZ_A);
  ok(r2 === null, '2e: o próprio Juiz do caso recebendo de novo não gera aviso nem recusa');
}

// ---------------------------------------------------------------------------
console.log('\n3) ACÚMULO PROIBIDO — quem acusa não julga');
// ---------------------------------------------------------------------------
{
  // Ele tem cargo de Juiz hoje, então cobre o papel de destinatário "Juiz" e consegue receber.
  // Mas continua gravado como promotor DESTE caso: entregar o papel é certo, designá-lo juiz do
  // caso que ele mesmo acusou não é.
  const p = processoPenal({ promotor: EX_PROMOTOR_HOJE_JUIZ, delegado: EX_PROMOTOR_HOJE_JUIZ });
  const r = receber(p, EX_PROMOTOR_HOJE_JUIZ);
  const depois = db.buscarPorNumero('processos', p.numero);

  ok(depois.juiz === null, '3a: o promotor do caso NÃO vira Juiz dele');
  ok(depois.status === 'Denúncia oferecida - aguardando juiz', '3b: o status não avança');
  ok(!!r && !!r.recusa, '3c: e a resposta NÃO é muda — era esse o pedido');
  ok(/[Pp]romotor deste caso/.test(r.recusa),
    '3d: a mensagem diz que ele é o promotor do caso');
  ok(/outro Juiz precisa/i.test(r.recusa),
    '3e: ...e diz o que precisa acontecer para destravar');

  // O mesmo Juiz em OUTRO processo, onde ele não consta como promotor, assume normalmente — a trava
  // é sobre o conflito no caso concreto, não sobre a pessoa.
  const p2 = processoPenal({ promotor: PROMOTOR });
  receber(p2, EX_PROMOTOR_HOJE_JUIZ);
  ok(db.buscarPorNumero('processos', p2.numero).juiz === EX_PROMOTOR_HOJE_JUIZ,
    '3f: o mesmo Juiz assume normalmente um caso em que NÃO consta como promotor');
}

// ---------------------------------------------------------------------------
console.log('\n4) OUTRAS RECUSAS — sempre com explicação, nunca mudas');
// ---------------------------------------------------------------------------
{
  const p = processoPenal();
  const r = receber(p, STAFF_SEM_CARGO);
  ok(db.buscarPorNumero('processos', p.numero).juiz === null,
    '4a: quem não tem cargo de Juiz não vira titular (staff recebendo pela supervisão)');
  ok(!!r && /\/rh/.test(r.recusa), '4b: ...e a mensagem aponta onde resolver (o registro no /rh)');

  const p2 = processoPenal({ reus: [REU] });
  const r2 = receber(p2, REU);
  ok(db.buscarPorNumero('processos', p2.numero).juiz === null,
    '4c: réu do próprio processo não vira Juiz dele, mesmo tendo o cargo');
  ok(!!r2 && /parte neste processo/i.test(r2.recusa), '4d: ...com a razão dita por extenso');
}

// ---------------------------------------------------------------------------
console.log('\n5) ESCOPO — quem destrava, e com quais guardas');
// ---------------------------------------------------------------------------
{
  const p = processoPenal();
  // Contestação, petição incidental, intimação: não estão neste elo. Fazer mais que o pedido é tão
  // errado quanto fazer menos — cada elo da corrente é uma decisão à parte.
  for (const tipo of ['contestacao', 'peticao_incidental', 'intimacao_juiz']) {
    const r = emissao.aplicarEfeitoDoRecebimento(tipo, p, { numero: 'X-P1' }, JUIZ_A, 'processos');
    ok(r === null, `5-${tipo}: recebimento de "${tipo}" não mexe no processo (fora deste elo)`);
  }
  ok(db.buscarPorNumero('processos', p.numero).juiz === null,
    '5a: nenhum dos tipos acima designou Juiz');

  // Lista FECHADA de elos, conferida item a item. Cada elo aqui foi uma decisão explícita do
  // operador; um tipo que apareça sem passar por essa decisão é o que este canário existe para
  // pegar.
  //   +razoes_recurso (19/08/2026): o recurso passou a exigir entrega.
  //   +solicitacao_medida (19/08/2026): o requerimento do MP é entregue em cena, e é o recebimento
  //    que libera deferir/indeferir. Antes os botões nasciam com o pedido.
  //   +manifestacao_mp_gated (20/08/2026): o MP virou porta ÚNICA — não há mais "tipo denúncia" a
  //    emitir, então o elo que distribuía o processo teve de mudar de tipo junto, senão o penal
  //    aberto pelo MP não ganhava Juiz por caminho nenhum (mapeamento de 20/08).
  const tiposComEfeito = Object.keys(emissao.EFEITOS_POS_RECEBIMENTO).sort();
  ok(JSON.stringify(tiposComEfeito) === JSON.stringify(['denuncia_mp', 'manifestacao_mp_gated', 'razoes_recurso', 'solicitacao_medida']),
    '5b: só os elos decididos têm efeito de recebimento — nenhum a mais',
    tiposComEfeito.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n5-bis) AS GUARDAS DA MANIFESTAÇÃO — escopo penal, e só a PRIMEIRA distribui');
// ---------------------------------------------------------------------------
{
  // A manifestação do MP é o ato mais frequente do processo: ela vai e volta a instrução inteira.
  // Se distribuísse toda vez, trocaria o Juiz do caso a cada documento. Estas guardas são a
  // diferença entre "a primeira manifestação abre o processo" e "o MP escolhe o juiz quando quer".
  const p = processoPenal();
  const r1 = emissao.aplicarEfeitoDoRecebimento('manifestacao_mp_gated', p, { numero: 'M-P1' }, JUIZ_A, 'processos');
  ok(!!r1 && r1.campos && r1.campos.juiz === JUIZ_A,
    '5c: a PRIMEIRA manifestação num penal sem juiz distribui o processo a quem recebeu');
  ok(r1.campos.status === 'Instrução', '5d: e o leva para instrução');

  // IDEMPOTÊNCIA — é a guarda que o operador pediu por escrito.
  const agora = db.buscarPorNumero('processos', p.numero);
  const r2 = emissao.aplicarEfeitoDoRecebimento('manifestacao_mp_gated', agora, { numero: 'M-P2' }, JUIZ_B, 'processos');
  ok(r2 === null, '5e: a SEGUNDA manifestação não reatribui — entrega e cala, sem recusa ruidosa');
  ok(db.buscarPorNumero('processos', p.numero).juiz === JUIZ_A, '5f: o Juiz do caso continua sendo o primeiro');

  // ESCOPO 1 — cível tem sorteio próprio; distribuir aqui atropelaria o fluxo dele.
  const civel = processoPenal({ tipo: 'Cível', status: 'Aguardando defesa' });
  const rc = emissao.aplicarEfeitoDoRecebimento('manifestacao_mp_gated', civel, { numero: 'C-P1' }, JUIZ_A, 'processos');
  ok(rc === null, '5g: manifestação em processo CÍVEL não designa Juiz');
  ok(db.buscarPorNumero('processos', civel.numero).juiz === null, '5h: e o cível segue sem juiz');

  // ESCOPO 2 — a MESMA peça roda em petição administrativa (commands/peticao.js sobrepõe a tabela).
  // Sem a guarda de tabela, o efeito gravaria juiz+Instrução num registro de `peticoes` — ou, pior,
  // num processo de mesmo número.
  db.inserir('peticoes', { numero: '0099TN', tipo: 'Porte de arma', status: 'Pendente', juiz: null, promotor: PROMOTOR, canalId: 'c9' });
  const pet = db.buscarPorNumero('peticoes', '0099TN');
  const rp = emissao.aplicarEfeitoDoRecebimento('manifestacao_mp_gated', pet, { numero: 'T-P1' }, JUIZ_A, 'peticoes');
  ok(rp === null, '5i: manifestação em PETIÇÃO administrativa não designa Juiz');
  ok(db.buscarPorNumero('peticoes', '0099TN').juiz === null, '5j: e a petição segue sem juiz');
  ok(!/Instrução/.test(JSON.stringify(db.buscarPorNumero('peticoes', '0099TN'))),
    '5k: nem ganhou status de processo penal');
}

// ---------------------------------------------------------------------------
console.log('\n6) A LINHA QUE NÃO SE CRUZA — gate ≠ ato judicial');
// ---------------------------------------------------------------------------
{
  // Espelha o teste 9 de testes-intimacao-gated.js, do lado de cá. O efeito distribui o caso; não
  // pode, em hipótese nenhuma, produzir juízo de mérito.
  const p = processoPenal();
  receber(p, JUIZ_A);
  const depois = db.buscarPorNumero('processos', p.numero);

  ok(!depois.sentenca && !depois.resultado && !depois.pena,
    '6a: nenhuma decisão de mérito nasce do recebimento');
  ok(!/denunciaRecebida|acusacaoAceita|denunciaAceita/.test(JSON.stringify(depois)),
    '6b: nenhum campo de "acusação aceita" foi criado');
  ok(depois.status === 'Instrução',
    '6c: o status é o mesmo que o sorteio automático já produzia — distribuição, não julgamento');

  // pecas.receber continua pura: quem aplica efeito é a camada de cima (emissaoPeca), nunca o
  // módulo do selo. Sem isto, o teste 9f cai — e com razão.
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'pecas.js'), 'utf-8');
  const corpo = src.slice(src.indexOf('function receber('), src.indexOf('function destravarSelo('));
  ok(corpo.length > 500, '6z: o trecho analisado é o corpo real da função (o scan não passou vazio)');
  // Procurar a palavra "juiz" seria grosseiro demais — ela aparece num comentário legítimo sobre
  // juiz substituto. O que não pode existir é ESCRITA na tabela de processos: é exatamente isso
  // que acoplaria o selo ao ato judicial se alguém o fizesse por conveniência.
  ok(!/db\.atualizar\(\s*'processos'/.test(corpo) && !/juiz\s*:/.test(corpo),
    '6d: pecas.receber não escreve em processos nem designa Juiz — o efeito vive na camada de cima');
}

// ---------------------------------------------------------------------------
console.log('\n7) CAMINHO DE PRODUÇÃO — o clique real chega no efeito');
// ---------------------------------------------------------------------------
{
  // Sem isto o efeito seria mais uma função órfã: existe, é testada, e nenhum caminho de produção
  // a alcança. Já aconteceu seis vezes neste projeto.
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'emissaoPeca.js'), 'utf-8');
  const i = src.indexOf('coletor.on(\'collect\'');
  ok(i > 0, '7z: o handler do recebimento foi encontrado (o scan não passou vazio)');
  const corpo = src.slice(i, i + 4000);
  ok(/aplicarEfeitoDoRecebimento/.test(corpo),
    '7a: o coletor da captura chama o efeito — o clique real chega aqui');
  // O pós-processamento saiu do coletor e virou `aoAplicar` de cada efeito (19/08/2026): cada elo
  // mexe numa tabela diferente e tem a própria narrativa, então deixá-lo no coletor obrigaria a
  // reescrevê-lo a cada elo novo. A asserção segue o código: o coletor CHAMA o pós-efeito, e é o
  // efeito da denúncia que re-renderiza o painel.
  ok(/aoAplicar/.test(corpo), '7b: o coletor dispara o pós-efeito do elo');
  const efeitoDenuncia = src.slice(src.indexOf('denuncia_mp: {'), src.indexOf('async function aplicarEfeitoDoRecebimento'));
  ok(efeitoDenuncia.length > 200, '7b-z: o bloco do efeito foi encontrado (scan não vazio)');
  ok(/repostarPainel/.test(efeitoDenuncia),
    '7b-2: ...e o efeito da denúncia re-renderiza o painel (o menu do Juiz aparece)');
  ok(corpo.indexOf('Selo conferido') < corpo.indexOf('aplicarEfeitoDoRecebimento'),
    '7c: o efeito roda DEPOIS da lavratura — falha no efeito não desfaz a entrega');
  ok(/catch/.test(corpo.slice(corpo.indexOf('aplicarEfeitoDoRecebimento'))),
    '7d: ...e está dentro de try/catch, pela mesma razão');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
