/* eslint-disable */
// INVENTÁRIO FECHADO DE ANEXOS EM CANAL (19/08/2026). Rode com:
//   node scripts/testes-anexos-em-canal.js
//
// POR QUE ESTE ARQUIVO EXISTE, e por que ele é uma LISTA e não uma regra esperta:
//
// O padrão "teor postado direto no canal" já escapou VÁRIAS vezes — sentença, acórdão, decisão de
// petição, Diário Oficial, e por último a manifestação do MP na petição, que tinha um caminho de
// código próprio, separado do penal, e por isso passou por baixo de todas as varreduras anteriores.
//
// A varredura de visibilidade (testes-visibilidade-varredura.js) protege a tabela `pecas` e os
// pontos de decisão que alguém INVENTARIOU. Ela não vê um `canal.send({ files: [...] })` numa
// função nova, num arquivo novo, com um nome que ninguém previu. Foi exatamente assim que a
// manifestação escapou.
//
// A DEFESA QUE FUNCIONA CONTRA ISSO NÃO É UMA HEURÍSTICA MELHOR — é fail-closed. Todo ponto do
// código que anexa arquivo a uma mensagem está declarado abaixo, com a razão pela qual é legítimo.
// Ponto NOVO que não esteja aqui derruba o teste, e quem o escreveu tem que declarar por que ele
// pode existir. O custo é uma linha por ponto; o benefício é que nenhum vazamento passa calado.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIRS = ['commands', 'utils', 'services'];

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// ---------------------------------------------------------------------------
// O INVENTÁRIO
// ---------------------------------------------------------------------------
// Chave = o NOME do arquivo anexado, como aparece no código. É estável (muda só quando o ato muda)
// e legível, ao contrário de número de linha.
//
// `permitido` explica por que aquele anexo pode existir. As razões aceitas hoje são estas cinco, e
// nenhuma delas é "porque sempre foi assim":
//
//   GATED       — sai pelo pipeline de peças, com selo e janela de entrega.
//   AO_EMISSOR  — vai por DM a quem acabou de escrever o documento (ele já viu o teor).
//   URGENCIA    — mandado e medida: decisão do operador em 18/08/2026, cumprimento não espera cena.
//   SEM_TEOR    — o documento não carrega teor de decisão (carteirinha, banner, edital público).
//   PROVA       — anexo das partes, que nunca foi peça (SPEC §5) e é público aos autos por natureza.
const INVENTARIO = {
  // ---- pelo pipeline gated ----
  '${peca.numero}-${sufixo}-fls${i + 1}.png': {
    arquivo: 'utils/emissaoPeca.js', permitido: 'AO_EMISSOR',
    razao: 'via do emissor, por DM — é quem escreveu a peça; o destinatário só recebe em cena',
  },

  // ---- urgência: decisão explícita do operador em 18/08/2026 ----
  'Mandado-${numeroMandado}.png': {
    arquivo: 'commands/mandado.js|commands/medida.js', permitido: 'URGENCIA',
    razao: 'mandado FORA do gate — cumprimento não pode esperar cena (decisão do operador)',
  },
  'Oficio-${numero}.png': {
    arquivo: 'commands/oficio.js', permitido: 'URGENCIA',
    razao: 'ofício sem destinatário no processo — não há a quem entregar em cena',
  },
  'Intimacao-${numero}.png': {
    arquivo: 'commands/peticao.js|commands/processo.js', permitido: 'URGENCIA',
    razao: 'intimação de pauta/diligência FORA do gate (decisão do operador); a de parte é gated',
  },

  // ---- sem teor de decisão ----
  'banner-painel.png': {
    arquivo: 'commands/painel.js', permitido: 'SEM_TEOR', razao: 'imagem decorativa do painel',
  },
  'carteira-oab-${oab.replace(/\\D/g, \'\')}.png': {
    arquivo: 'utils/carteirinha.js', permitido: 'SEM_TEOR', razao: 'carteirinha funcional, sem teor de ato',
  },
  'carteira-${registro.cargo.toLowerCase()}-${matricula}.png': {
    arquivo: 'utils/carteirinha.js', permitido: 'SEM_TEOR', razao: 'idem, para os demais cargos',
  },
  'Edital-${numero.replace(/[^\\w.-]/g, \'_\')}.png': {
    arquivo: 'commands/edital.js', permitido: 'SEM_TEOR', razao: 'edital é chamamento público, de inteiro teor público',
  },

  // ---- prova ----
  'anexo.nomeArquivo': {
    arquivo: 'commands/processo.js', permitido: 'PROVA', razao: 'anexo das partes; prova nunca foi peça (SPEC §5)',
  },
  'pdf.name': {
    arquivo: 'commands/diarioOficial.js', permitido: 'SEM_TEOR',
    razao: 'comunicado redigido pela Staff — o anexo É o conteúdo dele, não teor de decisão',
  },
  'brasao.png': {
    arquivo: 'commands/painel.js', permitido: 'SEM_TEOR', razao: 'brasão institucional, imagem decorativa',
  },
  'Intimacao-Reu-${numero}.png': {
    arquivo: 'commands/processo.js', permitido: 'URGENCIA',
    razao: 'via do réu — SPEC §11.1: réu fica fora do gate, o Juiz marca cumprida na mão',
  },

  // ---- órgãos apenas: não há parte no canal para proteger ----
  'Parecer-MP-${numero}.png': {
    arquivo: 'commands/processo.js', permitido: 'INTERNO',
    razao: 'a bifurcação é UPSTREAM: oferecer+ingame vira peça denuncia_mp antes de chegar aqui; '
      + 'o que sobra é arquivamento (encerra o caso, sem destinatário) e legado',
  },
  'Decisao-Revisao-${numero}.png': {
    arquivo: 'utils/supervisao.js', permitido: 'INTERNO',
    razao: 'revisão de arquivamento roda no INQUÉRITO — canal com Delegado/Promotor/Procurador, '
      + 'sem advogado nem réu; não há entrega pessoal a proteger',
  },

  // ---- caminho comum: só em processo aberto/legado, onde não há entrega a proteger ----
  'Sentenca-${numero}.png': {
    arquivo: 'commands/peticao.js|commands/processo.js', permitido: 'BIFURCADO',
    razao: 'só no ramo aberto/legado — o ramo ingame emite peça (ver varredura E)',
  },
  'Acordao-${numeroApelacao}.png': {
    arquivo: 'commands/processo.js', permitido: 'BIFURCADO',
    razao: 'CORRIGIDO EM 19/08/2026 — agora só no ramo aberto/legado; ingame emite peça',
  },
  'Manifestacao-MP-${numero}.png': {
    arquivo: 'commands/peticao.js', permitido: 'BIFURCADO',
    razao: 'CORRIGIDO EM 19/08/2026 — agora só no ramo aberto/legado; ingame emite peça',
  },
};

