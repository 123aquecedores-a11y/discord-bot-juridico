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

// id de cada documento vem do autoincremento global do banco (db.inserir já garante único
// entre todas as tabelas) — não precisa de um gerador de id à parte.
function criarDocumento({ tipo, url, nomeArquivo, autorId, atoOrigemId = null, protocoloVinculado }) {
  return db.inserir('documentosAnexados', {
    tipo, url, nomeArquivo, autorId, atoOrigemId, protocoloVinculado,
    dataEnvio: new Date().toISOString(),
  });
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

module.exports = { criarDocumento, listarPorProtocolo, atualizarProtocolo };
