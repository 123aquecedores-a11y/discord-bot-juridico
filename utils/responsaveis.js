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
const andamentos = require('./andamentos');
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
      // REINÍCIO ÚNICO DO PRAZO DO MP (decisão do operador — "opção B").
      //
      // Antes, toda troca de Promotor zerava as 24h. Isso abria um loop: o Procurador trocava de
      // promotor a cada 23h e o prazo nunca vencia, deixando o Juiz travado indefinidamente à espera
      // de uma manifestação que ninguém precisava dar. A trava do Juiz é lazy (libera sozinha no
      // decurso), então prazo que nunca vence = decisão que nunca sai.
      //
      // Agora o relógio volta a zero UMA VEZ SÓ por petição. A primeira troca reinicia (o promotor
      // novo merece a janela cheia — ele acabou de receber os autos) e marca prazoMpJaReiniciado.
      // Da segunda troca em diante o prazo SEGUE CORRENDO da data que já estava valendo: trocar de
      // promotor deixa de ser uma forma de comprar tempo.
      //
      // A manifestação anterior PERMANECE nos autos nos dois casos — ato praticado não se desfaz.
      Promotor: {
        campo: 'promotor',
        resetPrazo: (reg) => (reg && reg.prazoMpJaReiniciado
          ? {} // já usou o reinício: o relógio não volta a zero
          : { sorteioPromotorEm: new Date().toISOString(), prazoMpJaReiniciado: true }),
      },
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
// Regra-mãe: na dúvida, é Staff.
const QUEM_TROCA = {
  Juiz: ['Desembargador'],
  Promotor: ['Procurador'],
  Delegado: ['Desembargador', 'Procurador'],
  // Não há instância acima do Desembargador, então a redistribuição de relator é do próprio
  // colegiado (é o que o botão "Trocar relator (apelação)" já fazia antes da Parte 2) — mais Staff.
  Desembargador: ['Desembargador'],
};

// O substituto precisa constar no rh com o cargo? Sim, salvo exceção DECLARADA. Delegado é a
// exceção: a integração da Polícia Civil injeta o delegado por @menção crua, sem contratar no rh
// (mesmo motivo de estadoResponsavel não checar cargo) — exigir rh aqui impediria justamente a
// troca que a Supervisão precisa fazer nos inquéritos vindos da PC.
const EXIGE_CARGO_RH = { Juiz: true, Promotor: true, Desembargador: true, Delegado: false };

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

// Trava de segurança da reconciliação por cargo: demissão em massa real não existe: dezenas de
// responsáveis "sem cargo" de uma vez é sintoma de rh zerado/corrompido (este banco já foi resetado
// antes), e reatribuir tudo seria destrutivo e difícil de desfazer. Acima deste limite, a
// reconciliação POR CARGO é abortada e pede conferência humana — a detecção por AUSÊNCIA (que é
// definitiva) continua valendo normalmente.
const LIMITE_RECONCILIACAO_SEM_CARGO = 5;

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

