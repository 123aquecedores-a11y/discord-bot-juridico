// Análise fiel e estruturada de documentos (spec_resumo_ia_documentos.md). Substitui o resumo raso
// em prosa por uma EXTRAÇÃO estruturada (JSON → embed híbrido), pra o cargo entender o caso antes de
// abrir o PDF. Motor genérico por `tipoDocumento`; por ora só o relatório de inquérito é implementado
// (§7 lista os próximos, com o mesmo motor). Princípios (§1): fidelidade absoluta, descreve mas não
// julga, lacuna = "Não consta", NÃO lê mídia, disclaimer fixo.
const { EmbedBuilder } = require('discord.js');
const cartorio = require('./cartorio');

// System prompt exato da spec (§4), adaptado só em "texto"→"documento" porque o PDF vai multimodal.
const SYSTEM_PROMPT = [
  'Você é o escrivão de um cartório judicial de um servidor de roleplay. Sua função é',
  'RESUMIR FIELMENTE um documento jurídico para que a autoridade responsável entenda',
  'rápido o caso ANTES de abrir o documento original. Você NÃO é juiz nem promotor e',
  'NÃO toma nenhuma decisão.',
  '',
  'REGRAS ABSOLUTAS:',
  '1. Use SOMENTE o que está escrito no documento fornecido. É proibido inventar, inferir,',
  '   supor ou completar informação que não esteja no documento.',
  '2. Descreva o que a autoridade afirma; NÃO julgue. Nunca diga se há "indícios',
  '   suficientes", se a prova é válida, se cabe denúncia, condenação ou arquivamento.',
  '   Use fórmulas como "o delegado aponta como prova…", "o delegado requer o',
  '   indiciamento por…".',
  '3. Se uma informação não estiver no documento, responda exatamente "Não consta no',
  '   relatório" (ou lista vazia, conforme o campo). Nunca preencha com suposição.',
  '4. Você NÃO tem acesso a vídeos, fotos ou áudios — eles são postados à parte. NUNCA',
  '   descreva o conteúdo de uma mídia. Se o documento mencionar uma mídia, apenas registre',
  '   que ele faz referência a ela.',
  '5. Não copie o documento inteiro; extraia e organize de forma objetiva e curta.',
  '',
  'Responda EXCLUSIVAMENTE com um JSON válido no formato especificado, sem comentários',
  'fora do JSON.',
].join('\n');

// Schema do relatório de inquérito (§3) — vai como instrução no user message.
const SCHEMA_RELATORIO = `{
  "capa_cartorio": "1–2 frases, tom de escrivania, SEM juízo de mérito. Ex.: 'Vieram os autos do Inquérito Policial nº X, com relatório final da autoridade policial e documentos anexos.'",
  "origem_investigacao": "Como/por que a investigação começou, conforme o relatório. 'Não consta no relatório' se ausente.",
  "diligencias_realizadas": ["Cada diligência que o relatório diz ter sido feita: oitivas, buscas, apreensões, perícias, quebras de sigilo etc. Só o que está escrito."],
  "provas_apontadas": ["Cada elemento que o DELEGADO aponta como prova, com a referência quando o documento indicar. NÃO avaliar se a prova é boa/suficiente."],
  "indiciados": [{ "nome": "Nome como consta", "identificacao": "RG/ID se constar, senão 'Não consta'", "crimes_requeridos": ["Tipificações pelas quais o DELEGADO requer o indiciamento, como escritas"] }],
  "pedido_final": "O que o delegado requer ao final (ex.: remessa dos autos ao MP, indiciamento, medidas). 'Não consta' se ausente.",
  "midias_referenciadas": ["Menções, no texto, a vídeos/fotos/áudios juntados no canal. SEM descrever o conteúdo da mídia."],
  "pontos_nao_constantes": ["APENAS fatos objetivos de ausência documental, sem juízo de mérito (ex.: 'não há laudo pericial juntado'). Lista vazia se não houver nada objetivo."]
}`;

