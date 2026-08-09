const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');
const config = require('../config');

function slugCanal(numero) {
  return numero.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// Cria um canal privado dentro de uma categoria, visível só pros IDs de usuário passados
// (+ o cargo de staff, se configurado, sempre enxerga tudo).
// `type` é sempre explícito (Member/Role) — sem isso, o discord.js só consegue inferir o
// tipo checando se o ID está em cache, e como o bot roda só com o intent "Guilds" (sem
// GuildMembers), qualquer pessoa que não interagiu com o bot recentemente não está em cache,
// e a criação do canal quebra com "Supplied parameter is not a cached User or Role".
async function criarCanalTicket(guild, { categoriaId, prefixo, numero, membros = [] }) {
  const overwrites = [
    { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...membros.map(id => ({
      id, type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];
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
async function adicionarMembro(canal, discordId) {
  try {
    await canal.permissionOverwrites.edit(discordId, {
      ViewChannel: true,
      SendMessages: true,
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

module.exports = { criarCanalTicket, adicionarMembro, arquivarCanal, reabrirCanal };
