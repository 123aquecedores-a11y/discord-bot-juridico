// RENDERIZAÇÃO DA PEÇA COM SELO DE AUTENTICAÇÃO (SPEC §5.2 e §5.3).
//
// O desenho inteiro depende de o documento ser legível na tela do jogo e de o selo sobreviver a uma
// captura de tela recomprimida. Por isso duas decisões guiam este arquivo:
//
// 1) PAGINAÇÃO MEDIDA, não estimada. Quebrar por contagem de caracteres erra: a mesma quantidade de
//    texto ocupa alturas diferentes conforme o tamanho dos parágrafos. Aqui quem decide onde quebrar
//    é o próprio Chromium, medindo altura real no DOM — o mesmo motor que vai renderizar.
//
// 2) QR EM TODAS AS PÁGINAS, não só na última. A spec original punha o selo apenas na última página.
//    Num documento de três páginas exibido no jogo, o receptor captura a página que estiver na tela
//    e a leitura falharia sem motivo aparente — ele não teria como saber que precisava rolar até o
//    fim. Mesmo token em todas as folhas: qualquer página capturada decodifica igual. Os dígitos, que
//    são só para conferência humana, ficam na última.
const QRCode = require('qrcode');
const { renderHtmlToPngs } = require('./gerarDocumentoPNG');

// A4 a 96dpi, mesma medida do resto do projeto.
const LARGURA = 794;
const ALTURA = 1123;

// Altura útil do corpo, descontados cabeçalho, rodapé e margens. É o orçamento que a paginação
// respeita; se o layout mudar, este número muda junto.
const ALTURA_CORPO = 640;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escapa PRIMEIRO e só então converte `**x**` em negrito e quebras de linha — na ordem inversa, um
// nome de parte com `<` ou `&` entraria cru no HTML. Usado só na qualificação, que é montada pelo
// bot a partir do registro; o texto livre do usuário nunca passa por aqui.
function negritoSimples(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
}

