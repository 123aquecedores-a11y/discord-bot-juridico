/* eslint-disable */
// TEOR GRAVADO EM `andamentos` — o buraco que a camada de visibilidade não cobre. Rode com:
//   node scripts/testes-teor-em-andamentos.js
//
// POR QUE ESTE ARQUIVO EXISTE (18/08/2026):
// `podeVerTeor` (utils/pecas.js) é o ponto único de visibilidade — mas ele governa a tabela
// `pecas`. Os atos LEGADOS (sentença, apelação, intimação, mandado, medida, manifestação do MP)
// não são peças: eles gravam o teor no campo `detalhe` de um ANDAMENTO. Andamento é exibido por
// embedHistorico, cujo gate é `temAcessoTotal` — ou seja, TODAS as partes do processo. Em processo
// `ingame` isso entrega o teor sem entrega pessoal nenhuma, e é PERMANENTE: continua consultável
// depois do canal ser arquivado.
//
// A varredura de visibilidade (testes-visibilidade-varredura.js) não pegava isso porque ela
// pergunta "este ponto de saída de PEÇA chama podeVerTeor?". Um ato que nunca foi peça passa por
// fora da pergunta inteira. Este arquivo fecha o ângulo cego.
//
// COMO ELE IMPEDE A PRÓXIMA OCORRÊNCIA: lista de CONHECIDOS, não lista de proibidos. Todo
// `andamentos.registrar` que persiste texto livre precisa estar declarado aqui embaixo, com o
// estado dele. Um ato novo que grave teor sem ser declarado FAZ O TESTE FALHAR — o autor é forçado
// a decidir conscientemente se aquilo pode ou não ser lido por todas as partes antes da entrega.

const fs = require('fs');
const path = require('path');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// Cada entrada: onde está, e qual o ESTADO. `gated: true` = já respeita o modo do processo (não
// grava teor quando ingame). `gated: false` = ainda grava teor cru, DÍVIDA CONHECIDA e aceita.
// Mover uma linha de false para true é o trabalho da migração de cada ato.
const CONHECIDOS = [
  { arquivo: 'commands/processo.js', marca: 'tipo: \'sentenca\'', ato: 'sentença', gated: true },
  { arquivo: 'commands/processo.js', marca: 'tipo: \'apelacao\'', ato: 'apelação (razões)', gated: false },
  { arquivo: 'commands/processo.js', marca: 'Teor: ${teor}', ato: 'intimação (2 pontos)', gated: false },
  { arquivo: 'commands/mandado.js', marca: 'Fundamentação: ${teor}', ato: 'mandado', gated: false },
  { arquivo: 'commands/medida.js', marca: 'Fundamentação do Juízo:', ato: 'medida', gated: false },
  { arquivo: 'commands/processo.js', marca: 'tipo: \'manifestacao_mp\'', ato: 'manifestação do MP', gated: false },
];

const raiz = path.join(__dirname, '..');
const ARQUIVOS = ['commands/processo.js', 'commands/mandado.js', 'commands/medida.js', 'commands/oficio.js', 'commands/peticao.js', 'utils/emissaoPeca.js', 'utils/supervisao.js'];

console.log('\n=== Teor gravado em andamentos (ângulo cego da camada de visibilidade) ===\n');

console.log('1) A sentença não persiste mais o teor quando o processo é gated');
{
  const src = fs.readFileSync(path.join(raiz, 'commands/processo.js'), 'utf-8');
  const trecho = src.slice(src.indexOf("tipo: 'sentenca', titulo:") - 900, src.indexOf("tipo: 'sentenca', titulo:") + 500);
  ok(/sentencaGated/.test(trecho), '1a: a gravação da sentença consulta o modo do processo', 'esperava a decisão por modo junto do registro');
  ok(/modoDoProcesso\(processo\) === 'ingame'/.test(trecho), '1b: ...e a decisão é pelo modo real (ingame), não por um flag paralelo');
  ok(/restrito at[ée] a entrega pessoal/.test(trecho), '1c: no gated grava descrição genérica, não a fundamentação');
  // O caminho não-gated tem que continuar gravando o texto — aberto/legado não regridem.
  ok(/:\s*texto,/.test(trecho), '1d: fora do gated o texto continua sendo gravado (sem regressão em aberto/legado)');
}

console.log('\n2) Inventário: todo ato que persiste teor está declarado');
{
  for (const c of CONHECIDOS) {
    const src = fs.readFileSync(path.join(raiz, c.arquivo), 'utf-8');
    ok(src.includes(c.marca), `2-${c.ato}: continua existindo onde o inventário diz`, `marca não encontrada em ${c.arquivo}: ${c.marca}`);
  }
  const pendentes = CONHECIDOS.filter(c => !c.gated).map(c => c.ato);
  console.log(`     ℹ️  dívida conhecida e aceita (grava teor cru, aguardando migração): ${pendentes.join(', ')}`);
}

console.log('\n3) Nenhum ato NOVO gravando andamento sem passar por esta revisão');
{
  // BASELINE DE CONTAGEM, não heurística de regex.
  //
  // A primeira versão deste teste tentava adivinhar, por regex, quais `detalhe:` carregavam texto
  // livre. Ela passou verde detectando ZERO — regex frágil que não casava com template literal
  // multilinha, ou seja, exatamente o tipo de teste que diz "tudo certo" sem olhar nada. Trocado
  // por uma contagem: não tem como passar vazio, e não tem como um andamento novo escapar.
  //
  // Se você adicionou/removeu um andamento e este teste falhou: vá ver se o `detalhe` dele carrega
  // TEOR (texto que uma parte escreveu — fundamentação, razões, manifestação) ou só METADADO
  // (quem, quando, qual número). Se for teor, decida se pode ser lido por TODAS as partes antes da
  // entrega pessoal; se não puder, gate por `modoDoProcesso(processo) === 'ingame'`, como a
  // sentença faz. Depois atualize o número aqui e, se for teor, o inventário acima.
  const BASELINE = {
    'commands/processo.js': 26,
    'commands/mandado.js': 1,
    'commands/medida.js': 2,
    'commands/oficio.js': 2,
    'utils/emissaoPeca.js': 3,
    'utils/supervisao.js': 2,
  };

  let totalVisto = 0;
  for (const [arq, esperado] of Object.entries(BASELINE)) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf-8');
    const visto = (src.match(/andamentos\.registrar\(/g) || []).length;
    totalVisto += visto;
    ok(visto === esperado, `3-${arq}: ${esperado} andamento(s), como revisado`, `agora tem ${visto} — revise o novo/removido e atualize o baseline`);
  }
  // Trava contra o modo de falha que derrubou a versão anterior: se a varredura parar de enxergar
  // os arquivos (path errado, rename), o total vai a zero e ISSO tem que falhar, não passar.
  ok(totalVisto >= 30, '3z: a varredura realmente leu os arquivos (não passou por vacuidade)', `total visto: ${totalVisto}`);
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
