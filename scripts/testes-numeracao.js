/* eslint-disable */
// Testes da numeração monotônica. Rode com:
//   node scripts/testes-numeracao.js
//
// O bug que estes testes existem para impedir já aconteceu duas vezes: primeiro por contagem de
// registros (colisão real de dois "0007CV"), depois por "maior existente" quando uma limpeza apagou
// todos os processos e a numeração voltou ao 0001. A partir da entrega in-game o número vai impresso
// num documento que circula dentro do jogo, então reusar número passa a apontar um documento antigo
// para um caso novo.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-numeracao-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';

const db = require('../database/db');
const estado = require('../utils/estado');
const { proximoNumero, proximoNumeroClassico, PISOS, chaveContador } = require('../utils/numeracao');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

console.log('\n=== Numeração monotônica ===\n');

// ---------------------------------------------------------------------------
console.log('1) O contador nunca retrocede (o bug de 14/08)');
{
  // Banco novo, sem nenhum processo: a semeadura respeita o piso do que já foi emitido.
  const primeiro = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(primeiro === '0009PN', `1a: banco vazio começa DEPOIS do piso conhecido (PN=${PISOS.PN})`, `saiu ${primeiro}`);

  db.inserir('processos', { numero: primeiro, tipo: 'Penal', status: 'Instrução' });
  const segundo = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(segundo === '0010PN', '1b: segue em frente normalmente', `saiu ${segundo}`);
  db.inserir('processos', { numero: segundo, tipo: 'Penal', status: 'Instrução' });

  // O CASO QUE QUEBROU: apagar TODOS os registros. Antes, o próximo voltava para 0001.
  const dados = JSON.parse(fs.readFileSync(DB_TESTE, 'utf-8'));
  dados.processos = [];
  fs.writeFileSync(DB_TESTE, JSON.stringify(dados, null, 2));
  ok(db.todos('processos').length === 0, '1c: todos os processos foram apagados');

  const depoisDaLimpeza = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(depoisDaLimpeza === '0011PN', '1d: mesmo com o banco limpo, o número NÃO retrocede', `saiu ${depoisDaLimpeza}`);
  ok(depoisDaLimpeza !== primeiro && depoisDaLimpeza !== segundo, '1e: ...e não reemite nenhum dos anteriores');
}

// ---------------------------------------------------------------------------
console.log('\n2) Séries são independentes');
{
  const cv = proximoNumero(db, 'processos', 'CV', p => p.tipo === 'Civil');
  ok(cv === '0006CV', `2a: CV começa depois do piso próprio (CV=${PISOS.CV})`, `saiu ${cv}`);
  const md = proximoNumero(db, 'medidas', 'MD');
  ok(md === '0012MD', `2b: MD idem (MD=${PISOS.MD})`, `saiu ${md}`);
  const pn = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(pn === '0012PN', '2c: mexer em CV e MD não move o contador de PN', `saiu ${pn}`);
}

// ---------------------------------------------------------------------------
console.log('\n3) Formato clássico tem a mesma garantia');
{
  const ofi = proximoNumeroClassico(db, 'oficios', 'OFI');
  ok(ofi === 'OFI-0011', `3a: OFI começa depois do piso (OFI=${PISOS.OFI})`, `saiu ${ofi}`);
  db.inserir('oficios', { numero: ofi, status: 'Pendente' });

  const dados = JSON.parse(fs.readFileSync(DB_TESTE, 'utf-8'));
  dados.oficios = [];
  fs.writeFileSync(DB_TESTE, JSON.stringify(dados, null, 2));
  ok(proximoNumeroClassico(db, 'oficios', 'OFI') === 'OFI-0012', '3b: ...e também não retrocede com o banco limpo');
}

// ---------------------------------------------------------------------------
console.log('\n4) Semeadura pega o MAIOR entre piso e registro existente');
{
  // Série sem piso na tabela e com registro à frente: o existente manda.
  db.inserir('apelacoes', { numero: '0042AP', status: 'Pendente' });
  const ap = proximoNumero(db, 'apelacoes', 'AP');
  ok(ap === '0043AP', '4a: registro à frente do piso vence o piso', `saiu ${ap}`);

  // Série nova, sem piso e sem registro: começa do 1.
  const zz = proximoNumero(db, 'consultas', 'ZZ');
  ok(zz === '0001ZZ', '4b: série desconhecida começa do 0001', `saiu ${zz}`);
}

