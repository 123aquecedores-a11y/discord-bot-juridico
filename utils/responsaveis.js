// Motor único de "responsável de ticket" — usado pela troca manual (Parte 2), pela reatribuição
// automática de fantasma (Parte 3, evento + varredura). Princípio: NÃO enumerar tipos com switch.
// A regra ("todo ticket com responsável marcado permite trocar esse responsável") vive num MAPA
// data-driven por tabela; tipo novo = uma linha aqui, zero código novo.
const db = require('../database/db');
const rh = require('./rh');
const canais = require('./canais');
const auditoria = require('./auditoria');
const documentoPng = require('../services/gerarDocumentoPNG');
const config = require('../config');

// Mapa data-driven: cada tabela declara o campo do canal, o predicado "aberto" e seus papéis
// (campo onde o responsável mora + como reiniciar o prazo em curso quando esse papel troca).
const TABELAS_TICKET = {
  processos: {
    canalCampo: 'canalId',
    aberto: (r) => !['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'].includes(r.status),
    papeis: {
      Juiz:     { campo: 'juiz',     resetPrazo: () => ({ juizDesde: new Date().toISOString() }) },
      Promotor: { campo: 'promotor', resetPrazo: () => ({}) },
      Delegado: { campo: 'delegado', resetPrazo: () => ({}) },
    },
  },
  medidas: {
    canalCampo: 'canalId',
    aberto: (r) => !['Deferida', 'Negada', 'Arquivada'].includes(r.status),
    papeis: {
      Juiz:     { campo: 'juiz',     resetPrazo: () => ({ aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false }) },
      Promotor: { campo: 'promotor', resetPrazo: () => ({}) },
      Delegado: { campo: 'delegado', resetPrazo: () => ({}) },
    },
  },
  peticoes: {
    canalCampo: 'canalId',
    aberto: (r) => !['Deferido', 'Indeferido', 'Vencido', 'Arquivada', 'Cancelada — prazo de vínculo expirado'].includes(r.status),
    papeis: {
      Juiz:     { campo: 'juiz',     resetPrazo: () => ({}) },
      // Troca de promotor reinicia as 24h do MP; a manifestação anterior PERMANECE (ato não se desfaz).
      Promotor: { campo: 'promotor', resetPrazo: () => ({ sorteioPromotorEm: new Date().toISOString() }) },
    },
  },
  apelacoes: {
    canalCampo: 'canalId',
    aberto: (r) => r.status === 'Aguardando decisão',
    papeis: {
      Desembargador: { campo: 'desembargadorId', resetPrazo: () => ({}) },
    },
  },
};

// Quem pode fazer a troca MANUAL de cada papel (Parte 2). Staff sempre pode (checado à parte).
// Desembargador só por Staff — não há instância acima dele; autotroca daria poder de última palavra
// a quem já é a última palavra. Regra-mãe: na dúvida sobre quem troca um papel, é Staff.
const QUEM_TROCA = {
  Juiz: ['Desembargador'],
  Promotor: ['Procurador'],
  Delegado: ['Desembargador', 'Procurador'],
  Desembargador: [], // Staff apenas
};

// Sorteio do substituto por papel (Juiz balanceia carga; os outros é sorteio simples).
function sortearParaPapel(papel, excluirIds) {
  if (papel === 'Juiz') return rh.sortearJuiz({ excluirIds });
  return rh.sortearPorCargo(papel, { excluirIds });
}

// IDs de todos os responsáveis atuais do ticket (pra excluir do sorteio — ninguém acumula 2 papéis).
function responsaveisAtuais(tabela, registro) {
  const cfg = TABELAS_TICKET[tabela];
  if (!cfg) return [];
  return Object.values(cfg.papeis).map(p => registro[p.campo]).filter(Boolean);
}

// Núcleo compartilhado: efetiva a troca de UM papel num ticket. Grava o campo + reinicia prazo,
// migra o acesso ao canal (novo entra, antigo sai), posta o andamento narrativo no ticket e
// registra a auditoria com o tipo do ticket explícito. Não decide QUEM entra — recebe novoId
// pronto (do sorteio automático OU da @menção da troca manual).
async function aplicarTroca(guild, { tabela, numero, papel, novoId, textoAndamento, acaoAuditoria, motivoAuditoria, executorId = null }) {
  const cfg = TABELAS_TICKET[tabela];
  const pcfg = cfg.papeis[papel];
  const registro = db.buscarPorNumero(tabela, numero);
  if (!registro) return { ok: false, razao: 'ticket não encontrado' };
  const antigoId = registro[pcfg.campo];

  db.atualizar(tabela, numero, { [pcfg.campo]: novoId, ...pcfg.resetPrazo() });

  const canal = registro[cfg.canalCampo] ? await guild.channels.fetch(registro[cfg.canalCampo]).catch(() => null) : null;
  if (canal) {
    await canais.adicionarMembro(canal, novoId);
    if (antigoId && antigoId !== novoId) await canal.permissionOverwrites.delete(antigoId).catch(() => {});
    if (textoAndamento) await canal.send({ content: textoAndamento });
  }
  await auditoria.registrar(guild, {
    acao: acaoAuditoria, executorId,
    referencia: `${rotuloTabela(tabela)} ${numero}: ${antigoId ? `<@${antigoId}>` : '—'} → <@${novoId}>`,
    motivo: motivoAuditoria,
  });
  return { ok: true, antigoId, novoId };
}

