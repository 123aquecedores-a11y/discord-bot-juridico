const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');
const config = require('../config');
const estado = require('./estado');
const guildGuard = require('./guildGuard');

function slugCanal(numero) {
  return numero.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// Cria a categoria na primeira vez que é preciso e guarda o ID em `estado` (mesmo mecanismo
// da mensagem fixa do painel) — assim novos módulos que precisam de categoria própria não
// dependem de configuração manual no .env, só nascem organizados sozinhos.
async function obterOuCriarCategoria(guild, chaveEstado, nome) {
  // Camada de profundidade do isolamento: criar categoria/canal é a escrita mais visível e mais
  // chata de desfazer, e ainda grava o id no `estado` (banco) — se vier do guild errado, a
  // instalação passa a apontar pra uma categoria de outro servidor. Ver utils/guildGuard.js.
  guildGuard.exigirGuild(guild, 'canais.obterOuCriarCategoria');
  const idSalvo = estado.obter(chaveEstado);
  if (idSalvo) {
    const existente = await guild.channels.fetch(idSalvo).catch(() => null);
    if (existente) return existente.id;
  }
  const categoria = await guild.channels.create({ name: nome, type: ChannelType.GuildCategory });
  estado.definir(chaveEstado, categoria.id);
  return categoria.id;
}

// Cria um canal privado dentro de uma categoria, visível só pros IDs de usuário passados
// (+ o cargo de staff, se configurado, sempre enxerga tudo).
// `type` é sempre explícito (Member/Role) — sem isso, o discord.js só consegue inferir o
// tipo checando se o ID está em cache, e como o bot roda só com o intent "Guilds" (sem
// GuildMembers), qualquer pessoa que não interagiu com o bot recentemente não está em cache,
// e a criação do canal quebra com "Supplied parameter is not a cached User or Role".
// bloquearConversa (spec-andamentos-processuais_4.md, seção 8.7): canal só tem interação via
// botão/select/modal, sem bate-papo livre — nega SendMessages pra todo mundo (menos o bot).
// Clicar botão, escolher select e enviar modal NÃO exigem SendMessages no Discord (só digitar
// mensagem exige), então os componentes continuam funcionando normalmente mesmo bloqueado.
// A única exceção real é aguardarAnexoPDF, que depende de mensagem de verdade pra pegar o
// anexo — ele mesmo libera SendMessages pontualmente pra quem está anexando (ver anexoPdf.js).
// ---------------------------------------------------------------------------
// LEITURA INSTITUCIONAL DOS TICKETS (20/08/2026, pedido do operador)
// ---------------------------------------------------------------------------
// Os quatro cargos de magistratura e MP passam a VER todo canal de ticket. Isso já valia em toda
// porta do BOT — `temAcessoTotal` (PAPEIS_COMPARTILHADOS) e `CARGOS_QUE_VEEM_TEOR` já os incluíam;
// o que faltava era o Discord, onde o canal nega ViewChannel ao @everyone e só abre para os
// membros nominais e a staff. Eles podiam ler o processo por comando e não viam o canal existir.
//
// LEITURA, nunca escrita: sem SendMessages, porque a regra de "nenhum canal de processo tem
// bate-papo" continua valendo. Botão, select e modal NÃO exigem SendMessages no Discord, então
// quem tem ação no caso continua agindo normalmente.
//
// FÁCIL DE INVERTER: para tirar um cargo da leitura institucional, remova-o desta lista — é o
// único lugar que decide isso.
const CARGOS_LEITURA_TICKET = ['roleJuizId', 'rolePromotorId', 'roleDesembargadorId', 'roleProcuradorId'];

// EXCEÇÃO: o que NÃO recebe leitura por cargo, e segue restrito ao juiz e ao promotor do caso.
// Busca e apreensão e quebra de sigilo são diligências cujo vazamento queima a própria diligência
// — quem souber antes avisa o alvo. Constante no topo de propósito: inverter isso depois é apagar
// uma linha, não caçar condição espalhada.
const TIPOS_TICKET_RESTRITO = [/busca\s*e?\s*apreens/i, /quebra\s*d[eo]\s*sigilo/i];
const ehTicketRestrito = (rotulo) => !!rotulo && TIPOS_TICKET_RESTRITO.some(re => re.test(String(rotulo)));

// Overwrites de LEITURA por cargo. Devolve [] quando o ticket é restrito ou quando nenhuma role
// está configurada — instalação sem os cargos não ganha overwrite inventado.
function overwritesLeituraPorCargo({ restrito = false } = {}) {
  if (restrito) return [];
  return CARGOS_LEITURA_TICKET
    .map(chave => config[chave])
    .filter(Boolean)
    .map(id => ({
      id, type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    }));
}

// IMPEDIMENTO — quem é PARTE não vê o próprio caso, nem que tenha o cargo.
//
// Isto é o que impede a abertura acima de virar um buraco: um Promotor que é RÉU num processo
// passaria a enxergar o canal onde se decide sobre ele. O deny é por MEMBRO, e no Discord o deny
// de membro vence o allow de role — é a única ordem que funciona, porque a role é justamente o
// que ele tem de sobra.
//
// `ViewChannel` negado leva ReadMessageHistory junto: sem ver o canal, não há histórico a ler.
function overwritesImpedimento(impedidos = []) {
  return [...new Set(impedidos.filter(Boolean).map(String))].map(id => ({
    id, type: OverwriteType.Member,
    deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
  }));
}

// A menção institucional da PRIMEIRA mensagem do ticket. Uma vez só, no card de abertura — os
// andamentos seguintes não mencionam ninguém, senão cada ato viraria ping para quatro cargos.
function mencaoCargosTicket({ restrito = false } = {}) {
  if (restrito) return '';
  const ids = CARGOS_LEITURA_TICKET.map(c => config[c]).filter(Boolean);
  return ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '';
}


async function criarCanalTicket(guild, { categoriaId, prefixo, numero, membros = [], bloquearConversa = false, impedidos = [], restrito = false, rotuloTipo = null }) {
  // `restrito` explícito OU deduzido do rótulo do ato (busca e apreensão, quebra de sigilo).
  restrito = restrito || ehTicketRestrito(rotuloTipo);
  impedidos = [...new Set((impedidos || []).filter(Boolean).map(String))];
  guildGuard.exigirGuild(guild, 'canais.criarCanalTicket');
  const permissaoMembro = bloquearConversa
    ? { allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }
    : { allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] };

  const overwrites = [
    { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...overwritesLeituraPorCargo({ restrito }),
    { id: config.staffRoleId, type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    // MEMBROS depois das ROLES, e IMPEDIDOS por último. A ordem no array não é o que decide (o
    // Discord avalia @everyone -> roles -> membro, sempre), mas escrever nesta ordem deixa a
    // precedência legível para quem lê o código: o allow nominal cobre o deny de role, e o deny
    // do impedido cobre tudo.
    ...membros.filter(id => !impedidos.includes(String(id))).map(id => ({ id, type: OverwriteType.Member, ...permissaoMembro })),
    ...overwritesImpedimento(impedidos),
  ].filter(o => o.id);

  const canal = await guild.channels.create({
    name: `${prefixo}-${slugCanal(numero)}`,
    type: ChannelType.GuildText,
    parent: categoriaId || undefined,
    permissionOverwrites: overwrites,
  });

  // MENÇÃO INSTITUCIONAL — a PRIMEIRA mensagem do ticket, uma vez só.
  //
  // Fica aqui, e não em cada rito, por dois motivos: é um lugar só para mudar, e é o único ponto
  // que garante "primeira mensagem" de verdade — o card de abertura que cada fluxo posta em
  // seguida vira a segunda. Andamentos e atos posteriores NÃO mencionam: quatro cargos pingados a
  // cada despacho viraria ruído, e ruído faz a pessoa desligar a notificação do tribunal inteiro.
  //
  // Ticket restrito não menciona ninguém — a diligência não se anuncia.
  const mencao = mencaoCargosTicket({ restrito });
  if (mencao) {
    await canal.send({
      content: `${mencao}\n📁 Autos abertos: **${numero}**. Leitura institucional — acompanhe pelo painel; este canal não tem bate-papo.`,
      allowedMentions: { parse: ['roles'] },
    }).catch(err => console.error(`[canais] menção institucional falhou em ${canal.id}: ${err.message}`));
  }
  return canal;
}

// Dá acesso de visualização/escrita a um usuário específico num canal já existente.
// Não deixa vazar erro: se o ID for inválido de verdade (não é mais garantia de sucesso só
// por passar o type explícito), o Discord recusa a permission overwrite — isso não pode
// derrubar o fluxo inteiro (abrir processo, aprovar habilitação etc.), só significa que essa
// pessoa específica não recebeu acesso.
//
// Detecta sozinho se o canal é "bloqueado" (seção 8.7) olhando se já existe alguma permission
// overwrite de membro negando SendMessages — a maioria de quem entra num processo (Juiz
// sorteado, advogado habilitado, réu identificado depois) chega por AQUI, não pelos `membros`
// passados na criação do canal, então sem essa checagem o bloqueio valeria só pra quem abriu
// o canal e ninguém mais.
function canalTemConversaBloqueada(canal) {
  return canal.permissionOverwrites.cache.some(o => o.type === OverwriteType.Member && o.deny.has(PermissionFlagsBits.SendMessages));
}

async function adicionarMembro(canal, discordId) {
  const bloqueado = canalTemConversaBloqueada(canal);
  try {
    await canal.permissionOverwrites.edit(discordId, {
      ViewChannel: true,
      SendMessages: !bloqueado,
      ReadMessageHistory: true,
    }, { type: OverwriteType.Member });
    return true;
  } catch (err) {
    console.error(`Não foi possível dar acesso a ${discordId} no canal ${canal.id}: ${err.message}`);
    return false;
  }
}

// Trava o canal (ninguém mais entra, quem já está só lê) e move pra categoria "Arquivados",
// pra sumir da visão principal sem apagar o histórico. Guarda a categoria de origem numa
// mensagem invisível pro bot (topic do canal) pra dar pra "desarquivar" depois.
async function arquivarCanal(canal) {
  // Precisa ser um snapshot (array), não a Collection viva: canal.permissionOverwrites.edit()
  // reinsere a entry no cache (delete+set da mesma chave), e iterar um Map/Collection
  // enquanto ele é remontado por baixo faz o for-of revisitar as mesmas entradas pra sempre —
  // travava aqui indefinidamente e o arquivamento nunca chegava no setParent.
  const overwrites = [...canal.permissionOverwrites.cache.values()];
  for (const overwrite of overwrites) {
    await canal.permissionOverwrites.edit(overwrite.id, { SendMessages: false }, { type: overwrite.type }).catch(() => {});
  }
  if (config.categoriaArquivadosId && canal.parentId !== config.categoriaArquivadosId) {
    const categoriaOrigemId = canal.parentId;
    await canal.setParent(config.categoriaArquivadosId, { lockPermissions: false }).catch(() => {});
    if (categoriaOrigemId) {
      await canal.setTopic(`origem:${categoriaOrigemId}`).catch(() => {});
    }
  }
}

// Reverte o travamento pros IDs passados e move o canal de volta pra categoria de origem
// (usado ao reabrir um processo arquivado por prazo, ou ao desarquivar manualmente).
async function reabrirCanal(canal, membros) {
  for (const id of membros) {
    await canal.permissionOverwrites.edit(id, { SendMessages: true }, { type: OverwriteType.Member }).catch(() => {});
  }
  const match = /origem:(\d+)/.exec(canal.topic || '');
  if (match) {
    await canal.setParent(match[1], { lockPermissions: false }).catch(() => {});
    await canal.setTopic(null).catch(() => {});
  }
}

// BACKFILL — aplica a leitura por cargo (e o impedimento) a um canal que JÁ existe.
//
// Sem isto a mudança valeria só para tickets novos, e os quatro cargos continuariam sem ver
// justamente os casos em curso. Roda no boot sobre os tickets abertos.
//
// Idempotente: cargo que já tem ViewChannel é pulado, então rodar todo boot não custa chamada de
// API. Silenciosa em erro: permissão negada num canal não pode derrubar o bot.
//
// O IMPEDIDO É APLICADO PRIMEIRO, de propósito. Se a chamada falhar no meio, o pior estado
// possível é "o impedido está barrado e os cargos ainda não entraram" — nunca o contrário.
async function garantirLeituraPorCargo(canal, { restrito = false, impedidos = [] } = {}) {
  if (!canal) return 0;
  let mexeu = 0;

  for (const id of [...new Set((impedidos || []).filter(Boolean).map(String))]) {
    const atual = canal.permissionOverwrites?.cache?.get(id);
    if (atual && atual.deny?.has(PermissionFlagsBits.ViewChannel)) continue;
    try {
      await canal.permissionOverwrites.edit(id, { ViewChannel: false, ReadMessageHistory: false }, { type: OverwriteType.Member });
      mexeu++;
    } catch (e) { console.error(`[canais] impedimento de ${id} em ${canal.id} falhou: ${e.message}`); }
  }

  if (restrito) return mexeu;
  for (const chave of CARGOS_LEITURA_TICKET) {
    const roleId = config[chave];
    if (!roleId) continue;
    const atual = canal.permissionOverwrites?.cache?.get(roleId);
    if (atual && atual.allow?.has(PermissionFlagsBits.ViewChannel)) continue;
    try {
      await canal.permissionOverwrites.edit(roleId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }, { type: OverwriteType.Role });
      mexeu++;
    } catch (e) { console.error(`[canais] leitura de ${chave} em ${canal.id} falhou: ${e.message}`); }
  }
  return mexeu;
}

module.exports = {
  criarCanalTicket, adicionarMembro, arquivarCanal, reabrirCanal, obterOuCriarCategoria,
  canalTemConversaBloqueada, garantirLeituraPorCargo,
  // exportadas para teste e para quem monta o card de abertura
  overwritesLeituraPorCargo, overwritesImpedimento, mencaoCargosTicket, ehTicketRestrito,
  CARGOS_LEITURA_TICKET,
};
