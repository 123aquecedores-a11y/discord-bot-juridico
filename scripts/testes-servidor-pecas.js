/* eslint-disable */
// Testes do endereço permanente da peça e da densidade do QR. Rode com:
//   node scripts/testes-servidor-pecas.js
//
// Dois riscos aqui, e os dois são silenciosos:
//   1. o QR encolher numa mudança de layout e voltar a ficar ilegível na captura;
//   2. o token público e o token do selo se confundirem — quem recebesse o link do documento
//      ganharia junto a chave que destrava a entrega.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-servidor-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.BASE_URL_PECAS = 'https://bot.exemplo.app';

const db = require('../database/db');
const pecas = require('../utils/pecas');
const servidor = require('../services/servidorPecas');
const QRCode = require('qrcode');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// Resposta falsa, para exercitar a rota sem abrir porta.
function fakeRes() {
  const r = { status: null, headers: null, corpo: null, fim: false };
  return {
    r,
    writeHead: (s, h) => { r.status = s; r.headers = h; },
    end: (c) => { r.corpo = c; r.fim = true; },
  };
}
const chamar = async (url, metodo = 'GET') => { const res = fakeRes(); await servidor.tratar({ method: metodo, url }, res); return res.r; };

(async () => {
  console.log('\n=== Endereço permanente da peça ===\n');

  console.log('1) Densidade do QR — o número que decide se o selo é legível');
  {
    const token = 'tk_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const qr = QRCode.create(token, { errorCorrectionLevel: 'Q' });
    const comMargem = qr.modules.size + 8; // zona de silêncio de 4 módulos de cada lado
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'services', 'gerarPecaPNG.js'), 'utf-8');
    const px = Number((fonte.match(/const QR_PX = (\d+)/) || [])[1]);

    ok(px >= 140, `1a: o QR é renderizado com pelo menos 140px (está em ${px})`);
    ok(/margin: 4/.test(fonte), '1b: margem de 4 módulos (zona de silêncio do padrão QR)');
    ok(/errorCorrectionLevel: 'Q'/.test(fonte), '1c: correção de erro Q — sobrevive a HUD por cima');
    ok(!/toDataURL\(\s*`|toDataURL\(\s*'http/.test(fonte), '1d: o payload é só o token, nunca uma URL');

    const porModulo = px / comMargem;
    ok(porModulo >= 3.5, `1e: ${porModulo.toFixed(2)} px/módulo no PNG (mínimo prático: 3,5)`);
    // Medido no jogo: o documento renderiza a ~0,92 do tamanho nativo.
    const noJogo = porModulo * 0.92;
    ok(noJogo >= 3, `1f: ${noJogo.toFixed(2)} px/módulo na tela do jogo, a 0,92 do nativo`);
  }

  console.log('\n2) Token público é SEPARADO do token do selo');
  {
    db.inserir('processos', { numero: '0001PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame', juiz: 'j1', habilitacoes: [] });
    const g = pecas.gerar({
      processoTabela: 'processos', processoNumero: '0001PN', tipo: 'peticao_incidental',
      autorId: 'adv', autorPapel: 'Advogado', texto: 'Parágrafo de teste.',
      qualificacao: '**Classe:** Ação Penal', assinante: 'Dr. Fulano',
      destinatarios: [{ papel: 'Juiz' }],
    });
    const peca = g.peca;
    const tokenSelo = peca.destinatarios[0].token;

    const reg = pecas.registrarPaginasPublicas(peca.numero, 'Juiz', null, 2);
    ok(reg.ok && reg.paginas.length === 2, '2a: uma URL por página — cada página é impressa separadamente');

    const publicos = reg.paginas.map(p => p.token);
    ok(!publicos.includes(tokenSelo), '2b: NENHUM token público é igual ao token do selo');
    ok(publicos[0] !== publicos[1], '2c: cada página tem token próprio');
    ok(publicos.every(t => t.length >= 24), '2d: tokens longos o bastante para não serem adivinhados');
    ok(publicos.every(t => !/^\d+$/.test(t)), '2e: e não são id sequencial');

    const resolvido = pecas.resolverTokenPublico(publicos[1]);
    ok(resolvido && resolvido.pagina === 2 && resolvido.pecaNumero === peca.numero, '2f: o token resolve na página certa');
    ok(resolvido.tokenSelo === tokenSelo, '2g: e leva ao selo daquele destinatário, para regerar igual');
    ok(pecas.resolverTokenPublico('inexistente') === null, '2h: token desconhecido não resolve');

    // O que o servidor devolve nunca pode conter o token do selo em texto — só dentro do QR.
    const url = servidor.urlPublica(publicos[0]);
    ok(url === `https://bot.exemplo.app/p/${publicos[0]}.png`, '2i: monta a URL pública da página', url);
    ok(!url.includes(tokenSelo), '2j: a URL não carrega o token do selo');
  }

  console.log('\n3) A rota HTTP');
  {
    const saude = await chamar('/health');
    ok(saude.status === 200, '3a: /health responde sem depender do banco');

    const raiz = await chamar('/');
    ok(raiz.status === 200, '3b: / também (o Railway usa para healthcheck)');

    for (const caminho of ['/p/../../etc/passwd', '/p/abc.png', '/p/.png', '/outra/coisa', '/p/' + 'x'.repeat(200) + '.png']) {
      const r = await chamar(caminho);
      ok(r.status === 404, `3c: recusa ${caminho.slice(0, 32)}`);
    }

    const post = await chamar('/health', 'POST');
    ok(post.status === 404, '3d: só GET e HEAD');

    // Token bem formado mas inexistente responde IGUAL a token malformado: sem isso o servidor
    // vira oráculo de "este documento existe".
    const inexistente = await chamar('/p/' + 'A'.repeat(32) + '.png');
    ok(inexistente.status === 404 && inexistente.corpo === '404', '3e: token inexistente responde igual a malformado (sem oráculo)');
  }

  console.log('\n4) Cache é descartável');
  {
    const dir = servidor.dirCache();
    ok(path.isAbsolute(dir), '4a: o cache fica ao lado do banco, no volume');
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'services', 'servidorPecas.js'), 'utf-8');
    ok(/renameSync/.test(fonte), '4b: grava por tmp+rename (crash não deixa PNG cortado no cache)');
    ok(/createHash\('sha256'\)/.test(fonte), '4c: o nome do arquivo não é o token em claro');
    // Procura INTERPOLAÇÃO do token num console, não a palavra "token": o log de boot imprime
    // `.../p/<token>.png` como modelo do endereço, que é placeholder e ajuda quem for configurar.
    // O que não pode é um valor real vazar — `${token}` ou `${dados.tokenSelo}` dentro de um log.
    const logaValor = /console\.\w+\([\s\S]{0,300}?\$\{\s*[\w.]*[Tt]oken/.test(fonte);
    ok(!logaValor, '4d: nenhum log interpola o valor de um token');
    ok(/<token>/.test(fonte), '4e: ...e o log de boot mostra o formato do endereço, como placeholder');
  }

  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