// Reatribuição AUTOMÁTICA (Parte 3) — sorteia o substituto e efetiva. motivoTipo entra no log e no
// andamento ("ausente do servidor" / "sem o cargo"), pra reatribuição nunca acontecer em silêncio.
async function reatribuirAutomatico(guild, { tabela, numero, papel, motivoTipo }) {
  const cfg = TABELAS_TICKET[tabela];
  const registro = db.buscarPorNumero(tabela, numero);
  if (!registro || !cfg || !cfg.papeis[papel]) return { ok: false, razao: 'papel/ticket inválido' };
  if (!cfg.aberto(registro)) return { ok: false, razao: 'ticket encerrado' }; // arquivado/encerrado: não mexe

  const antigoId = registro[cfg.papeis[papel].campo];
  const excluir = [...responsaveisAtuais(tabela, registro)].filter(Boolean); // exclui quem já atua (inclui o fantasma)
  const novoId = sortearParaPapel(papel, excluir);
  if (!novoId) return { ok: false, semSubstituto: true, antigoId, razao: 'sem substituto com o cargo' };

  const motivoTexto = motivoTipo === 'ausente' ? 'responsável ausente do servidor' : 'responsável sem o cargo';
  const [nomeAntigo, nomeNovo] = await Promise.all([
    documentoPng.nomeExibicao(guild, antigoId),
    documentoPng.nomeExibicao(guild, novoId),
  ]);
  const artigo = papel === 'Juiz' ? 'O(a) Juiz(a)' : `O(a) ${papel}`;
  const textoAndamento = `♻️ **Redistribuição automática** — ${artigo} ${nomeAntigo} deixou de integrar o quadro (${motivoTexto}); redistribuídos os autos a ${nomeNovo}. <@${novoId}> assume o caso.`;

  const r = await aplicarTroca(guild, {
    tabela, numero, papel, novoId, textoAndamento,
    acaoAuditoria: `Reatribuição automática de ${papel} (${motivoTexto})`,
    motivoAuditoria: motivoTexto, executorId: null,
  });
  return { ...r, papel, motivoTipo };
}

function rotuloTabela(tabela) {
  return { processos: 'Processo', medidas: 'Medida', peticoes: 'Petição', apelacoes: 'Apelação' }[tabela] || tabela;
}

// ---- Varredura de responsável fantasma (Parte 3, camada 2) ----
// Role do Discord por cargo — usada só na Passada A pra distinguir "perdeu o cargo (role removida)"
// de "ainda é do quadro". Se a role não estiver configurada (id nulo), a Passada A cai só na
// presença no servidor pra aquele cargo (não desativa por falta de role que o bot nem conhece).
const ROLE_POR_CARGO = {
  Juiz: config.roleJuizId, Promotor: config.rolePromotorId, Delegado: config.roleDelegadoId,
  Desembargador: config.roleDesembargadorId, Procurador: config.roleProcuradorId, Advogado: config.roleAdvogadoId,
};

// PASSADA A — reconcilia o `rh` com o Discord. Desativa todo registro ativo cujo dono saiu do
// servidor OU (se a role do cargo é conhecida) não tem mais a role. Roda ANTES da B: limpa a fila
// de sorteio, senão a B poderia re-sortear um fantasma pra cobrir outro. Retorna os órfãos achados.
async function limparRhFantasma(guild) {
  const orfaos = [];
  for (const reg of db.todos('rh', r => r.ativo)) {
    const membro = await guild.members.fetch(reg.discordId).catch(() => null);
    let motivo = null;
    if (!membro) motivo = 'ausente do servidor';
    else {
      const roleId = ROLE_POR_CARGO[reg.cargo];
      if (roleId && !membro.roles.cache.has(roleId)) motivo = 'sem a role do cargo';
    }
    if (!motivo) continue;
    rh.demitir(reg.discordId);
    orfaos.push({ discordId: reg.discordId, cargo: reg.cargo, motivo });
    await auditoria.registrar(guild, { acao: `RH: desativação automática (${motivo})`, executorId: null, referencia: `<@${reg.discordId}> (era ${reg.cargo})`, motivo });
  }
  return orfaos;
}

