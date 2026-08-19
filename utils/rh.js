const db = require('../database/db');

const CARGOS = ['Delegado', 'Promotor', 'Juiz', 'Advogado', 'Desembargador', 'Procurador'];

// Cargos da magistratura/MP que (Fase 2) ganham leitura ampla de TODOS os tickets e (Fase 1)
// ficam sujeitos ao impedimento por ser parte. O impedimento casa o RG do operador contra o RG
// da parte (réu/investigado/alvo/autor/testemunha), então SÓ estes cargos precisam de RG
// cadastrado pra o impedimento ser verificável. Advogado e Delegado ficam de fora (não têm
// leitura ampla). Centralizado aqui pra Fase 1/Fase 2 reusarem a MESMA definição.
const CARGOS_MAGISTRATURA = ['Juiz', 'Promotor', 'Desembargador', 'Procurador'];

// Um cargo precisa de RG cadastrado pra o impedimento pegar? (fail-open: sem RG, o impedimento
// não é verificável pra essa pessoa — e isso tem que aparecer, nunca falhar em silêncio.)
function precisaRg(cargo) { return CARGOS_MAGISTRATURA.includes(cargo); }

function getCargo(discordId) {
  const registro = db.buscarUm('rh', r => r.discordId === discordId && r.ativo);
  return registro || null;
}

function temCargo(discordId, cargo) {
  const r = getCargo(discordId);
  return !!r && r.cargo === cargo;
}

// ---------------------------------------------------------------------------
// COBERTURA DE PAPEL — ponto único (19/08/2026)
// ---------------------------------------------------------------------------
// A CHEFIA COBRE A BASE: onde um Promotor atua, o Procurador também; onde um Juiz atua, o
// Desembargador também. Isso já valia na supervisão e passou a valer nos atos ordinários e no
// recebimento de peças.
//
// POR QUE ISTO EXISTE COMO FUNÇÃO: a regra estava escrita em TRÊS lugares, e um deles não sabia
// dela. `atosPorCargo.podeAtuar` e `pecas.ocupaDestinatario` aplicavam a cobertura; a varredura de
// responsáveis fantasma (responsaveis.motivoInvalidez) comparava o cargo EXATO. O resultado
// apareceu em produção: um Desembargador responsável por seis processos cíveis — que ele pode
// julgar sem problema — foi contado como "sem o cargo" nos seis de uma vez, e só não teve os casos
// redistribuídos porque a trava de segurança de 5 abortou a rodada.
//
// Regra copiada é regra que diverge. Aqui é UM lugar, e os três consultam.
const COBERTURA = {
  Juiz: ['Juiz', 'Desembargador'],
  Promotor: ['Promotor', 'Procurador'],
  Desembargador: ['Desembargador'],
  Procurador: ['Procurador'],
};

// Esta pessoa cobre `papel`? Para papel FORA do mapa (Advogado, Autor, Delegado, réu) a resposta é
// o cargo exato — partes e integrações não têm chefia que as substitua, e afrouxar isso seria
// exatamente o vazamento que a separação entre órgão e parte existe para impedir.
function cobreOPapel(discordId, papel) {
  if (!discordId || !papel) return false;
  const aceitos = COBERTURA[papel];
  if (!aceitos) return temCargo(discordId, papel);
  return aceitos.some(c => temCargo(discordId, c));
}

function contratar(discordId, cargo, nomePersonagem = null, rg = null) {
  // desativa cadastro anterior (se houver) e cria um novo
  const dados = db.buscarUm('rh', r => r.discordId === discordId && r.ativo);
  if (dados) db.atualizarPorFiltro('rh', r => r.discordId === discordId && r.ativo, { ativo: false });
  // nomePersonagem: guardado aqui pra alimentar a ficha funcional do judiciário (Parte 6) e
  // pra montar o apelido "Cargo Nome" no auto-atendimento de contratação (commands/rh.js).
  // rg/oab/oabDesde acompanham a pessoa entre trocas de cargo (ex.: promover Advogado→Juiz não
  // apaga a OAB dele), sempre preservando o que já existia quando o novo valor não é informado.
  return db.inserir('rh', {
    discordId, cargo, ativo: true, licenca: false,
    nomePersonagem: nomePersonagem || (dados && dados.nomePersonagem) || null,
    rg: rg || (dados && dados.rg) || null,
    oab: (dados && dados.oab) || null,
    oabDesde: (dados && dados.oabDesde) || null,
  });
}

// Atualiza campos do cadastro ATIVO da pessoa (nome/rg/oab/oabDesde). Usado pela emissão de
// carteirinha (grava a OAB gerada) e pela edição administrativa global (Gerenciar dados).
function atualizarDados(discordId, campos) {
  return db.atualizarPorFiltro('rh', r => r.discordId === discordId && r.ativo, campos);
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

// Magistrados/MP ATIVOS sem RG cadastrado — o impedimento (Fase 1) não é verificável pra eles até
// alguém preencher o RG (via "Gerenciar dados"). Fail-open VISÍVEL: essa lista é o que a Staff usa
// pra saber onde a trava ainda não pega. Não inventa RG — só aponta o buraco.
function magistradosSemRg() {
  return db.todos('rh', r => r.ativo && precisaRg(r.cargo) && !r.rg);
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

module.exports = { CARGOS, CARGOS_MAGISTRATURA, COBERTURA, precisaRg, getCargo, temCargo, cobreOPapel, contratar, atualizarDados, demitir, setLicenca, listarPorCargo, magistradosSemRg, sortearJuiz, sortearPorCargo };