// Por que ESTE responsável é inválido? null = está válido (ou não dá pra afirmar). Dois motivos,
// em ordem de confiança:
//  1. 'ausente'  — saiu do servidor (10007). Definitivo, não tem falso positivo.
//  2. 'semcargo' — continua no servidor, mas o rh não o registra mais naquele cargo (demitido,
//     promovido, trocado). Conferido no RH, que é a fonte da verdade do bot, NUNCA na role do
//     Discord: detectar por role já causou reatribuição indevida (o próprio swap de cargo do bot
//     remove/readiciona a role). Papel que não vem do rh — Delegado, que a integração da Polícia
//     Civil injeta por @menção crua — fica de fora por declaração (EXIGE_CARGO_RH), senão a
//     reconciliação expulsaria um responsável legítimo que nunca esteve no quadro.
async function motivoInvalidez(guild, papel, id) {
  const estado = await estadoResponsavel(guild, id);
  if (estado === 'indeterminado') return null; // falha transitória de rede: não arrisca
  if (estado === 'ausente') return 'ausente';
  if (EXIGE_CARGO_RH[papel] === false) return null;
  // cobreOPapel, não temCargo: um Desembargador responsável por caso de Juiz PODE atuar nele
  // (atosPorCargo/ocupaDestinatario dizem isso), então tratá-lo como fantasma redistribuiria
  // casos de quem está perfeitamente apto. Foi o que aconteceu em produção em 19/08/2026.
  return rh.cobreOPapel(id, papel) ? null : 'semcargo';
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

// Texto do aviso do prazo do MP numa troca de Promotor em petição (ver o resetPrazo de peticoes).
// Recebe o registro ANTES da troca. Devolve null quando não é o caso (outro papel/tabela).
function textoPrazoMp(tabela, papel, registroAntes) {
  if (tabela !== 'peticoes' || papel !== 'Promotor' || !registroAntes) return null;
  if (!registroAntes.prazoMpJaReiniciado) {
    return '⏱️ **Prazo do MP reiniciado por ato da Supervisão** — o Ministério Público tem 24 (vinte e quatro) horas, '
      + 'a contar de agora, para se manifestar. Este é o **único** reinício desta petição: novas trocas de Promotor não '
      + 'devolvem o prazo.';
  }
  const desde = registroAntes.sorteioPromotorEm ? new Date(registroAntes.sorteioPromotorEm) : null;
  const quando = desde && !isNaN(desde) ? desde.toLocaleString('pt-BR') : 'a data já registrada nos autos';
  return '⏱️ **Prazo do MP NÃO foi reiniciado** — esta petição já usou seu reinício único. O prazo de 24 (vinte e quatro) '
    + `horas segue correndo desde ${quando}, e a troca de Promotor não o devolve.`;
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

  // resetPrazo recebe o registro ANTES da troca — é assim que o reinício único do prazo do MP
  // (petições/Promotor) sabe se já foi usado. Os demais papéis ignoram o argumento.
  db.atualizar(tabela, numero, { [pcfg.campo]: novoId, ...pcfg.resetPrazo(registro) });

  // Aviso do prazo do MP: sai em TODA troca de Promotor em petição, dizendo a verdade daquela
  // troca — reiniciou agora, ou já tinha reiniciado e o relógio continua correndo. Sem isso, a
  // Supervisão trocaria de promotor achando que comprou 24h e o Juiz decidiria no meio.
  const avisoMp = textoPrazoMp(tabela, papel, registro);

  const canal = registro[cfg.canalCampo] ? await guild.channels.fetch(registro[cfg.canalCampo]).catch(() => null) : null;
  if (canal) {
    await canais.adicionarMembro(canal, novoId);
    if (antigoId && antigoId !== novoId) await canal.permissionOverwrites.delete(antigoId).catch(() => {});
    if (textoAndamento) await canal.send({ content: textoAndamento });
    if (avisoMp) await canal.send({ content: avisoMp }).catch(() => {});
  }
  await auditoria.registrar(guild, {
    acao: acaoAuditoria, executorId,
    referencia: `${rotuloTabela(tabela)} ${numero}: ${antigoId ? `<@${antigoId}>` : '—'} → <@${novoId}>`,
    motivo: motivoAuditoria,
  });
  // Andamento nos autos: a mensagem no canal rola pra cima e some de vista; o histórico é o que
  // fica. Vale pros dois caminhos (troca manual e reatribuição automática) porque os dois passam
  // por aqui. Best-effort — falhar no registro não pode desfazer uma troca já efetivada.
  await andamentos.registrar(guild, numero, {
    tipo: 'troca_responsavel', titulo: `🔁 Troca de ${papel}`,
    detalhe: `${antigoId ? `<@${antigoId}>` : '—'} → <@${novoId}>${motivoAuditoria ? `. Motivo: ${motivoAuditoria}` : ''}`,
    executorId, metadata: { tabela, papel, antigoId: antigoId || null, novoId },
  }).catch(e => console.error('[responsaveis] falha ao registrar andamento da troca (ignorado):', e.message));
  // O prazo do MP também vai pro HISTÓRICO, não só pro canal: a mensagem rola pra cima, o andamento
  // fica. É por ele que se responde depois "por que o Juiz decidiu se o MP não tinha se manifestado".
  if (avisoMp) {
    const reiniciouAgora = !registro.prazoMpJaReiniciado;
    await andamentos.registrar(guild, numero, {
      tipo: 'prazo_mp',
      titulo: reiniciouAgora ? '⏱️ Prazo do MP reiniciado (único)' : '⏱️ Prazo do MP mantido (reinício já usado)',
      detalhe: avisoMp,
      executorId,
      metadata: { reiniciouAgora, sorteioPromotorEmAnterior: registro.sorteioPromotorEm || null },
    }).catch(e => console.error('[responsaveis] falha ao registrar andamento do prazo do MP (ignorado):', e.message));
  }
  return { ok: true, antigoId, novoId, prazoMpReiniciado: avisoMp ? !registro.prazoMpJaReiniciado : undefined };
}

// Motivo automático que vai pro andamento nos autos e pra auditoria — reatribuição automática
// nunca acontece em silêncio nem sem justificativa registrada.
const MOTIVOS_REATRIBUICAO = {
  ausente: 'responsável ausente do servidor',
  semcargo: 'responsável sem o cargo (reconciliação automática)',
};

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

  const motivoTexto = MOTIVOS_REATRIBUICAO[motivoTipo] || 'responsável inválido';
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

// ---- Parte 2: TROCA MANUAL de responsável (universal) ----
// Mesmo motor da reatribuição automática (aplicarTroca). O que muda é só a ORIGEM do substituto
// (@menção da Supervisão em vez de sorteio) e o texto do andamento. Nada aqui enumera tipo de
// ticket: tudo sai de TABELAS_TICKET/QUEM_TROCA, então um tipo novo declarado no mapa já nasce
// trocável, sem ninguém cadastrar exceção.

// Resolve o ticket por REFERÊNCIA: número interno ("0001PN") ou ID do canal do Discord (a Supervisão
// costuma estar dentro do canal, não com o número na mão). Varre todas as tabelas do mapa.
function resolverTicket(ref) {
  const t = String(ref || '').trim();
  if (!t) return null;
  if (/^\d{15,25}$/.test(t)) {
    for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
      const porCanal = db.buscarUm(tabela, r => r[cfg.canalCampo] === t);
      if (porCanal) return { tabela, cfg, registro: porCanal };
    }
    return null; // snowflake que não é canal de ticket: não tenta como número
  }
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    const r = db.buscarPorNumero(tabela, t);
    if (r) return { tabela, cfg, registro: r };
  }
  return null;
}

