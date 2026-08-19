/* eslint-disable */
// "X.y is not a function" — a classe de erro que só aparece EM PRODUÇÃO, no clique do jogador.
// Rode com:  node scripts/testes-chamadas-existem.js
//
// ACHADO EM 19/08/2026: toda petição administrativa estourava
// "ministerioPublico.postarNoCanalMP is not a function". A função existia em
// utils/ministerioPublico.js e era usada internamente, mas NUNCA entrou no module.exports —
// enquanto commands/peticao.js:377 a chamava de fora. Estava assim desde o commit 9180eae.
//
// POR QUE NENHUM TESTE PEGOU: JavaScript não reclama de `modulo.naoExiste` — devolve `undefined`
// em silêncio. O erro só nasce na CHAMADA, e só se aquela linha executar. Uma linha que só roda
// quando um jogador protocola petição não é exercitada por teste de unidade nenhum.
//
// ESTE ARQUIVO FECHA ISSO SEM PRECISAR EXECUTAR O FLUXO: carrega cada módulo de verdade (require
// real, o que já valida o boot) e confere, para cada `modulo.metodo(` escrito no código, que o
// método existe no export. É análise estática do CHAMADOR contra o objeto REAL do chamado.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Banco temporário: alguns módulos leem o db no require. Nunca tocar no dados.json real.
const DB_TESTE = path.join(os.tmpdir(), `dados-teste-chamadas-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild1';

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const RAIZ = path.join(__dirname, '..');
const DIRS = ['commands', 'utils', 'services'];

function arquivosJs() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(RAIZ, d);
    if (!fs.existsSync(abs)) continue;
    for (const nome of fs.readdirSync(abs)) if (nome.endsWith('.js')) out.push(`${d}/${nome}`);
  }
  out.push('index.js');
  return out.filter(f => fs.existsSync(path.join(RAIZ, f)));
}

// COMENTÁRIO NÃO É CHAMADA. Uma linha como `// vem de utils/documentos.js (textoIntimacao)` casa
// com o padrão `modulo.metodo(` e produziria acusação falsa.
//
// A primeira versão reescrevia o arquivo removendo comentários por regex e falhou nas duas pontas:
// colapsava linhas (número errado no relatório) e ainda deixava passar comentário de linha. Em vez
// de reescrever a fonte inteira, o teste agora decide POR LINHA — mais simples de acertar e o
// número reportado é sempre o número real do arquivo.
const ehLinhaDeComentario = (linha) => {
  const t = linha.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

console.log('\n=== Chamadas a funções que não existem ("X.y is not a function") ===\n');

const ARQUIVOS = arquivosJs();
ok(ARQUIVOS.length >= 20, '0: a varredura encontrou arquivos para varrer', `achou ${ARQUIVOS.length}`);

// ---------------------------------------------------------------------------
console.log('\n1) Todo módulo local CARREGA (é o boot, sem subir o bot)');
// Se um require quebra aqui, o bot não sobe em produção — este bloco é o smoke test de boot.
const modulos = new Map();
let carregados = 0;
for (const rel of ARQUIVOS) {
  if (rel === 'index.js') continue; // index.js faz login no Discord; não se carrega em teste
  try {
    modulos.set(rel, require(path.join(RAIZ, rel)));
    carregados++;
  } catch (e) {
    ok(false, `1-${rel}: carrega sem erro`, e.message);
  }
}
ok(carregados > 0, '1z: algum módulo foi carregado (a varredura não passou vazia)', `carregou ${carregados}`);
if (carregados === ARQUIVOS.length - 1) ok(true, `1a: todos os ${carregados} módulos carregam (boot limpo)`);

// ---------------------------------------------------------------------------
console.log('\n2) Toda chamada `modulo.metodo(...)` existe no export do módulo');
{
  let chamadasExaminadas = 0;
  const quebradas = [];

  for (const rel of ARQUIVOS) {
    const src = fs.readFileSync(path.join(RAIZ, rel), 'utf-8');
    const linhasDoArquivo = src.split('\n');

    // Mapa: nome da variável -> caminho do módulo local exigido.
    //   const ministerioPublico = require('../utils/ministerioPublico');
    const alias = new Map();
    const reRequire = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = reRequire.exec(src)) !== null) {
      const destino = path.normalize(path.join(path.dirname(path.join(RAIZ, rel)), m[2]));
      const relDestino = path.relative(RAIZ, destino).replace(/\\/g, '/');
      const comExt = relDestino.endsWith('.js') ? relDestino : `${relDestino}.js`;
      if (modulos.has(comExt)) alias.set(m[1], comExt);
    }
    if (!alias.size) continue;

    // Toda chamada `variavel.metodo(`
    const reChamada = new RegExp(`\\b(${[...alias.keys()].map(k => k.replace(/\$/g, '\\$')).join('|')})\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    while ((m = reChamada.exec(src)) !== null) {
      const [, variavel, metodo] = m;
      const linha = src.slice(0, m.index).split('\n').length;
      if (ehLinhaDeComentario(linhasDoArquivo[linha - 1] || '')) continue;

      const destino = alias.get(variavel);
      const mod = modulos.get(destino);
      chamadasExaminadas++;
      if (typeof mod[metodo] !== 'function') {
        quebradas.push(`${rel}:${linha} → ${variavel}.${metodo}() não existe em ${destino}`);
      }
    }
  }

  ok(quebradas.length === 0,
    '2a: nenhuma chamada aponta para função inexistente no export',
    quebradas.join('  |  '));

  // CANÁRIO: se o parser de require/chamada quebrar, 2a aprovaria sem examinar nada — foi
  // exatamente esse tipo de teste vazio que já passou verde três vezes neste projeto.
  ok(chamadasExaminadas >= 100,
    '2z: a varredura realmente examinou chamadas (não passou vazia)',
    `examinou ${chamadasExaminadas}`);
  console.log(`     ℹ️  ${chamadasExaminadas} chamadas \`modulo.metodo()\` conferidas contra o export real`);
}

// ---------------------------------------------------------------------------
console.log('\n3) Funções usadas INTERNAMENTE e chamadas de fora estão exportadas');
{
  // O caso exato do postarNoCanalMP: definida, usada dentro do próprio arquivo, e chamada de fora —
  // mas ausente do module.exports. O bloco 2 já pega isso; aqui trava o caso conhecido para não
  // voltar em silêncio se alguém "limpar" o export.
  const mp = require(path.join(RAIZ, 'utils/ministerioPublico.js'));
  ok(typeof mp.postarNoCanalMP === 'function',
    '3a: ministerioPublico.postarNoCanalMP está exportada (era o bug de TODA petição administrativa)');
  ok(typeof mp.ehMembroDoMP === 'function', '3b: ...sem quebrar o que já era exportado');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
