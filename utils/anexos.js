// Modelo de dados `documento` (seção 1 da especificação) — todo PDF anexado por
// aguardarAnexoPDF vira um registro aqui, nunca só um link solto num embed. `protocoloVinculado`
// é o campo que resolve "isso tem que ir para os autos": bate com numero_processo (ex:
// "0001CV") ou com protocolo_inquerito (ex: "IP-2026-000007") enquanto o processo ainda não
// existe — ver dossiê de inquérito.
//
// Nome do arquivo é anexos.js (não documentos.js) de propósito: já existe utils/documentos.js
// nesse bot, mas é outra coisa — gera o TEXTO formal de peças (sentença, mandado, ofício), não
// registra anexo enviado por alguém. Evita confundir os dois.
const db = require('../database/db');
const config = require('../config');

// id de cada documento vem do autoincremento global do banco (db.inserir já garante único
// entre todas as tabelas) — não precisa de um gerador de id à parte.
//
// `canalId` + `mensagemId` são o que faz o documento sobreviver. A `url` do CDN do Discord é um
// link ASSINADO que expira em 24h: medido em produção em 18/08/2026, 29 dos 34 anexos gravados já
// retornavam HTTP 404, incluindo 11 provas em processos aguardando defesa. Ela fica gravada só
// como atalho de curta duração; o que os autos exibem é `linkMensagem()`.
function criarDocumento({ tipo, url, canalId = null, mensagemId = null, nomeArquivo, autorId, atoOrigemId = null, protocoloVinculado }) {
  return db.inserir('documentosAnexados', {
    tipo, url, canalId, mensagemId, nomeArquivo, autorId, atoOrigemId, protocoloVinculado,
    dataEnvio: new Date().toISOString(),
  });
}

// LINK QUE NÃO EXPIRA. Aponta para a MENSAGEM, não para o anexo: o Discord serve
// `/channels/<guild>/<canal>/<mensagem>` permanentemente, e o anexo está vivo lá dentro.
//
// Preferido a resolver o anexo via API na leitura, que também funcionaria mas custaria uma chamada
// por documento — um dossiê com onze provas viraria onze buscas. Aqui é zero chamada, zero cache.
// A permissão passa a ser a do próprio canal do Discord: quem não pode ver o canal já não deveria
// ver o documento.
//
// Documento antigo, gravado antes desta correção, não tem o par — devolve null, e quem exibe cai
// no rótulo sem link em vez de mostrar uma URL que dá 404.
function linkMensagem(documento) {
  if (!documento || !documento.canalId || !documento.mensagemId) return null;
  return `https://discord.com/channels/${config.guildId}/${documento.canalId}/${documento.mensagemId}`;
}

// Como o documento deve aparecer nos autos: link para a mensagem quando dá, ausência DECLARADA
// quando não dá. Nunca devolve a `url` do CDN — ela é o problema que esta função existe para evitar.
//
// O caso `arquivoNaoLocalizado` é o mais importante dos três: documento perdido não pode sumir em
// silêncio dos autos. O Juiz precisa VER que falta uma peça, em vez de julgar um dossiê que parece
// completo. Um item que some sem deixar rastro é pior que um item quebrado que se anuncia.
function rotuloComLink(documento, texto = null) {
  const nome = texto || documento.nomeArquivo || 'documento';
  if (documento.arquivoNaoLocalizado) return `⚠️ ${nome} — **arquivo não localizado**`;
  const link = linkMensagem(documento);
  return link ? `[${nome}](${link})` : `${nome} _(link indisponível — anexo anterior à correção)_`;
}

// Todo documento (indícios, cumprimentos, petição inicial, contestação...) cujo
// protocoloVinculado bate com o processo ou com o inquérito que o originou — é a consulta que
// alimenta os autos.
function listarPorProtocolo(protocolo) {
  return db.todos('documentosAnexados', d => d.protocoloVinculado === protocolo);
}

// Usado quando o dossiê de inquérito vira processo (ver utils/dossie.js): o documento que
// nasceu vinculado ao protocolo do inquérito passa a apontar pro número do processo, que é
// mais simples de consultar depois (autos do processo) do que manter as duas referências.
function atualizarProtocolo(documentoId, novoProtocolo) {
  return db.atualizarPorFiltro('documentosAnexados', d => d.id === documentoId, { protocoloVinculado: novoProtocolo });
}

module.exports = { criarDocumento, listarPorProtocolo, atualizarProtocolo, linkMensagem, rotuloComLink };
