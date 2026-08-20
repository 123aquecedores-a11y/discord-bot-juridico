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
// A SEGUNDA INSTÂNCIA ENXERGA TUDO (20/08/2026, pedido do operador).
//
// O Desembargador já podia LER os autos por toda porta do bot — `temAcessoTotal`
// (PAPEIS_COMPARTILHADOS) libera o histórico e a listagem, e `CARGOS_QUE_VEEM_TEOR` libera o teor
// das peças gated. O que faltava era o Discord: o canal do ticket nega ViewChannel ao @everyone e
// só abre para os membros nominais e a staff, então ele não via o canal existir. Na prática podia
// ler o processo por comando e não conseguia abrir a porta dele.
//
// LEITURA, não escrita: `deny SendMessages` é deliberado. Ele é instância RECURSAL — acompanha e
// supervisiona, não peticiona em primeiro grau. As ações que ele tem (Supervisão, Designar Juiz,
// Trocar Juiz) são botão/select/modal, que NÃO exigem SendMessages no Discord.
//
// E quando ele É parte do caso, escreve normalmente: overwrite de MEMBRO tem precedência sobre
// overwrite de ROLE no Discord, e quem entra num caso entra por `adicionarMembro`, que grava
// overwrite de membro. O deny de role só alcança quem está ali apenas pelo cargo.
function overwriteSegundaInstancia() {
  if (!config.roleDesembargadorId) return [];
  return [{
    id: config.roleDesembargadorId, type: OverwriteType.Role,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    deny: [PermissionFlagsBits.SendMessages],
  }];
}

async function criarCanalTicket(guild, { categoriaId, prefixo, numero, membros = [], bloquearConversa = false }) {
  guildGuard.exigirGuild(guild, 'canais.criarCanalTicket');
  const permissaoMembro = bloquearConversa
    ? { allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }
    : { allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] };

  const overwrites = [
    { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...membros.map(id => ({ id, type: OverwriteType.Member, ...permissaoMembro })),
  ];
  overwrites.push(...overwriteSegundaInstancia());
  if (config.staffRoleId) {
    overwrites.push({
      id: config.staffRoleId, type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const canal = await guild.channels.create({
    name: `${prefixo}-${slugCanal(numero)}`,
    type: ChannelType.GuildText,
    parent: categoriaId || undefined,
    permissionOverwrites: overwrites,
  });
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

// Aplica o overwrite da segunda instância a um canal que JÁ existe. Chamada no boot, sobre os
// tickets abertos: canal criado antes de 20/08/2026 não tem o overwrite, e sem isto a mudança só
// valeria para processos novos — o Desembargador continuaria sem ver justamente os casos em curso.
//
// Idempotente e silenciosa: se o overwrite já está lá, não faz nada; se falhar, loga e segue. Não
// pode derrubar o boot por causa de permissão de um canal.
async function garantirAcessoSegundaInstancia(canal) {
  if (!config.roleDesembargadorId || !canal) return false;
  const atual = canal.permissionOverwrites?.cache?.get(config.roleDesembargadorId);
  if (atual && atual.allow?.has(PermissionFlagsBits.ViewChannel)) return false;
  try {
    await canal.permissionOverwrites.edit(config.roleDesembargadorId, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: false,
    }, { type: OverwriteType.Role });
    return true;
  } catch (e) {
    console.error(`[canais] não consegui liberar ${canal.id} para a segunda instância: ${e.message}`);
    return false;
  }
}

module.exports = { criarCanalTicket, adicionarMembro, arquivarCanal, reabrirCanal, obterOuCriarCategoria, canalTemConversaBloqueada, garantirAcessoSegundaInstancia };
