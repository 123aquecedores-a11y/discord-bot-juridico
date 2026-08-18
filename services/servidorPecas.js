// ENDEREÇO PERMANENTE DA PEÇA — servidor HTTP que serve cada página do documento como PNG.
//
// POR QUE EXISTE: a impressora do jogo recebe uma URL e busca a imagem sozinha. O link de anexo do
// Discord expira em 24h, e hospedagem externa com cota (Fivemanage) para de servir o que já estava
// hospedado quando a cota estoura — quebra retroativa, que é inaceitável para documento de tribunal.
// Aqui o endereço é do próprio serviço, e a fonte da verdade é o texto no banco.
//
// UMA URL POR PÁGINA (`/p/<token>.png`): no jogo cada página é impressa separadamente.
//
// SEM AUTENTICAÇÃO, DE PROPÓSITO E COM CONSEQUÊNCIA ACEITA: o jogo busca a imagem sem sessão, então
// exigir login quebraria a impressora. Isso significa que QUEM TEM O LINK VÊ O DOCUMENTO, sem passar
// pela camada de visibilidade — o link É o papel, e passar o papel adiante é o mesmo ato de passar o
// documento adiante, que a §2 da spec já assume que é possível e trata por dissuasão, não por
// impedimento técnico.
//
// Três consequências disso, e as três estão implementadas abaixo:
//   1. o token é imprevisível (24 bytes aleatórios), nunca id sequencial;
//   2. o token NÃO aparece em log — nem em acesso, nem em erro;
//   3. resposta idêntica para token inválido e token inexistente, para o servidor não virar oráculo
//      de "este documento existe".
const http = require('http');
const fs = require('fs');
const path = require('path');
const pecas = require('../utils/pecas');
const { gerarPecaPNG } = require('./gerarPecaPNG');

// Cache no volume: a renderização é determinística, então o arquivo em disco é só memória de
// trabalho. Pode ser apagado a qualquer momento sem perda — a fonte da verdade é o texto no banco,
// e a página seguinte se regera sozinha.
function dirCache() {
  const base = process.env.DADOS_JSON_PATH
    ? path.dirname(process.env.DADOS_JSON_PATH)
    : path.join(__dirname, '..');
  return path.join(base, 'cache-pecas');
}

// Nome de arquivo derivado do token, sem o token em claro: quem tiver acesso ao disco não colhe uma
// lista de links válidos de uma vez.
const nomeCache = (token) => require('crypto').createHash('sha256').update(token).digest('hex') + '.png';

function lerCache(token) {
  try { return fs.readFileSync(path.join(dirCache(), nomeCache(token))); } catch { return null; }
}

function gravarCache(token, buffer) {
  try {
    fs.mkdirSync(dirCache(), { recursive: true });
    const destino = path.join(dirCache(), nomeCache(token));
    // tmp + rename pelo mesmo motivo do banco: um crash no meio da escrita deixaria PNG cortado no
    // cache, e o jogo imprimiria meia página sem ninguém entender por quê.
    const tmp = `${destino}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, destino);
  } catch (e) {
    console.warn('[pecas-http] não consegui gravar o cache:', e.message);
  }
}

// Rótulos do documento por tipo de ato. Espelha o catálogo de utils/emissaoPeca.js, mas sem importá-lo
// — emissaoPeca puxa discord.js, e este servidor não precisa do bot para responder.
const TITULOS = {
  peticao_incidental: { titulo: 'PETIÇÃO', orgao: 'PODER JUDICIÁRIO', unidade: 'Comarca de São Paulo — Vara Criminal' },
  intimacao_juiz: { titulo: 'INTIMAÇÃO', orgao: 'PODER JUDICIÁRIO', unidade: 'Comarca de São Paulo — Vara Criminal' },
};
const TITULO_PADRAO = { titulo: 'DOCUMENTO', orgao: 'PODER JUDICIÁRIO', unidade: '' };

async function renderizarPagina(dados) {
  const cfg = TITULOS[dados.tipo] || TITULO_PADRAO;
  const paginas = await gerarPecaPNG({
    token: dados.tokenSelo,
    digitos: dados.digitos,
    codigoArquivo: dados.codigoArquivo,
    numeroPeca: dados.pecaNumero,
    numeroProcesso: dados.processoNumero,
    titulo: cfg.titulo,
    orgao: cfg.orgao,
    unidade: cfg.unidade,
    data: new Date(dados.criadoEm || Date.now()).toLocaleDateString('pt-BR'),
    qualificacao: dados.qualificacao || null,
    texto: dados.texto,
    assinante: dados.assinante || '—',
    cargoAssinante: dados.autorPapel,
  });
  return paginas[dados.pagina - 1] || null;
}

// Resposta única para tudo que não resolve. Sem distinguir "token malformado" de "não existe": a
// diferença transformaria o servidor num oráculo de existência de documento.
function naoEncontrado(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404');
}

async function tratar(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return naoEncontrado(res);

  // Healthcheck: o Railway precisa de algo que responda sem depender do banco.
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  const m = /^\/p\/([A-Za-z0-9_-]{16,64})\.png$/.exec((req.url || '').split('?')[0]);
  if (!m) return naoEncontrado(res);
  const token = m[1];

  const cacheado = lerCache(token);
  if (cacheado) return responderPng(res, cacheado, req.method === 'HEAD');

  const dados = pecas.resolverTokenPublico(token);
  if (!dados) return naoEncontrado(res);

  try {
    const png = await renderizarPagina(dados);
    if (!png) return naoEncontrado(res);
    gravarCache(token, png);
    return responderPng(res, png, req.method === 'HEAD');
  } catch (e) {
    // Sem o token na mensagem: log não pode virar a porta dos fundos do documento.
    console.error(`[pecas-http] falha ao renderizar página do documento ${dados.pecaNumero}:`, e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('erro ao gerar o documento');
  }
}

function responderPng(res, buffer, apenasCabecalho) {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    // O conteúdo de um token nunca muda (texto e selo são imutáveis depois de gerados), então cache
    // longo é seguro e poupa a impressora do jogo de buscar de novo.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (apenasCabecalho) return res.end();
  return res.end(buffer);
}

// A URL pública que vai impressa no jogo. BASE_URL_PECAS deve apontar para o domínio do serviço no
// Railway; sem ela, não há endereço a oferecer e quem chama trata a ausência.
function urlPublica(token) {
  const base = (process.env.BASE_URL_PECAS || '').trim().replace(/\/+$/, '');
  return base ? `${base}/p/${token}.png` : null;
}

let servidor = null;
function iniciar() {
  if (servidor) return servidor;
  const porta = Number(process.env.PORT) || 3000;
  servidor = http.createServer((req, res) => {
    tratar(req, res).catch(() => naoEncontrado(res));
  });
  servidor.listen(porta, () => {
    const base = (process.env.BASE_URL_PECAS || '').trim();
    console.log(`[pecas-http] servindo páginas de documento na porta ${porta}`
      + (base ? ` — endereço público: ${base}/p/<token>.png` : ' — ⚠️ BASE_URL_PECAS não configurada: o link para o jogo não será gerado'));
  });
  return servidor;
}

module.exports = { iniciar, urlPublica, tratar, dirCache };
