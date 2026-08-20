/* eslint-disable */
// DECISÕES DO JUIZ POR TRECHOS, NO TEMPLATE DO TRIBUNAL (19/08/2026). Rode com:
//   node scripts/testes-decisao-por-trechos.js
//
// DUAS COISAS, que juntas resolvem o mesmo problema — "PNG único muito longo":
//
//   1. O Juiz monta a decisão em VÁRIOS TRECHOS, com o mesmo painel que o MP já usa na denúncia.
//      O teto de 4.000 caracteres é do campo do Discord, não da sentença.
//   2. O documento sai PAGINADO, no template do tribunal, com selo em todas as páginas.
//
// O QUE ESTE ARQUIVO GUARDA COM MAIS CUIDADO é o "sem duplicar": é fácil resolver isto criando um
// segundo painel de rascunho para o Juiz. Metade das asserções existe para provar que é o MESMO
// componente, com finais diferentes.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-trechos-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const emissao = require('../utils/emissaoPeca');
const { montarHtml } = require('../services/gerarPecaPNG');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const JUIZ = '150000000000000001';

console.log('\n=== Decisões do Juiz por trechos, no template do tribunal ===\n');

// ---------------------------------------------------------------------------
console.log('1) É O MESMO COMPONENTE do MP — não nasceu um painel paralelo');
// ---------------------------------------------------------------------------
{
  const src = LER('utils', 'emissaoPeca.js');
  ok(src.length > 1000, '1z: o arquivo foi lido (scan não vazio)');

  // Um painel só. Se aparecer um "painelRascunhoJuiz", é a cópia nascendo.
  const paineis = (src.match(/function painelRascunho\b/g) || []).length;
  ok(paineis === 1, '1a: existe UMA função de painel de rascunho', `${paineis}`);
  ok(!/painelRascunhoJuiz|rascunhoDecisaoTrechos/.test(src), '1b: e nenhuma variante para o Juiz');

  // O que difere é o FINAL, e ele é injetável.
  ok(/const FINALIZADORES = new Map\(\)/.test(src), '1c: o desfecho é registrável, não fixo em criarPeca');
  ok(/FINALIZADORES\.get\(tipoChave\) \|\| criarPeca/.test(src),
    '1d: quem não registra desfecho cai no criarPeca de sempre');

  // Os botões do painel são os mesmos para todos — mesmo customId, mesmo roteador.
  const painel = emissao.painelDeRascunho(JUIZ, 'fundamentacao_sentenca', '0001PN');
  const ids = painel.components.flatMap(l => l.toJSON().components.map(c => c.custom_id));
  ok(ids.some(i => i.startsWith('peca:enviar:')), '1e: o botão Enviar é o do componente compartilhado');
  ok(ids.some(i => i.startsWith('peca:add:')), '1f: "Adicionar mais texto" idem');
  ok(ids.some(i => i.startsWith('peca:undo:')), '1g: "Apagar último trecho" idem');
}

// ---------------------------------------------------------------------------
console.log('\n2) O RASCUNHO acumula trechos e vira um texto só');
// ---------------------------------------------------------------------------
{
  emissao.semearRascunho(JUIZ, 'fundamentacao_sentenca', '0002PN', 'Primeiro bloco, digitado no modal.');
  let r = emissao.lerRascunho(JUIZ, 'fundamentacao_sentenca', '0002PN');
  ok(r.trechos.length === 1, '2a: o texto do modal vira o PRIMEIRO trecho');
  ok(emissao.textoDoRascunho(r).includes('Primeiro bloco'), '2b: e está lá');

  r.trechos.push('Segundo bloco, acrescentado pelo painel.');
  const junto = emissao.textoDoRascunho(r);
  ok(junto.includes('Primeiro bloco') && junto.includes('Segundo bloco'),
    '2c: os trechos viram UM texto — não uma decisão por trecho');

  emissao.limparRascunho(JUIZ, 'fundamentacao_sentenca', '0002PN');
  ok(emissao.lerRascunho(JUIZ, 'fundamentacao_sentenca', '0002PN').trechos.length === 0,
    '2d: e o finalizador consome o rascunho (segundo Enviar não reemite)');

  // Semear vazio não inventa trecho em branco.
  emissao.semearRascunho(JUIZ, 'fundamentacao_sentenca', '0003PN', '');
  ok(emissao.lerRascunho(JUIZ, 'fundamentacao_sentenca', '0003PN').trechos.length === 0,
    '2e: texto vazio não vira trecho fantasma');
}