// ---- helpers de render (Discord: field ≤1024, description ≤4096) ----
const LIMITE_CAMPO = 1000;
function campo(txt) {
  const s = (txt === null || txt === undefined) ? '' : String(txt);
  return s.length > LIMITE_CAMPO ? `${s.slice(0, LIMITE_CAMPO)}… (ver documento)` : s;
}
// Campo de string: vazio → "Não consta no relatório" (regra da §6). Nunca fica em branco.
function campoStr(txt) {
  const s = txt && String(txt).trim();
  return s ? campo(txt) : 'Não consta no relatório';
}
// Seção de lista: vazia → não renderiza nada (§6, evita "Não consta" repetido em bloco).
function addLista(embed, nome, arr) {
  const itens = (Array.isArray(arr) ? arr : []).map((x) => (x === null || x === undefined ? '' : String(x).trim())).filter(Boolean);
  if (!itens.length) return;
  embed.addFields({ name: nome, value: campo(itens.map((x) => `• ${x}`).join('\n')) });
}

// Cabeçalho comum do embed (título com o tipo + disclaimer + rodapé fixo, §6).
function embedBase(rotulo, capa) {
  return new EmbedBuilder()
    .setColor(0x4b6584)
    .setTitle(`📝 Despacho do Cartório${rotulo ? ` — ${rotulo}` : ''}`.slice(0, 256))
    .setDescription(`*(resumo automático da IA — apoio, não é decisão)*\n> ${capa || 'Vieram os autos para análise.'}`)
    .setFooter({ text: 'Fonte: documento original juntado aos autos. Este resumo não decide o mérito.' });
}

// Renderizador específico do relatório de inquérito (§3/§6). Defensivo: se a IA devolver um JSON
// levemente fora do formato, usa fallbacks e nunca lança.
function renderRelatorioInquerito(a) {
  const embed = embedBase('Relatório de inquérito', campo(a.capa_cartorio));
  embed.addFields({ name: '📌 Origem da investigação', value: campoStr(a.origem_investigacao) });
  addLista(embed, '🔎 Diligências realizadas', a.diligencias_realizadas);
  addLista(embed, '🧾 Provas apontadas pelo delegado', a.provas_apontadas);

  const indiciados = (Array.isArray(a.indiciados) ? a.indiciados : [])
    .map((i) => {
      const crimes = (Array.isArray(i.crimes_requeridos) ? i.crimes_requeridos : []).filter(Boolean).join(', ') || 'Não consta';
      return `• ${i.nome || 'Não consta'} (${i.identificacao || 'Não consta'}) — ${crimes}`;
    });
  if (indiciados.length) embed.addFields({ name: '⚖️ Indiciamento requerido', value: campo(indiciados.join('\n')) });

  embed.addFields({ name: '📨 Pedido final do delegado', value: campoStr(a.pedido_final) });
  addLista(embed, '🎥 Mídias referenciadas (juntadas no canal)', a.midias_referenciadas);
  addLista(embed, '⚠️ Pontos não constantes no documento', a.pontos_nao_constantes);
  return embed;
}

// Schema genérico — cobre qualquer documento jurídico (§7). Os mesmos 5 princípios da §1 valem.
const SCHEMA_GENERICO = `{
  "capa_cartorio": "1–2 frases, tom de escrivania, dizendo o que é o documento e de quem, SEM juízo de mérito.",
  "partes_envolvidas": ["Pessoas/órgãos citados e seu papel, como consta (ex.: 'Autor: Fulano', 'Órgão requisitado: Detran'). Lista vazia se não constar."],
  "objeto": "Do que trata o documento em 1–3 frases (o que se narra, comunica ou requisita). 'Não consta no relatório' se ausente.",
  "fatos_ou_fundamentos": ["Cada fato ou fundamento que o AUTOR do documento afirma, como escrito. NÃO julgue se procede."],
  "pedidos": ["Cada pedido, requerimento ou determinação ao final do documento, como escrito."],
  "documentos_mencionados": ["Documentos ou anexos que o texto diz juntar (ex.: 'procuração', 'comprovante de residência')."],
  "midias_referenciadas": ["Menções a vídeos/fotos/áudios juntados no canal. SEM descrever o conteúdo."],
  "pontos_nao_constantes": ["Apenas ausências factuais objetivas, sem juízo de mérito. Lista vazia se nada objetivo."]
}`;

