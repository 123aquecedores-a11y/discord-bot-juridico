// Registro central de cidadão ("ficha"), com RG como chave primária — é o RG que não muda,
// diferente do nome (pode trocar) e do Discord (a mesma pessoa pode logar com contas
// diferentes, ou nunca ter usado o bot antes de precisar de uma petição via advogado).
// Vai acumulando dado conforme o bot é usado: nome atual + histórico, endereços (pode ter
// mais de um) e todo ID de Discord já vinculado a esse RG.
const db = require('../database/db');

function normalizarRG(rg) {
  return (rg || '').trim();
}

function buscarPorRG(rg) {
  return db.buscarUm('fichas', f => f.rg === normalizarRG(rg));
}

function buscarPorDiscordId(discordId) {
  return db.buscarUm('fichas', f => (f.discordIds || []).includes(discordId));
}

function garantirFicha(rg) {
  const existente = buscarPorRG(rg);
  if (existente) return existente;
  return db.inserir('fichas', {
    rg: normalizarRG(rg), nomeCivil: null, historicoNomes: [], trocasDeNome: 0,
    discordIds: [], enderecos: [], telefones: [], redesSociais: [],
    criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
  });
}

// `origem` fica num array à parte (vinculosOrigem), não dentro de discordIds — discordIds
// continua um array plano de IDs (várias partes do bot já fazem .includes() nele), então isso
// não quebra nada existente, só adiciona rastreabilidade de por que/quando cada vínculo entrou.
function vincularDiscordId(rg, discordId, origem = 'Não especificada') {
  if (!discordId) return;
  const ficha = garantirFicha(rg);
  if (!(ficha.discordIds || []).includes(discordId)) {
    db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
      discordIds: [...(ficha.discordIds || []), discordId],
      vinculosOrigem: [...(ficha.vinculosOrigem || []), { discordId, origem, em: new Date().toISOString() }],
      atualizadoEm: new Date().toISOString(),
    });
  }
}

function enderecosDe(rg) {
  const ficha = buscarPorRG(rg);
  return ficha ? (ficha.enderecos || []) : [];
}