console.log('\n=== Anexos em mensagem: inventário fechado ===\n');

// ---------------------------------------------------------------------------
console.log('1) TODO ponto que anexa arquivo está declarado');
// ---------------------------------------------------------------------------
{
  function arquivosJs(dir) {
    const abs = path.join(RAIZ, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
  }
  const fontes = DIRS.flatMap(arquivosJs);
  ok(fontes.length > 10, '1z: a varredura encontrou arquivos para varrer', `${fontes.length} arquivos`);

  // Captura `name: <qualquer coisa>` dentro de um bloco de anexo. Pega template literal, string e
  // expressão — o que interessa é a IDENTIDADE do anexo, não a forma de escrevê-la.
  const RE_ANEXO = /attachment:[^}]*?name:\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w.$]*)/g;

  const achados = [];
  for (const rel of fontes) {
    const src = fs.readFileSync(path.join(RAIZ, rel), 'utf-8');
    for (const m of src.matchAll(RE_ANEXO)) {
      const nome = m[1].replace(/^[`'"]|[`'"]$/g, '');
      achados.push({ rel, nome });
    }
  }
  ok(achados.length > 5, '1y: e encontrou pontos de anexo (o scan não passou vazio)', `${achados.length} pontos`);

  const naoDeclarados = [];
  for (const a of achados) {
    const entrada = INVENTARIO[a.nome];
    if (!entrada) { naoDeclarados.push(`${a.rel} → ${a.nome}`); continue; }
    // O arquivo também precisa bater: mover um anexo de lugar é mudar o contexto em que ele vive.
    const arquivosOk = entrada.arquivo.split('|');
    if (!arquivosOk.includes(a.rel.replace(/\\/g, '/'))) {
      naoDeclarados.push(`${a.rel} → ${a.nome} (declarado em ${entrada.arquivo})`);
    }
  }
  ok(naoDeclarados.length === 0,
    '1a: nenhum anexo fora do inventário — ponto novo precisa ser declarado com a razão',
    naoDeclarados.join(' | '));

  // O inverso: entrada que não corresponde a nenhum ponto real vira lixo que dá falsa sensação de
  // cobertura. Vale a mesma exigência.
  const nomesReais = new Set(achados.map(a => a.nome));
  const orfas = Object.keys(INVENTARIO).filter(n => !nomesReais.has(n));
  ok(orfas.length === 0, '1b: nenhuma entrada do inventário está órfã', orfas.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n2) TODA razão declarada é uma das aceitas');
// ---------------------------------------------------------------------------
{
  // Sem isto, alguém "declara" um ponto novo com a razão `PORQUE_SIM` e o teste volta a ser
  // carimbo. O conjunto de razões aceitas é uma decisão de política, e mudá-lo tem que doer.
  // INTERNO é a razão mais delicada da lista: ela afirma que NÃO HÁ parte no canal para proteger.
  // Por isso o bloco 5 abaixo confere essa afirmação no código, em vez de aceitá-la de palavra.
  const ACEITAS = new Set(['GATED', 'AO_EMISSOR', 'URGENCIA', 'SEM_TEOR', 'PROVA', 'BIFURCADO', 'INTERNO']);
  const invalidas = Object.entries(INVENTARIO)
    .filter(([, v]) => !ACEITAS.has(v.permitido))
    .map(([k, v]) => `${k}=${v.permitido}`);
  ok(invalidas.length === 0, '2a: toda entrada usa uma razão do conjunto aceito', invalidas.join(' | '));

  const semRazao = Object.entries(INVENTARIO).filter(([, v]) => !v.razao || v.razao.length < 20).map(([k]) => k);
  ok(semRazao.length === 0, '2b: e toda entrada explica POR QUÊ, em texto legível', semRazao.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n3) OS PONTOS "BIFURCADO" realmente bifurcam');
// ---------------------------------------------------------------------------
{
  // Declarar BIFURCADO e não bifurcar seria a pior forma de passar verde: a lista diria que está
  // protegido e o código estaria vazando. Aqui cada um é conferido no arquivo.
  const BIFURCA = /modoDoProcesso\(|ehLegado\(|Gated\b|emitirAtoComoPeca\(/;
  let conferidos = 0;
  for (const [nome, e] of Object.entries(INVENTARIO)) {
    if (e.permitido !== 'BIFURCADO') continue;
    for (const rel of e.arquivo.split('|')) {
      const src = fs.readFileSync(path.join(RAIZ, rel), 'utf-8');
      const i = src.indexOf(nome.slice(0, 25));
      if (i < 0) continue;
      conferidos++;
      // Janela ANTES do anexo: a bifurcação tem que estar acima, no mesmo trecho.
      const antes = src.slice(Math.max(0, i - 2500), i);
      ok(BIFURCA.test(antes), `3-${rel}:${nome.slice(0, 24)}: tem bifurcação por modo acima do anexo`);
    }
  }
  // Canário calculado do próprio inventário, não um número mágico: acrescentar um BIFURCADO e
  // esquecer de atualizar o canário faria a cobertura cair sem ninguém notar.
  const esperados = Object.values(INVENTARIO)
    .filter(e => e.permitido === 'BIFURCADO')
    .reduce((n, e) => n + e.arquivo.split('|').length, 0);
  ok(conferidos === esperados,
    '3z: todos os pontos BIFURCADO declarados foram conferidos no código',
    `conferiu ${conferidos} de ${esperados}`);
}

// ---------------------------------------------------------------------------
console.log('\n5) A razão INTERNO é conferida, não aceita de palavra');
// ---------------------------------------------------------------------------
// INTERNO afirma que NÃO HÁ parte no canal para proteger. É a razão mais fácil de usar para
// justificar um vazamento sem querer — então é a única que exige prova no código.
{
  const proc = fs.readFileSync(path.join(RAIZ, 'commands', 'processo.js'), 'utf-8');
  const sup = fs.readFileSync(path.join(RAIZ, 'utils', 'supervisao.js'), 'utf-8');
  ok(proc.length > 1000 && sup.length > 1000, '5z: as fontes foram lidas (scan não vazio)');

  // Parecer do MP: a afirmação é que a bifurcação acontece ANTES, no menu. Se esse desvio sumir, o
  // parecer volta a postar teor num processo que já pode ter advogado habilitado.
  ok(/escolha === 'oferecer' && !ehLegado\(processo\)/.test(proc)
    && /abrirEmissao\(interaction, 'denuncia_mp'/.test(proc),
    '5a: a denúncia em processo ingame é desviada para a peça ANTES de chegar ao parecer');

  // Revisão de arquivamento: a afirmação é que roda no inquérito, decidida pelo Procurador.
  ok(/revisaoArquivamento/.test(proc) || /revisaoArquivamento/.test(sup),
    '5b: a revisão de arquivamento é um estado próprio do inquérito');
  ok(/Procurador/.test(sup), '5c: e quem decide é o Procurador — ato interno do MP');
}

// ---------------------------------------------------------------------------
console.log('\n4) A MANIFESTAÇÃO DO MP na petição — o bug recorrente');
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(RAIZ, 'commands', 'peticao.js'), 'utf-8');
  const corpo = src.slice(src.indexOf('async function gravarManifestacao'));
  const fim = corpo.search(/\n(?:async function |function )/);
  const bloco = fim < 0 ? corpo : corpo.slice(0, fim);
  ok(bloco.length > 400, '4z: o corpo de gravarManifestacao foi encontrado (scan não vazio)');

  ok(/modoDoProcesso\(atual\) === 'ingame'/.test(bloco), '4a: bifurca por modo');
  ok(/emitirAtoComoPeca\(/.test(bloco), '4b: e o ramo gated emite PEÇA, com selo');
  ok(/tipo: 'manifestacao_mp_gated'/.test(bloco),
    '4c: pelo MESMO tipo do penal — não nasceu um paralelo');
  ok(/tabela: 'peticoes'/.test(bloco), '4d: só dizendo em que tabela a origem vive');
  ok(/destinatarios: \[\{ papel: 'Juiz' \}\]/.test(bloco),
    '4e: dirigida ao JUÍZO — é a ele que o MP se manifesta, não ao advogado');

  // O teor inline era metade do vazamento: o PNG chamava atenção, mas a citação em bloco entregava
  // a fundamentação do mesmo jeito.
  const iGated = bloco.indexOf("if (gated && emissao.ok)");
  const iElse = bloco.indexOf('} else {', iGated);
  ok(iGated > 0 && iElse > iGated, '4y: os dois ramos foram localizados (scan não vazio)');
  const ramoGated = bloco.slice(iGated, iElse);
  ok(!/truncar\(fundamentacao/.test(ramoGated),
    '4f: o ramo gated NÃO cita a fundamentação no canal');
  ok(!/files:/.test(ramoGated), '4g: e não anexa PNG nenhum');
  ok(/🔒/.test(ramoGated), '4h: posta só metadado, dizendo que o teor está restrito');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) {
  console.log('\nAnexo novo? Declare-o em INVENTARIO, com a razão pela qual pode existir.');
  console.log('Se a razão for "o teor tem que sair pelo gate", então o certo NÃO é declarar —');
  console.log('é emitir a peça por emissaoPeca.emitirAtoComoPeca e postar só metadado no canal.\n');
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
}
process.exit(falhas.length ? 1 : 0);