// Papéis que ESTE ticket permite trocar agora. Sem responsável marcado não é troca, é designação
// (outro fluxo — designarJulgador); ticket encerrado/arquivado devolve vazio, e é isso que faz o
// botão sumir sozinho, sem lista de status espalhada pela UI.
function papeisTrocaveis(tabela, registro) {
  const cfg = TABELAS_TICKET[tabela];
  if (!cfg || !registro || !ticketAberto(cfg, registro)) return [];
  return Object.entries(cfg.papeis)
    .filter(([, pcfg]) => !!registro[pcfg.campo])
    .map(([papel, pcfg]) => ({ papel, atualId: registro[pcfg.campo] }));
}

// Quem pode trocar ESTE papel. `temCargo` é injetado por quem chama (a UI passa o teste de cargo do
// interaction) pra este módulo não depender de discord.js nem de permissoes.js.
function podeTrocarPapel(papel, { staff = false, temCargo = () => false } = {}) {
  if (staff) return true;
  return (QUEM_TROCA[papel] || []).some(c => temCargo(c));
}

// Botão de entrada da Supervisão dentro do ticket. Fonte única do customId — o painel do processo,
// os cards de medida/petição e a apelação chamam esta função, ninguém remonta a string.
function botaoSupervisaoTicket(tabela, numero) {
  return new ButtonBuilder()
    .setCustomId(`painel:acao:supervisao:ticket:${tabela}#${numero}`)
    .setLabel('🛡️ Supervisão').setStyle(ButtonStyle.Secondary);
}

