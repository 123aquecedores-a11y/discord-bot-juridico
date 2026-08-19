/* eslint-disable */
// COBERTURA DE PAPEL — PONTO ÚNICO (19/08/2026). Rode com:
//   node scripts/testes-cobertura-papel.js
//
// A REGRA: a chefia cobre a base. Desembargador cobre Juiz; Procurador cobre Promotor.
//
// POR QUE ESTE ARQUIVO EXISTE: a regra estava escrita em três lugares e um deles não sabia dela.
// `atosPorCargo.podeAtuar` e `pecas.ocupaDestinatario` aplicavam a cobertura; a varredura de
// responsáveis fantasma comparava o cargo EXATO. O defeito apareceu em produção: um Desembargador
// responsável por seis processos cíveis, que ele pode julgar sem problema, foi contado como "sem o
// cargo" nos seis — e só não perdeu os casos porque a trava de segurança de 5 abortou a rodada.
//
// O teste central é o 3: o Desembargador NÃO é fantasma num caso de Juiz. Os outros existem para
// que a consolidação não afrouxe nada pelo caminho — cobertura larga demais vira vazamento.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-cobertura-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const atos = require('../utils/atosPorCargo');
const pecas = require('../utils/pecas');
const responsaveis = require('../utils/responsaveis');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ = '110000000000000001';
const DESEMB = '110000000000000002';
const PROMOTOR = '110000000000000003';
const PROCURADOR = '110000000000000004';
const ADVOGADO = '110000000000000005';
const DELEGADO = '110000000000000006';

rh.contratar(JUIZ, 'Juiz', 'Juiz');
rh.contratar(DESEMB, 'Desembargador', 'Desembargador');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(PROCURADOR, 'Procurador', 'Procurador');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado');
rh.contratar(DELEGADO, 'Delegado', 'Delegado');

console.log('\n=== Cobertura de papel: um único cobreOPapel ===\n');

// ---------------------------------------------------------------------------
console.log('1) A REGRA, no ponto único');
// ---------------------------------------------------------------------------
{
  ok(rh.cobreOPapel(JUIZ, 'Juiz') === true, '1a: Juiz cobre Juiz');
  ok(rh.cobreOPapel(DESEMB, 'Juiz') === true, '1b: Desembargador cobre Juiz — a chefia cobre a base');
  ok(rh.cobreOPapel(PROMOTOR, 'Promotor') === true, '1c: Promotor cobre Promotor');
  ok(rh.cobreOPapel(PROCURADOR, 'Promotor') === true, '1d: Procurador cobre Promotor');

  // A cobertura é de cima para baixo, nunca ao contrário.
  ok(rh.cobreOPapel(JUIZ, 'Desembargador') === false, '1e: Juiz NÃO cobre Desembargador (não é mão dupla)');
  ok(rh.cobreOPapel(PROMOTOR, 'Procurador') === false, '1f: Promotor NÃO cobre Procurador');

  // E não atravessa a fronteira entre magistratura e MP.
  ok(rh.cobreOPapel(PROMOTOR, 'Juiz') === false, '1g: Promotor NÃO cobre Juiz — quem acusa não julga');
  ok(rh.cobreOPapel(DESEMB, 'Promotor') === false, '1h: Desembargador NÃO cobre Promotor');

  // Papéis FORA do mapa caem no cargo exato: partes e integrações não têm chefia substituta.
  ok(rh.cobreOPapel(ADVOGADO, 'Advogado') === true, '1i: papel fora do mapa vale pelo cargo exato');
  ok(rh.cobreOPapel(DESEMB, 'Advogado') === false, '1j: nenhuma chefia cobre Advogado — é parte, não órgão');
  ok(rh.cobreOPapel(PROCURADOR, 'Delegado') === false, '1k: nenhuma chefia cobre Delegado');
  ok(rh.cobreOPapel(null, 'Juiz') === false && rh.cobreOPapel(JUIZ, null) === false,
    '1l: argumento faltando responde false (fail-closed)');
}

// ---------------------------------------------------------------------------
console.log('\n2) O DEFEITO DE PRODUÇÃO — Desembargador não é fantasma em caso de Juiz');
// ---------------------------------------------------------------------------
// Este é o teste que faltava. `motivoInvalidez` é async e consulta o servidor para saber se a
// pessoa ainda está nele; aqui o guild de mentira responde "presente", isolando a checagem de
// CARGO, que é o que mudou.
async function secao2() {
  const guild = { id: 'guild1', members: { fetch: async (id) => ({ id }) } };
  const motivo = (papel, id) => responsaveis.motivoInvalidez(guild, papel, id);

  ok(await motivo('Juiz', DESEMB) === null,
    '2a: Desembargador responsável por caso de Juiz NÃO é marcado como fantasma');
  ok(await motivo('Promotor', PROCURADOR) === null,
    '2b: Procurador responsável por caso de Promotor NÃO é marcado como fantasma');

  // Controles — a consolidação não pode ter desligado a detecção de verdade.
  ok(await motivo('Juiz', JUIZ) === null, '2c: Juiz no caso de Juiz segue válido');
  ok(await motivo('Juiz', ADVOGADO) === 'semcargo',
    '2d: quem realmente não cobre o papel CONTINUA sendo detectado');
  ok(await motivo('Juiz', PROMOTOR) === 'semcargo',
    '2e: Promotor num caso de Juiz continua sendo fantasma (não é cobertura, é impedimento)');
  ok(await motivo('Promotor', JUIZ) === 'semcargo', '2f: e o inverso também');

  // Quem saiu do quadro continua sendo pego, que é o propósito original da varredura.
  const EX = '110000000000000009';
  rh.contratar(EX, 'Juiz', 'Ex-juiz');
  ok(await motivo('Juiz', EX) === null, '2g: controle — enquanto é Juiz, é válido');
  rh.demitir(EX);
  ok(await motivo('Juiz', EX) === 'semcargo', '2h: demitido volta a ser detectado como fantasma');

  // O caso EXATO da produção: promovido de Juiz a Desembargador, ainda responsável pelos casos.
  const PROMOVIDO = '110000000000000010';
  rh.contratar(PROMOVIDO, 'Juiz', 'Promovido');
  rh.contratar(PROMOVIDO, 'Desembargador', 'Promovido'); // a promoção desativa o registro anterior
  ok(rh.temCargo(PROMOVIDO, 'Juiz') === false,
    '2i: depois da promoção o cargo exato "Juiz" é falso — era daqui que vinha o falso positivo');
  ok(await motivo('Juiz', PROMOVIDO) === null,
    '2j: ...e mesmo assim ele NÃO é fantasma nos processos que já julgava');
}

