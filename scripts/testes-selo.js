/* eslint-disable */
// Testes do selo: montagem do documento, paginação e leitura do QR. Rode com:
//   node scripts/testes-selo.js
//
// Os testes de paginação sobem Chromium de verdade (~30s). É proposital: a paginação é medida pelo
// próprio motor de renderização, então testá-la com um stub não provaria nada — e o risco que ela
// carrega é o pior do módulo, que é PERDER TEOR silenciosamente por overflow.

const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DADOS_JSON_PATH = path.join(os.tmpdir(), `dados-teste-selo-${process.pid}.json`);

const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { lerToken, mensagemDeFalha } = require('../utils/lerSelo');
const { montarHtml } = require('../services/gerarPecaPNG');
const { gerarPecaPNG } = require('../services/gerarPecaPNG');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const TOKEN = 'tk_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const PARAGRAFO = 'Considerando os elementos coligidos aos autos e a farta documentação acostada pelas partes, verifica-se que a pretensão deduzida encontra amparo na prova produzida sob o crivo do contraditório, razão pela qual se impõe o acolhimento do pedido nos termos a seguir delineados. ';
const dadosPeca = (texto) => ({
  token: TOKEN, digitos: '729416', numeroPeca: '0001PN-P1', numeroProcesso: '0001PN',
  titulo: 'PETIÇÃO INICIAL', orgao: 'PODER JUDICIÁRIO', unidade: 'Comarca — Vara Criminal',
  data: '18/08/2026', texto, assinante: 'Dr. Fulano de Tal', cargoAssinante: 'Advogado',
});

(async () => {
  console.log('\n=== Selo de autenticação ===\n');

  // -------------------------------------------------------------------------
  console.log('1) Leitura do QR em Node puro (SPEC §12)');
  {
    const png = await QRCode.toBuffer(TOKEN, { errorCorrectionLevel: 'Q', width: 300, margin: 2 });
    const r = lerToken(png);
    ok(r.ok && r.token === TOKEN, '1a: lê o token de um PNG');

    const rgba = PNG.sync.read(png);
    const jpg = jpeg.encode({ data: rgba.data, width: rgba.width, height: rgba.height }, 40).data;
    ok(lerToken(jpg).token === TOKEN, '1b: lê de um JPEG recomprimido a 40 (o Discord não chega perto)');

    // Falha TÉCNICA — não conta para a trava (SPEC §6.4). O motivo tem que vir separado.
    const branca = new PNG({ width: 300, height: 300 }); branca.data.fill(255);
    const semQr = lerToken(PNG.sync.write(branca));
    ok(!semQr.ok && semQr.motivo === 'sem_qr', '1c: imagem sem QR devolve motivo sem_qr, não erro');

    const cortado = lerToken(png.slice(0, Math.floor(png.length / 2)));
    ok(!cortado.ok && cortado.motivo === 'corrompida', '1d: imagem truncada devolve corrompida');

    const naoImagem = lerToken(Buffer.from('isto não é imagem nenhuma'));
    ok(!naoImagem.ok && naoImagem.motivo === 'formato', '1e: arquivo que não é imagem devolve formato');

    ok(lerToken(Buffer.alloc(0)).motivo === 'corrompida', '1f: arquivo vazio não explode');

    // Nenhuma mensagem pode sugerir digitar código — esse caminho não existe (SPEC §13).
    const todas = ['formato', 'corrompida', 'sem_qr'].map(mensagemDeFalha).join(' ');
    ok(!/digit|c[óo]digo|n[úu]mero do selo/i.test(todas), '1g: nenhuma mensagem oferece digitação');
  }

  // -------------------------------------------------------------------------
  console.log('\n2) Montagem do documento (SPEC §5.3)');
  {
    const html = await montarHtml(dadosPeca(PARAGRAFO));
    ok(/<img src="data:image\/png;base64,/.test(html), '2a: o QR entra embutido, sem requisição externa');
    ok(!html.includes(TOKEN), '2b: o token NÃO aparece em texto no documento — só dentro do QR');
    ok(/SELO DE AUTENTICAÇÃO/.test(html), '2c: o selo é identificado na peça');
    ok((html.match(/class="valor"/g) || []).length === 6, '2d: os 6 dígitos do selo estão presentes');
    ok(/sanção administrativa/i.test(html), '2e: aviso de sanção na tela (o mecanismo é anunciado, SPEC §3.10)');
    ok(/monospace|Courier/.test(html), '2f: selo em fonte monoespaçada');

    // Reserva do código de arquivo físico: espaço existe, nasce VAZIO, sem lógica de atribuição.
    ok(/ARQUIVO FÍSICO/.test(html), '2g: o rodapé reserva espaço para o código de arquivo físico');
    ok(/<div class="caixa"><\/div>/.test(html), '2h: ...e ele nasce em branco');

    const comCodigo = await montarHtml({ ...dadosPeca(PARAGRAFO), codigoArquivo: 'AB-2026-0001X-EXCEDENTE' });
    const caixa = comCodigo.match(/<div class="caixa">([^<]*)<\/div>/);
    ok(caixa && caixa[1].length === 12, '2i: quando preenchido, corta em 12 caracteres', `veio "${caixa && caixa[1]}"`);
  }

  // -------------------------------------------------------------------------
  console.log('\n3) Paginação real, com Chromium (SPEC §5.2 e §15.12)');
  {
    // Documento curto: uma página só.
    const curto = await gerarPecaPNG(dadosPeca('Parágrafo único e curto.'));
    ok(curto.length === 1, '3a: documento curto cabe em uma página', `saiu com ${curto.length}`);

    // Acima de 4.000 caracteres — é o teste 12 da SPEC §15.
    const textoLongo = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${PARAGRAFO}`).join('\n\n');
    ok(textoLongo.length > 4000, `3b: o texto de teste passa de 4.000 caracteres (${textoLongo.length})`);
    const paginas = await gerarPecaPNG(dadosPeca(textoLongo));
    ok(paginas.length > 1, `3c: petição acima de 4.000 caracteres é PAGINADA (${paginas.length} páginas)`);

    // O risco real: overflow cortando texto sem ninguém perceber. Num documento judicial isso é
    // perda de teor, não detalhe visual.
    const html = await montarHtml(dadosPeca(textoLongo));
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const distribuicao = await page.evaluate(() => {
      const folhas = document.querySelectorAll('#documento .folha');
      let total = 0, estourou = false;
      folhas.forEach(f => {
        const c = f.querySelector('.corpo');
        total += c.children.length;
        if (c.scrollHeight > c.clientHeight && c.children.length > 1) estourou = true;
      });
      return { folhas: folhas.length, paragrafos: total, estourou };
    });
    await browser.close();
    ok(distribuicao.paragrafos === 16, '3d: NENHUM parágrafo se perde na paginação', `renderizou ${distribuicao.paragrafos} de 16`);
    ok(!distribuicao.estourou, '3e: nenhuma página ficou com texto além da área visível');

    // O ponto da mudança na §5.3: qualquer página capturada tem que servir.
    const lidos = paginas.map(p => lerToken(p));
    ok(lidos.every(r => r.ok && r.token === TOKEN), '3f: TODA página tem QR e decodifica para o MESMO token');
    ok(lidos.length === paginas.length, '3g: ...inclusive a primeira, que é a que o jogador tende a capturar');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(process.env.DADOS_JSON_PATH); } catch (_) {}
  if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
  process.exit(0);
})();
