/* eslint-disable */
// VARREDURA DA CAMADA DE VISIBILIDADE (SPEC §8). Rode com:
//   node scripts/testes-visibilidade-varredura.js
//
// A spec chama este teste de "o que impede a regressão daqui a três features", e é literal: uma
// auditoria anterior já achou vazamento de teor por rol de provas e por autocomplete. Aqueles
// vazamentos não vieram de alguém decidir vazar — vieram de um ponto de saída novo que ninguém
// lembrou de proteger.
//
// Por isso a varredura é ESTÁTICA, sobre o código-fonte, e não um teste de comportamento. Teste de
// comportamento só cobre o handler que alguém lembrou de escrever; a varredura cobre o handler que
// ainda não existe. Quando a Faixa 1 for ativada e as peças começarem a aparecer em embeds,
// autocomplete, busca e índice, é este arquivo que vai reclamar antes do vazamento acontecer.
//
// Três asserções:
//   A) o acesso à tabela `pecas` é MONOPÓLIO de utils/pecas.js;
//   B) ninguém lê o teor (`.texto`) de uma peça sem passar pela camada;
//   C) toda chamada à camada, fora do módulo, passa `ehStaff` explicitamente.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const MODULO = path.join('utils', 'pecas.js'); // o dono da regra — é ele que pode tudo

// Diretórios varridos: onde moram os pontos de saída ao usuário.
const DIRS = ['.', 'utils', 'commands', 'services', 'database'];

// Allow-list EXPLÍCITA e justificada. Não use isto para calar um achado — se um ponto de saída
// legítimo precisar entrar aqui, o motivo tem que caber numa linha e ser verdadeiro.
const SERVIDOR = path.join('services', 'servidorPecas.js');

const PERMITIDOS = new Set([
  MODULO, // o próprio módulo da camada
  // EXCEÇÃO DECLARADA, com consequência aceita: o servidor HTTP serve a página para a impressora do
  // jogo, que busca a imagem sem sessão — exigir login quebraria a impressora. Quem tem o link vê o
  // documento, e isso é deliberado: o link É o papel, e passar o papel adiante é o mesmo ato que a
  // §2 da spec já trata por dissuasão e não por impedimento técnico.
  //
  // A exceção é estreita e a asserção A4 abaixo é o que a mantém assim: o servidor só pode chegar
  // ao teor por TOKEN PÚBLICO imprevisível. No dia em que alguém lhe der um caminho por número de
  // peça, o gate cairia inteiro por uma URL adivinhável — e o teste quebra antes disso ir ao ar.
  SERVIDOR,
]);

// PORTAS DA CAMADA — funções de utils/pecas.js por onde o teor pode legitimamente sair, porque
// cada uma chama `podeVerTeor` antes de devolver qualquer coisa.
//
// Ampliar esta lista é permitido, mas só depois de conferir no código que a função nova realmente
// consulta a camada. Uma porta que não confere permissão transforma esta varredura num carimbo.
// A asserção A3 abaixo faz essa conferência automaticamente.
const PORTAS = ['podeVerTeor', 'projetarParaUsuario', 'paraRenderizacao'];
const REGEX_PORTAS = new RegExp(`(?:${PORTAS.join('|')})\\s*\\(`, 'g');