// ---------------------------------------------------------------------------
console.log('\n5) Proteção: nada pode apagar ou zerar um contador');
// Contadores NÃO são regeneráveis — perdê-los reemite número. `estado` guarda também coisas
// derivadas, então a garantia não pode vir da natureza da tabela: tem que vir daqui.
{
  ok(typeof estado.obter === 'function' && typeof estado.definir === 'function', '5a: estado expõe obter e definir');
  const exportado = Object.keys(require('../utils/estado'));
  ok(!exportado.some(k => /remover|delete|excluir|apagar|limpar|resetar/i.test(k)),
    '5b: estado NÃO expõe nenhuma função de remoção', exportado.join(', '));

  const exportadoDb = Object.keys(db);
  ok(!exportadoDb.some(k => /remover|delete|excluir|apagar/i.test(k)),
    '5c: o db NÃO expõe remoção de registro', exportadoDb.join(', '));

  // Só os donos escrevem em chave `contador*`. Se um handler novo começar a escrever, o teste cai.
  const RAIZ = path.join(__dirname, '..');
  const DONOS = ['utils/numeracao.js', 'utils/carteirinha.js', 'utils/rh.js'];
  const infratores = [];
  for (const dir of ['.', 'utils', 'commands', 'services', 'database']) {
    const abs = path.join(RAIZ, dir);
    if (!fs.existsSync(abs)) continue;
    for (const nome of fs.readdirSync(abs)) {
      if (!nome.endsWith('.js')) continue;
      const rel = `${dir === '.' ? '' : dir + '/'}${nome}`;
      if (DONOS.includes(rel)) continue;
      const src = fs.readFileSync(path.join(RAIZ, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/definir\s*\(\s*[`'"]contador/i.test(src) || /chaveContador\s*\(/.test(src)) infratores.push(rel);
    }
  }
  ok(infratores.length === 0, '5d: só os módulos donos escrevem em chave `contador*`', infratores.join('; '));

  // E o comportamento: um valor corrompido não pode virar "recomeça do zero".
  estado.definir(chaveContador('PN'), 'lixo');
  const aposLixo = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(parseInt(aposLixo, 10) >= PISOS.PN, '5e: contador corrompido re-semeia pelo piso, não pelo zero', `saiu ${aposLixo}`);

  estado.definir(chaveContador('PN'), '-5');
  const aposNegativo = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  ok(parseInt(aposNegativo, 10) >= PISOS.PN, '5f: contador negativo idem', `saiu ${aposNegativo}`);
}

// ---------------------------------------------------------------------------
console.log('\n7) Refundação — reset do tribunal recomeça em 0001');
// Os pisos preservam continuidade com o que já circulou no jogo. Num reset deliberado, em que todos
// os processos são apagados de propósito, não há continuidade a preservar: o primeiro processo do
// tribunal recém-fundado tem que ser 0001PN, não 0009PN.
{
  const { refundarNumeracao, refundada, CHAVE_REFUNDACAO } = require('../utils/numeracao');
  ok(refundada() === false, '7a: antes da refundação, os pisos valem');

  const r = refundarNumeracao({ motivo: 'teste' });
  ok(!!estado.obter(CHAVE_REFUNDACAO), '7b: a refundação fica registrada (não é efeito colateral silencioso)');
  ok(refundada() === true, '7c: e o estado passa a valer para a semeadura');
  ok(r.zerados.length > 0, '7d: reporta quais séries tinham contador', `zerou ${r.zerados.length}`);

  // Simula o banco recém-apagado.
  const dados = JSON.parse(fs.readFileSync(DB_TESTE, 'utf-8'));
  dados.processos = []; dados.medidas = []; dados.oficios = []; dados.apelacoes = [];
  fs.writeFileSync(DB_TESTE, JSON.stringify(dados, null, 2));

  ok(proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal') === '0001PN', '7e: PN recomeça em 0001, ignorando o piso 8');
  ok(proximoNumero(db, 'processos', 'CV', p => p.tipo === 'Civil') === '0001CV', '7f: CV idem, ignorando o piso 5');
  ok(proximoNumeroClassico(db, 'oficios', 'OFI') === 'OFI-0001', '7g: e o formato clássico também');
  ok(proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal') === '0002PN', '7h: e segue monotônico a partir daí');

  // A garantia principal não pode ter sido perdida: depois da refundação, apagar registro continua
  // sem fazer o número voltar.
  const dados2 = JSON.parse(fs.readFileSync(DB_TESTE, 'utf-8'));
  dados2.processos = [];
  fs.writeFileSync(DB_TESTE, JSON.stringify(dados2, null, 2));
  ok(proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal') === '0003PN', '7i: e apagar registro AINDA não faz retroceder');
}

console.log('\n6) Mil emissões seguidas, sem repetir uma');
{
  const vistos = new Set();
  for (let i = 0; i < 1000; i++) vistos.add(proximoNumero(db, 'medidas', 'MD'));
  ok(vistos.size === 1000, '6a: 1000 números, 1000 distintos', `distintos: ${vistos.size}`);
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