// ---------------------------------------------------------------------------
console.log('\n3) OS OUTROS DOIS CONSUMIDORES seguem iguais');
// ---------------------------------------------------------------------------
{
  // atosPorCargo — comportamento idêntico ao de antes da consolidação.
  const podeAtuar = (id, cargo) => atos.podeAtuar({ usuarioId: id, cargo, titularId: JUIZ });
  ok(podeAtuar(DESEMB, 'Juiz') === true, '3a: atosPorCargo — Desembargador atua em ato de Juiz');
  ok(podeAtuar(PROCURADOR, 'Promotor') === true, '3b: atosPorCargo — Procurador atua em ato de Promotor');
  ok(podeAtuar(ADVOGADO, 'Juiz') === false, '3c: atosPorCargo — Advogado não atua em ato de Juiz');
  ok(atos.podeAtuar({ usuarioId: ADVOGADO, cargo: 'Advogado', titularId: ADVOGADO }) === true,
    '3d: atosPorCargo — o titular segue passando pelo caminho mais barato');
  ok(atos.podeAtuar({ usuarioId: PROMOTOR, cargo: 'Advogado', titularId: ADVOGADO }) === false,
    '3e: atosPorCargo — cargo fora do escopo compartilhado NÃO ganha cobertura');

  // pecas.ocupaDestinatario — a fronteira que impede vazamento entre advogados.
  const proc = db.inserir('processos', {
    numero: '0500CV', tipo: 'Civil', juiz: JUIZ, promotor: PROMOTOR, autor: ADVOGADO,
    habilitacoes: [], reus: [], canalId: 'c1',
  });
  const ocupa = (papel, id) => pecas.ocupaDestinatario('processos', proc, { papel }, id);
  ok(ocupa('Juiz', DESEMB) === true, '3f: pecas — Desembargador recebe peça dirigida ao Juiz');
  ok(ocupa('Promotor', PROCURADOR) === true, '3g: pecas — Procurador recebe peça dirigida ao Promotor');
  ok(ocupa('Advogado', DESEMB) === false,
    '3h: pecas — NENHUMA chefia recebe peça dirigida ao Advogado (é o que impede o vazamento)');
  ok(ocupa('Juiz', PROMOTOR) === false, '3i: pecas — Promotor não recebe peça do Juiz');
}

// ---------------------------------------------------------------------------
console.log('\n4) AS TRÊS CÓPIAS SUMIRAM do código');
// ---------------------------------------------------------------------------
{
  // Sem isto, alguém reescreve a comparação à mão no próximo módulo e a divergência volta.
  const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
  const arquivos = {
    'utils/atosPorCargo.js': LER('utils', 'atosPorCargo.js'),
    'utils/pecas.js': LER('utils', 'pecas.js'),
    'utils/responsaveis.js': LER('utils', 'responsaveis.js'),
  };
  ok(Object.values(arquivos).every(s => s.length > 500), '4z: os três arquivos foram lidos (scan não vazio)');

  // A assinatura da regra COPIADA é específica: "se o papel é X, aceita também a chefia Y".
  // Procurar só por temCargo(..., 'Procurador') seria grosseiro e pegaria `isSupervisao`, que é
  // outra pergunta — "esta pessoa é da supervisão?", cargo global, não cobertura de papel.
  const COPIA = /===\s*'(Promotor|Juiz)'\s*&&\s*rh\.temCargo\([^)]*'(Procurador|Desembargador)'\)/;
  for (const [nome, src] of Object.entries(arquivos)) {
    ok(!COPIA.test(src), `4a-${nome}: não reimplementa a cobertura na mão`);
  }
  for (const nome of ['utils/atosPorCargo.js', 'utils/pecas.js', 'utils/responsaveis.js']) {
    ok(/cobreOPapel/.test(arquivos[nome]), `4b-${nome}: consulta o ponto único rh.cobreOPapel`);
  }
  ok(!/rh\.temCargo\(id, papel\)/.test(arquivos['utils/responsaveis.js']),
    '4c: responsaveis.js não usa mais o cargo EXATO para decidir fantasma');
}

(async () => {
  await secao2();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
