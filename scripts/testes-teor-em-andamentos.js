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
  { arquivo: 'commands/processo.js', marca: 'tipo: \'apelacao\'', ato: 'apelação (razões)', gated: true },
  { arquivo: 'commands/mandado.js', marca: 'Fundamentação: ${teor}', ato: 'mandado', gated: true },
  { arquivo: 'commands/medida.js', marca: 'Fundamentação do Juízo:', ato: 'medida', gated: true },
  { arquivo: 'commands/processo.js', marca: 'tipo: \'manifestacao_mp\'', ato: 'manifestação do MP', gated: true },
  { arquivo: 'commands/processo.js', marca: 'Teor: ', ato: 'intimação (2 pontos)', gated: true },
];

const raiz = path.join(__dirname, '..');
const ARQUIVOS = ['commands/processo.js', 'commands/mandado.js', 'commands/medida.js', 'commands/oficio.js', 'commands/peticao.js', 'utils/emissaoPeca.js', 'utils/supervisao.js'];

console.log('\n=== Teor gravado em andamentos (ângulo cego da camada de visibilidade) ===\n');

console.log('1) O ponto único de decisão funciona (teste COMPORTAMENTAL, não scan)');
{
  // A versão anterior só olhava o código-fonte. Agora a regra mora numa função pura sobre o banco
  // (pecas.detalheDeAndamento), então dá para exercitá-la de verdade nos três modos.
  const os = require('os');
  const DB_TESTE = path.join(os.tmpdir(), `dados-teste-teor-and-${process.pid}.json`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.env.DADOS_JSON_PATH = DB_TESTE;
  process.env.RESETAR_BANCO = '';
  const db = require('../database/db');
  const pecas = require('../utils/pecas');

  const TEOR = 'FUNDAMENTACAO SECRETA QUE NAO PODE VAZAR';
  const GENERICO = 'restrito até a entrega pessoal.';

  // `modo: null` grava SEM o campo — é como um processo anterior à feature se parece (legado).
  const criar = (numero, modo) => db.inserir('processos', {
    numero, tipo: 'Civil', status: 'Instrução', ...(modo === null ? {} : { modoEntrega: modo }),
  });

  criar('9001CV', 'ingame'); criar('9002CV', 'aberto'); criar('9003CV', null);

  ok(pecas.detalheDeAndamento('9001CV', TEOR, GENERICO) === GENERICO,
    '1a: processo ingame NÃO recebe o teor — grava a descrição genérica');
  ok(!pecas.detalheDeAndamento('9001CV', TEOR, GENERICO).includes(TEOR),
    '1b: ...e o teor não aparece nem parcialmente no que foi gravado');
  ok(pecas.detalheDeAndamento('9002CV', TEOR, GENERICO) === TEOR,
    '1c: processo aberto continua gravando o teor (sem regressão)');
  ok(pecas.detalheDeAndamento('9003CV', TEOR, GENERICO) === TEOR,
    '1d: processo legado continua gravando o teor (sem regressão)');
  // Falha FECHADA: processo que não existe não pode virar desculpa para gravar teor... mas também
  // não pode sumir com o andamento de um ticket sem processo vinculado. Documenta o que acontece.
  ok(pecas.detalheDeAndamento('INEXISTENTE', TEOR, GENERICO) === TEOR,
    '1e: sem processo encontrado grava o teor (ticket avulso não tem entrega pessoal a proteger)');

  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
}

console.log('\n1b) Todos os atos migrados usam o PONTO ÚNICO, não a regra copiada');
{
  // -1 em commands/processo.js em 20/08/2026: a SENTENÇA deixou de usar `detalheDeAndamento`.
  // Com o gate removido (decisão do operador), o teor não precisa mais ser restringido no
  // andamento — o documento já está publicado no canal. O helper continua sendo o ponto único
  // para quem ainda restringe.
  const esperado = { 'commands/processo.js': 4, 'commands/mandado.js': 1, 'commands/medida.js': 1 };
  let total = 0;
  for (const [arq, n] of Object.entries(esperado)) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf-8');
    const visto = (src.match(/detalheDeAndamento\(/g) || []).length;
    total += visto;
    ok(visto === n, `1b-${arq}: ${n} ato(s) pelo ponto único`, `achou ${visto}`);
  }
  ok(total === 6, '1b-total: os 6 atos migrados passam pelo mesmo lugar', `total ${total}`);

  // Ninguém pode reintroduzir a regra DE ANDAMENTO por fora do helper. A checagem antes era ampla
  // demais e passou a acusar uma decisão LEGÍTIMA e diferente: se o PNG da intimação vai ou não ao
  // canal compartilhado (Bloco B). Consultar o modo do processo não é o problema — o problema seria
  // um `detalhe:` decidindo sozinho o que gravar. Por isso a asserção agora é sobre o `detalhe:`.
  const proc = fs.readFileSync(path.join(raiz, 'commands/processo.js'), 'utf-8');
  const detalhesComGateSolto = (proc.match(/detalhe:[^\n]*modoDoProcesso/g) || []).length;
  ok(detalhesComGateSolto === 0,
    '1b-z: nenhum `detalhe:` decide o gate sozinho — todos passam pelo ponto único',
    `${detalhesComGateSolto} ocorrência(s)`);
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
    // +2 em 20/08/2026: 'processo_arquivado' e 'despacho_juiz'. REVISADOS, e são EXCEÇÃO
    // DECLARADA pelo operador — os dois carregam TEOR de propósito:
    //
    //   - o arquivamento nunca mais é mudo: as RAZÕES do Juiz vão para os autos junto com o ato,
    //     visíveis às partes. Arquivar em silêncio era o defeito que se estava corrigindo.
    //   - o DESPACHO é o ato ordinatório do Juiz, e existe justamente para ser lido: "indefiro o
    //     pedido de prisão temporária, porque...". Gatear um despacho exigiria cena para cada
    //     "indefiro" — e o custo de encenação existe para o documento que a parte precisa TER em
    //     mãos, não para o Juiz responder um pedido.
    //
    // A regra geral NÃO mudou: o teor da SENTENÇA, da denúncia e das peças do MP continua saindo
    // só pela entrega gated com selo. O que entra aqui é a fala ordinatória do Juízo nos autos.
    // 29 -> 27 em 20/08/2026: o despacho e o arquivamento saíram daqui e passaram a lavrar por
    // `emissaoPeca.publicarAtoNoCanal` (que registra o andamento junto com a publicação do PNG).
    // Não sumiram — mudaram de arquivo. Ver a contagem de utils/emissaoPeca.js abaixo, que subiu
    // exatamente na mesma proporção.
    'commands/processo.js': 27,
    'commands/mandado.js': 1,
    'commands/medida.js': 2,
    'commands/oficio.js': 2,
    // +1 em 20/08/2026: `publicarAtoNoCanal` lavra o andamento do ato publicado (sentença,
    // despacho, razões do arquivamento). REVISADO, e é EXCEÇÃO DECLARADA: os três carregam TEOR de
    // propósito — são a fala do Juízo nos autos, feita para ser lida, e o documento já vai
    // publicado no canal junto. Ver a razão PUBLICADO em scripts/testes-anexos-em-canal.js.
    'utils/emissaoPeca.js': 6, // +1 em 19/08/2026: 'selo destravado pela supervisão' — REVISADO: o detalhe carrega o MOTIVO escrito pela supervisão (metadado do ato), nunca o teor da peça
    // +1 em 19/08/2026: 'juiz_designado' (elo denúncia recebida → destrava o juiz) — REVISADO: o detalhe diz QUEM assumiu e que o caso foi para instrução; é metadado da distribuição, não tem nada do teor da denúncia
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
