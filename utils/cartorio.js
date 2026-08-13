// IA "cartório" (Parte 5) — gera um resumo em tom de despacho de cartório pra APOIAR quem vai
// decidir (Juiz/Promotor), sem NUNCA decidir nada. Princípios inegociáveis:
//  - a IA só resume/contextualiza; jamais defere, indefere, conclui culpa ou mérito;
//  - os cruzamentos de dados são calculados por CÓDIGO antes (utils/cruzamento.js) e entram
//    como fatos prontos no prompt — a IA não "descobre" nada sozinha;
//  - fallback gracioso: sem chave ou com erro na API, retorna null e o fluxo segue normal.
// Usa a API REST do Google Gemini (free tier) direto via fetch — sem SDK/dependência nova.
const config = require('../config');

// IMPORTANTE (modelos "thinking", ex.: gemini-flash-latest → Gemini 2.5): o raciocínio interno
// consome o maxOutputTokens ANTES de escrever a resposta. Medições reais deste projeto: um prompt
// trivial já gasta ~300–700 tokens só de "pensamento"; sobre um PDF inteiro, bem mais. Se o teto
// for baixo, o thinking engole tudo e a resposta volta VAZIA (finishReason MAX_TOKENS) — foi
// exatamente a causa do "PDF anexado não resumido" (Frente 5.3, com maxOutputTokens:1400).
// thinkingBudget:0 devolve HTTP 400 nesse alias, e um budget baixo positivo é ignorado (pediu 128,
// pensou 454), então o único controle confiável é dar TETO FOLGADO: thinking + saída cabem juntos
// e o modelo para sozinho no STOP. Teto alto não encarece respostas normais (o modelo não enche
// até o teto — para quando termina); só evita o truncamento.
const MAX_TOKENS_DESPACHO = 2048;     // despacho curto (2–4 frases) + thinking
const MAX_TOKENS_REVISAO = 4096;      // texto revisado (pode ser longo) + thinking
const MAX_TOKENS_ANALISE_PDF = 8192;  // JSON estruturado de um PDF inteiro + thinking (o mais pesado)

// A análise multimodal de um PDF inteiro (upload do documento + leitura + thinking + JSON) é bem
// mais lenta que uma chamada de texto: medições reais passavam de 25s. Com o teto padrão de 25s do
// fetchComTimeout, a chamada era abortada no meio → null → "PDF não resumido" (Frente 5.3). Todos os
// fluxos que chamam isso já deram interaction.deferReply antes (token vale 15 min), então esperar
// mais é seguro. 90s cobre PDFs reais com folga sem pendurar a interação indefinidamente.
const TIMEOUT_ANALISE_PDF_MS = 90000;

// Retry da análise de PDF. A causa nº1 de "resumo indisponível" observada em produção foi um HTTP
// 503 UNAVAILABLE ("This model is currently experiencing high demand") — o modelo gratuito/compartilhado
// do Google fica sobrecarregado por picos de demanda, o que é TEMPORÁRIO. Repetir a chamada resolve na
// grande maioria das vezes. Só repetimos em erros TRANSITÓRIOS (503/500/502/504 do servidor, 429 de
// limite por minuto, e resposta vazia/truncada); 4xx de cliente (400/403/404) são definitivos e retornam
// na hora. A interação já foi deferida antes (token vale 15 min), então esperar entre tentativas é seguro.
const STATUS_TRANSITORIOS = new Set([429, 500, 502, 503, 504]);
const MAX_TENTATIVAS_ANALISE = 3;
const ESPERA_RETRY_MS = [2000, 5000]; // backoff antes da 2ª e da 3ª tentativa
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + leitura do corpo sob UM único deadline. Sem timeout, um HANG na rede (não é erro HTTP,
// o try/catch normal não pega) deixaria o `await` pendurado pra sempre — e como em vários fluxos a
// confirmação ao usuário só é enviada DEPOIS desse await, a interação travaria (token expira em
// 15 min). O `consumir(resp)` lê o corpo (json/arrayBuffer) AINDA sob o mesmo AbortController, então
// um travamento no meio do streaming do corpo (ex.: download de PDF grande) também é abortado — não
// só a fase de conexão/headers. Ao abortar, o fetch lança AbortError, que cai no catch de quem chama
// e vira o fallback null/''. O timer só é limpo quando tudo termina (finally).
async function fetchComTimeout(url, opcoes, consumir, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opcoes, signal: ctrl.signal });
    return await consumir(resp);
  } finally {
    clearTimeout(timer);
  }
}