/**
 * Troca manual de um responsável. Valida tudo antes de mexer em qualquer coisa: em erro, o estado
 * fica EXATAMENTE como estava e a razão volta pronta pra mostrar a quem clicou.
 * @returns {Promise<{ok:boolean, erro?:string, antigoId?:string, novoId?:string, papel?:string}>}
 */
async function trocarManual(guild, { tabela, numero, papel, novoId, motivo, executorId = null }) {
  const cfg = TABELAS_TICKET[tabela];
  if (!cfg || !cfg.papeis[papel]) return { ok: false, erro: `Não existe ${papel} em ${rotuloTabela(tabela)}.` };
  const registro = db.buscarPorNumero(tabela, numero);
  if (!registro) return { ok: false, erro: 'Caso não encontrado.' };
  if (!ticketAberto(cfg, registro)) return { ok: false, erro: `${rotuloTabela(tabela)} ${numero}: caso já encerrado/arquivado — responsável de caso fechado é registro histórico, não se troca.` };
  if (!String(motivo || '').trim()) return { ok: false, erro: 'O motivo da troca é obrigatório.' };
  if (!novoId) return { ok: false, erro: 'Marque o substituto com @menção.' };

  const antigoId = registro[cfg.papeis[papel].campo];
  if (!antigoId) return { ok: false, erro: `Este caso não tem ${papel} atribuído — use "Designar", não "Trocar".` };
  if (antigoId === novoId) return { ok: false, erro: `<@${novoId}> já é o(a) ${papel} deste caso.` };
  // Ninguém acumula dois papéis no mesmo ticket (mesma regra do sorteio automático, que exclui os
  // responsáveis atuais) — senão o promotor viraria juiz do próprio caso.
  const outroPapel = Object.entries(cfg.papeis).find(([p, pc]) => p !== papel && registro[pc.campo] === novoId);
  if (outroPapel) return { ok: false, erro: `<@${novoId}> já atua neste caso como ${outroPapel[0]}.` };
  if (EXIGE_CARGO_RH[papel] !== false && !rh.temCargo(novoId, papel)) {
    return { ok: false, erro: `<@${novoId}> não consta como ${papel} ativo no quadro (RH).` };
  }
  const membro = await checarMembro(guild, novoId);
  if (membro.ausente) return { ok: false, erro: `<@${novoId}> não está no servidor.` };

  const [nomeAntigo, nomeNovo] = await Promise.all([
    documentoPng.nomeExibicao(guild, antigoId),
    documentoPng.nomeExibicao(guild, novoId),
  ]);
  const artigo = papel === 'Juiz' ? 'O(a) Juiz(a)' : `O(a) ${papel}`;
  const textoAndamento = `🔁 **Troca de responsável** — ${artigo} ${nomeAntigo} deixa o caso; assume ${nomeNovo}, por ato da Supervisão${executorId ? ` (<@${executorId}>)` : ''}. Motivo: ${String(motivo).trim()}. Os atos já praticados permanecem nos autos. <@${novoId}> assume a partir de agora.`;

  const r = await aplicarTroca(guild, {
    tabela, numero, papel, novoId, textoAndamento,
    acaoAuditoria: `Troca de ${papel} (${rotuloTabela(tabela)})`,
    motivoAuditoria: String(motivo).trim(), executorId,
  });
  if (!r.ok) return { ok: false, erro: r.razao || 'Não foi possível concluir a troca.' };

  // SEXTO CÓDIGO ÓRFÃO, achado em 18/08/2026 ao verificar a §6.2 a pedido do operador.
  //
  // `pecas.reiniciarValvulaPorTroca` existia, estava testado e NUNCA ERA CHAMADO. A regra da SPEC §7
  // — "a contagem reinicia na troca de responsável" — simplesmente não valia em produção: o
  // substituto herdava um caso cuja válvula já estava correndo, e que podia destravar sozinho em
  // minutos. A cena nunca aconteceria, e ninguém saberia por quê.
  //
  // A §6.2 e a disponibilidade (Bloco F) NÃO se atropelam, e este é o ponto exato onde isso se vê:
  // disponibilidade é PREVENÇÃO (escolhe quem entra); substituição é REMÉDIO (conserta quem saiu).
  // O substituto assume as entregas pendentes por PAPEL, sem regenerar nada — e agora com o relógio
  // reiniciado, que é o que torna a herança justa.
  let herdadas = [];
  try {
    const pecas = require('./pecas');
    const reiniciadas = pecas.reiniciarValvulaPorTroca(tabela, numero, papel);
    if (reiniciadas.length) {
      console.log(`[pecas] troca de ${papel} em ${numero}: válvula reiniciada em ${reiniciadas.length} entrega(s) pendente(s).`);
    }
    // SPEC §6.2: "ao assumir, o substituto recebe a lista do que herdou". Era o DÉCIMO código órfão
    // desta auditoria — pendentesDoPapel existia, testado, e nenhum caminho o chamava: o substituto
    // entrava no caso sem saber que havia entrega esperando por ele. Vai no canal do caso, junto do
    // andamento da troca (o mesmo lugar onde ele lê que assumiu).
    herdadas = pecas.pendentesDoPapel(tabela, numero, papel);
    if (herdadas.length) {
      const cfgT = TABELAS_TICKET[tabela];
      const reg = db.buscarPorNumero(tabela, numero);
      const canal = reg && reg[cfgT.canalCampo] ? await guild.channels.fetch(reg[cfgT.canalCampo]).catch(() => null) : null;
      const aviso = `📥 <@${novoId}> — você herdou **${herdadas.length} entrega(s) pendente(s)** aguardando recebimento neste caso: ${herdadas.map(h => h.numero).join(', ')}. O prazo para ciência reiniciou agora.`;
      if (canal) await canal.send({ content: aviso }).catch(() => {});
    }
  } catch (e) { console.error('[pecas] falha ao reiniciar válvula/herança na troca:', e.message); }

  return { ...r, papel, tabela, numero, herdadas };
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
  // Sem substituto, os dois motivos NÃO se equivalem:
  //  - 'ausente': a pessoa foi embora. Deixar o nome dela ali é atribuição falsa — tira e marca
  //    pendência (é melhor um caso explicitamente sem responsável do que um fantasma).
  //  - 'semcargo': a pessoa está NO SERVIDOR e consegue agir (os gates de ação usam user.id, não o
  //    rh). Esvaziar o campo sem ter por quem trocar PIORA o caso — de alguém que ainda atua pra
  //    ninguém — e por um sinal fraco (uma linha do rh). Então não mexe; segue candidato na próxima
  //    varredura, quando talvez já exista substituto.
  if (r.semSubstituto && motivoTipo === 'semcargo') {
    console.warn(`♻️ [fantasma] ${rotuloTabela(tabela)} ${reg.numero}: ${papel} <@${antigoId}> está no servidor mas não consta no quadro (rh) — sem substituto disponível, foi MANTIDO (não se esvazia um caso que ainda tem quem aja).`);
    return { tabela, numero: reg.numero, papel, antigoId, motivoTipo, resultado: 'mantido_sem_substituto', novoId: null };
  }
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
  return { tabela, numero: reg.numero, papel, antigoId, motivoTipo, resultado: r.ok ? 'reatribuido' : (r.semSubstituto ? 'pendencia_sem_substituto' : 'falhou'), novoId: r.novoId || null };
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

// PASSADA B — RECONCILIAÇÃO: percorre todo ticket ABERTO e confere, pra cada responsável marcado,
// se ele (1) ainda está no servidor e (2) ainda tem o cargo no rh. Falhando qualquer um dos dois,
// reatribui pelo mesmo motor da troca. É a camada que conserta o que o evento nunca pega: quem saiu
// (ou foi demitido) ANTES desta feature existir, ou enquanto o bot estava fora do ar — nenhum
// guildMemberRemove chegou pra esses. Idempotente: numa 2ª passada não há mais o que consertar.
// Falha transitória de fetch não reatribui ninguém (motivoInvalidez devolve null).
async function reatribuirTicketsFantasma(guild, { limiteSemCargo = LIMITE_RECONCILIACAO_SEM_CARGO } = {}) {
  // Levanta TODOS os candidatos antes de mexer em qualquer coisa — é o que permite a trava de
  // segurança abaixo enxergar o tamanho do estrago antes de causá-lo.
  const candidatos = [];
  for (const [tabela, cfg] of Object.entries(TABELAS_TICKET)) {
    for (const reg of db.todos(tabela).filter(r => ticketAberto(cfg, r))) {
      for (const [papel, pcfg] of Object.entries(cfg.papeis)) {
        const id = reg[pcfg.campo];
        if (!id) continue;
        const motivoTipo = await motivoInvalidez(guild, papel, id);
        if (motivoTipo) candidatos.push({ tabela, cfg, reg, papel, pcfg, motivoTipo });
      }
    }
  }

  const semCargo = candidatos.filter(c => c.motivoTipo === 'semcargo');
  const abortarSemCargo = semCargo.length > limiteSemCargo;
  if (abortarSemCargo) {
    console.warn(`⚠️ [fantasma] ${semCargo.length} responsáveis apareceram "sem o cargo" de uma vez (limite ${limiteSemCargo}) — isso tem cara de rh zerado, não de demissão em massa. Reconciliação POR CARGO abortada nesta rodada (confira o quadro no /rh); a correção por AUSÊNCIA do servidor seguiu normalmente.`);
    console.warn(`   casos que ficaram de fora: ${semCargo.map(c => `${c.reg.numero}/${c.papel}`).join(', ')}`);
  }

  const tratados = [];
  for (const c of candidatos) {
    if (c.motivoTipo === 'semcargo' && abortarSemCargo) continue;
    tratados.push(await aplicarReatribuicaoOuPendencia(guild, c.tabela, c.cfg, c.reg, c.papel, c.pcfg, c.motivoTipo));
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
async function varrerResponsaveisFantasma(guild, opts = {}) {
  const orfaosRh = await limparRhFantasma(guild);
  const tickets = await reatribuirTicketsFantasma(guild, opts);
  const recuperados = await recuperarPendencias(guild);
  // "Mantido" não é conserto — é um candidato que a trava de segurança deixou como estava. Contar
  // junto faria o log dizer que consertou algo numa varredura que não mexeu em nada.
  const mexidos = tickets.filter(t => t.resultado !== 'mantido_sem_substituto');
  const mantidos = tickets.length - mexidos.length;
  const porAusencia = mexidos.filter(t => t.motivoTipo === 'ausente').length;
  const porCargo = mexidos.filter(t => t.motivoTipo === 'semcargo').length;
  console.log(`♻️ [fantasma] Varredura: ${orfaosRh.length} registro(s) rh órfão(s) desativado(s); ${mexidos.length} ticket(s) com responsável fantasma tratado(s) (${porAusencia} por ausência do servidor, ${porCargo} por perda de cargo)${mantidos ? `; ${mantidos} mantido(s) por falta de substituto` : ''}; ${recuperados.length} pendência(s) recuperada(s).`);
  if (orfaosRh.length) console.log(`   rh órfãos: ${orfaosRh.map(o => `${o.discordId}(${o.cargo}: ${o.motivo})`).join(', ')}`);
  if (tickets.length) console.log(`   tickets: ${tickets.map(t => `${t.numero}/${t.papel}[${t.motivoTipo}]→${t.resultado}`).join(', ')}`);
  return { orfaosRh, tickets, recuperados };
}

module.exports = {
  TABELAS_TICKET, QUEM_TROCA, EXIGE_CARGO_RH, ticketAberto, LIMITE_RECONCILIACAO_SEM_CARGO,
  checarMembro, estadoResponsavel, motivoInvalidez, sortearParaPapel, sortearSubstitutoValido, canalArquivado,
  responsaveisAtuais, aplicarTroca, reatribuirAutomatico, rotuloTabela,
  resolverTicket, papeisTrocaveis, podeTrocarPapel, botaoSupervisaoTicket, trocarManual,
  limparRhFantasma, reatribuirTicketsFantasma, recuperarPendencias,
  varrerResponsaveisFantasma, tratarResponsavelInvalido,
  textoPrazoMp, // exposto pro teste do reinício único do prazo do MP
};