// GATILHO DA REGRA B — lista de EXCLUSÃO, não de inclusão.
//
// A primeira versão desta regra era o oposto: uma lista de funções "arriscadas" que disparavam o
// gatilho, e qualquer coisa fora dela passava batido. Isso tinha um furo real, provado com um teste
// isolado antes deste consertar: uma função NOVA em utils/pecas.js que devolvesse teor — por
// map/array, por interpolação de string, por campo de embed montado à mão, por autocomplete — não
// dispararia NADA até alguém lembrar de cadastrá-la na lista. O arquivo inteiro era pulado, silêncio
// total. Achado falso (a versão de inclusão evitava) é ruim; achado que nunca dispara é pior.
//
// Agora é o contrário: QUALQUER chamada `pecas.<algo>(` aciona a suspeita por padrão. Só escapa
// quem está nesta lista — e cada nome aqui foi conferido, campo por campo, no código-fonte de
// utils/pecas.js em 18/08/2026, confirmando que a função NUNCA devolve `.texto`:
//   modoDoProcesso, janelaMinutos, ocupanteAtual, ocupaDestinatario, isSupervisao → string/boolean/ID
//   abrirEntrega, encerrarEntrega, janelaAberta, destravarSelo → { ok, janela, minutos... }, sem texto
//   podeVerTeor, processoSentenciado, habilitadoNoProcesso → boolean
//   metadados → projeção explícita campo a campo, texto excluído de propósito (e o token também)
//   registrarPaginasPublicas, registrarEnvio → só metadado de entrega (páginas, tokens públicos)
//   varrerValvula, reiniciarValvulaPorTroca, destravarTodasPendencias, fecharJanelasDoProcesso →
//     arrays de { peca: NÚMERO, processoNumero, processoTabela }, nunca o registro inteiro
//   relatorioLegado → contagem agregada
//   revogarLinksDeProcessosEncerrados → array de NÚMEROS de peça, nunca o registro (auditada em
//     18/08/2026 junto da correção que a criou)
// Uma função nova entra AQUI só depois de alguém ler o `return` dela e confirmar que não vaza —
// até lá, ela aciona a varredura, que é o lado seguro do erro.
const SEGURAS_SEM_TEOR = new Set([
  'modoDoProcesso', 'janelaMinutos', 'ocupanteAtual', 'ocupaDestinatario', 'isSupervisao',
  'abrirEntrega', 'encerrarEntrega', 'janelaAberta', 'destravarSelo', 'podeVerTeor',
  'processoSentenciado', 'habilitadoNoProcesso', 'metadados', 'registrarPaginasPublicas',
  'registrarEnvio', 'varrerValvula', 'reiniciarValvulaPorTroca', 'destravarTodasPendencias',
  'relatorioLegado', 'fecharJanelasDoProcesso', 'revogarLinksDeProcessosEncerrados',
  // Acrescentadas em 18/08/2026, e o motivo de cada uma — entrar nesta lista é abrir mão de um
  // alarme, então tem que estar justificado, não só declarado:
  //
  // detalheDeAndamento(processoNumero, teor, generico): devolve UMA DAS DUAS STRINGS QUE O
  //   CHAMADOR PASSOU. Não consulta a tabela `pecas`, não lê `.texto` de peça nenhuma — só olha o
  //   modo do processo para decidir qual das duas persistir. O teor que ela devolve já estava na
  //   mão de quem chamou.
  // classificarDestinatarioIntimacao(processo, {...}): devolve roteamento — { via, papel,
  //   habilitacaoId }. Lê partes/habilitações do PROCESSO, nunca peça, e não devolve texto de ato.
  'detalheDeAndamento', 'classificarDestinatarioIntimacao',
]);

// Acha qualquer `pecas.<nome>(` (ou `pecasModulo.<nome>(`, alias usado nalgum teste) cujo nome NÃO
// esteja na lista segura. Uma ocorrência só já basta para acender o gatilho.
function chamaFuncaoArriscada(src) {
  const re = /\bpecas(?:Modulo)?\.(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!SEGURAS_SEM_TEOR.has(m[1])) return true;
  }
  return false;
}

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function arquivosJs() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(RAIZ, dir);
    if (!fs.existsSync(abs)) continue;
    for (const nome of fs.readdirSync(abs)) {
      if (!nome.endsWith('.js')) continue;
      const rel = path.join(dir === '.' ? '' : dir, nome);
      if (!fs.statSync(path.join(RAIZ, rel)).isFile()) continue;
      out.push(rel);
    }
  }
  return out;
}

// Comentários explicam o código, e o código é o que roda: um `// db.todos('pecas')` num comentário
// não vaza nada. Removê-los evita achado falso que ensina a equipe a ignorar a varredura.
function semComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const ARQUIVOS = arquivosJs();
const FONTES = new Map(ARQUIVOS.map(f => [f, semComentarios(fs.readFileSync(path.join(RAIZ, f), 'utf-8'))]));

console.log('\n=== Varredura da camada de visibilidade ===\n');
console.log(`  (${ARQUIVOS.length} arquivos varridos em ${DIRS.join(', ')})\n`);

