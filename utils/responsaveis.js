// Motor único de "responsável de ticket" — usado pela troca manual (Parte 2) e pela reatribuição
// automática de fantasma (Parte 3, evento + varredura). Princípio: NÃO enumerar tipos com switch.
// A regra vive num MAPA data-driven por tabela; tipo novo = uma linha aqui, zero código novo.
//
// Autoridade de cargo = a tabela `rh` (fonte da verdade do bot). A detecção de fantasma usa
// PRESENÇA no servidor (definitiva) + rh.temCargo — NÃO a role do Discord. Detectar por role dava
// falso positivo destrutivo (contratação cujo roles.add falha em silêncio, swap de cargo do próprio
// bot) — ver revisão adversarial. O "perdeu o cargo" é pego quando o rh reflete isso (/rh demitir).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
    // 'Indeferida pelo Juiz' é decisão terminal (simétrica a Deferida/Negada).
    aberto: (r) => !['Deferida', 'Negada', 'Indeferida pelo Juiz', 'Arquivada'].includes(r.status),
    papeis: {
      Juiz:     { campo: 'juiz',     resetPrazo: () => ({ aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false }) },
      Promotor: { campo: 'promotor', resetPrazo: () => ({ aguardandoMpDesde: new Date().toISOString(), lembreteMpEnviado: false, escalonamentoMpEnviado: false }) },
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

// "Aberto de verdade" = aberto por status E não arquivado manualmente. Arquivamento manual tranca o
// canal sem mudar o status jurídico; sem esse guard a varredura ressuscitaria um caso fechado.
function ticketAberto(cfg, reg) {
  return cfg.aberto(reg) && !reg.arquivadoManual;
}

// Quem pode fazer a troca MANUAL de cada papel (Parte 2). Staff sempre pode (checado à parte).
// Desembargador só por Staff — não há instância acima dele. Regra-mãe: na dúvida, é Staff.
const QUEM_TROCA = {
  Juiz: ['Desembargador'],
  Promotor: ['Procurador'],
  Delegado: ['Desembargador', 'Procurador'],
  Desembargador: [], // Staff apenas
};

// Presença no servidor de forma CONFIÁVEL: distingue "não é membro" (DiscordAPIError 10007) de uma
// falha transitória (rede/timeout). { presente:true } / { ausente:true } / { indeterminado:true }.
// Sem isso, um piscar de rede viraria demissão em massa indevida.
async function checarMembro(guild, id) {
  try {
    await guild.members.fetch(id);
    return { presente: true };
  } catch (e) {
    if (e && e.code === 10007) return { ausente: true };
    return { indeterminado: true };
  }
}

// É um responsável válido? 'valido' | 'ausente' | 'indeterminado'. Só olha PRESENÇA no servidor —
// NÃO checa rh.temCargo: nem todo responsável de ticket é um cargo do rh (a integração da Polícia
// Civil injeta o `delegado` por @menção crua, sem contratar no rh; ele é participante legítimo). Só
// reatribui quem SAIU do servidor (definitivo). Quem continua presente ainda consegue agir no caso
// (os gates de ação usam user.id, não o rh); tirá-lo à força expulsaria um responsável legítimo.
async function estadoResponsavel(guild, id) {
  const res = await checarMembro(guild, id);
  if (res.indeterminado) return 'indeterminado';
  if (res.ausente) return 'ausente';
  return 'valido';
}

// Sorteio do substituto por papel (Juiz balanceia carga; os outros é sorteio simples).
function sortearParaPapel(papel, excluirIds) {
  if (papel === 'Juiz') return rh.sortearJuiz({ excluirIds });
  return rh.sortearPorCargo(papel, { excluirIds });
}

// Sorteia um substituto e VALIDA que ele ainda está no servidor (o pool vem do rh, então o cargo já
// é garantido; só falta confirmar que não é um fantasma que saiu e o rh ainda não limpou). Se for
// ausente, demite no rh e re-sorteia excluindo-o — até achar um válido ou esgotar. Fecha o buraco
// "fantasma cobrindo fantasma" na camada de evento (que não roda a Passada A).
async function sortearSubstitutoValido(guild, papel, excluir) {
  const excluidos = [...excluir];
  for (let i = 0; i < 30; i++) {
    const cand = sortearParaPapel(papel, excluidos);
    if (!cand) return null;
    const res = await checarMembro(guild, cand);
    if (res.presente) return cand;
    if (res.indeterminado) { excluidos.push(cand); continue; } // não arrisca: tenta outro
    rh.demitir(cand); // ausente (saiu): reconcilia o rh e exclui
    excluidos.push(cand);
  }
  return null;
}

// IDs de todos os responsáveis atuais do ticket (pra excluir do sorteio — ninguém acumula 2 papéis).
function responsaveisAtuais(tabela, registro) {
  const cfg = TABELAS_TICKET[tabela];
  if (!cfg) return [];
  return Object.values(cfg.papeis).map(p => registro[p.campo]).filter(Boolean);
}

// O canal do ticket está na categoria de Arquivados? (pega arquivamentos manuais antigos, feitos
// antes da flag arquivadoManual existir — não ressuscita o que a Staff fechou de propósito.)
async function canalArquivado(guild, canalId) {
  if (!canalId || !config.categoriaArquivadosId) return false;
  const canal = await guild.channels.fetch(canalId).catch(() => null);
  return !!(canal && canal.parentId === config.categoriaArquivadosId);
}

// Núcleo compartilhado: efetiva a troca de UM papel num ticket. Grava o campo + reinicia prazo,
// migra o acesso ao canal (novo entra, antigo sai), posta o andamento narrativo e registra a
// auditoria. Recebe novoId pronto (do sorteio automático OU da @menção da troca manual).
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

// Reatribuição AUTOMÁTICA (Parte 3) — sorteia um substituto VÁLIDO e efetiva. Nunca em silêncio.
async function reatribuirAutomatico(guild, { tabela, numero, papel, motivoTipo }) {
  const cfg = TABELAS_TICKET[tabela];
  const registro = db.buscarPorNumero(tabela, numero);
  if (!registro || !cfg || !cfg.papeis[papel]) return { ok: false, razao: 'papel/ticket inválido' };
  if (!ticketAberto(cfg, registro)) return { ok: false, razao: 'ticket encerrado' };
  if (await canalArquivado(guild, registro[cfg.canalCampo])) return { ok: false, razao: 'canal arquivado' };

  const antigoId = registro[cfg.papeis[papel].campo];
  const excluir = [...responsaveisAtuais(tabela, registro)].filter(Boolean);
  const novoId = await sortearSubstitutoValido(guild, papel, excluir);
  if (!novoId) return { ok: false, semSubstituto: true, antigoId, razao: 'sem substituto válido' };

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

// Botão de designar à mão pra pendência (só Juiz em processo/petição tem designarjulgador hoje).
function componentesPendencia(tabela, numero, papel) {
  if (papel === 'Juiz' && (tabela === 'processos' || tabela === 'peticoes')) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:supervisao:designarjulgador:${numero}`).setLabel('Designar Juiz').setStyle(ButtonStyle.Primary),
    )];
  }
  return [];
}

// Núcleo compartilhado (varredura E evento): reatribui um papel fantasma; sem substituto, tira o
// fantasma do campo, marca pendência (papel em pendenciaPapeis pra a recuperação saber o que
// refazer), REVOGA o acesso do antigo e avisa com botão — nunca falsamente atribuído, nunca invisível.
async function aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo) {
  const antigoId = reg[pcfg.campo];
  const r = await reatribuirAutomatico(guild, { tabela, numero: reg.numero, papel, motivoTipo });
  if (r.semSubstituto) {
    const atual = db.buscarPorNumero(tabela, reg.numero) || reg;
    const pendentes = Array.from(new Set([...(atual.pendenciaPapeis || []), papel]));
    db.atualizar(tabela, reg.numero, { [pcfg.campo]: null, semResponsavelPendente: true, pendenciaPapeis: pendentes });
    const canal = reg[cfg.canalCampo] ? await guild.channels.fetch(reg[cfg.canalCampo]).catch(() => null) : null;
    if (canal) {
      if (antigoId) await canal.permissionOverwrites.delete(antigoId).catch(() => {});
      await canal.send({
        content: `⚠️ O(a) ${papel} deste caso saiu do quadro e **não há substituto disponível**. Marcado como pendência para a Supervisão — não ficou responsável fantasma.`,
        components: componentesPendencia(tabela, reg.numero, papel),
      });
    }
  }
  return { tabela, numero: reg.numero, papel, antigoId, resultado: r.ok ? 'reatribuido' : (r.semSubstituto ? 'pendencia_sem_substituto' : 'falhou'), novoId: r.novoId || null };
}

// PASSADA A — reconcilia o rh com o Discord: desativa todo registro ativo cujo dono saiu do servidor
// (10007). Roda ANTES da B (limpa a fila de sorteio). Falha transitória de fetch NÃO desativa ninguém.
async function limparRhFantasma(guild) {
  const orfaos = [];
  for (const reg of db.todos('rh', r => r.ativo)) {
    const res = await checarMembro(guild, reg.discordId);
    if (!res.ausente) continue; // presente ou indeterminado: mantém
    rh.demitir(reg.discordId);
    orfaos.push({ discordId: reg.discordId, cargo: reg.cargo, motivo: 'ausente do servidor' });
    await auditoria.registrar(guild, { acao: 'RH: desativação automática (ausente do servidor)', executorId: null, referencia: `<@${reg.discordId}> (era ${reg.cargo})`, motivo: 'ausente do servidor' });
  }
  return orfaos;
}

// PASSADA B — reatribui os tickets abertos com responsável fantasma (ausente OU !rh.temCargo, o rh já
// foi limpo na A). Falha transitória de fetch: não arrisca (não reatribui).
async function reatribuirTicketsFantasma(guild) {
  const tratados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => ticketAberto(cfg, r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        const id = reg[pcfg.campo];
        if (!id) continue;
        const estado = await estadoResponsavel(guild, id);
        if (estado !== 'ausente') continue; // só reatribui quem SAIU do servidor (presente = mantém)
        tratados.push(await aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, 'ausente'));
      }
    }
  }
  return tratados;
}

// Recuperação de pendências: refaz só os papéis pendentes (pendenciaPapeis) assim que surge
// substituto válido; limpa a marca. Sem isso um caso zerado ficaria invisível/parado pra sempre.
async function recuperarPendencias(guild) {
  const recuperados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => r.semResponsavelPendente && ticketAberto(cfg, r))) {
      if (await canalArquivado(guild, reg[cfg.canalCampo])) continue; // mesmo guard de reatribuirAutomatico: não ressuscita arquivado por categoria
      const pendentes = (reg.pendenciaPapeis || []).filter(papel => cfg.papeis[papel] && !reg[cfg.papeis[papel].campo]);
      const aindaPendentes = [];
      for (const papel of pendentes) {
        const excluir = responsaveisAtuais(tabela, reg).filter(Boolean);
        const novoId = await sortearSubstitutoValido(guild, papel, excluir);
        if (!novoId) { aindaPendentes.push(papel); continue; }
        await aplicarTroca(guild, {
          tabela, numero: reg.numero, papel, novoId,
          textoAndamento: `♻️ **Responsável designado** — surgiu ${papel} disponível; <@${novoId}> assume o caso, que estava sem responsável.`,
          acaoAuditoria: `Designação automática de ${papel} (pendência resolvida)`, motivoAuditoria: 'pendência resolvida', executorId: null,
        });
        reg[cfg.papeis[papel].campo] = novoId;
        recuperados.push({ tabela, numero: reg.numero, papel, novoId });
      }
      db.atualizar(tabela, reg.numero, aindaPendentes.length ? { pendenciaPapeis: aindaPendentes } : { pendenciaPapeis: [], semResponsavelPendente: false });
    }
  }
  return recuperados;
}

// ---- Camada 1: evento (reação imediata a quem SAIU do servidor) ----
// guildMemberRemove -> aqui. Demite no rh e reatribui os tickets abertos onde a pessoa é
// responsável. A varredura diária é a rede de segurança. Idempotente.
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
    for (const reg of db.todos(tabela).filter(r => ticketAberto(cfg, r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        if (reg[pcfg.campo] !== discordId) continue;
        tratados.push(await aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo));
      }
    }
  }
  return tratados;
}

// Varredura completa: Passada A (limpa rh) → Passada B (conserta tickets) → recuperação de
// pendências. Loga os números — é o "relatório do primeiro run". Sem cron novo.
async function varrerResponsaveisFantasma(guild) {
  const orfaosRh = await limparRhFantasma(guild);
  const tickets = await reatribuirTicketsFantasma(guild);
  const recuperados = await recuperarPendencias(guild);
  console.log(`♻️ [fantasma] Varredura: ${orfaosRh.length} registro(s) rh órfão(s) desativado(s); ${tickets.length} ticket(s) com responsável fantasma tratado(s); ${recuperados.length} pendência(s) recuperada(s).`);
  if (orfaosRh.length) console.log(`   rh órfãos: ${orfaosRh.map(o => `${o.discordId}(${o.cargo}: ${o.motivo})`).join(', ')}`);
  if (tickets.length) console.log(`   tickets: ${tickets.map(t => `${t.numero}/${t.papel}→${t.resultado}`).join(', ')}`);
  return { orfaosRh, tickets, recuperados };
}

module.exports = {
  TABELAS_TICKET, QUEM_TROCA, ticketAberto,
  checarMembro, estadoResponsavel, sortearParaPapel, sortearSubstitutoValido, canalArquivado,
  responsaveisAtuais, aplicarTroca, reatribuirAutomatico, rotuloTabela,
  limparRhFantasma, reatribuirTicketsFantasma, recuperarPendencias,
  varrerResponsaveisFantasma, tratarResponsavelInvalido,
};