// Não duplica endereço igual (comparação simples, sem normalizar abreviação/acento) — só
// registra endereço novo de fato, mantendo o histórico completo em vez de sobrescrever.
function adicionarEndereco(rg, endereco, origem) {
  const ficha = garantirFicha(rg);
  const enderecos = ficha.enderecos || [];
  const jaExiste = enderecos.some(e => e.endereco.trim().toLowerCase() === endereco.trim().toLowerCase());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
      enderecos: [...enderecos, { endereco, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return { novo: !jaExiste, enderecosAnteriores: enderecos };
}

// Mesma lógica de endereço: não duplica, mantém histórico. Telefone e rede social são o que
// permite achar a pessoa mesmo sem saber RG nem tê-la visto no Discord — é a mesma ideia de
// um sistema de investigação de verdade, cruzando qualquer dado que já apareceu numa petição.
function adicionarTelefone(rg, telefone, origem) {
  const ficha = garantirFicha(rg);
  const telefones = ficha.telefones || [];
  const jaExiste = telefones.some(t => t.valor.trim() === telefone.trim());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
      telefones: [...telefones, { valor: telefone, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return !jaExiste;
}

function adicionarRedeSocial(rg, rede, origem) {
  const ficha = garantirFicha(rg);
  const redes = ficha.redesSociais || [];
  const jaExiste = redes.some(r => r.valor.trim().toLowerCase() === rede.trim().toLowerCase());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
      redesSociais: [...redes, { valor: rede, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return !jaExiste;
}

// Busca livre: acha a ficha por qualquer pedaço de nome (atual ou anterior), endereço,
// telefone ou rede social — não precisa saber o RG nem o Discord da pessoa. Pode retornar
// mais de uma ficha (nomes/ruas parecidos), por isso devolve lista, não um registro único.
function buscarPorTermo(termo) {
  const t = (termo || '').trim().toLowerCase();
  if (!t) return [];
  return db.todos('fichas', f => {
    if ((f.rg || '').toLowerCase().includes(t)) return true;
    if ((f.nomeCivil || '').toLowerCase().includes(t)) return true;
    if ((f.historicoNomes || []).some(h => h.nome.toLowerCase().includes(t))) return true;
    if ((f.enderecos || []).some(e => e.endereco.toLowerCase().includes(t))) return true;
    if ((f.telefones || []).some(tel => tel.valor.toLowerCase().includes(t))) return true;
    if ((f.redesSociais || []).some(r => r.valor.toLowerCase().includes(t))) return true;
    return false;
  });
}

function jaTrocouNomeAntes(rg) {
  const ficha = buscarPorRG(rg);
  return !!ficha && (ficha.trocasDeNome || 0) > 0;
}

// Só troca de nome (deferida) grava nomeCivil via registrarTrocaNome — mas porte de arma e
// limpeza de ficha também coletam o nome do cliente, e sem isso a ficha nunca tinha nome
// nenhum registrado até a pessoa pedir uma troca de nome. Isso só define se ainda estiver
// vazio — não sobrescreve um nome já oficializado por troca de nome com um nome não verificado
// vindo de outro tipo de petição.
function definirNomeSeVazio(rg, nome, origem = 'Não especificada') {
  if (!nome) return;
  const ficha = garantirFicha(rg);
  if (!ficha.nomeCivil) {
    db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
      nomeCivil: nome, nomeCivilOrigem: origem, atualizadoEm: new Date().toISOString(),
    });
  }
}

// Guarda o nome anterior no histórico antes de sobrescrever — não perde rastro de quem a
// pessoa já foi.
function registrarTrocaNome(rg, nomeNovo) {
  const ficha = garantirFicha(rg);
  const historico = ficha.nomeCivil
    ? [...(ficha.historicoNomes || []), { nome: ficha.nomeCivil, ate: new Date().toISOString() }]
    : (ficha.historicoNomes || []);
  return db.atualizarPorFiltro('fichas', f => f.rg === normalizarRG(rg), {
    nomeCivil: nomeNovo, historicoNomes: historico, trocasDeNome: (ficha.trocasDeNome || 0) + 1, atualizadoEm: new Date().toISOString(),
  });
}

function jaTeveLimpezaFichaDeferida(rg) {
  return db.todos('peticoes', p => p.tipo === 'LimpezaFicha' && p.rgCliente === normalizarRG(rg) && p.status === 'Deferido').length > 0;
}

// Todas as petições já protocoladas em nome desse RG, mais recente primeiro.
function peticoesDoRG(rg) {
  return db.todos('peticoes', p => p.rgCliente === normalizarRG(rg));
}

// Identidade da parte = nome + RG (Frente 7). Casa PRIMARIAMENTE por RG (reuRg/autorRg/partes[].rg
// dos processos e rgAlvo das medidas) e TAMBÉM pelas contas de Discord já vinculadas à ficha — assim
// uma pessoa com RG mas sem Discord ainda aparece cruzada. db.todos retorna cada registro uma vez.
function registrosRelacionados(registro) {
  const ids = registro?.discordIds || [];
  const rg = registro?.rg || null;
  const casaProcesso = p =>
    (ids.length && (ids.includes(p.autor) || ids.includes(p.autorDiscordId) || (p.reus || []).some(r => ids.includes(r)))) ||
    (rg && (p.reuRg === rg || p.autorRg === rg || (p.partes || []).some(x => x.rg === rg)));
  const casaMedida = m => (ids.length && ids.includes(m.alvoDiscordId)) || (rg && m.rgAlvo === rg);
  return { processos: db.todos('processos', casaProcesso), medidas: db.todos('medidas', casaMedida) };
}

// Chamado quando alguém entra no servidor (guildMemberAdd, index.js) — se essa conta já foi
// vinculada a uma ficha (por RG do cliente/réu que ainda não tinha Discord no momento do
// vínculo), aplica o apelido correspondente agora que a pessoa está de fato no servidor.
// Antes disso, o próprio vínculo já funcionava (permission overwrite não exige membresia),
// só o apelido dependia da pessoa já estar no servidor pra `setNickname` funcionar.
async function sincronizarNovoMembro(member) {
  const ficha = buscarPorDiscordId(member.id);
  if (!ficha || !ficha.nomeCivil) return null;
  return member.setNickname(ficha.nomeCivil.slice(0, 32)).then(() => true).catch(() => false);
}

module.exports = {
  buscarPorRG, buscarPorDiscordId, garantirFicha, vincularDiscordId,
  enderecosDe, adicionarEndereco, adicionarTelefone, adicionarRedeSocial, buscarPorTermo,
  jaTrocouNomeAntes, registrarTrocaNome, definirNomeSeVazio,
  jaTeveLimpezaFichaDeferida, peticoesDoRG, registrosRelacionados, sincronizarNovoMembro,
};