// Formatador único do bloco "📝 Despacho do Cartório" — evita a string ser montada em dois
// lugares (despachoParaCanal e blocoResumoPdf) e divergir. `comQuebraInicial` adiciona o \n\n de
// quando o bloco é concatenado ao final de outra mensagem.
function blocoDespacho(texto, { comQuebraInicial = false } = {}) {
  const prefixo = comQuebraInicial ? '\n\n' : '';
  return `${prefixo}📝 **Despacho do Cartório** *(resumo automático da IA — apoio, não é decisão)*\n> ${texto.replace(/\n+/g, '\n> ')}`;
}

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
    return await fetchComTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: MAX_TOKENS_DESPACHO },
      }),
    }, async (resp) => {
      if (!resp.ok) {
        console.error('[cartorio] Gemini respondeu', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
        return null;
      }
      const data = await resp.json();
      const texto = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
      return texto || null;
    });
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
    return await fetchComTimeout(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: MAX_TOKENS_REVISAO } }),
    }, async (resp) => {
      if (!resp.ok) { console.error('[cartorio] revisar respondeu', resp.status); return null; }
      const data = await resp.json();
      const t = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
      return t || null;
    });
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
  return blocoDespacho(texto);
}

// Parse tolerante do JSON que a IA devolve — cobre a resposta vir crua, dentro de cercas
// ```json ... ``` ou com texto em volta (pega do primeiro { ao último }). Null se nada colar.
function parseJsonSeguro(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { /* tenta os fallbacks abaixo */ }
  const semCerca = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(semCerca); } catch { /* último fallback */ }
  const i = semCerca.indexOf('{');
  const j = semCerca.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(semCerca.slice(i, j + 1)); } catch { return null; } }
  return null;
}

