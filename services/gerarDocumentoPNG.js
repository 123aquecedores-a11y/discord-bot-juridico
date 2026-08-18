// Gera documentos oficiais (mandado, decisão/sentença, intimação, ofício) como imagem PNG,
// estilo TJSP/MPSP — renderiza um template HTML/CSS com Puppeteer e captura como screenshot.
// Segue a especificação em geracao-documentos-png.md fornecida pelo operador.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TEMPLATE_BASE = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 0; }
  body {
    width: 794px; /* A4 a 96dpi */
    min-height: 1123px;
    margin: 0;
    padding: 60px 70px;
    font-family: 'Times New Roman', Times, serif;
    color: #1a1a1a;
    background: #fdfdfb;
    box-sizing: border-box;
  }
  .header {
    text-align: center;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 16px;
    margin-bottom: 30px;
  }
  .header .brasao-img {
    max-height: 110px;
    margin-bottom: 10px;
  }
  .header .orgao {
    font-size: 16px;
    font-weight: bold;
    text-transform: uppercase;
  }
  .header .subunidade {
    font-size: 13px;
    margin-top: 2px;
    color: #333;
  }
  .titulo-documento {
    text-align: center;
    font-size: 18px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin: 30px 0;
  }
  .metadados {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    margin-bottom: 24px;
    border-bottom: 1px solid #ccc;
    padding-bottom: 10px;
  }
  .metadados div strong { display: block; font-size: 11px; color: #666; }
  .secao-titulo {
    font-weight: bold;
    font-size: 14px;
    text-transform: uppercase;
    margin: 22px 0 8px 0;
  }
  .corpo {
    font-size: 15px;
    line-height: 1.7;
    text-align: justify;
    white-space: pre-wrap;
  }
  .dispositivo {
    font-size: 15px;
    line-height: 1.7;
    text-align: justify;
    margin-top: 18px;
    font-weight: bold;
  }
  .assinatura {
    margin-top: 60px;
    text-align: center;
  }
  /* Nome de quem gerou o documento, renderizado como assinatura manuscrita acima da linha.
     A assinatura é o próprio nome em fonte cursiva — não há upload de imagem. */
  .assinatura .assinatura-nome {
    font-family: 'Segoe Script', 'Brush Script MT', cursive;
    font-style: italic;
    font-size: 34px;
    color: #14245a;
    line-height: 1;
    margin-bottom: 2px;
  }
  .assinatura .linha {
    border-top: 1px solid #1a1a1a;
    width: 320px;
    margin: 0 auto 6px auto;
  }
  .rodape {
    /* Fluindo ao final do conteúdo (não mais position:absolute). Com bottom:40px, num documento
       longo (2+ páginas) o rodapé ancorava na altura de UMA página e cruzava o texto no meio.
       Fluindo, ele sempre fica logo após a assinatura, qualquer que seja o tamanho do documento. */
    margin-top: 50px;
    font-size: 10px;
    color: #888;
    text-align: center;
    border-top: 1px solid #ddd;
    padding-top: 8px;
  }
</style>
</head>
<body>

  <div class="header">
    {{LOGO_IMG_TAG}}
    <div class="orgao">{{ORGAO_LINHA1}}</div>
    <div class="subunidade">{{ORGAO_LINHA2}}</div>
  </div>

  <div class="titulo-documento">{{TITULO_DOCUMENTO}}</div>

  <div class="metadados">
    <div><strong>Processo/Protocolo</strong>{{NUMERO_PROCESSO}}</div>
    <div><strong>Data</strong>{{DATA_EMISSAO}}</div>
    <div><strong>Destinatário</strong>{{DESTINATARIO}}</div>
  </div>

  <div class="corpo">Vistos.</div>

  {{BLOCO_SECOES}}

  <div class="assinatura">
    <div class="assinatura-nome">{{NOME_ASSINANTE}}</div>
    <div class="linha"></div>
    {{NOME_ASSINANTE}}<br>
    {{CARGO_ASSINANTE}}
  </div>

  <div class="rodape">
    Documento gerado eletronicamente pelo sistema do Tribunal — {{NUMERO_PROCESSO}} — {{DATA_EMISSAO}}
  </div>

</body>
</html>
`;

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Monta o bloco de seções (Relatório/Fundamentação/Dispositivo) de acordo com o tipo de
 * documento, envolvendo o texto livre do usuário com o esqueleto fixo de uma peça jurídica
 * real — o Juiz/Promotor/Delegado continua escrevendo só a fundamentação em texto livre, o
 * resto (relatório, dispositivo, fecho) é montado pelo bot ao redor.
 */
function montarBlocoSecoes(tipoDocumento, dados) {
  // Escapa TODO campo que entra cru no HTML (não só o corpoTexto): nome do réu/autor, crime,
  // pena, regime, destinatário, nº do processo e assinante são texto livre do usuário e poderiam
  // injetar HTML/CSS no documento renderizado pelo Puppeteer.
  const corpo = escapeHtml(dados.corpoTexto);
  const nomeReu = escapeHtml(dados.nomeReu);
  const nomeAutor = escapeHtml(dados.nomeAutor);
  const crimeDescricao = escapeHtml(dados.crimeDescricao);
  const pena = escapeHtml(dados.pena);
  const regime = escapeHtml(dados.regime);
  const destinatario = escapeHtml(dados.destinatario);
  const numeroProcesso = escapeHtml(dados.numeroProcesso);
  const nomeAssinante = escapeHtml(dados.nomeAssinante);
  const posicao = escapeHtml(dados.posicao);

  switch (tipoDocumento) {
    case 'sentenca_penal_condenatoria':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">O Ministério Público ofereceu denúncia em face de ${nomeReu}, imputando-lhe a prática de ${crimeDescricao}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO PROCEDENTE a pretensão punitiva estatal para CONDENAR ${nomeReu}, como incurso(a) nas sanções de ${crimeDescricao}, à pena de ${pena}, em regime inicial ${regime}.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_penal_absolutoria':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">O Ministério Público ofereceu denúncia em face de ${nomeReu}, imputando-lhe a prática de ${crimeDescricao}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO IMPROCEDENTE a pretensão punitiva estatal e ABSOLVO ${nomeReu}, nos termos do artigo 386 do Código de Processo Penal.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_civel_procedente':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">${nomeAutor} ajuizou a presente ação em face de ${nomeReu}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO PROCEDENTE o pedido formulado por ${nomeAutor}.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_civel_improcedente':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">${nomeAutor} ajuizou a presente ação em face de ${nomeReu}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO IMPROCEDENTE o pedido formulado por ${nomeAutor}, nos termos do artigo 487, I, do Código de Processo Civil.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'decisao_indeferimento_inicial':
      return `
        <div class="corpo">${corpo}</div>
        <div class="dispositivo">Ante o exposto, INDEFIRO A PETIÇÃO INICIAL e, por consequência, EXTINGO o processo sem resolução do mérito, nos termos do artigo 485 do Código de Processo Civil.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.</div>
      `;

    // Parecer do próprio Ministério Público (spec-atualizacoes-bot-juridico.md, seção 1) — texto
    // na voz do Promotor oferecendo a denúncia, não do Juiz recebendo-a (esse é outro ato,
    // separado, que já acontece em botoesJuiz/oferecer quando o Juiz é sorteado).
    case 'parecer_mp_denuncia':
      return `
        <div class="corpo">Com base no relatório do inquérito policial e nos elementos de convicção coligidos, em face de ${nomeReu}, pela prática, em tese, de ${crimeDescricao}:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público OFERECE DENÚNCIA em face do(a) indiciado(a) acima qualificado(a), requerendo o recebimento, autuação e regular processamento, nos termos do artigo 41 do Código de Processo Penal.</div>
      `;

    case 'parecer_mp_arquivamento':
      return `
        <div class="corpo">Trata-se de inquérito instaurado para apurar, em tese, a prática de ${crimeDescricao}.</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público PROMOVE O ARQUIVAMENTO do presente inquérito, por ausência de justa causa para o oferecimento de denúncia, nos termos do artigo 28 do Código de Processo Penal, sem prejuízo de reabertura caso surjam novas provas.</div>
      `;

    // Parecer do MP sobre petição administrativa (porte de arma, troca de nome, limpeza de ficha,
    // alvará de evento). Posição: Favorável / Desfavorável / Nada a opor. A fundamentação (corpo) é
    // obrigatória em Favorável/Desfavorável e ausente em "Nada a opor" — que gera PNG mesmo assim,
    // por ser ato processual igual.
    case 'parecer_mp_peticao':
      return `
        <div class="corpo">O Ministério Público, na qualidade de fiscal da ordem jurídica, manifesta-se sobre o pedido formulado nos autos em epígrafe.</div>
        ${corpo ? `<div class="corpo" style="margin-top:10px;">${corpo}</div>` : ''}
        <div class="dispositivo">Manifestação do Ministério Público: ${posicao}.</div>
      `;

    case 'oficio':
      return `
        <div class="corpo">Senhor(a) destinatário(a),</div>
        <div class="corpo" style="margin-top:10px;">Por determinação de ${nomeAssinante}, nos autos do processo nº ${numeroProcesso}, encaminho o presente para:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="corpo" style="margin-top:14px;">Atenciosamente.</div>
      `;

    case 'mandado_citacao':
      return `
        <div class="corpo">MANDA ao Oficial de Justiça que proceda à CITAÇÃO de ${destinatario}, para que tome conhecimento da presente ação, cujo objeto consiste em:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">CUMPRA-SE.</div>
      `;

    case 'mandado_intimacao':
    case 'intimacao':
      return `
        <div class="corpo">MANDA ao Oficial de Justiça que proceda à INTIMAÇÃO de ${destinatario}, para que tome ciência da seguinte determinação:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">CUMPRA-SE.</div>
      `;

    case 'mandado_generico':
      return `
        <div class="corpo">${corpo}</div>
        <div class="dispositivo">CUMPRA-SE.</div>
      `;

    // Decisão do Procurador sobre revisão de arquivamento pedida pelo Delegado (problema
    // relatado: antes o Procurador não tinha nenhum documento formal pra essa decisão, só
    // texto solto no canal — agora os dois desfechos geram peça em PNG, igual parecer do MP).
    case 'decisao_revisao_manter':
      return `
        <div class="corpo">Trata-se de pedido de revisão do arquivamento do inquérito, formulado pelo Delegado responsável.</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público MANTÉM o arquivamento anteriormente promovido.</div>
      `;

    case 'decisao_revisao_forcar':
      return `
        <div class="corpo">Trata-se de pedido de revisão do arquivamento do inquérito, formulado pelo Delegado responsável.</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público REFORMA o arquivamento anteriormente promovido e OFERECE DENÚNCIA, requerendo o recebimento, autuação e regular processamento, nos termos do artigo 41 do Código de Processo Penal.</div>
      `;

    default:
      // fallback: nenhum tipo reconhecido, mantém comportamento antigo (só o texto livre)
      return `<div class="corpo">${corpo}</div>`;
  }
}

// Um único Chromium é reaproveitado por todos os documentos/banners (abrir um por documento
// estouraria a memória). O gerenciamento abaixo cuida de três coisas que faltavam:
//  1) flags amigáveis a container — sobretudo --disable-dev-shm-usage: sem ela o Chromium tenta
//     usar o /dev/shm minúsculo do container e trava/estoura ao renderizar (causa clássica de
//     crash em Railway/Render e afins);
//  2) auto-recuperação: se o Chromium morrer (OOM/crash), a instância morta é descartada e
//     religada no próximo uso, em vez de deixar TODA geração de PNG quebrada até reiniciar o bot;
//  3) desligamento por ociosidade: depois de um tempo sem gerar nada, o Chromium é fechado pra
//     devolver memória ao container, e religa sozinho quando voltar a ser preciso.
const LAUNCH_OPTS = {
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
  ],
  // No Railway (Docker) o Chromium vem do apt e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
  // aponta pra ele. Local (Windows/dev), a variável fica vazia e o Puppeteer usa o Chromium
  // que ele mesmo baixou. Sem passar isso, com PUPPETEER_SKIP_DOWNLOAD=1 o launch não acha
  // navegador e os PNGs não saem.
  ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
};
const BROWSER_IDLE_MS = 5 * 60 * 1000;

let browserInstance = null;
let browserBootPromise = null; // evita abrir dois Chromium em pedidos quase simultâneos
let idleTimer = null;
let activeJobs = 0;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  if (!browserBootPromise) {
    browserBootPromise = puppeteer.launch(LAUNCH_OPTS).then(browser => {
      browserInstance = browser;
      // Chromium caiu (ex: morto por falta de memória): esquece a instância morta pra religar
      // no próximo uso, em vez de tentar usar um browser fantasma e quebrar todos os documentos.
      browser.on('disconnected', () => {
        if (browserInstance === browser) browserInstance = null;
        browserBootPromise = null;
      });
      return browser;
    }).catch(err => {
      browserBootPromise = null; // libera nova tentativa no próximo pedido
      throw err;
    });
  }
  return browserBootPromise;
}

function agendarDesligamentoOcioso() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeJobs > 0) return; // ainda gerando algo — não desliga agora
    const b = browserInstance;
    browserInstance = null;
    browserBootPromise = null;
    if (b && b.connected) b.close().catch(() => {});
  }, BROWSER_IDLE_MS);
  if (idleTimer.unref) idleTimer.unref(); // o timer não deve segurar o processo Node vivo
}

// Renderiza um HTML em PNG reusando o Chromium compartilhado. Centraliza newPage/close e a
// contagem de trabalhos ativos (pra não desligar o Chromium no meio de uma geração).
// `seletor` captura só aquele elemento em vez da página inteira — é como as carteirinhas
// recortam o cartão (.card). Sem passar por aqui, uma carteirinha não conta em activeJobs e o
// desligamento por ociosidade pode fechar o Chromium no meio da geração.
async function renderHtmlToPng(html, viewport, { fullPage = false, seletor = null } = {}) {
  activeJobs++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setViewport(viewport);
      await page.setContent(html, { waitUntil: 'networkidle0' });
      if (!seletor) return await page.screenshot({ type: 'png', fullPage });
      const elemento = await page.$(seletor);
      if (!elemento) throw new Error(`elemento "${seletor}" não encontrado no template`);
      return await elemento.screenshot({ type: 'png' });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    activeJobs--;
    agendarDesligamentoOcioso();
  }
}

// Carrega os logos uma única vez e mantém em memória como base64, pra não ler o arquivo do
// disco a cada documento gerado.
const LOGO_FILES = {
  judiciario: 'logo-tjsp.png',
  ministerio_publico: 'logo-mpsp.png',
  policia_civil: 'logo-policia-civil.png', // adicionar arquivo quando disponível
};

const logoCache = {};

function getLogoImgTag(orgaoEmissor) {
  if (logoCache[orgaoEmissor] === undefined) {
    const filePath = path.join(__dirname, '..', 'assets', LOGO_FILES[orgaoEmissor] || '');
    if (fs.existsSync(filePath)) {
      const base64 = fs.readFileSync(filePath).toString('base64');
      logoCache[orgaoEmissor] = `<img class="brasao-img" src="data:image/png;base64,${base64}">`;
    } else {
      logoCache[orgaoEmissor] = ''; // sem logo cadastrado ainda -> cabeçalho só com texto
    }
  }
  return logoCache[orgaoEmissor];
}

/**
 * Gera um PNG a partir dos dados do documento.
 * @param {Object} dados
 * @param {'sentenca_penal_condenatoria'|'sentenca_penal_absolutoria'|'sentenca_civel_procedente'|'sentenca_civel_improcedente'|'decisao_indeferimento_inicial'|'parecer_mp_denuncia'|'parecer_mp_arquivamento'|'parecer_mp_peticao'|'oficio'|'mandado_citacao'|'mandado_intimacao'|'intimacao'|'mandado_generico'} [dados.tipoDocumento]
 * @param {string} [dados.posicao] - só para parecer_mp_peticao: Favorável / Desfavorável / Nada a opor
 * @param {'judiciario'|'ministerio_publico'|'policia_civil'} dados.orgaoEmissor
 * @param {string} dados.subunidade - ex: "Comarca de São Paulo — Vara Criminal"
 * @param {string} dados.tituloDocumento - ex: "SENTENÇA", "MANDADO DE CITAÇÃO"
 * @param {string} dados.numeroProcesso
 * @param {string} dados.dataEmissao
 * @param {string} dados.destinatario
 * @param {string} dados.corpoTexto - texto livre escrito pelo Juiz/Promotor/Delegado
 * @param {string} [dados.nomeReu]
 * @param {string} [dados.nomeAutor]
 * @param {string} [dados.crimeDescricao]
 * @param {string} [dados.pena] - só para sentenca_penal_condenatoria
 * @param {string} [dados.regime] - só para sentenca_penal_condenatoria
 * @param {string} dados.nomeAssinante
 * @param {string} dados.cargoAssinante
 * @returns {Promise<Buffer>} PNG buffer
 */
async function gerarDocumentoPNG(dados) {
  // judiciario fica vazio de propósito: o brasão nacional já traz "Poder Judiciário"
  // desenhado dentro da própria imagem — repetir em texto duplicaria a informação no cabeçalho.
  const ORGAOS = {
    judiciario: [''],
    ministerio_publico: ['MINISTÉRIO PÚBLICO DO ESTADO DE SÃO PAULO'],
    policia_civil: ['POLÍCIA CIVIL DO ESTADO DE SÃO PAULO'],
  };

  const blocoSecoes = montarBlocoSecoes(dados.tipoDocumento, dados);

  // Escapa TODO campo de texto livre antes de entrar no template (subunidade, título, destinatário,
  // assinante, cargo, nº do processo, data) — não só o corpo. LOGO_IMG_TAG e BLOCO_SECOES são HTML
  // já montado pelo bot (logo é <img>; o bloco já teve seus campos escapados), por isso não são
  // reescapados. As substituições usam função pra que um '$' no valor não vire padrão de replace.
  const subunidade = escapeHtml(dados.subunidade);
  const tituloDocumento = escapeHtml(dados.tituloDocumento);
  const destinatario = escapeHtml(dados.destinatario);
  const nomeAssinante = escapeHtml(dados.nomeAssinante);
  const cargoAssinante = escapeHtml(dados.cargoAssinante);
  const numeroProcesso = escapeHtml(dados.numeroProcesso);
  const dataEmissao = escapeHtml(dados.dataEmissao);

  const html = TEMPLATE_BASE
    .replace('{{LOGO_IMG_TAG}}', () => getLogoImgTag(dados.orgaoEmissor))
    .replace('{{ORGAO_LINHA1}}', () => ORGAOS[dados.orgaoEmissor][0])
    .replace('{{ORGAO_LINHA2}}', () => subunidade)
    .replace('{{TITULO_DOCUMENTO}}', () => tituloDocumento)
    .replace('{{DESTINATARIO}}', () => destinatario)
    .replace('{{BLOCO_SECOES}}', () => blocoSecoes)
    .replace(/\{\{NOME_ASSINANTE\}\}/g, () => nomeAssinante)
    .replace('{{CARGO_ASSINANTE}}', () => cargoAssinante)
    .replace(/\{\{NUMERO_PROCESSO\}\}/g, () => numeroProcesso)
    .replace(/\{\{DATA_EMISSAO\}\}/g, () => dataEmissao);

  return renderHtmlToPng(html, { width: 794, height: 1123 }, { fullPage: true });
}

// PNG é uma imagem estática — <@id> não vira menção clicável nela como vira no texto do
// Discord, então todo campo que hoje é @menção precisa virar nome de exibição de verdade
// antes de entrar no template, ou o documento sai com "<@123456789>" literal no papel.
async function nomeExibicao(guild, discordId) {
  if (!discordId) return 'Não identificado';
  const membro = await guild.members.fetch(discordId).catch(() => null);
  return membro ? membro.displayName : `Usuário ${discordId}`;
}

// ---- Carteirinha (identidade de advogado / OAB) ----
// Reusa o MESMO browser Puppeteer do pipeline de documentos (renderHtmlToPng) — não sobe outro.
// Renderiza o template compartilhado carteirinha_template.html e captura só o elemento .card
// (1013×639) em deviceScaleFactor 2 → PNG final 2026×1278.
const CARTEIRINHA_TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'carteirinha_template.html');
let carteirinhaTemplateCache = null;

function getCarteirinhaTemplate() {
  if (carteirinhaTemplateCache === null) {
    carteirinhaTemplateCache = fs.readFileSync(CARTEIRINHA_TEMPLATE_PATH, 'utf-8');
  }
  return carteirinhaTemplateCache;
}

/**
 * Gera a carteirinha da OAB em PNG.
 * @param {Object} dados
 * @param {string} dados.nome - nome do advogado (vai em NOME e na assinatura do cartão)
 * @param {string} dados.rg
 * @param {string} dados.oab - número já formatado (ex: "000.001")
 * @param {string} dados.data - data de inscrição dd/mm/aaaa
 * @returns {Promise<Buffer>} PNG buffer
 */
async function gerarCarteirinhaPNG({ nome, rg, oab, data }) {
  // escapeHtml em todos os campos: são texto livre do usuário e entrariam crus no HTML.
  const html = getCarteirinhaTemplate()
    .replace(/\{\{NOME\}\}/g, () => escapeHtml(nome))
    .replace(/\{\{RG\}\}/g, () => escapeHtml(rg))
    .replace(/\{\{OAB\}\}/g, () => escapeHtml(oab))
    .replace(/\{\{DATA\}\}/g, () => escapeHtml(data));

  // deviceScaleFactor 2 = dobro da densidade → cartão nítido (2026×1278 no PNG final).
  return renderHtmlToPng(html, { width: 1013, height: 639, deviceScaleFactor: 2 }, { seletor: '.card' });
}

// ---- Carteiras funcionais por cargo (Juiz/Desembargador/Promotor/Procurador) ----
// Mesmo mecanismo da carteirinha da OAB (elemento .card 1013×639 @2x), mas com um template por
// cargo (cores diferentes) e as variáveis {{CARGO}}/{{NOME}}/{{RG}}/{{NUMERO}}.
const cacheTemplateCarteira = {};
function getTemplateCarteira(arquivo) {
  if (!cacheTemplateCarteira[arquivo]) {
    cacheTemplateCarteira[arquivo] = fs.readFileSync(path.join(__dirname, '..', 'assets', arquivo), 'utf-8');
  }
  return cacheTemplateCarteira[arquivo];
}

/**
 * Gera a carteira funcional de um cargo em PNG.
 * @param {{arquivo:string, cargo:string, nome:string, rg:string, numero:string}} dados
 * @returns {Promise<Buffer>}
 */
async function gerarCarteiraCargoPNG({ arquivo, cargo, nome, rg, numero }) {
  const html = getTemplateCarteira(arquivo)
    .replace(/\{\{CARGO\}\}/g, () => escapeHtml(cargo))
    .replace(/\{\{NOME\}\}/g, () => escapeHtml(nome))
    .replace(/\{\{RG\}\}/g, () => escapeHtml(rg))
    .replace(/\{\{NUMERO\}\}/g, () => escapeHtml(numero));
  return renderHtmlToPng(html, { width: 1013, height: 639, deviceScaleFactor: 2 }, { seletor: '.card' });
}

// ---- Edital (processo seletivo) ----
// Mesmo pipeline/browser dos documentos. Renderiza o template compartilhado edital_template.html
// como página A4 e captura fullPage (padrão dos outros documentos).
const EDITAL_TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'edital_template.html');
let editalTemplateCache = null;

function getEditalTemplate() {
  if (editalTemplateCache === null) {
    editalTemplateCache = fs.readFileSync(EDITAL_TEMPLATE_PATH, 'utf-8');
  }
  return editalTemplateCache;
}

/**
 * Gera o PNG do edital a partir do template compartilhado.
 * @param {{numero:string, vagasJuiz:(number|string), vagasPromotor:(number|string), requisitos:string, inicio:string, fim:string}} dados
 * @returns {Promise<Buffer>}
 */
async function gerarEditalPNG({ numero, vagasJuiz, vagasPromotor, requisitos, inicio, fim }) {
  const html = getEditalTemplate()
    .replace(/\{\{NUMERO\}\}/g, () => escapeHtml(numero))
    .replace(/\{\{VAGAS_JUIZ\}\}/g, () => escapeHtml(String(vagasJuiz)))
    .replace(/\{\{VAGAS_PROMOTOR\}\}/g, () => escapeHtml(String(vagasPromotor)))
    .replace(/\{\{REQUISITOS\}\}/g, () => escapeHtml(requisitos))
    .replace(/\{\{INICIO\}\}/g, () => escapeHtml(inicio))
    .replace(/\{\{FIM\}\}/g, () => escapeHtml(fim));

  return renderHtmlToPng(html, { width: 794, height: 1123 }, { fullPage: true });
}

module.exports = { gerarDocumentoPNG, gerarCarteirinhaPNG, gerarCarteiraCargoPNG, gerarEditalPNG, nomeExibicao, getBrowser, renderHtmlToPng };