// DENSIDADE DO QR — é o que decide se o selo é legível na captura, e cada parâmetro aqui tem conta
// por trás. Medido: o documento renderiza no jogo a ~0,92 do tamanho nativo do PNG, então o que vale
// é a escala de render, não a fração de tela.
//
// - PAYLOAD: só o token, nunca uma URL. Quem lê é o próprio bot, então embutir endereço só engordaria
//   o QR. Com 35 caracteres em nível Q dá versão 4 — 33×33 módulos.
// - MARGEM 4 MÓDULOS (zona de silêncio do padrão QR). Com margem 1, a borda do selo encosta no
//   código e a leitura falha por um motivo que aumentar o tamanho não resolve. Custa 8 módulos:
//   33 + 8 = 41 no total.
// - TAMANHO 168px: 168 / 41 = 4,1 px por módulo. O anterior (96px, margem 1) dava 2,74 — marginal,
//   e uma falha no teste não distinguiria layout apertado de captura ruim.
// - NÍVEL Q: 25% de redundância, que é o que sobrevive a HUD do jogo por cima de um pedaço do código.
const QR_MODULOS_COM_MARGEM = 41;
const QR_PX = 168;
const qrDataUri = (token) => QRCode.toDataURL(token, { errorCorrectionLevel: 'Q', margin: 4, width: QR_PX });

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #888; font-family: 'Times New Roman', Times, serif; }
  .folha {
    width: ${LARGURA}px; height: ${ALTURA}px;
    padding: 40px 54px 0 54px;
    background: #fdfdfb; color: #1a1a1a;
    position: relative; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .cabecalho { text-align: center; border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  .cabecalho .orgao { font-size: 15px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
  .cabecalho .unidade { font-size: 12px; color: #333; margin-top: 2px; }
  .titulo { text-align: center; font-size: 17px; font-weight: bold; text-transform: uppercase; letter-spacing: 2px; margin: 16px 0 6px; }
  .metadados { display: flex; justify-content: space-between; font-size: 11px; color: #444; border-bottom: 1px solid #ccc; padding-bottom: 7px; margin-bottom: 10px; }
  .qualificacao { font-size: 12px; line-height: 1.45; border-left: 3px solid #1a1a1a; padding-left: 10px; margin-bottom: 12px; }

  /* CABEÇALHO COMPACTO, da página 2 em diante. Repetir o timbre inteiro em toda folha era o maior
     desperdício vertical do documento: cabeçalho, título, metadados e qualificação somavam ~190px
     por página, que é quase um terço da área útil. Aqui viram uma linha de 20px.
     Cada página é uma impressão no jogo e um espaço no arquivo físico — papel custa caro aqui. */
  .cabecalho-compacto { display: none; font-size: 11px; color: #444; border-bottom: 1px solid #1a1a1a; padding-bottom: 5px; margin-bottom: 10px; letter-spacing: 0.5px; }
  .folha.continuacao .cabecalho,
  .folha.continuacao .titulo,
  .folha.continuacao .metadados,
  .folha.continuacao .qualificacao { display: none; }
  .folha.continuacao .cabecalho-compacto { display: block; }
  /* Só a ÚLTIMA folha mostra o selo completo — é ela que leva a assinatura, os dígitos de
     conferência humana e a caixa de arquivo físico. Nas demais fica só o QR, que é o que a captura
     precisa ler: o QR está em TODAS as páginas, e é isso que faz qualquer captura destravar.
     A classe "ultima" é independente de "continuacao": num documento de uma página só, a folha 1 é
     as duas coisas ao mesmo tempo — cabeçalho completo E selo completo. */
  .folha:not(.ultima) .selo .info .digitos,
  .folha:not(.ultima) .selo .info .aviso,
  .folha:not(.ultima) .selo .arquivo,
  .folha:not(.ultima) .assinatura { display: none; }
  /* min-height:0 é obrigatório aqui. O padrão de um flex item é min-height:auto, que o impede de
     encolher abaixo do próprio conteúdo — o .corpo cresceria junto com o texto, clientHeight
     acompanharia, e a paginação nunca detectaria estouro (documento inteiro numa folha só,
     com o excedente cortado pelo overflow da folha). */
  /* Entrelinha 1,45 e margem de parágrafo de 7px: o padrão anterior (1,65 e 11px) era espaçamento de
     tela, não de documento impresso. Peça judicial real usa entrelinha próxima de 1,5. */
  .corpo { flex: 1; min-height: 0; font-size: 14px; line-height: 1.45; text-align: justify; overflow: hidden; }
  .corpo p { margin: 0 0 7px 0; text-indent: 34px; }
  .assinatura { text-align: center; font-size: 13px; margin: 12px 0 4px; }
  .assinatura .linha { border-top: 1px solid #1a1a1a; width: 260px; margin: 0 auto 4px; }

  /* SELO — fonte monoespaçada, corpo grande, alto contraste (SPEC §5.3). Precisa sobreviver a
     recompressão de captura, então nada de cinza claro nem fonte fina. */
  .selo { border: 2px solid #1a1a1a; display: flex; align-items: center; gap: 14px; padding: 8px 12px; margin-bottom: 10px; background: #fff; }
  /* O QR sai no tamanho nativo em que foi gerado — reescalar por CSS reintroduziria interpolação e
     comeria justamente a nitidez de borda de módulo que a leitura usa. image-rendering: pixelated
     garante que, se algum navegador escalar, seja por vizinho mais próximo e não por suavização. */
  .selo .qr { width: ${QR_PX}px; height: ${QR_PX}px; flex: none; }
  .selo .qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
  .selo .info { flex: 1; font-family: 'Courier New', Courier, monospace; }
  .selo .titulo-selo { font-size: 11px; font-weight: bold; letter-spacing: 1px; }
  .selo .digitos { display: flex; gap: 10px; margin-top: 6px; }
  .selo .digitos .d { text-align: center; }
  .selo .digitos .rotulo { font-size: 9px; color: #555; }
  .selo .digitos .valor { font-size: 22px; font-weight: bold; border: 1px solid #1a1a1a; padding: 0 7px; line-height: 1.25; }
  .selo .aviso { font-size: 9px; color: #333; margin-top: 5px; line-height: 1.3; }
  /* RESERVA — código de arquivo físico, até 12 caracteres. Fica em branco de propósito: o arquivo
     in-game só será desenhado depois que a Faixa 1 rodar, e não há nenhuma lógica de atribuição
     aqui. O espaço existe agora para que acrescentá-lo depois não mude a diagramação nem obrigue a
     revalidar a leitura do QR de novo. */
  .selo .arquivo { flex: none; width: 108px; border-left: 1px solid #1a1a1a; padding-left: 10px; font-family: 'Courier New', Courier, monospace; }
  .selo .arquivo .rotulo { font-size: 8px; color: #555; letter-spacing: 0.5px; }
  .selo .arquivo .caixa { font-size: 13px; font-weight: bold; letter-spacing: 1px; border-bottom: 1px solid #1a1a1a; min-height: 18px; margin-top: 3px; }
  .rodape { display: flex; justify-content: space-between; font-size: 10px; color: #555; border-top: 1px solid #ccc; padding: 5px 0 8px; }
`;

// A paginação roda DENTRO do Chromium porque só ele sabe a altura real do texto renderizado.
// Move parágrafo a parágrafo para a folha corrente; quando estoura o orçamento, devolve o
// parágrafo e abre folha nova. Parágrafo que sozinho não cabe fica na sua própria folha em vez de
// entrar em laço infinito.
const scriptPaginacao = (numeroProcesso) => `
  (function () {
    var NUMERO_PROCESSO = ${JSON.stringify(String(numeroProcesso || ''))};
    var molde = document.getElementById('molde');
    var paragrafos = Array.prototype.slice.call(molde.children);
    molde.remove();
    var container = document.getElementById('documento');
    var modelo = document.getElementById('modelo-folha');

    // A folha 2 em diante nasce como CONTINUAÇÃO: sem timbre, sem título, sem qualificação, e com o
    // selo reduzido ao QR. Precisa ser decidido na criação, e não depois: se a folha nascesse
    // completa e fosse compactada no fim, o texto já teria sido distribuído contra a altura errada e
    // sobraria um vão em branco em cada página.
    function novaFolha() {
      var f = modelo.cloneNode(true);
      f.id = '';
      // O modelo vive escondido para não aparecer como uma folha em branco na captura; o clone
      // precisa perder esse display:none, senão o Puppeteer recusa capturar elemento invisível.
      f.removeAttribute('style');
      f.classList.add('folha');
      if (container.children.length > 0) f.classList.add('continuacao');
      container.appendChild(f);
      return f;
    }

    var folha = novaFolha();
    var corpo = folha.querySelector('.corpo');
    for (var i = 0; i < paragrafos.length; i++) {
      var p = paragrafos[i];
      corpo.appendChild(p);
      // Compara com a altura REAL disponível no elemento, não com uma constante: o espaço livre
      // depende do cabeçalho e do selo, e uma constante chutada quebra silenciosamente sempre que o
      // layout mudar um pixel. clientHeight é o que o Chromium reservou de fato.
      if (corpo.scrollHeight > corpo.clientHeight && corpo.children.length > 1) {
        corpo.removeChild(p);
        folha = novaFolha();
        corpo = folha.querySelector('.corpo');
        corpo.appendChild(p);
      }
    }

    // SEGUNDA PASSADA — a assinatura. Ela não participou da distribuição acima de propósito:
    // reservá-la em todas as folhas (que era o que a versão anterior fazia) desperdiçava ~50px por
    // página para um bloco que só aparece na última. Agora ela entra no fim, e se a última folha não
    // a comportar, os parágrafos do fim escorrem para uma folha nova até caber.
    function ultimaFolha() {
      var todas = container.querySelectorAll('.folha');
      return todas[todas.length - 1];
    }
    var fim = ultimaFolha();
    fim.classList.add('ultima');
    var guarda = 0;
    while (fim.querySelector('.corpo').scrollHeight > fim.querySelector('.corpo').clientHeight
           && fim.querySelector('.corpo').children.length > 1 && guarda++ < 50) {
      var corpoFim = fim.querySelector('.corpo');
      var ultimoP = corpoFim.lastElementChild;
      corpoFim.removeChild(ultimoP);
      fim.classList.remove('ultima');
      var nova = novaFolha();
      nova.querySelector('.corpo').appendChild(ultimoP);
      nova.classList.add('ultima');
      fim = nova;
    }

    var folhas = container.querySelectorAll('.folha');
    for (var j = 0; j < folhas.length; j++) {
      folhas[j].querySelector('.n-folha').textContent = 'fls. ' + (j + 1) + ' de ' + folhas.length;
      var compacto = folhas[j].querySelector('.cabecalho-compacto');
      if (compacto) compacto.textContent = NUMERO_PROCESSO + ' — fl. ' + (j + 1) + '/' + folhas.length;
    }
    document.body.setAttribute('data-paginas', folhas.length);
  })();
`;

// `texto` é a fonte da verdade guardada no banco; aqui ele vira exibição (SPEC §5.1). Linhas em
// branco separam parágrafos.
function paragrafosHtml(texto) {
  const blocos = String(texto || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (!blocos.length) return '<p>(sem conteúdo)</p>';
  return blocos.map(b => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * Gera as páginas PNG de uma peça, com selo em todas.
 * @param {Object} dados
 * @param {string} dados.token       - token de uso único do destinatário; é o que vai no QR
 * @param {string} dados.digitos     - 6 dígitos do selo (leitura humana)
 * @param {string} dados.numeroPeca  - ex: "0001PN-P1"
 * @param {string} dados.titulo      - ex: "PETIÇÃO INICIAL"
 * @param {string} dados.orgao       - ex: "PODER JUDICIÁRIO"
 * @param {string} [dados.unidade]
 * @param {string} dados.numeroProcesso
 * @param {string} dados.data
 * @param {string} dados.texto
 * @param {string} dados.assinante
 * @param {string} dados.cargoAssinante
 * @returns {Promise<Buffer[]>} uma página por posição do array
 */
async function gerarPecaPNG(dados) {
  const html = await montarHtml(dados);
  return renderHtmlToPngs(html, { width: LARGURA, height: ALTURA }, { seletorPagina: '#documento .folha' });
}

// Montagem separada da renderização: o HTML é a parte com regra de layout (paginação, selo em todas
// as páginas) e precisa ser inspecionável sem subir Chromium.
async function montarHtml(dados) {
  const qr = await qrDataUri(dados.token);
  const digitos = String(dados.digitos || '').padEnd(6, '0').slice(0, 6).split('');
  const rotulos = ['A', 'B', 'C', 'D', 'E', 'F'];

  const seloHtml = `
    <div class="selo">
      <div class="qr"><img src="${qr}"></div>
      <div class="info">
        <div class="titulo-selo">SELO DE AUTENTICAÇÃO — DOC. ${escapeHtml(dados.numeroPeca)}</div>
        <div class="digitos">
          ${digitos.map((d, i) => `<div class="d"><div class="rotulo">${rotulos[i]}</div><div class="valor">${escapeHtml(d)}</div></div>`).join('')}
        </div>
        <div class="aviso">Documento entregue em ato presencial. Receber sem o encontro, ou repassar este documento fora dos autos, é sujeito a sanção administrativa.</div>
      </div>
      <div class="arquivo">
        <div class="rotulo">ARQUIVO FÍSICO</div>
        <div class="caixa">${escapeHtml(String(dados.codigoArquivo || '').slice(0, 12))}</div>
      </div>
    </div>`;

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>${CSS}</style></head><body>
    <div id="documento"></div>
    <div id="molde" style="display:none">${paragrafosHtml(dados.texto)}</div>
    <div id="modelo-folha" style="display:none">
      <div class="cabecalho">
        <div class="orgao">${escapeHtml(dados.orgao)}</div>
        ${dados.unidade ? `<div class="unidade">${escapeHtml(dados.unidade)}</div>` : ''}
      </div>
      <div class="cabecalho-compacto"></div>
      <div class="titulo">${escapeHtml(dados.titulo)}</div>
      <div class="metadados">
        <span>Processo nº ${escapeHtml(dados.numeroProcesso)}</span>
        <span>Documento ${escapeHtml(dados.numeroPeca)}</span>
        <span>${escapeHtml(dados.data)}</span>
      </div>
      ${dados.qualificacao ? `<div class="qualificacao">${negritoSimples(dados.qualificacao)}</div>` : ''}
      <div class="corpo"></div>
      <div class="assinatura">
        <div class="linha"></div>
        <div><strong>${escapeHtml(dados.assinante)}</strong></div>
        <div>${escapeHtml(dados.cargoAssinante)}</div>
      </div>
      ${seloHtml}
      <div class="rodape"><span class="n-folha"></span><span>Autenticidade conferível pelo selo acima</span></div>
    </div>
    <script>${scriptPaginacao(dados.numeroProcesso)}</script>
  </body></html>`;
}

module.exports = { gerarPecaPNG, montarHtml, LARGURA, ALTURA };
