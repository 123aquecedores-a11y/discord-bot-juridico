// IA "cartório" (Parte 5) — gera um resumo em tom de despacho de cartório pra APOIAR quem vai
// decidir (Juiz/Promotor), sem NUNCA decidir nada. Princípios inegociáveis:
//  - a IA só resume/contextualiza; jamais defere, indefere, conclui culpa ou mérito;
//  - os cruzamentos de dados são calculados por CÓDIGO antes (utils/cruzamento.js) e entram
//    como fatos prontos no prompt — a IA não "descobre" nada sozinha;
//  - fallback gracioso: sem chave ou com erro na API, retorna null e o fluxo segue normal.
// Usa a API REST do Google Gemini (free tier) direto via fetch — sem SDK/dependência nova.
const config = require('../config');

async function gerarResumoCartorio({ tipoAto, textoLivre = null, resumoFatos = null }) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) return null; // IA desligada (sem chave) — fluxo segue sem despacho.

  const model = config.geminiModel || 'gemini-flash-latest';
  const prompt = [
    'Você é o(a) escrivão(ã) de um cartório judicial em um servidor de RP (roleplay jurídico).',
    'Escreva um DESPACHO DE CARTÓRIO curto (2 a 4 frases), em português formal jurídico, resumindo o ato abaixo pra o Juiz ou Promotor ler rápido e se situar.',
    'REGRAS INEGOCIÁVEIS:',
    '- Você NUNCA decide nada: não defira, não indefira, não conclua culpa, inocência ou mérito, não recomende resultado.',
    '- Apenas resuma o que está posto e, se houver pontos de atenção objetivos já listados abaixo, mencione-os de forma natural na prosa (ex.: "cumpre observar que...").',
    '- Não invente dados que não estejam abaixo.',
    '',
    `Tipo de ato: ${tipoAto}`,
    textoLivre ? `Teor/pedido informado: ${textoLivre}` : null,
    resumoFatos ? `Fatos objetivos já apurados pelo sistema (base pronta, não recalcule): ${resumoFatos}` : null,
    '',
    'Responda apenas com o texto do despacho, sem título e sem aspas.',
  ].filter(Boolean).join('\n');

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 320 },
      }),
    });
    if (!resp.ok) {
      console.error('[cartorio] Gemini respondeu', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const data = await resp.json();
    const texto = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
    return texto || null;
  } catch (e) {
    console.error('[cartorio] falha ao gerar despacho:', e.message);
    return null;
  }
}

// Revisão de texto livre (botão "✨ Revisar") — corrige SÓ a forma (gramática, concordância,
// ortografia, pontuação, clareza) e PRESERVA o conteúdo/sentido. Nunca adiciona, remove ou
// inventa informação, nem muda argumento/decisão. Temperatura baixa pra ser fiel. Opt-in: quem
// chama mostra antes→depois e o autor decide se aceita (o bot não reescreve nada sozinho).
async function revisarTexto(texto) {
  const apiKey = config.geminiApiKey;
  if (!apiKey || !texto || !texto.trim()) return null;
  const model = config.geminiModel || 'gemini-flash-latest';
  const prompt = [
    'Você é um revisor de texto de um cartório judicial. Corrija APENAS a forma do texto abaixo:',
    'gramática, concordância, ortografia, pontuação e clareza da redação.',
    'REGRAS INEGOCIÁVEIS:',
    '- Preserve EXATAMENTE o conteúdo, os fatos, nomes, números, datas e o sentido.',
    '- NÃO adicione, remova nem invente informação. NÃO mude o argumento nem qualquer decisão.',
    '- Mantenha o tom e o registro do autor (se já é formal, siga formal).',
    '- Se o texto já estiver correto, devolva-o praticamente igual.',
    'Responda apenas com o texto corrigido, sem comentários e sem aspas.',
    '',
    'Texto a revisar:',
    texto,
  ].join('\n');

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 800 } }),
    });
    if (!resp.ok) { console.error('[cartorio] revisar respondeu', resp.status); return null; }
    const data = await resp.json();
    const t = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
    return t || null;
  } catch (e) {
    console.error('[cartorio] revisar falha:', e.message);
    return null;
  }
}

// Monta o bloco pronto pra postar no canal (ou null se a IA não produziu nada). Deixa explícito
// que é apoio informativo, pra ninguém confundir com decisão.
async function despachoParaCanal(dados) {
  const texto = await gerarResumoCartorio(dados);
  if (!texto) return null;
  return `📝 **Despacho do Cartório** *(resumo automático — apoio informativo, não é decisão)*\n> ${texto.replace(/\n+/g, '\n> ')}`;
}

// Lê um PDF (por URL) e resume o conteúdo real — o Gemini é multimodal, então baixa o PDF e
// manda inline pra IA. Mesmo princípio: só RESUME, nunca decide. Retorna null (fallback) se não
// houver chave, o PDF não baixar, for grande demais, ou a API falhar.
async function resumirPdf(pdfUrl, { tipoAto = 'documento' } = {}) {
  const apiKey = config.geminiApiKey;
  if (!apiKey || !pdfUrl) return null;
  const model = config.geminiModel || 'gemini-flash-latest';
  try {
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) return null;
    const buf = Buffer.from(await pdfResp.arrayBuffer());
    if (buf.length > 18 * 1024 * 1024) return null; // limite do envio inline (~20MB)
    const prompt = [
      `Você é o(a) escrivão(ã) do cartório. Leia o PDF anexado (${tipoAto}) e escreva um resumo`,
      'curto (3 a 5 frases), em português formal jurídico, tom de despacho, do que o documento',
      'contém: pontos principais, pedidos e datas relevantes.',
      'NUNCA decida nada (não defira, indefira, conclua culpa/mérito). Só resuma o conteúdo real.',
      'Se não conseguir ler o documento, responda exatamente: "Não foi possível ler o documento."',
    ].join(' ');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }),
    });
    if (!resp.ok) { console.error('[cartorio] resumirPdf respondeu', resp.status); return null; }
    const data = await resp.json();
    const t = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
    return t && t !== 'Não foi possível ler o documento.' ? t : null;
  } catch (e) {
    console.error('[cartorio] resumirPdf falha:', e.message);
    return null;
  }
}

module.exports = { gerarResumoCartorio, despachoParaCanal, revisarTexto, resumirPdf };
