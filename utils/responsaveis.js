// Motor único de "responsável de ticket" — usado pela troca manual (Parte 2), pela reatribuição
// automática de fantasma (Parte 3, evento + varredura). Princípio: NÃO enumerar tipos com switch.
// A regra ("todo ticket com responsável marcado permite trocar esse responsável") vive num MAPA
// data-driven por tabela; tipo novo = uma linha aqui, zero código novo.
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
    // 'Indeferida pelo Juiz' é decisão terminal (simétrica a Deferida/Negada) — não pode ser tratada
    // como aberta (senão a varredura reatribui responsável numa medida já decidida).
    aberto: (r) => !['Deferida', 'Negada', 'Indeferida pelo Juiz', 'Arquivada'].includes(r.status),
    papeis: {
      Juiz:     { campo: 'juiz',     resetPrazo: () => ({ aguardandoJuizDesde: new Date().toISOString(), lembreteJuizEnviado: false, escalonamentoJuizEnviado: false }) },
      // Troca de Promotor numa medida em "Aguardando MP" reinicia o relógio das 24h do MP (espelha o Juiz).
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

// "Aberto de verdade" = aberto por status E não arquivado manualmente. O arquivamento manual
// (painel: arquivarManual) tranca o canal sem mudar o status jurídico; sem esse guard, a varredura
// ressuscitaria um caso que a Staff fechou de propósito. arquivadoManual é gravado no momento do
// arquivamento, então vale também pros tickets antigos.
function ticketAberto(cfg, reg) {
  return cfg.aberto(reg) && !reg.arquivadoManual;
}

// Quem pode fazer a troca MANUAL de cada papel (Parte 2). Staff sempre pode (checado à parte).
// Desembargador só por Staff — não há instância acima dele; autotroca daria poder de última palavra
// a quem já é a última palavra. Regra-mãe: na dúvida sobre quem troca um papel, é Staff.
const QUEM_TROCA = {
  Juiz: ['Desembargador'],
  Promotor: ['Procurador'],
  Delegado: ['Desembargador', 'Procurador'],
  Desembargador: [], // Staff apenas
};

// Role do Discord por cargo — pra distinguir "perdeu o cargo (role removida)" de "ainda é do quadro".
// Se a role não estiver configurada (id nulo), cai só na presença no servidor pra aquele cargo.
const ROLE_POR_CARGO = {
  Juiz: config.roleJuizId, Promotor: config.rolePromotorId, Delegado: config.roleDelegadoId,
  Desembargador: config.roleDesembargadorId, Procurador: config.roleProcuradorId, Advogado: config.roleAdvogadoId,
};

// Presença no servidor de forma CONFIÁVEL: distingue "não é membro" (DiscordAPIError 10007) de uma
// falha transitória (rede/timeout). Retorna { membro } se presente, { ausente:true } se 10007, e
// { indeterminado:true } em qualquer outra falha — nesse caso NÃO se conclui ausência (não demite,
// não reatribui). Sem isso, um piscar de rede viraria demissão/reatribuição em massa indevida.
async function checarMembro(guild, id) {
  try {
    return { membro: await guild.members.fetch(id) };
  } catch (e) {
    if (e && e.code === 10007) return { ausente: true };
    return { indeterminado: true };
  }
}

// É um responsável VÁLIDO daquele papel? Presente no servidor e (quando a role é conhecida) com a
// role. Retorna 'valido' | 'ausente' | 'sem_cargo' | 'indeterminado'.
async function estadoResponsavel(guild, id, papel) {
  const res = await checarMembro(guild, id);
  if (res.indeterminado) return 'indeterminado';
  if (res.ausente) return 'ausente';
  const roleId = ROLE_POR_CARGO[papel];
  if (roleId && !res.membro.roles.cache.has(roleId)) return 'sem_cargo';
  return 'valido';
}

// Sorteio do substituto por papel (Juiz balanceia carga; os outros é sorteio simples).
function sortearParaPapel(papel, excluirIds) {
  if (papel === 'Juiz') return rh.sortearJuiz({ excluirIds });
  return rh.sortearPorCargo(papel, { excluirIds });
}

// Sorteia um substituto e VALIDA que ele é responsável válido DE VERDADE (presente + com a role).
// Se o sorteado for outro fantasma (que a Passada A ainda não pegou), demite-o no rh e re-sorteia
// excluindo-o — até achar um válido ou esgotar o pool. Fecha o buraco "fantasma cobrindo fantasma"
// na camada de evento (que não tem a reconciliação da Passada A) e em qualquer caller futuro.
async function sortearSubstitutoValido(guild, papel, excluir) {
  const excluidos = [...excluir];
  for (let i = 0; i < 30; i++) { // limite de segurança contra loop
    const cand = sortearParaPapel(papel, excluidos);
    if (!cand) return null;
    const estado = await estadoResponsavel(guild, cand, papel);
    if (estado === 'valido') return cand;
    if (estado === 'indeterminado') { excluidos.push(cand); continue; } // não arrisca: tenta outro
    // sorteado é fantasma (ausente/sem cargo): reconcilia o rh e exclui, tenta outro
    rh.demitir(cand);
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

// Reatribuição AUTOMÁTICA (Parte 3) — sorteia um substituto VÁLIDO e efetiva. motivoTipo entra no
// log e no andamento, pra reatribuição nunca acontecer em silêncio.
async function reatribuirAutomatico(guild, { tabela, numero, papel, motivoTipo }) {
  const cfg = TABELAS_TICKET[tabela];
  const registro = db.buscarPorNumero(tabela, numero);
  if (!registro || !cfg || !cfg.papeis[papel]) return { ok: false, razao: 'papel/ticket inválido' };
  if (!ticketAberto(cfg, registro)) return { ok: false, razao: 'ticket encerrado' }; // arquivado/encerrado: não mexe

  const antigoId = registro[cfg.papeis[papel].campo];
  const excluir = [...responsaveisAtuais(tabela, registro)].filter(Boolean); // exclui quem já atua (inclui o fantasma)
  const novoId = await sortearSubstitutoValido(guild, papel, excluir);
  if (!novoId) return { ok: false, semSubstituto: true, antigoId, razao: 'sem substituto válido com o cargo' };

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

// Botão de ação pra pendência: designar responsável à mão (só o fluxo de Juiz em processo/petição
// tem designarjulgador hoje; pros demais papéis, a visibilidade no painel da Supervisão + a troca
// manual é o caminho). Retorna [] se não houver botão aplicável.
function componentesPendencia(tabela, numero, papel) {
  if (papel === 'Juiz' && (tabela === 'processos' || tabela === 'peticoes')) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:supervisao:designarjulgador:${numero}`).setLabel('Designar Juiz').setStyle(ButtonStyle.Primary),
    )];
  }
  return [];
}

// Núcleo compartilhado (varredura E evento): reatribui um papel fantasma de um ticket; sem
// substituto, tira o fantasma do campo, marca pendência (papel gravado em pendenciaPapeis pra a
// recuperação saber o que refazer), REVOGA o acesso do antigo e avisa com botão de designar —
// nunca deixa falsamente atribuído e nunca invisível.
async function aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, motivoTipo) {
  const antigoId = reg[pcfg.campo];
  const r = await reatribuirAutomatico(guild, { tabela, numero: reg.numero, papel, motivoTipo });
  if (r.semSubstituto) {
    const atual = db.buscarPorNumero(tabela, reg.numero) || reg;
    const pendentes = Array.from(new Set([...(atual.pendenciaPapeis || []), papel]));
    db.atualizar(tabela, reg.numero, { [pcfg.campo]: null, semResponsavelPendente: true, pendenciaPapeis: pendentes });
    const canal = reg[cfg.canalCampo] ? await guild.channels.fetch(reg[cfg.canalCampo]).catch(() => null) : null;
    if (canal) {
      if (antigoId) await canal.permissionOverwrites.delete(antigoId).catch(() => {}); // revoga acesso do inválido
      await canal.send({
        content: `⚠️ O(a) ${papel} deste caso saiu do quadro e **não há substituto disponível**. Marcado como pendência para a Supervisão — não ficou responsável fantasma.`,
        components: componentesPendencia(tabela, reg.numero, papel),
      });
    }
  }
  return { tabela, numero: reg.numero, papel, antigoId, resultado: r.ok ? 'reatribuido' : (r.semSubstituto ? 'pendencia_sem_substituto' : 'falhou'), novoId: r.novoId || null };
}

// ---- Advogado habilitado / defensor dativo (Parte 3, cobertura da spec) ----
// O advogado não cabe no modelo campo-único: mora em processos.habilitacoes[] (advogadoId +
// status 'Aprovado'). Se um advogado habilitado vira fantasma, o réu ficaria sem defesa — a spec
// proíbe. Aqui reusamos o mecanismo pronto de defensor dativo (utils/prazos.js). discordId != null
// restringe ao advogado que disparou o evento; null varre todos.
async function tratarAdvogadosFantasma(guild, discordId = null) {
  const prazos = require('./prazos'); // lazy: evita ciclo de require no load
  const tratados = [];
  for (const p of db.todos('processos').filter(r => ticketAberto(TABELAS_TICKET.processos, r))) {
    const habs = (p.habilitacoes || []).filter(h => h.status === 'Aprovado' && h.advogadoId);
    for (const hab of habs) {
      if (discordId && hab.advogadoId !== discordId) continue;
      const estado = await estadoResponsavel(guild, hab.advogadoId, 'Advogado');
      if (estado === 'valido' || estado === 'indeterminado') continue;
      // Advogado fantasma: marca a habilitação como saída e sorteia dativo (excluindo o fantasma).
      hab.status = 'Removido - advogado ausente';
      db.atualizar('processos', p.numero, { habilitacoes: p.habilitacoes });
      const dativo = prazos.sortearDefensorDativo(db.buscarPorNumero('processos', p.numero), [hab.advogadoId]);
      if (dativo) {
        await prazos.nomearDefensorDativo(guild, db.buscarPorNumero('processos', p.numero), dativo);
        tratados.push({ tabela: 'processos', numero: p.numero, papel: 'Advogado', antigoId: hab.advogadoId, resultado: 'defensor_dativo', novoId: dativo });
      } else {
        const canal = p.canalId ? await guild.channels.fetch(p.canalId).catch(() => null) : null;
        if (canal) await canal.send({ content: `⚠️ O advogado de defesa saiu do quadro e **não há advogado disponível** para defensor dativo no processo ${p.numero}. Providência da Supervisão necessária — o réu não pode ficar sem defesa.` });
        await auditoria.registrar(guild, { acao: 'Advogado ausente sem defensor dativo disponível', executorId: null, referencia: `Processo ${p.numero}`, motivo: 'sem advogado para dativo' });
        tratados.push({ tabela: 'processos', numero: p.numero, papel: 'Advogado', antigoId: hab.advogadoId, resultado: 'pendencia_sem_dativo', novoId: null });
      }
    }
  }
  return tratados;
}

// ---- Passada A: reconcilia o rh com o Discord ----
// Desativa todo registro ativo cujo dono saiu do servidor (10007) OU (se a role do cargo é conhecida)
// perdeu a role. Roda ANTES da B: limpa a fila de sorteio. Falha transitória de fetch NÃO desativa
// ninguém (checarMembro distingue). Retorna os órfãos achados.
async function limparRhFantasma(guild) {
  const orfaos = [];
  for (const reg of db.todos('rh', r => r.ativo)) {
    const estado = await estadoResponsavel(guild, reg.discordId, reg.cargo);
    if (estado === 'valido' || estado === 'indeterminado') continue;
    const motivo = estado === 'ausente' ? 'ausente do servidor' : 'sem a role do cargo';
    rh.demitir(reg.discordId);
    orfaos.push({ discordId: reg.discordId, cargo: reg.cargo, motivo });
    await auditoria.registrar(guild, { acao: `RH: desativação automática (${motivo})`, executorId: null, referencia: `<@${reg.discordId}> (era ${reg.cargo})`, motivo });
  }
  return orfaos;
}

// ---- Passada B: reatribui os tickets abertos com responsável fantasma ----
async function reatribuirTicketsFantasma(guild) {
  const tratados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => ticketAberto(cfg, r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        const id = reg[pcfg.campo];
        if (!id) continue;
        const estado = await estadoResponsavel(guild, id, papel);
        if (estado === 'valido' || estado === 'indeterminado') continue; // válido, ou falha transitória: não arrisca
        tratados.push(await aplicarReatribuicaoOuPendencia(guild, tabela, cfg, reg, papel, pcfg, estado === 'ausente' ? 'ausente' : 'sem_cargo'));
      }
    }
  }
  return tratados;
}

// ---- Recuperação de pendências (fecha o loop do "sem substituto") ----
// Percorre tickets abertos marcados como pendência e tenta refazer só os papéis pendentes
// (pendenciaPapeis) — assim que surgir substituto válido, designa e limpa a marca. Sem isso, um
// caso zerado ficaria invisível/parado pra sempre (não bate em nenhum job de re-sorteio por status).
async function recuperarPendencias(guild) {
  const recuperados = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => r.semResponsavelPendente && ticketAberto(cfg, r))) {
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
        reg[cfg.papeis[papel].campo] = novoId; // mantém o registro local coerente pro próximo papel
        recuperados.push({ tabela, numero: reg.numero, papel, novoId });
      }
      db.atualizar(tabela, reg.numero, aindaPendentes.length ? { pendenciaPapeis: aindaPendentes } : { pendenciaPapeis: [], semResponsavelPendente: false });
    }
  }
  return recuperados;
}

// ---- Camada 1: evento (reação imediata) ----
// Uma pessoa específica ficou inválida como responsável (saiu / perdeu o cargo). Trata os advogados
// dela (dativo) ANTES de demitir o rh, demite no rh e reatribui os tickets abertos onde ela é
// responsável. A varredura diária é a rede de segurança. Idempotente.
async function tratarResponsavelInvalido(guild, discordId, motivoTipo) {
  const tratados = [];
  // Advogado primeiro (o dativo exclui o fantasma via habilitacoes; independe do rh dele).
  tratados.push(...await tratarAdvogadosFantasma(guild, discordId));

  if (rh.getCargo(discordId)) {
    rh.demitir(discordId);
    await auditoria.registrar(guild, {
      acao: `RH: desativação automática (${motivoTipo === 'ausente' ? 'ausente do servidor' : 'sem o cargo'})`,
      executorId: null, referencia: `<@${discordId}>`,
    });
  }
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

// Pro guildMemberUpdate: retorna o cargo se o registro rh ativo do membro existe mas ele não tem
// mais a role correspondente (perdeu o cargo, continua no servidor). Senão null.
function cargoSemRole(membro) {
  const reg = rh.getCargo(membro.id);
  if (!reg) return null;
  const roleId = ROLE_POR_CARGO[reg.cargo];
  return (roleId && !membro.roles.cache.has(roleId)) ? reg.cargo : null;
}

// Varredura completa: Passada A (limpa rh) → Passada B (conserta tickets) → advogados fantasma →
// recuperação de pendências. Loga os números — é o "relatório do primeiro run". Sem cron novo.
async function varrerResponsaveisFantasma(guild) {
  const orfaosRh = await limparRhFantasma(guild);
  const tickets = await reatribuirTicketsFantasma(guild);
  const advogados = await tratarAdvogadosFantasma(guild);
  const recuperados = await recuperarPendencias(guild);
  console.log(`♻️ [fantasma] Varredura: ${orfaosRh.length} registro(s) rh órfão(s) desativado(s); ${tickets.length} ticket(s) com responsável fantasma tratado(s); ${advogados.length} advogado(s) fantasma; ${recuperados.length} pendência(s) recuperada(s).`);
  if (orfaosRh.length) console.log(`   rh órfãos: ${orfaosRh.map(o => `${o.discordId}(${o.cargo}: ${o.motivo})`).join(', ')}`);
  if (tickets.length) console.log(`   tickets: ${tickets.map(t => `${t.numero}/${t.papel}→${t.resultado}`).join(', ')}`);
  if (advogados.length) console.log(`   advogados: ${advogados.map(t => `${t.numero}→${t.resultado}`).join(', ')}`);
  return { orfaosRh, tickets, advogados, recuperados };
}

module.exports = {
  TABELAS_TICKET, QUEM_TROCA, ticketAberto,
  checarMembro, estadoResponsavel, sortearParaPapel, sortearSubstitutoValido,
  responsaveisAtuais, aplicarTroca, reatribuirAutomatico, rotuloTabela,
  limparRhFantasma, reatribuirTicketsFantasma, tratarAdvogadosFantasma, recuperarPendencias,
  varrerResponsaveisFantasma, tratarResponsavelInvalido, cargoSemRole,
};