// ---------------------------------------------------------------------------
console.log('\n3) EM QUAIS DECISÕES foi aplicado');
// ---------------------------------------------------------------------------
{
  for (const [tipo, onde] of [
    ['fundamentacao_sentenca', 'sentença'],
    ['fundamentacao_mandado', 'mandado direto do Juiz'],
    ['fundamentacao_medida', 'mandado vindo de medida do MP'],
  ]) {
    ok(!!emissao.TIPOS[tipo], `3-${onde}: tem rascunho por trechos`);
    ok(emissao.TIPOS[tipo].semPeca === true,
      `3-${onde}-b: e é declarado semPeca — o texto vira o corpo do ato, não uma peça entregue`);
    ok(emissao.TIPOS[tipo].destinatarios.length === 0,
      `3-${onde}-c: sem destinatário, porque não há a quem entregar este texto`);
  }

  // Os finalizadores estão registrados de verdade (carregar os módulos é o que os registra).
  require('../commands/processo');
  require('../commands/medida');
  require('../commands/mandado');
  const src = LER('utils', 'emissaoPeca.js');
  ok(/registrarFinalizador/.test(src), '3z: o registro existe');
  for (const [arq, tipo] of [
    ['commands/processo.js', 'fundamentacao_sentenca'],
    ['commands/mandado.js', 'fundamentacao_mandado'],
    ['commands/medida.js', 'fundamentacao_medida'],
  ]) {
    ok(new RegExp(`registrarFinalizador\\('${tipo}'`).test(LER(...arq.split('/'))),
      `3-reg-${tipo}: registrado em ${arq}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n4) O TEMPLATE é o do tribunal — e nenhum elemento se perdeu');
// ---------------------------------------------------------------------------
async function secao4() {
  const base = {
    gated: true, token: 'T'.repeat(30), digitos: '481509',
    numeroPeca: '0001PN-P1', numeroProcesso: '0001PN', titulo: 'SENTENÇA',
    orgao: 'PODER JUDICIÁRIO', unidade: 'Comarca de São Paulo — Vara Única',
    data: '19 de agosto de 2026', assinante: 'Ricardo Mancini', cargoAssinante: 'Juiz',
  };
  const html = await montarHtml({ ...base, texto: 'Fundamentação.' });

  for (const [trecho, oque] of [
    ['brasao-img', 'brasão do Poder Judiciário'],
    ['PODER JUDICIÁRIO', 'órgão'],
    ['Comarca de São Paulo — Vara Única', 'subunidade'],
    ['Processo/Protocolo', 'rótulo do cabeçalho'],
    ['>Vistos.<', 'fórmula de abertura'],
    ['<div class="dispositivo">CUMPRA-SE.</div>', 'dispositivo'],
    ['assinatura-nome', 'assinatura manuscrita'],
    ['Documento gerado eletronicamente pelo sistema do Tribunal', 'rodapé'],
    ['class="selo"', 'selo de autenticação'],
  ]) {
    ok(html.includes(trecho), `4-${oque}: está no documento`);
  }

  // Os dígitos são STRING de 6 caracteres, não array — passar array produz vírgulas entre eles.
  const valores = (html.match(/<div class="valor">([^<]*)<\/div>/g) || []).map(x => x.replace(/<[^>]+>/g, ''));
  ok(valores.join('') === '481509', '4-digitos: os seis dígitos saem inteiros, sem separador', valores.join(' '));

  // "CUMPRA-SE." é ORDEM: numa peça de advogado seria mandar cumprir o que ele não pode determinar.
  // Procurar a string "CUMPRA-SE." é grosseiro: ela aparece no COMENTÁRIO do CSS, que vai
  // embutido no HTML. O que importa é o elemento existir ou não.
  const temDispositivo = (h) => /<div class="dispositivo">/.test(h);
  const htmlAdv = await montarHtml({ ...base, titulo: 'PETIÇÃO', cargoAssinante: 'Advogado', texto: 'x' });
  ok(!temDispositivo(htmlAdv), '4-cumpra-se: NÃO aparece em peça de advogado');
  const htmlMp = await montarHtml({ ...base, titulo: 'DENÚNCIA', cargoAssinante: 'Promotor', texto: 'x' });
  ok(!temDispositivo(htmlMp), '4-cumpra-se-mp: nem em manifestação do MP');
  ok(temDispositivo(html), '4-cumpra-se-juiz: mas aparece, sim, em ato do Juízo');

  // Documento sem selo não pode fingir que tem.
  const aberto = await montarHtml({ ...base, gated: false, token: null, digitos: null, texto: 'x' });
  ok(/modo aberto, sem selo de autenticação/.test(aberto),
    '4-aberto: documento sem gate diz no rodapé que não tem selo');
  ok(!aberto.includes('class="selo"'), '4-aberto-b: e não desenha selo nenhum');
}

// ---------------------------------------------------------------------------
console.log('\n5) PAGINAÇÃO — curto numa página, longo em várias');
// ---------------------------------------------------------------------------
async function secao5() {
  const { gerarPecaPNG } = require('../services/gerarPecaPNG');
  const base = {
    gated: true, token: 'T'.repeat(30), digitos: '481509',
    numeroPeca: '0001PN-P1', numeroProcesso: '0001PN', titulo: 'SENTENÇA',
    orgao: 'PODER JUDICIÁRIO', unidade: 'Comarca de São Paulo — Vara Única',
    data: '19/08/2026', assinante: 'Ricardo Mancini', cargoAssinante: 'Juiz',
  };

  const curto = await gerarPecaPNG({ ...base, texto: 'Julgo procedente a denúncia.\n\nPena de 58 meses.' });
  ok(curto.length === 1, '5a: documento curto cabe em UMA página', `${curto.length}`);
  ok(curto[0].length > 5000, '5b: e o PNG tem conteúdo de verdade', `${curto[0].length} bytes`);

  const longo = await gerarPecaPNG({
    ...base,
    texto: Array.from({ length: 36 }, (_, i) => `(${i + 1}) A prova testemunhal colhida em audiência demonstra a materialidade do delito imputado ao acusado, e as declarações guardam coerência com os demais elementos dos autos.`).join('\n\n'),
  });
  ok(longo.length > 1, '5c: documento longo é PAGINADO — era este o problema do PNG único', `${longo.length} páginas`);
  ok(longo.every(b => b.length > 5000), '5d: e toda página tem conteúdo');

  // O ESTOURO SILENCIOSO que já aconteceu: com o brasão em max-height, a medição rodava antes de a
  // imagem entrar no layout, sobrava um parágrafo na página e o selo cobria o texto. Altura fixa é
  // o que garante que a paginação meça o layout final.
  const css = LER('services', 'gerarPecaPNG.js');
  ok(/\.cabecalho \.brasao-img \{ height: 64px;/.test(css),
    '5e: o brasão tem altura FIXA — com max-height a medição rodava antes do layout final');
  ok(!/\.cabecalho \.brasao-img \{ max-height/.test(css), '5f: e não sobrou o max-height');
}

(async () => {
  await secao4();
  await secao5();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