// Análise FIEL e ESTRUTURADA de um documento em PDF (spec_resumo_ia_documentos.md) — em vez de um
// resumo raso em prosa, extrai um JSON com o esquema pedido pra o cargo entender o caso antes de
// abrir o PDF. Mesmos princípios: só descreve o que está escrito, nunca decide mérito. O PDF vai
// multimodal (Gemini lê inclusive PDF escaneado).
// Retorno DISCRIMINADO (Frente 5.3) pra o fallback nunca ser mudo NEM enganoso: `{ ok: true, dados }`
// no sucesso, ou `{ ok: false, motivo }` com a causa REAL (não configurada / download / tamanho /
// quota 429 / erro HTTP / resposta vazia / timeout / conexão) pra virar um aviso claro pro cargo.
async function analisarPdfEstruturado(pdfUrl, { systemPrompt, schemaTexto, rotuloTipo = null } = {}) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) return { ok: false, motivo: 'a análise automática por IA não está configurada neste servidor' };
  if (!pdfUrl || !systemPrompt || !schemaTexto) return { ok: false, motivo: 'faltaram dados internos para montar a análise' };
  const model = config.geminiModel || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // 1) Baixa o PDF UMA vez (rebaixar a cada tentativa seria desperdício — quem falha é a IA, não o download).
  let buf;
  try {
    buf = await fetchComTimeout(pdfUrl, {}, async (resp) => (resp.ok ? Buffer.from(await resp.arrayBuffer()) : null));
  } catch (e) {
    console.error('[cartorio] analisarPdf: falha ao baixar PDF:', e.message);
    return { ok: false, motivo: /abort/i.test(e.message || '') ? 'a análise ultrapassou o tempo limite ao baixar o documento' : 'não foi possível baixar o documento anexado' };
  }
  if (!buf) return { ok: false, motivo: 'não foi possível baixar o documento anexado' };
  if (buf.length > 14 * 1024 * 1024) return { ok: false, motivo: 'o documento é grande demais para a análise automática (acima de 14 MB)' };

  const instrucaoUsuario = [
    rotuloTipo ? `Tipo de documento a analisar: ${rotuloTipo}.` : null,
    'Analise o DOCUMENTO EM PDF anexado e devolva EXCLUSIVAMENTE um JSON válido, exatamente com estas chaves e esta estrutura:',
    schemaTexto,
    'Se alguma informação não constar no documento, use "Não consta no relatório" (ou lista vazia, conforme o campo). Nunca invente.',
  ].filter(Boolean).join('\n\n');
  const corpo = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: instrucaoUsuario }, { inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: MAX_TOKENS_ANALISE_PDF, responseMimeType: 'application/json' },
  };

  // 2) Chama o Gemini repetindo em falhas TRANSITÓRIAS (o 503 de sobrecarga que causou o "resumo
  //    indisponível" em produção), com backoff. Erro definitivo ou timeout: para na hora, sem empilhar espera.
  let ultimo = { ok: false, motivo: 'não foi possível analisar o documento' };
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_ANALISE; tentativa++) {
    if (tentativa > 1) {
      const espera = ESPERA_RETRY_MS[tentativa - 2] || 5000;
      console.warn(`[cartorio] analisarPdf: tentativa ${tentativa}/${MAX_TENTATIVAS_ANALISE} em ${espera}ms (falha transitória anterior: ${ultimo.motivo})`);
      await esperar(espera);
    }
    try {
      const r = await fetchComTimeout(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      }, async (resp) => {
        if (!resp.ok) {
          console.error('[cartorio] analisarPdf respondeu', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
          const motivo = resp.status === 429
            ? 'o limite de uso gratuito da IA foi atingido — tente novamente em alguns minutos'
            : resp.status === 503
              ? 'o serviço de IA do Google está sobrecarregado no momento — tente novamente em instantes'
              : `a IA respondeu com erro (código ${resp.status})`;
          return { ok: false, motivo, transitorio: STATUS_TRANSITORIOS.has(resp.status) };
        }
        const data = await resp.json();
        const t = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
        const dados = parseJsonSeguro(t);
        return dados
          ? { ok: true, dados }
          : { ok: false, motivo: 'a IA não retornou um resumo legível (resposta vazia ou truncada)', transitorio: true };
      }, TIMEOUT_ANALISE_PDF_MS);

      if (r.ok) return r;            // sucesso
      ultimo = r;
      if (!r.transitorio) return r;  // erro definitivo (4xx de cliente): repetir não muda nada
    } catch (e) {
      const abortou = /abort/i.test(e.message || '');
      console.error(`[cartorio] analisarPdf tentativa ${tentativa} falhou:`, e.message);
      ultimo = { ok: false, motivo: abortou ? 'a análise ultrapassou o tempo limite' : 'houve uma falha de conexão ao analisar o documento' };
      if (abortou) return ultimo;    // timeout de 90s: repetir só empilharia mais 90s de espera
    }
  }
  return ultimo; // esgotou as tentativas — devolve a última falha transitória com o motivo real
}

// A IA está ligada? (tem chave). Usado pelos fluxos pra decidir se mostram aviso de "resumo
// indisponível" (só quando a IA existe mas falhou) ou ficam em silêncio (IA desligada).
function iaLigada() {
  return !!config.geminiApiKey;
}

module.exports = { gerarResumoCartorio, despachoParaCanal, revisarTexto, analisarPdfEstruturado, iaLigada };
