/* eslint-disable */
// A PÁGINA PÚBLICA É O PAPEL — /p/<token>.png. Rode com:
//   node scripts/testes-pagina-publica.js
//
// ACHADO CRÍTICO DA AUDITORIA (19/08/2026), provado com execução real antes de consertar:
// services/servidorPecas.js NÃO passava `gated` para gerarPecaPNG, e pecas.resolverTokenPublico
// nem devolvia o campo. Como o bloco do selo é condicional a `gated`, a página servida pelo link
// público de uma peça GATED saía SEM O QR — e é ESTA página que o jogador imprime dentro do jogo.
// O destinatário fotografava um papel sem selo e não conseguia receber nunca, enquanto o PNG
// enviado por DM (que passa `gated` certo) tinha o selo. Duas vias do "arquivo único" divergindo é
// exatamente o que a SPEC §3.7 proíbe.
//
// CAUSA RAIZ, e por isso o conserto não foi um remendo: servidorPecas mantinha um CATÁLOGO PRÓPRIO
// de rótulos com apenas 2 dos 7 tipos — não podia importar emissaoPeca (discord.js). A cópia
// divergiu: os 5 tipos dos Blocos D e E caíam num "DOCUMENTO" genérico sem unidade, e a vara
// estava fixa em "Vara Criminal". Agora os dois lados leem de utils/catalogoAtos.js.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-pagpub-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';

const db = require('../database/db');
const pecas = require('../utils/pecas');
const catalogo = require('../utils/catalogoAtos');
const emissao = require('../utils/emissaoPeca');
const { montarHtml } = require('../services/gerarPecaPNG');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// Reproduz EXATAMENTE o que services/servidorPecas.js:renderizarPagina monta. Se aquele arquivo
// mudar e parar de passar `gated`, este teste continua verde por espelhar o certo — por isso o
// bloco 3 confere o FONTE de lá também. Os dois juntos fecham o ângulo.
function argsDaPaginaPublica(d) {
  const cfg = catalogo.rotuloDoAto(d.tipo);
  return {
    gated: d.gated,
    token: d.tokenSelo,
    digitos: d.digitos,
    codigoArquivo: d.codigoArquivo,
    numeroPeca: d.pecaNumero,
    numeroProcesso: d.processoNumero,
    titulo: cfg.titulo,
    orgao: cfg.orgao,
    unidade: catalogo.unidadeDoProcesso({ tipo: d.processoTipo }),
    data: '19/08/2026',
    qualificacao: d.qualificacao || null,
    texto: d.texto,
    assinante: d.assinante || '—',
    cargoAssinante: d.autorPapel,
  };
}

function criarPecaEToken({ numero, tipoProcesso, modo, tipoAto }) {
  db.inserir('processos', {
    numero, tipo: tipoProcesso, status: 'Instrução', modoEntrega: modo, juiz: 'id_juiz',
    habilitacoes: [{ id: 1, advogadoId: 'id_adv', status: 'Aprovado' }],
  });
  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: numero, tipo: tipoAto,
    autorId: 'id_juiz', autorPapel: 'Juiz', texto: 'teor da peça', assinante: 'Dr. Fulano',
    destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
  });
  pecas.registrarPaginasPublicas(g.peca.numero, 'Advogado', 1, 1);
  const peca = db.buscarPorNumero('pecas', g.peca.numero);
  return { peca, token: peca.destinatarios[0].paginasPublicas[0].token };
}

