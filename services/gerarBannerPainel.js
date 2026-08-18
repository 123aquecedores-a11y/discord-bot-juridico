// Banner ilustrado pro topo do canal do painel — mesma família visual dos documentos oficiais
// (Puppeteer + HTML/CSS, brasão nacional), só que em formato paisagem, decorativo, pra dar cara
// de portal oficial ao canal em vez de um embed de texto puro.
const fs = require('fs');
const path = require('path');
const { renderHtmlToPng } = require('./gerarDocumentoPNG');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo-tjsp.png');

let logoBase64Cache;
function getLogoTag() {
  if (logoBase64Cache === undefined) {
    logoBase64Cache = fs.existsSync(LOGO_PATH)
      ? `<img class="brasao" src="data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}">`
      : '';
  }
  return logoBase64Cache;
}

// Balança da justiça em SVG simples (símbolo genérico, sem depender de nenhuma imagem/estátua
// de terceiros) — mantém a mesma paleta dourada/azul-marinho do resto do banner.
const BALANCA_SVG = `
<svg viewBox="0 0 120 220" width="120" height="220" xmlns="http://www.w3.org/2000/svg">
  <line x1="60" y1="10" x2="60" y2="150" stroke="#8a6d1f" stroke-width="4"/>
  <line x1="20" y1="35" x2="100" y2="35" stroke="#8a6d1f" stroke-width="4"/>
  <circle cx="60" cy="10" r="7" fill="#8a6d1f"/>
  <line x1="20" y1="35" x2="20" y2="75" stroke="#8a6d1f" stroke-width="2"/>
  <line x1="100" y1="35" x2="100" y2="75" stroke="#8a6d1f" stroke-width="2"/>
  <path d="M4 75 Q20 105 36 75 Z" fill="none" stroke="#0f1e3d" stroke-width="3"/>
  <path d="M84 75 Q100 105 116 75 Z" fill="none" stroke="#0f1e3d" stroke-width="3"/>
  <rect x="44" y="150" width="32" height="10" fill="#8a6d1f"/>
  <rect x="52" y="160" width="16" height="45" fill="#8a6d1f"/>
  <rect x="38" y="205" width="44" height="10" fill="#8a6d1f"/>
</svg>
`;

const TEMPLATE_BANNER = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; }
  .banner {
    width: 1200px;
    height: 360px;
    box-sizing: border-box;
    background: linear-gradient(180deg, #fdfdfb 0%, #f4f1e8 100%);
    border: 6px solid #b8860b;
    padding: 36px 56px;
    display: flex;
    align-items: center;
    font-family: 'Times New Roman', Times, serif;
    color: #1a1a1a;
  }
  .brasao { height: 200px; margin-right: 44px; flex-shrink: 0; }
  .meio { flex: 1; text-align: center; }
  .orgao { font-size: 44px; font-weight: bold; color: #0f1e3d; letter-spacing: 3px; }
  .divisor { width: 220px; height: 2px; background: #b8860b; margin: 12px auto; }
  .pais { font-size: 15px; letter-spacing: 5px; color: #8a6d1f; font-weight: bold; margin-bottom: 22px; }
  .titulo { font-size: 24px; font-weight: bold; color: #0f1e3d; }
  .descricao { font-size: 14px; color: #333; margin-top: 8px; line-height: 1.5; }
  .balanca { flex-shrink: 0; margin-left: 30px; opacity: 0.85; }
</style>
</head>
<body>
  <div class="banner">
    {{BRASAO}}
    <div class="meio">
      <div class="orgao">PODER JUDICIÁRIO</div>
      <div class="divisor"></div>
      <div class="pais">REPÚBLICA FEDERATIVA DO BRASIL</div>
      <div class="titulo">{{TITULO}}</div>
      <div class="descricao">{{DESCRICAO}}</div>
    </div>
    <div class="balanca">{{BALANCA}}</div>
  </div>
</body>
</html>
`;

async function gerarBannerPainel({ titulo, descricao }) {
  const html = TEMPLATE_BANNER
    .replace('{{BRASAO}}', getLogoTag())
    .replace('{{TITULO}}', titulo)
    .replace('{{DESCRICAO}}', descricao)
    .replace('{{BALANCA}}', BALANCA_SVG);

  return renderHtmlToPng(html, { width: 1200, height: 360 });
}

module.exports = { gerarBannerPainel };