// PASSADA B — percorre os tickets ABERTOS; pra cada responsável marcado, é fantasma se saiu do
// servidor OU não tem mais o cargo (o rh já foi limpo na A, então rh.temCargo agora reflete a
// realidade). Reatribui; sem substituto, tira o fantasma (campo → null) e marca pendência — nunca
// deixa falsamente atribuído. Retorna os casos tratados.
// Núcleo compartilhado (varredura E evento): reatribui um papel fantasma de um ticket; sem
// substituto, tira o fantasma do campo e marca pendência — nunca deixa falsamente atribuído.
async function aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo) {
  const antigoId = reg[pcfg.campo];
  const r = await reatribuirAutomatico(guild, { tabela, numero: reg.numero, papel, motivoTipo });
  if (r.semSubstituto) {
    db.atualizar(tabela, reg.numero, { [pcfg.campo]: null, semResponsavelPendente: true });
    const canal = reg[cfg.canalCampo] ? await guild.channels.fetch(reg[cfg.canalCampo]).catch(() => null) : null;
    if (canal) await canal.send({ content: `⚠️ O(a) ${papel} deste caso saiu do quadro e **não há substituto disponível**. Caso marcado como pendência para a Supervisão — não ficou responsável fantasma.` });
  }
  return { tabela, numero: reg.numero, papel, antigoId, resultado: r.ok ? 'reatribuido' : (r.semSubstituto ? 'pendencia_sem_substituto' : 'falhou'), novoId: r.novoId || null };
}

async function reatribuirTicketsFantasma(guild) {
  const tratados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => cfg.aberto(r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        const id = reg[pcfg.campo];
        if (!id) continue;
        const membro = await guild.members.fetch(id).catch(() => null);
        if (membro && rh.temCargo(id, papel)) continue; // responsável válido — o rh já foi limpo na Passada A
        const motivoTipo = !membro ? 'ausente' : 'sem_cargo';
        tratados.push(await aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo));
      }
    }
  }
  return tratados;
}

// ---- Camada 1: evento (reação imediata) ----
// Uma pessoa específica ficou inválida como responsável (saiu do servidor / perdeu o cargo).
// Demite no rh (tira da fila de sorteio) e reatribui os tickets abertos onde ela é responsável.
// A varredura diária é a rede de segurança pro que o evento não pegar (bot offline na hora,
// casos pré-existentes). Idempotente: se o ticket já não a tem, nada acontece.
async function tratarResponsavelInvalido(guild, discordId, motivoTipo) {
  if (rh.getCargo(discordId)) {
    rh.demitir(discordId);
    await auditoria.registrar(guild, {
      acao: `RH: desativação automática (${motivoTipo === 'ausente' ? 'ausente do servidor' : 'sem o cargo'})`,
      executorId: null, referencia: `<@${discordId}>`,
    });
  }
  const tratados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => cfg.aberto(r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        if (reg[pcfg.campo] !== discordId) continue;
        tratados.push(await aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo));
      }
    }
  }
  return tratados;
}

// Pro guildMemberUpdate: retorna o cargo se o registro rh ativo do membro existe mas ele não tem
// mais a role correspondente (perdeu o cargo, continua no servidor). Senão null. Só age quando a
// role do cargo é conhecida (id configurado) — não demite por falta de role que o bot nem conhece.
function cargoSemRole(membro) {
  const reg = rh.getCargo(membro.id);
  if (!reg) return null;
  const roleId = ROLE_POR_CARGO[reg.cargo];
  return (roleId && !membro.roles.cache.has(roleId)) ? reg.cargo : null;
}

// Varredura completa: Passada A (limpa rh) → Passada B (conserta tickets). Loga os dois números —
// é o "relatório do primeiro run". Enganchada no job diário existente (sem cron novo).
async function varrerResponsaveisFantasma(guild) {
  const orfaosRh = await limparRhFantasma(guild);
  const tickets = await reatribuirTicketsFantasma(guild);
  console.log(`♻️ [fantasma] Varredura: ${orfaosRh.length} registro(s) rh órfão(s) desativado(s); ${tickets.length} ticket(s) com responsável fantasma tratado(s).`);
  if (orfaosRh.length) console.log(`   rh órfãos: ${orfaosRh.map(o => `${o.discordId}(${o.cargo}: ${o.motivo})`).join(', ')}`);
  if (tickets.length) console.log(`   tickets: ${tickets.map(t => `${t.numero}/${t.papel}→${t.resultado}`).join(', ')}`);
  return { orfaosRh, tickets };
}

module.exports = {
  TABELAS_TICKET, QUEM_TROCA,
  sortearParaPapel, responsaveisAtuais, aplicarTroca, reatribuirAutomatico, rotuloTabela,
  limparRhFantasma, reatribuirTicketsFantasma, varrerResponsaveisFantasma,
  tratarResponsavelInvalido, cargoSemRole,
};
