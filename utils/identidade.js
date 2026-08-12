// Registro de nome civil por ID do Discord — é o que garante que troca de nome fique
// vinculada à pessoa (o ID nunca muda, mesmo que o nome mude), não só um texto solto.
const db = require('../database/db');

function obterNomeCivil(discordId) {
  const registro = db.buscarUm('identidades', r => r.discordId === discordId);
  return registro ? registro.nomeCivil : null;
}

function definirNomeCivil(discordId, nomeCivil) {
  const existente = db.buscarUm('identidades', r => r.discordId === discordId);
  if (existente) {
    return db.atualizarPorFiltro('identidades', r => r.discordId === discordId, { nomeCivil, atualizadoEm: new Date().toISOString() });
  }
  return db.inserir('identidades', { discordId, nomeCivil, atualizadoEm: new Date().toISOString() });
}

// Troca de nome é rastreada por RG, não por ID do Discord — o cliente é quem muda de nome
// (o advogado só protocola em nome dele), e o mesmo RG pode ser representado por
// advogados diferentes em petições diferentes ao longo do tempo.
function buscarPorRG(rg) {
  return db.buscarUm('identidades', r => r.rg === rg);
}

function jaTrocouNomeAntes(rg) {
  const registro = buscarPorRG(rg);
  return !!registro && (registro.trocasDeNome || 0) > 0;
}

function registrarTrocaNomePorRG(rg, nomeNovo) {
  const existente = buscarPorRG(rg);
  if (existente) {
    return db.atualizarPorFiltro('identidades', r => r.rg === rg, {
      nomeCivil: nomeNovo, trocasDeNome: (existente.trocasDeNome || 0) + 1, atualizadoEm: new Date().toISOString(),
    });
  }
  return db.inserir('identidades', { rg, nomeCivil: nomeNovo, trocasDeNome: 1, atualizadoEm: new Date().toISOString() });
}

module.exports = { obterNomeCivil, definirNomeCivil, buscarPorRG, jaTrocouNomeAntes, registrarTrocaNomePorRG };
