// Dossiê do inquérito (seção 4 da especificação) — vincula todas as medidas, mandados e
// documentos pedidos sob um mesmo inquérito da Polícia Civil, independente de qual Juiz/Promotor
// foi sorteado pra cada pedido individual.
//
// `protocoloInquerito` é o mesmo campo que o bot já chama de `medida.codigoExterno` (extraído
// do campo "Código/Protocolo" do embed da Polícia Civil, ver utils/integracaoPoliciaCivil.js) —
// não é um campo novo, é o nome que a especificação usa pra esse conceito que já existe aqui.
const db = require('../database/db');
const anexos = require('./anexos');

function obterDossie(protocoloInquerito) {
  return db.buscarUm('dossiesInquerito', d => d.protocoloInquerito === protocoloInquerito);
}

function obterOuCriarDossie(protocoloInquerito) {
  return obterDossie(protocoloInquerito) || db.inserir('dossiesInquerito', {
    protocoloInquerito, medidas: [], mandados: [], documentos: [], processoVinculado: null,
  });
}

function atualizarDossie(protocoloInquerito, campos) {
  return db.atualizarPorFiltro('dossiesInquerito', d => d.protocoloInquerito === protocoloInquerito, campos);
}

function registrarMedida(protocoloInquerito, numeroMedida) {
  const dossie = obterOuCriarDossie(protocoloInquerito);
  if (dossie.medidas.includes(numeroMedida)) return dossie;
  return atualizarDossie(protocoloInquerito, { medidas: [...dossie.medidas, numeroMedida] });
}

function registrarMandado(protocoloInquerito, numeroMandado) {
  const dossie = obterOuCriarDossie(protocoloInquerito);
  if (dossie.mandados.includes(numeroMandado)) return dossie;
  return atualizarDossie(protocoloInquerito, { mandados: [...dossie.mandados, numeroMandado] });
}

function registrarDocumento(protocoloInquerito, documentoId) {
  const dossie = obterOuCriarDossie(protocoloInquerito);
  if (dossie.documentos.includes(documentoId)) return dossie;
  return atualizarDossie(protocoloInquerito, { documentos: [...dossie.documentos, documentoId] });
}

// Chamado quando a denúncia é oferecida e o processo penal nasce a partir da medida — copia a
// vinculação de cada documento do dossiê pro número do processo (mais simples de consultar
// depois que manter as duas referências) e grava processoVinculado pra referência futura.
function vincularProcesso(protocoloInquerito, numeroProcesso) {
  const dossie = obterOuCriarDossie(protocoloInquerito);
  for (const documentoId of dossie.documentos) {
    anexos.atualizarProtocolo(documentoId, numeroProcesso);
  }
  return atualizarDossie(protocoloInquerito, { processoVinculado: numeroProcesso });
}

module.exports = { obterDossie, obterOuCriarDossie, registrarMedida, registrarMandado, registrarDocumento, vincularProcesso };
