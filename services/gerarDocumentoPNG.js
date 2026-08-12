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
  .assinatura .linha {
    border-top: 1px solid #1a1a1a;
    width: 320px;
    margin: 0 auto 6px auto;
  }
  .rodape {
    position: absolute;
    bottom: 40px;
    left: 70px;
    right: 70px;
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
  const corpo = escapeHtml(dados.corpoTexto);

  switch (tipoDocumento) {
    case 'sentenca_penal_condenatoria':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">O Ministério Público ofereceu denúncia em face de ${dados.nomeReu}, imputando-lhe a prática de ${dados.crimeDescricao}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO PROCEDENTE a pretensão punitiva estatal para CONDENAR ${dados.nomeReu}, como incurso(a) nas sanções de ${dados.crimeDescricao}, à pena de ${dados.pena}, em regime inicial ${dados.regime}.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_penal_absolutoria':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">O Ministério Público ofereceu denúncia em face de ${dados.nomeReu}, imputando-lhe a prática de ${dados.crimeDescricao}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO IMPROCEDENTE a pretensão punitiva estatal e ABSOLVO ${dados.nomeReu}, nos termos do artigo 386 do Código de Processo Penal.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_civel_procedente':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">${dados.nomeAutor} ajuizou a presente ação em face de ${dados.nomeReu}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO PROCEDENTE o pedido formulado por ${dados.nomeAutor}.</div>
        <div class="corpo" style="margin-top:14px;">P.R.I.C.</div>
      `;

    case 'sentenca_civel_improcedente':
      return `
        <div class="secao-titulo">I – Relatório</div>
        <div class="corpo">${dados.nomeAutor} ajuizou a presente ação em face de ${dados.nomeReu}.</div>
        <div class="secao-titulo">II – Fundamentação</div>
        <div class="corpo">${corpo}</div>
        <div class="secao-titulo">III – Dispositivo</div>
        <div class="dispositivo">Ante o exposto, JULGO IMPROCEDENTE o pedido formulado por ${dados.nomeAutor}, nos termos do artigo 487, I, do Código de Processo Civil.</div>
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
        <div class="corpo">Com base no relatório do inquérito policial e nos elementos de convicção coligidos, em face de ${dados.nomeReu}, pela prática, em tese, de ${dados.crimeDescricao}:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público OFERECE DENÚNCIA em face do(a) indiciado(a) acima qualificado(a), requerendo o recebimento, autuação e regular processamento, nos termos do artigo 41 do Código de Processo Penal.</div>
      `;

    case 'parecer_mp_arquivamento':
      return `
        <div class="corpo">Trata-se de inquérito instaurado para apurar, em tese, a prática de ${dados.crimeDescricao}.</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">Ante o exposto, o Ministério Público PROMOVE O ARQUIVAMENTO do presente inquérito, por ausência de justa causa para o oferecimento de denúncia, nos termos do artigo 28 do Código de Processo Penal, sem prejuízo de reabertura caso surjam novas provas.</div>
      `;

    case 'oficio':
      return `
        <div class="corpo">Senhor(a) destinatário(a),</div>
        <div class="corpo" style="margin-top:10px;">Por determinação de ${dados.nomeAssinante}, nos autos do processo nº ${dados.numeroProcesso}, encaminho o presente para:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="corpo" style="margin-top:14px;">Atenciosamente.</div>
      `;

    case 'mandado_citacao':
      return `
        <div class="corpo">MANDA ao Oficial de Justiça que proceda à CITAÇÃO de ${dados.destinatario}, para que tome conhecimento da presente ação, cujo objeto consiste em:</div>
        <div class="corpo" style="margin-top:10px;">${corpo}</div>
        <div class="dispositivo">CUMPRA-SE.</div>
      `;

    case 'mandado_intimacao':
    case 'intimacao':
      return `
        <div class="corpo">MANDA ao Oficial de Justiça que proceda à INTIMAÇÃO de ${dados.destinatario}, para que tome ciência da seguinte determinação:</div>
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
async function renderHtmlToPng(html, viewport, { fullPage = false } = {}) {
  activeJobs++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setViewport(viewport);
      await page.setContent(html, { waitUntil: 'networkidle0' });
      return await page.screenshot({ type: 'png', fullPage });
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
 * @param {'sentenca_penal_condenatoria'|'sentenca_penal_absolutoria'|'sentenca_civel_procedente'|'sentenca_civel_improcedente'|'decisao_indeferimento_inicial'|'parecer_mp_denuncia'|'parecer_mp_arquivamento'|'oficio'|'mandado_citacao'|'mandado_intimacao'|'intimacao'|'mandado_generico'} [dados.tipoDocumento]
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

  const html = TEMPLATE_BASE
    .replace('{{LOGO_IMG_TAG}}', getLogoImgTag(dados.orgaoEmissor))
    .replace('{{ORGAO_LINHA1}}', ORGAOS[dados.orgaoEmissor][0])
    .replace('{{ORGAO_LINHA2}}', dados.subunidade)
    .replace('{{TITULO_DOCUMENTO}}', dados.tituloDocumento)
    .replace('{{DESTINATARIO}}', dados.destinatario)
    .replace('{{BLOCO_SECOES}}', blocoSecoes)
    .replace('{{NOME_ASSINANTE}}', dados.nomeAssinante)
    .replace('{{CARGO_ASSINANTE}}', dados.cargoAssinante)
    .replace(/\{\{NUMERO_PROCESSO\}\}/g, dados.numeroProcesso)
    .replace(/\{\{DATA_EMISSAO\}\}/g, dados.dataEmissao);

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

module.exports = { gerarDocumentoPNG, nomeExibicao, getBrowser, renderHtmlToPng };
