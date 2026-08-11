const db = require('../database/db');

const CARGOS = ['Delegado', 'Promotor', 'Juiz', 'Advogado', 'Desembargador', 'Procurador'];

function getCargo(discordId) {
  const registro = db.buscarUm('rh', r => r.discordId === discordId && r.ativo);
  return registro || null;
}

function temCargo(discordId, cargo) {
  const r = getCargo(discordId);
  return !!r && r.cargo === cargo;
}

function contratar(discordId, cargo, nomePersonagem = null) {
  // desativa cadastro anterior (se houver) e cria um novo
  const dados = db.buscarUm('rh', r => r.discordId === discordId && r.ativo);
  if (dados) db.atualizarPorFiltro('rh', r => r.discordId === discordId && r.ativo, { ativo: false });
  // nomePersonagem: guardado aqui pra alimentar a ficha funcional do judiciário (Parte 6) e
  // pra montar o apelido "Cargo Nome" no auto-atendimento de contratação (commands/rh.js).
  return db.inserir('rh', { discordId, cargo, ativo: true, licenca: false, nomePersonagem: nomePersonagem || (dados && dados.nomePersonagem) || null });
}

function demitir(discordId) {
  return db.atualizarPorFiltro('rh', r => r.discordId === discordId && r.ativo, { ativo: false });
}

function setLicenca(discordId, emLicenca) {
  return db.atualizarPorFiltro('rh', r => r.discordId === discordId && r.ativo, { licenca: emLicenca });
}

function listarPorCargo(cargo) {
  return db.todos('rh', r => r.cargo === cargo && r.ativo);
}

// Sorteia um juiz: ativo, sem licença, priorizando quem tem menos processos/medidas abertos,
// excluindo impedidos (já atuaram nesse caso como delegado/promotor/advogado)
function sortearJuiz({ excluirIds = [] } = {}) {
  const juizes = listarPorCargo('Juiz').filter(j => !j.licenca && !excluirIds.includes(j.discordId));
  if (juizes.length === 0) return null;

  const processos = db.todos('processos');
  const medidas = db.todos('medidas');
  const cargaPorJuiz = juizes.map(j => {
    const abertos = [...processos, ...medidas].filter(
      p => p.juiz === j.discordId && !['Encerrado', 'Arquivado', 'Deferida', 'Negada'].includes(p.status)
    ).length;
    return { juiz: j, carga: abertos };
  });

  cargaPorJuiz.sort((a, b) => a.carga - b.carga);
  const menorCarga = cargaPorJuiz[0].carga;
  const empatados = cargaPorJuiz.filter(c => c.carga === menorCarga);
  const escolhido = empatados[Math.floor(Math.random() * empatados.length)];
  return escolhido.juiz.discordId;
}

// Sorteio simples (sem balanceamento de carga) — usado pra Promotor, Desembargador, Procurador.
function sortearPorCargo(cargo, { excluirIds = [] } = {}) {
  const ativos = listarPorCargo(cargo).filter(p => !p.licenca && !excluirIds.includes(p.discordId));
  if (ativos.length === 0) return null;
  return ativos[Math.floor(Math.random() * ativos.length)].discordId;
}

module.exports = { CARGOS, getCargo, temCargo, contratar, demitir, setLicenca, listarPorCargo, sortearJuiz, sortearPorCargo };