(async () => {
console.log('\n=== Página pública /p/<token>.png — é ela que vira papel no jogo ===\n');

console.log('1) O SELO — o defeito crítico que a auditoria pegou');
{
  const { peca, token } = criarPecaEToken({ numero: '7101PN', tipoProcesso: 'Penal', modo: 'ingame', tipoAto: 'intimacao_juiz' });
  const d = pecas.resolverTokenPublico(token);

  ok(d !== null, '1a: o token resolve');
  ok(peca.gated === true, '1b: a peça é gated no banco');
  ok(d.gated === true, '1c: resolverTokenPublico DEVOLVE `gated` — sem isso o selo some da página impressa');

  const html = await montarHtml(argsDaPaginaPublica(d));
  ok(/class="selo"/.test(html), '1d: a página pública SAI COM O SELO (era o bug: saía sem QR)');
  // O token NÃO aparece como texto no HTML — ele vai DENTRO do QR, embutido como data-URI. Isso é
  // proposital: token legível em texto seria copiável de um print sem passar pelo QR. O que dá para
  // afirmar aqui é que a imagem do selo foi gerada; que ela decodifica de volta para o token certo
  // é o que scripts/testes-selo.js prova com Chromium + jsQR de verdade.
  ok(/<img[^>]+src="data:image\/png;base64,/.test(html),
    '1e: ...com a imagem do QR embutida (o token vai DENTRO dela, nunca como texto copiável)');
  ok(!html.includes(d.tokenSelo),
    '1f: ...e o token NÃO aparece como texto no documento — seria copiável de um print sem ler o QR');
}

console.log('\n2) Modo ABERTO não ganha selo (o inverso também é regressão)');
{
  const { token } = criarPecaEToken({ numero: '7102CV', tipoProcesso: 'Civil', modo: 'aberto', tipoAto: 'peticao_incidental' });
  const d = pecas.resolverTokenPublico(token);
  ok(d.gated === false, '2a: peça de processo aberto não é gated');
  const html = await montarHtml(argsDaPaginaPublica(d));
  ok(!/class="selo"/.test(html), '2b: e a página pública NÃO monta selo — documento sem gate não finge ter autenticação');
}

console.log('\n3) RÓTULOS: fonte única, sem catálogo paralelo divergindo');
{
  // O catálogo do servidor tinha 2 de 7 tipos; os outros 5 viravam "DOCUMENTO" sem unidade.
  const ativos = Object.keys(emissao.TIPOS).filter(t => emissao.tipoAtivo(t));
  ok(ativos.length >= 7, `3a: há ${ativos.length} tipos ativos no catálogo de emissão`, `achou ${ativos.length}`);

  const semRotulo = ativos.filter(t => !catalogo.ROTULOS[t]);
  ok(semRotulo.length === 0,
    '3b: TODO tipo ativo tem rótulo próprio na fonte única (nenhum cai no "DOCUMENTO" genérico)',
    semRotulo.join(', '));

  // Canário: se ROTULOS esvaziar ou o catálogo de emissão sumir, 3b passaria por vacuidade.
  ok(Object.keys(catalogo.ROTULOS).length >= 7, '3z: a fonte única realmente tem rótulos (o teste 3b não passou vazio)');

  // E o servidor tem que estar LENDO daqui — não voltar a ter cópia local.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'services', 'servidorPecas.js'), 'utf-8');
  ok(/require\('\.\.\/utils\/catalogoAtos'\)/.test(fonte), '3c: servidorPecas importa a fonte única');
  ok(/gated: dados\.gated/.test(fonte), '3d: ...e passa `gated` ao renderizador (a linha que faltava)');
  ok(!/Vara Criminal/.test(fonte), '3e: ...e não tem mais vara fixa no código (era "Vara Criminal" para todo mundo)');
}

console.log('\n4) A VARA sai do PROCESSO, não do tipo do ato');
{
  const { token: tPenal } = criarPecaEToken({ numero: '7103PN', tipoProcesso: 'Penal', modo: 'ingame', tipoAto: 'peticao_incidental' });
  const { token: tCivel } = criarPecaEToken({ numero: '7104CV', tipoProcesso: 'Civil', modo: 'ingame', tipoAto: 'peticao_incidental' });

  const htmlPenal = await montarHtml(argsDaPaginaPublica(pecas.resolverTokenPublico(tPenal)));
  const htmlCivel = await montarHtml(argsDaPaginaPublica(pecas.resolverTokenPublico(tCivel)));

  ok(/Vara Criminal/.test(htmlPenal), '4a: o MESMO tipo de ato em processo penal imprime "Vara Criminal"');
  ok(/Vara C[íi]vel/.test(htmlCivel), '4b: ...e em processo cível imprime "Vara Cível" (era Criminal para os dois)');
}

console.log('\n5) A via da DM e a via do link são o MESMO documento (SPEC §3.7, arquivo único)');
{
  const { token } = criarPecaEToken({ numero: '7105PN', tipoProcesso: 'Penal', modo: 'ingame', tipoAto: 'sentenca' });
  const d = pecas.resolverTokenPublico(token);
  const htmlPublico = await montarHtml(argsDaPaginaPublica(d));

  // O que a emissão manda por DM usa o catálogo de emissaoPeca + unidadeDoProcesso.
  const cfgEmissao = emissao.TIPOS.sentenca;
  const htmlDm = await montarHtml({
    gated: true, token: d.tokenSelo, digitos: d.digitos, codigoArquivo: d.codigoArquivo,
    numeroPeca: d.pecaNumero, numeroProcesso: d.processoNumero,
    titulo: cfgEmissao.titulo, orgao: cfgEmissao.orgao,
    unidade: emissao.unidadeDoProcesso({ tipo: 'Penal' }),
    data: '19/08/2026', qualificacao: d.qualificacao || null, texto: d.texto,
    assinante: d.assinante || '—', cargoAssinante: d.autorPapel,
  });

  const tituloDe = (h) => (h.match(/<div class="titulo">([^<]+)</) || [])[1];
  const unidadeDe = (h) => (h.match(/<div class="unidade">([^<]+)</) || [])[1];
  ok(tituloDe(htmlPublico) === tituloDe(htmlDm),
    '5a: o TÍTULO é o mesmo nas duas vias', `público="${tituloDe(htmlPublico)}" dm="${tituloDe(htmlDm)}"`);
  ok(unidadeDe(htmlPublico) === unidadeDe(htmlDm),
    '5b: a UNIDADE é a mesma nas duas vias', `público="${unidadeDe(htmlPublico)}" dm="${unidadeDe(htmlDm)}"`);
  ok(/class="selo"/.test(htmlPublico) === /class="selo"/.test(htmlDm),
    '5c: o SELO existe (ou não) igualmente nas duas — divergir aqui é o defeito que a SPEC §3.7 proíbe');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