// CANÁRIO GLOBAL. Se arquivosJs() devolver lista vazia (renome de pasta, mudança de layout, erro de
// path no Windows), TODAS as asserções abaixo passam por vacuidade e a varredura vira um carimbo de
// aprovação automática. Teste vazio dá confiança falsa — é pior que teste ausente.
ok(ARQUIVOS.length >= 20, '0: a varredura encontrou arquivos para varrer', `achou ${ARQUIVOS.length}`);

// ---------------------------------------------------------------------------
console.log('A) O acesso à tabela `pecas` é monopólio de utils/pecas.js');
// Esta é a asserção mais forte das três. Quem lê o registro cru contorna a camada INTEIRA — não
// adianta proteger `.texto` se um handler pode fazer db.buscarPorNumero('pecas', n) e devolver o
// objeto completo num embed. Fechando a porta da tabela, todo caminho de leitura passa
// obrigatoriamente por projetarParaUsuario/podeVerTeor.
{
  const ACESSO_TABELA = /db\.(todos|buscarUm|buscarPorNumero|atualizar|atualizarPorFiltro|inserir|contar)\s*\(\s*['"]pecas['"]/g;
  const infratores = [];
  for (const [arquivo, src] of FONTES) {
    if (PERMITIDOS.has(arquivo)) continue;
    const achados = src.match(ACESSO_TABELA);
    if (achados) infratores.push(`${arquivo} (${achados.length}x)`);
  }
  ok(infratores.length === 0,
    'A1: nenhum arquivo fora de utils/pecas.js toca a tabela `pecas` direto',
    infratores.join('; '));

  // A varredura tem que estar viva: se a regex parar de casar (renome do módulo, troca da camada de
  // persistência), ela passaria a aprovar tudo em silêncio. Este é o canário.
  const noModulo = (FONTES.get(MODULO) || '').match(ACESSO_TABELA);
  ok(noModulo && noModulo.length >= 5,
    'A2: a própria regex ainda casa dentro do módulo (a varredura não virou no-op)',
    `casou ${noModulo ? noModulo.length : 0}x`);

  // Cada porta declarada precisa mesmo consultar a camada. Sem isto, ampliar a lista PORTAS seria
  // um jeito silencioso de furar a regra B — bastaria declarar a função nova como porta.
  const fonteModulo = FONTES.get(MODULO) || '';
  const semConferencia = [];
  for (const porta of PORTAS) {
    if (porta === 'podeVerTeor') continue; // é a própria camada
    const i = fonteModulo.indexOf(`function ${porta}(`);
    if (i === -1) { semConferencia.push(`${porta} (não encontrada)`); continue; }
    // Corpo aproximado: até a próxima declaração de função no nível de arquivo.
    const proxima = fonteModulo.indexOf('\nfunction ', i + 1);
    const corpo = fonteModulo.slice(i, proxima === -1 ? fonteModulo.length : proxima);
    if (!/podeVerTeor\s*\(/.test(corpo)) semConferencia.push(porta);
  }
  ok(semConferencia.length === 0,
    'A3: toda porta declarada realmente consulta podeVerTeor antes de devolver teor',
    semConferencia.join('; '));

  // A cerca da exceção do servidor HTTP: ele só pode alcançar o teor por token público. Qualquer
  // outra porta ali (paraRenderizacao, metadados, buscar por número) daria um caminho para o
  // documento sem o token — e a URL viraria adivinhável a partir do número do processo.
  const fonteServidor = FONTES.get(SERVIDOR) || '';
  ok(/resolverTokenPublico\s*\(/.test(fonteServidor),
    'A4: o servidor HTTP resolve o documento por token público');
  const outrasPortas = ['paraRenderizacao', 'metadados', 'projetarParaUsuario', 'podeVerTeor']
    .filter(p => new RegExp(`pecas\\.${p}\\s*\\(`).test(fonteServidor));
  ok(outrasPortas.length === 0,
    'A4b: ...e NÃO tem nenhum outro caminho para o teor além dele',
    outrasPortas.join('; '));
}

// ---------------------------------------------------------------------------
console.log('\nB) Ninguém devolve teor sem passar pela camada');
// `.texto` é o teor. Se um arquivo lê `.texto` de algo que veio de `pecas`, tem que haver
// podeVerTeor ou projetarParaUsuario no mesmo arquivo — senão está devolvendo teor cru.
{
  const infratores = [];
  let inspecionados = 0;
  for (const [arquivo, src] of FONTES) {
    if (PERMITIDOS.has(arquivo)) continue;
    // Só interessa quem pode TER uma peça em mãos. Importar `pecas` para chamar uma função da
    // lista segura (modoDoProcesso, janelaAberta...) não põe teor nenhum no arquivo — qualquer
    // outra chamada aciona o gatilho por padrão (ver SEGURAS_SEM_TEOR acima).
    if (!chamaFuncaoArriscada(src)) continue;
    inspecionados++;
    const leTeor = /\.texto\b/.test(src);
    REGEX_PORTAS.lastIndex = 0;
    const passaPelaCamada = REGEX_PORTAS.test(src);
    if (leTeor && !passaPelaCamada) infratores.push(arquivo);
  }
  ok(infratores.length === 0,
    'B1: todo arquivo que importa pecas e lê `.texto` passa por podeVerTeor/projetarParaUsuario',
    infratores.join('; '));
  // Canário do B: se `chamaFuncaoArriscada` parar de casar (renome de função, troca de import),
  // o `continue` acima pula TODOS os arquivos e B1 aprova sem ter olhado nada.
  ok(inspecionados >= 1, 'B2: a varredura B realmente inspecionou arquivos (não virou no-op)', `inspecionou ${inspecionados}`);
}

// ---------------------------------------------------------------------------
console.log('\nC) Toda chamada à camada passa `ehStaff` explicitamente');
// Staff é ROLE do Discord, não cargo do RH — o módulo não tem como resolver sozinho e recebe por
// parâmetro. Omitir faz a staff ver de MENOS, o que é o lado certo para errar, mas o erro é
// SILENCIOSO: ninguém descobre até um supervisor reclamar que não enxerga um processo. Silencioso-
// seguro não testado é dívida invisível — por isso a omissão falha aqui.
{
  const CHAMADAS = new RegExp(REGEX_PORTAS.source, 'g');
  const infratores = [];
  let chamadasVistas = 0;
  for (const [arquivo, src] of FONTES) {
    if (PERMITIDOS.has(arquivo)) continue;
    let m;
    CHAMADAS.lastIndex = 0;
    while ((m = CHAMADAS.exec(src)) !== null) {
      chamadasVistas++;
      // Lê a chamada até o parêntese que a fecha, contando aninhamento — argumento pode ter
      // objeto, chamada de função ou template dentro.
      let i = m.index + m[0].length, prof = 1;
      while (i < src.length && prof > 0) {
        if (src[i] === '(') prof++;
        else if (src[i] === ')') prof--;
        i++;
      }
      const chamada = src.slice(m.index, i);
      if (!/ehStaff/.test(chamada)) {
        const linha = src.slice(0, m.index).split('\n').length;
        infratores.push(`${arquivo}:${linha}`);
      }
    }
  }
  ok(infratores.length === 0,
    'C1: nenhuma chamada omite ehStaff (omissão deixaria a staff cega em silêncio)',
    infratores.join('; '));
  // Canário do C: REGEX_PORTAS que pare de casar faria o while nunca executar, e C1 aprovaria
  // "todas as zero chamadas" em silêncio.
  ok(chamadasVistas >= 1, 'C2: a varredura C realmente encontrou chamadas à camada (não virou no-op)', `viu ${chamadasVistas}`);
}

// ---------------------------------------------------------------------------
console.log('\nD) A varredura pega o vazamento quando ele aparece (auto-teste)');
// Uma varredura que nunca reprovou nada não prova que funciona. Aqui ela é apontada para código
// que VAZA de propósito — se aprovar, é a varredura que está quebrada, não o código.
{
  const casos = [
    {
      nome: 'handler que lê a tabela direto',
      src: `const db = require('../database/db');\nconst p = db.buscarPorNumero('pecas', n);\nreturn embed.setDescription(p.texto);`,
      regra: (s) => !/db\.(todos|buscarUm|buscarPorNumero|atualizar|atualizarPorFiltro|inserir|contar)\s*\(\s*['"]pecas['"]/.test(s),
    },
    {
      nome: 'handler que devolve `.texto` sem a camada',
      src: `const pecas = require('./pecas');\nconst r = pecas.gerar(dados);\nreturn r.peca.texto;`,
      regra: (s) => !(chamaFuncaoArriscada(s) && /\.texto\b/.test(s) && !/podeVerTeor\s*\(|projetarParaUsuario\s*\(|paraRenderizacao\s*\(/.test(s)),
    },
    {
      nome: 'handler que chama a camada sem ehStaff',
      src: `const pecas = require('./pecas');\nif (pecas.podeVerTeor(uid, num, processo)) mostrar();`,
      regra: (s) => /podeVerTeor\s*\([^)]*ehStaff/.test(s),
    },
    // Os quatro casos abaixo vieram de uma cobrança concreta: a regra anterior (lista de INCLUSÃO)
    // provou-se cega a qualquer função nova em pecas.js que ainda não tivesse sido cadastrada — um
    // teste isolado, fora deste arquivo, mostrou os quatro escapando por completo (arquivo pulado
    // inteiro, gatilho nem disparava). Ficam aqui como PROVA PERMANENTE de que a regra atual
    // (lista de EXCLUSÃO — chamaFuncaoArriscada) fecha essa lacuna, e para que uma futura
    // "otimização" da regra não a reabra em silêncio.
    {
      nome: 'vazamento via array/map de função NOVA (não cadastrada em SEGURAS_SEM_TEOR)',
      src: `const pecas = require('../utils/pecas');\nasync function listarAbertas(processoNumero) {\n  const lista = pecas.buscarTodasDoProcesso(processoNumero);\n  return lista.map(p => p.texto).join('\\n');\n}`,
      regra: (s) => !(chamaFuncaoArriscada(s) && /\.texto\b/.test(s) && !/podeVerTeor\s*\(|projetarParaUsuario\s*\(|paraRenderizacao\s*\(/.test(s)),
    },
    {
      nome: 'vazamento via interpolação de string',
      src: `const pecas = require('../utils/pecas');\nfunction resumo(n) {\n  const doc = pecas.buscarTodasDoProcesso(n)[0];\n  return { description: \`Teor: \${doc.texto}\` };\n}`,
      regra: (s) => !(chamaFuncaoArriscada(s) && /\.texto\b/.test(s) && !/podeVerTeor\s*\(|projetarParaUsuario\s*\(|paraRenderizacao\s*\(/.test(s)),
    },
    {
      nome: 'vazamento via campo de embed montado à mão',
      src: `const pecas = require('../utils/pecas');\nfunction embedRolDeProvas(n) {\n  const doc = pecas.buscarTodasDoProcesso(n)[0];\n  embed.addFields({ name: 'Conteúdo', value: doc.texto });\n}`,
      regra: (s) => !(chamaFuncaoArriscada(s) && /\.texto\b/.test(s) && !/podeVerTeor\s*\(|projetarParaUsuario\s*\(|paraRenderizacao\s*\(/.test(s)),
    },
    {
      nome: 'vazamento via autocomplete construído a partir do documento',
      src: `const pecas = require('../utils/pecas');\nasync function autocomplete(i) {\n  const docs = pecas.buscarTodasDoProcesso(i.options.getString('processo'));\n  return docs.map(d => ({ name: d.texto.slice(0, 90), value: d.numero }));\n}`,
      regra: (s) => !(chamaFuncaoArriscada(s) && /\.texto\b/.test(s) && !/podeVerTeor\s*\(|projetarParaUsuario\s*\(|paraRenderizacao\s*\(/.test(s)),
    },
  ];
  for (const c of casos) ok(c.regra(c.src) === false, `D: reprova ${c.nome}`);

  // E o contrário: código correto não pode ser reprovado, senão a equipe aprende a ignorar.
  const bom = `const pecas = require('./pecas');\nconst v = pecas.projetarParaUsuario(uid, p, processo, { ehStaff });\nreturn v.texto || '(sem acesso)';`;
  ok(/ehStaff/.test(bom) && !/db\.\w+\(\s*['"]pecas['"]/.test(bom), 'D: aprova o handler escrito do jeito certo');

  // E não reprova quem importa `pecas` só para saber o MODO do processo: modoDoProcesso devolve uma
  // string, não uma peça. É o caso real de commands/processo.js, que tem `.texto` do rascunho de
  // sentença e nenhuma relação com teor. Achado falso ensina a equipe a ignorar a varredura.
  const soModo = "const pecas = require('./pecas');\nif (pecas.modoDoProcesso(processo) !== 'legado') abrir();\nif (preset.texto) campo.setValue(preset.texto);";
  ok(!chamaFuncaoArriscada(soModo), 'D: aprova quem usa pecas só para ler o modo do processo');

  // E funções seguras de verdade (as 19 auditadas) não podem, sozinhas, acender o gatilho — senão
  // toda vez que alguém chamar abrirEntrega ou janelaAberta num arquivo que por acaso tenha um
  // `.texto` de outra coisa, a varredura reprovaria à toa.
  const chamaSegura = "const pecas = require('./pecas');\nconst r = pecas.abrirEntrega(num, uid);\nif (outraCoisa.texto) usar();";
  ok(!chamaFuncaoArriscada(chamaSegura), 'D: função segura (abrirEntrega) não aciona o gatilho sozinha');
}

// ---------------------------------------------------------------------------
console.log('\nE) DECISÕES DO JUIZ — o teor não pode ir cru para o canal da parte');
// ---------------------------------------------------------------------------
// AS REGRAS A–D PROTEGEM A TABELA `pecas`. Elas não enxergavam nada aqui, e é por isso que este
// bloco existe.
//
// A decisão do juiz não nascia como peça: era um `canal.send` com o texto formal montado por
// utils/documentos.js, num canal onde o advogado/requerente está dentro. O gate inteiro ficava de
// fora justamente do documento que mais importa do rito.
//
// A REGRA: todo ponto que publica TEOR DE DECISÃO tem que bifurcar por modo — em processo `ingame`
// vira peça com selo; em `aberto`/`legado` segue como sempre, porque lá não há entrega em cena a
// proteger. O que a varredura procura é a BIFURCAÇÃO: publicar teor sem ela é vazamento.
{
  // Cada entrada é um ponto REAL de publicação de decisão. Acrescentar decisão nova sem passar por
  // aqui é o que o canário no fim deste bloco impede.
  const DECISOES = [
    { arquivo: 'commands/peticao.js', funcao: 'finalizarDecisao', texto: 'textoSentencaPeticao',
      rotulo: 'decisão da petição administrativa (deferir/indeferir)' },
    { arquivo: 'commands/peticao.js', funcao: 'finalizarDecisao', texto: 'textoIntimacao',
      rotulo: 'diligência da petição administrativa' },
  ];

  // A SENTENÇA SAIU DESTE INVENTÁRIO em 20/08/2026, por decisão explícita do operador: ela deixou
  // de ser gated e passou a ser PUBLICADA no canal do processo, com PNG paginado visível às partes
  // no ato do julgamento.
  //
  // Dois motivos concretos levaram a isso. Primeiro, o desenho não fechava: processo sem defesa
  // habilitada não tinha a quem entregar, então nenhuma peça era criada — e o PNG que
  // `executarSentenca` gerava logo antes era DESCARTADO. A sentença não produzia documento em
  // lugar nenhum, nem canal, nem DM. Segundo, o custo de encenação não se pagava no ato que
  // ENCERRA o processo.
  //
  // O gate continua valendo para todo o resto: denúncia, manifestação do MP, intimação, razões de
  // recurso, decisão de petição administrativa. Ele foi removido de UM ato, e está registrado aqui
  // para que a ausência da sentença nesta lista seja uma decisão legível, e não um esquecimento.
  //
  // A guarda que sobrou no lugar: a seção abaixo confere que a sentença publica pelo gerador
  // PAGINADO e por uma porta só. Se alguém reintroduzir a bifurcação por modo, recoloque a entrada.
  const SENTENCA_SEM_GATE = { arquivo: 'commands/processo.js', funcao: 'executarSentenca' };

  // Recorta pela PRÓXIMA declaração, nunca por número fixo de caracteres: janela fixa já cortou
  // trecho no meio neste projeto e produziu falha que não era do código.
  function corpoDe(fonte, nome) {
    const decl = new RegExp(`^(?:async function ${nome}\\s*\\(|  async ${nome}\\s*\\(|function ${nome}\\s*\\()`, 'm');
    const i = fonte.search(decl);
    if (i < 0) return null;
    const resto = fonte.slice(i + 1);
    const prox = resto.search(/\n(?:async function |function |  async [a-zA-Z]+\(|module\.exports)/);
    return prox < 0 ? resto : resto.slice(0, prox);
  }

  // CONTAGEM, não presença. A primeira versão desta regra perguntava "há bifurcação nesta função?"
  // — e passava verde num teste de mutação em que eu removi a bifurcação de UMA das duas decisões:
  // a bifurcação da outra, na mesma função, respondia pelas duas.
  //
  // Agora cada publicação de teor precisa da SUA bifurcação. Uma função que publica dois teores e
  // tem uma bifurcação só está vazando um deles, e isso agora aparece.
  const CONTA = (corpo, re) => (corpo.match(re) || []).length;

  const porFuncao = new Map();
  for (const d of DECISOES) {
    const chave = `${d.arquivo}#${d.funcao}`;
    if (!porFuncao.has(chave)) porFuncao.set(chave, []);
    porFuncao.get(chave).push(d);
  }

  let examinadas = 0;
  for (const [chave, grupo] of porFuncao) {
    const [arquivo, funcao] = chave.split('#');
    const fonte = fs.readFileSync(path.join(RAIZ, arquivo), 'utf-8');
    const corpo = corpoDe(fonte, funcao);
    if (corpo === null) { ok(false, `E: ${funcao}`, `função não encontrada em ${arquivo}`); continue; }

    for (const d of grupo) {
      examinadas++;
      ok(corpo.includes(d.texto),
        `E${examinadas}z: o ponto de publicação de "${d.rotulo}" continua onde o inventário diz`,
        `${d.texto} não achado em ${funcao}`);
    }

    // Uma bifurcação POR decisão publicada nesta função.
    const bifurcacoes = CONTA(corpo, /Gated\s*=\s*require\('\.\.\/utils\/pecas'\)\.modoDoProcesso\(|Gated\s*=\s*require\('\.\/pecas'\)\.modoDoProcesso\(/g);
    ok(bifurcacoes >= grupo.length,
      `E-${funcao}: as ${grupo.length} decisão(ões) publicadas aqui têm bifurcação por modo — uma para cada`,
      `${bifurcacoes} bifurcação(ões) para ${grupo.length} publicação(ões)`);

    // E cada bifurcação precisa desembocar numa PEÇA, não num segundo jeito de postar o teor.
    ok(CONTA(corpo, /emitirAtoComoPeca\(/g) >= grupo.length,
      `E-${funcao}b: ...e cada uma emite peça com selo no caminho gated`,
      `${CONTA(corpo, /emitirAtoComoPeca\(/g)} emissão(ões) para ${grupo.length} publicação(ões)`);
  }

  // CANÁRIO — varredura que lê zero passa verde e mente. Já aconteceu três vezes neste projeto.
  ok(examinadas === DECISOES.length,
    `Ez: a varredura examinou as ${DECISOES.length} decisões (não passou vazia)`, `examinou ${examinadas}`);

  // A OUTRA PORTA da decisão: o Diário. Publicar o resultado é certo e continua; mandar o PNG da
  // decisão junto foi o vazamento de 19/08/2026. testes-diario-sem-teor.js guarda isso em detalhe —
  // aqui fica a asserção estrutural, para a varredura de visibilidade também enxergar essa saída.
  const fontesDiario = ['commands/peticao.js', 'commands/processo.js', 'utils/supervisao.js', 'utils/diarioAtos.js']
    .map(f => [f, fs.readFileSync(path.join(RAIZ, f), 'utf-8')]);
  ok(fontesDiario.every(([, src]) => src.length > 500), 'Ez2: as fontes do Diário foram lidas (scan não vazio)');
  for (const [nome, src] of fontesDiario) {
    ok(!/(publicarNoDiario|publicarAto)\([^;]*files:\s*png/i.test(src),
      `E-diario-${nome}: não manda PNG de decisão para o Diário`);
  }
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) {
  console.log('\nComo corrigir: leia o teor pela camada, nunca da tabela.');
  console.log('  const vista = pecas.projetarParaUsuario(usuarioId, peca, processo, { ehStaff });');
  console.log('  // vista.texto só existe se a pessoa puder ver — os metadados vêm sempre.\n');
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  process.exit(1);
}
