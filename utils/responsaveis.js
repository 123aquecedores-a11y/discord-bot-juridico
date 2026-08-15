// Motor único de "responsável de ticket" — usado pela troca manual (Parte 2), pela reatribuição
// automática de fantasma (Parte 3, evento + varredura). Princípio: NÃO enumerar tipos com switch.
// A regra ("todo ticket com responsável marcado permite trocar esse responsável") vive num MAPA
// data-driven por tabela; tipo novo = uma linha aqui, zero código novo.
const db = require('../database/db');
const rh = require('./rh');
const canais = require('./canais');
const auditoria = require('./auditoria');
const documentoPng = require('../services/gerarDocumentoPNG');

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

module.exports = {
  TABELAS_TICKET, QUEM_TROCA,
  sortearParaPapel, responsaveisAtuais, aplicarTroca, reatribuirAutomatico, rotuloTabela,
};
