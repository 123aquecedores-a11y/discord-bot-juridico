// LEITURA DO SELO (SPEC §5.3, §6.4, §12).
//
// Decodificação em Node PURO. Nunca IA, nunca OCR de dígitos, nunca chamada de API — e
// deliberadamente NÃO via Chromium: acoplaria o destravamento ao componente mais pesado do sistema,
// e se o Chromium cair perderíamos geração de documento E validação de selo ao mesmo tempo, dois
// caminhos críticos num ponto de falha só.
//
// O que sai daqui alimenta o contador da SPEC §6.4, e a distinção importa: `ilegivel` é falha
// técnica (imagem ruim) e NÃO conta para a trava; um token lido que não confere é tentativa
// indevida e conta. Por isso esta função devolve o motivo, não só null.
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

// Captura de tela do jogo chega como PNG ou JPEG. Os dois decodificadores são puro-JS, sem binário
// nativo — o serviço não pode depender de compilar nada no deploy.
function paraRGBA(buffer) {
  // Assinaturas nos primeiros bytes: PNG começa com \x89PNG, JPEG com \xFF\xD8\xFF. Confiar na
  // extensão do arquivo não serve — o nome vem do usuário.
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') {
    const png = PNG.sync.read(buffer);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  if (buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 128 });
    return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  }
  return null; // formato não suportado (WEBP, GIF, HEIC…) — tratado como ilegível, não como erro
}

/**
 * Lê o token do QR numa captura.
 * @param {Buffer} buffer imagem enviada pelo destinatário
 * @returns {{ok: boolean, token?: string, motivo?: 'formato'|'corrompida'|'sem_qr', detalhe?: string}}
 */
function lerToken(buffer) {
  if (!buffer || !buffer.length) return { ok: false, motivo: 'corrompida', detalhe: 'arquivo vazio' };

  let bitmap;
  try {
    bitmap = paraRGBA(buffer);
  } catch (e) {
    // Imagem truncada no upload, PNG com CRC quebrado, JPEG progressivo estranho. É falha técnica:
    // o destinatário tenta outra captura, e isso NÃO conta para a trava.
    return { ok: false, motivo: 'corrompida', detalhe: e.message };
  }
  if (!bitmap) return { ok: false, motivo: 'formato', detalhe: 'envie PNG ou JPEG' };

  // `attemptBoth` tenta também o QR invertido (claro sobre escuro) — tema escuro do jogo, filtro de
  // captura ou screenshot invertido não podem custar uma tentativa ao jogador.
  const achado = jsQR(bitmap.data, bitmap.width, bitmap.height, { inversionAttempts: 'attemptBoth' });
  if (!achado || !achado.data) return { ok: false, motivo: 'sem_qr', detalhe: `imagem ${bitmap.width}x${bitmap.height} sem QR legível` };

  return { ok: true, token: achado.data, dimensoes: `${bitmap.width}x${bitmap.height}` };
}

// Mensagem para o destinatário. Nunca oferece campo de digitação — não existe esse caminho no fluxo
// (SPEC §13). Só orienta a tirar uma captura melhor.
const MOTIVOS = {
  formato: 'Esse formato de imagem eu não consigo abrir. Mande a captura em PNG ou JPEG.',
  corrompida: 'A imagem chegou incompleta. Tente enviar de novo.',
  sem_qr: 'Não consegui ler o selo na captura. Tire outra com o selo inteiro visível, sem corte e sem sobreposição de HUD.',
};
const mensagemDeFalha = (motivo) => MOTIVOS[motivo] || MOTIVOS.sem_qr;

module.exports = { lerToken, mensagemDeFalha, paraRGBA };