// Renderizador genérico (§6) — usado por todos os tipos que não têm render próprio.
function renderGenerico(a, rotulo) {
  const embed = embedBase(rotulo, campo(a.capa_cartorio));
  addLista(embed, '👥 Partes / envolvidos', a.partes_envolvidas);
  embed.addFields({ name: '📄 Objeto do documento', value: campoStr(a.objeto) });
  addLista(embed, '🧾 Fatos e fundamentos alegados', a.fatos_ou_fundamentos);
  addLista(embed, '📨 Pedidos / requerimentos', a.pedidos);
  addLista(embed, '📎 Documentos mencionados', a.documentos_mencionados);
  addLista(embed, '🎥 Mídias referenciadas (juntadas no canal)', a.midias_referenciadas);
  addLista(embed, '⚠️ Pontos não constantes no documento', a.pontos_nao_constantes);
  return embed;
}

// Fábrica de tipo genérico: schema comum + render genérico com o rótulo do tipo.
const generico = (rotulo) => ({ rotulo, schema: SCHEMA_GENERICO, render: (a) => renderGenerico(a, rotulo) });

// Motor genérico por tipo (§7). O inquérito tem schema/render próprios (mais ricos); o resto usa o
// motor genérico. Cada `tipoDocumento` mapeia pra um dos 8 fluxos de anexo de PDF do bot.
const TIPOS = {
  relatorio_inquerito: { rotulo: 'Relatório de inquérito', schema: SCHEMA_RELATORIO, render: renderRelatorioInquerito },
  peticao_inicial: generico('Petição inicial'),
  contestacao: generico('Contestação'),
  resposta_oficio: generico('Resposta de ofício'),
  cumprimento_mandado: generico('Auto de cumprimento de mandado'),
  indicios_medida: generico('Peça de indícios (pedido de medida)'),
  peticao_avulsa: generico('Petição avulsa'),
  documento_peticao: generico('Documento juntado à petição'),
};

// Aviso VISÍVEL de que o resumo automático não saiu (Frente 5.3). O fallback NUNCA é mudo: o cargo
// vê o porquê e que isso não afeta o documento juntado. Cor âmbar pra destacar de um despacho
// normal (azulado). Mesmo formato de título, pra ficar no lugar esperado do despacho.
function embedIndisponivel(rotulo, motivo) {
  const m = String(motivo || 'não foi possível analisar o documento');
  const motivoFmt = m.charAt(0).toUpperCase() + m.slice(1);
  return new EmbedBuilder()
    .setColor(0xd35400)
    .setTitle(`📝 Despacho do Cartório${rotulo ? ` — ${rotulo}` : ''}`.slice(0, 256))
    .setDescription(`⚠️ **Resumo automático indisponível.**\n${motivoFmt}.\n\nO documento original foi juntado aos autos normalmente e deve ser lido na íntegra — a ausência do resumo não afeta sua validade.`)
    .setFooter({ text: 'Resumo automático (IA) — apoio, não é decisão. Indisponível neste documento.' });
}

// Retorna SEMPRE um EmbedBuilder pra tipos suportados (Frente 5.3): a análise fiel, ou um aviso
// visível de indisponibilidade com o MOTIVO REAL (não configurada / quota / timeout / erro / render).
// A engine (analisarPdfEstruturado) devolve `{ ok, dados|motivo }` e a gente só traduz em embed. Só
// retorna null pra tipo não mapeado (erro de chamada — não ocorre nos fluxos atuais).
async function gerarAnaliseEmbed({ tipoDocumento, pdfUrl }) {
  const cfg = TIPOS[tipoDocumento];
  if (!cfg) return null;
  let resultado;
  try {
    resultado = await cartorio.analisarPdfEstruturado(pdfUrl, { systemPrompt: SYSTEM_PROMPT, schemaTexto: cfg.schema, rotuloTipo: cfg.rotulo });
  } catch (e) {
    console.error('[analiseDocumento] análise falhou:', e.message);
    resultado = { ok: false, motivo: 'houve uma falha inesperada ao analisar o documento' };
  }
  if (!resultado || !resultado.ok || typeof resultado.dados !== 'object') {
    return embedIndisponivel(cfg.rotulo, resultado?.motivo || 'não foi possível analisar o documento');
  }
  try {
    return cfg.render(resultado.dados);
  } catch (e) {
    console.error('[analiseDocumento] render falhou:', e.message);
    return embedIndisponivel(cfg.rotulo, 'o documento foi lido, mas o resumo não pôde ser montado');
  }
}

module.exports = { gerarAnaliseEmbed, embedIndisponivel, TIPOS_SUPORTADOS: Object.keys(TIPOS) };
