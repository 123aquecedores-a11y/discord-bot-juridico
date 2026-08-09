// Registro central de cidadão ("ficha"), com CPF como chave primária — é o CPF que não muda,
// diferente do nome (pode trocar) e do Discord (a mesma pessoa pode logar com contas
// diferentes, ou nunca ter usado o bot antes de precisar de uma petição via advogado).
// Vai acumulando dado conforme o bot é usado: nome atual + histórico, endereços (pode ter
// mais de um) e todo ID de Discord já vinculado a esse CPF.
const db = require('../database/db');

function normalizarCPF(cpf) {
  return (cpf || '').trim();
}

function buscarPorCPF(cpf) {
  return db.buscarUm('fichas', f => f.cpf === normalizarCPF(cpf));
}

function buscarPorDiscordId(discordId) {
  return db.buscarUm('fichas', f => (f.discordIds || []).includes(discordId));
}

function garantirFicha(cpf) {
  const existente = buscarPorCPF(cpf);
  if (existente) return existente;
  return db.inserir('fichas', {
    cpf: normalizarCPF(cpf), nomeCivil: null, historicoNomes: [], trocasDeNome: 0,
    discordIds: [], enderecos: [], criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
  });
}

function vincularDiscordId(cpf, discordId) {
  if (!discordId) return;
  const ficha = garantirFicha(cpf);
  if (!(ficha.discordIds || []).includes(discordId)) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      discordIds: [...(ficha.discordIds || []), discordId], atualizadoEm: new Date().toISOString(),
    });
  }
}

function enderecosDe(cpf) {
  const ficha = buscarPorCPF(cpf);
  return ficha ? (ficha.enderecos || []) : [];
}

// Não duplica endereço igual (comparação simples, sem normalizar abreviação/acento) — só
// registra endereço novo de fato, mantendo o histórico completo em vez de sobrescrever.
function adicionarEndereco(cpf, endereco, origem) {
  const ficha = garantirFicha(cpf);
  const enderecos = ficha.enderecos || [];
  const jaExiste = enderecos.some(e => e.endereco.trim().toLowerCase() === endereco.trim().toLowerCase());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      enderecos: [...enderecos, { endereco, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return { novo: !jaExiste, enderecosAnteriores: enderecos };
}

function jaTrocouNomeAntes(cpf) {
  const ficha = buscarPorCPF(cpf);
  return !!ficha && (ficha.trocasDeNome || 0) > 0;
}

// Guarda o nome anterior no histórico antes de sobrescrever — não perde rastro de quem a
// pessoa já foi.
function registrarTrocaNome(cpf, nomeNovo) {
  const ficha = garantirFicha(cpf);
  const historico = ficha.nomeCivil
    ? [...(ficha.historicoNomes || []), { nome: ficha.nomeCivil, ate: new Date().toISOString() }]
    : (ficha.historicoNomes || []);
  return db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
    nomeCivil: nomeNovo, historicoNomes: historico, trocasDeNome: (ficha.trocasDeNome || 0) + 1, atualizadoEm: new Date().toISOString(),
  });
}

function jaTeveLimpezaFichaDeferida(cpf) {
  return db.todos('peticoes', p => p.tipo === 'LimpezaFicha' && p.cpfCliente === normalizarCPF(cpf) && p.status === 'Deferido').length > 0;
}

// Todas as petições já protocoladas em nome desse CPF, mais recente primeiro.
function peticoesDoCPF(cpf) {
  return db.todos('peticoes', p => p.cpfCliente === normalizarCPF(cpf));
}

module.exports = {
  buscarPorCPF, buscarPorDiscordId, garantirFicha, vincularDiscordId,
  enderecosDe, adicionarEndereco, jaTrocouNomeAntes, registrarTrocaNome,
  jaTeveLimpezaFichaDeferida, peticoesDoCPF,
};
