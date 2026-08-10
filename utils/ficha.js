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
    discordIds: [], enderecos: [], telefones: [], redesSociais: [],
    criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
  });
}

// `origem` fica num array à parte (vinculosOrigem), não dentro de discordIds — discordIds
// continua um array plano de IDs (várias partes do bot já fazem .includes() nele), então isso
// não quebra nada existente, só adiciona rastreabilidade de por que/quando cada vínculo entrou.
function vincularDiscordId(cpf, discordId, origem = 'Não especificada') {
  if (!discordId) return;
  const ficha = garantirFicha(cpf);
  if (!(ficha.discordIds || []).includes(discordId)) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      discordIds: [...(ficha.discordIds || []), discordId],
      vinculosOrigem: [...(ficha.vinculosOrigem || []), { discordId, origem, em: new Date().toISOString() }],
      atualizadoEm: new Date().toISOString(),
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

// Mesma lógica de endereço: não duplica, mantém histórico. Telefone e rede social são o que
// permite achar a pessoa mesmo sem saber CPF nem tê-la visto no Discord — é a mesma ideia de
// um sistema de investigação de verdade, cruzando qualquer dado que já apareceu numa petição.
function adicionarTelefone(cpf, telefone, origem) {
  const ficha = garantirFicha(cpf);
  const telefones = ficha.telefones || [];
  const jaExiste = telefones.some(t => t.valor.trim() === telefone.trim());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      telefones: [...telefones, { valor: telefone, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return !jaExiste;
}

function adicionarRedeSocial(cpf, rede, origem) {
  const ficha = garantirFicha(cpf);
  const redes = ficha.redesSociais || [];
  const jaExiste = redes.some(r => r.valor.trim().toLowerCase() === rede.trim().toLowerCase());
  if (!jaExiste) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      redesSociais: [...redes, { valor: rede, adicionadoEm: new Date().toISOString(), origem }],
      atualizadoEm: new Date().toISOString(),
    });
  }
  return !jaExiste;
}

// Busca livre: acha a ficha por qualquer pedaço de nome (atual ou anterior), endereço,
// telefone ou rede social — não precisa saber o CPF nem o Discord da pessoa. Pode retornar
// mais de uma ficha (nomes/ruas parecidos), por isso devolve lista, não um registro único.
function buscarPorTermo(termo) {
  const t = (termo || '').trim().toLowerCase();
  if (!t) return [];
  return db.todos('fichas', f => {
    if ((f.cpf || '').toLowerCase().includes(t)) return true;
    if ((f.nomeCivil || '').toLowerCase().includes(t)) return true;
    if ((f.historicoNomes || []).some(h => h.nome.toLowerCase().includes(t))) return true;
    if ((f.enderecos || []).some(e => e.endereco.toLowerCase().includes(t))) return true;
    if ((f.telefones || []).some(tel => tel.valor.toLowerCase().includes(t))) return true;
    if ((f.redesSociais || []).some(r => r.valor.toLowerCase().includes(t))) return true;
    return false;
  });
}

function jaTrocouNomeAntes(cpf) {
  const ficha = buscarPorCPF(cpf);
  return !!ficha && (ficha.trocasDeNome || 0) > 0;
}

// Só troca de nome (deferida) grava nomeCivil via registrarTrocaNome — mas porte de arma e
// limpeza de ficha também coletam o nome do cliente, e sem isso a ficha nunca tinha nome
// nenhum registrado até a pessoa pedir uma troca de nome. Isso só define se ainda estiver
// vazio — não sobrescreve um nome já oficializado por troca de nome com um nome não verificado
// vindo de outro tipo de petição.
function definirNomeSeVazio(cpf, nome, origem = 'Não especificada') {
  if (!nome) return;
  const ficha = garantirFicha(cpf);
  if (!ficha.nomeCivil) {
    db.atualizarPorFiltro('fichas', f => f.cpf === normalizarCPF(cpf), {
      nomeCivil: nome, nomeCivilOrigem: origem, atualizadoEm: new Date().toISOString(),
    });
  }
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

// Processo/medida não coletam CPF (só petição coleta) — por isso o cruzamento aqui é pelos
// IDs de Discord já vinculados à ficha, não pelo CPF. Pega tanto quem já foi réu/autor num
// processo quanto quem já foi alvo de uma medida provisória.
function registrosRelacionados(registro) {
  const ids = registro?.discordIds || [];
  if (ids.length === 0) return { processos: [], medidas: [] };
  const processos = db.todos('processos', p => ids.includes(p.autor) || (p.reus || []).some(r => ids.includes(r)));
  const medidas = db.todos('medidas', m => ids.includes(m.alvoDiscordId));
  return { processos, medidas };
}

// Chamado quando alguém entra no servidor (guildMemberAdd, index.js) — se essa conta já foi
// vinculada a uma ficha (por CPF do cliente/réu que ainda não tinha Discord no momento do
// vínculo), aplica o apelido correspondente agora que a pessoa está de fato no servidor.
// Antes disso, o próprio vínculo já funcionava (permission overwrite não exige membresia),
// só o apelido dependia da pessoa já estar no servidor pra `setNickname` funcionar.
async function sincronizarNovoMembro(member) {
  const ficha = buscarPorDiscordId(member.id);
  if (!ficha || !ficha.nomeCivil) return null;
  return member.setNickname(ficha.nomeCivil.slice(0, 32)).then(() => true).catch(() => false);
}

module.exports = {
  buscarPorCPF, buscarPorDiscordId, garantirFicha, vincularDiscordId,
  enderecosDe, adicionarEndereco, adicionarTelefone, adicionarRedeSocial, buscarPorTermo,
  jaTrocouNomeAntes, registrarTrocaNome, definirNomeSeVazio,
  jaTeveLimpezaFichaDeferida, peticoesDoCPF, registrosRelacionados, sincronizarNovoMembro,
};
