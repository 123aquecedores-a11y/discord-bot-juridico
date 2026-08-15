const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const P = PermissionFlagsBits;

// Núcleo da criação de canal (checa "Gerenciar Canais", resolve categoria, cria) — não lança:
// retorna { canal } ou { erroMsg }. Usado pelos dois formatos abaixo (readonly público / staff).
async function criarCanalBase(guild, { nome, topic, parentId, overwrites }) {
  // guild.members.me pode não estar populado logo no boot (ready) — cai pro fetchMe().
  const eu = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!eu || !eu.permissions.has(P.ManageChannels)) {
    return { erroMsg: '⚠️ Não tenho a permissão **Gerenciar Canais** — conceda ao bot e tente de novo.' };
  }
  const parent = parentId || config.categoriaPublicacoesId || null; // CATEGORIA_ID se houver, senão raiz
  try {
    const canal = await guild.channels.create({
      name: nome,
      type: ChannelType.GuildText,
      topic,
      ...(parent ? { parent } : {}),
      permissionOverwrites: overwrites,
    });
    return { canal };
  } catch (e) {
    return { erroMsg: `❌ Não consegui criar o canal: \`${e.message}\`. Verifique a permissão "Gerenciar Canais" e a posição do cargo do bot na hierarquia.` };
  }
}

// Público SOMENTE-LEITURA: @everyone vê, lê e clica em botões, mas NÃO envia; só o bot posta (e pode
// mencionar @everyone — usado pra notificar o edital). Usado por Diário Oficial e Editais.
async function criarCanalReadonly(guild, botUserId, opts = {}) {
  return criarCanalBase(guild, {
    ...opts,
    overwrites: [
      { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions] },
      { id: botUserId, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ManageMessages, P.MentionEveryone] },
    ],
  });
}

// STAFF-ONLY: @everyone SEM acesso; roles de staff (staffRoleId / roleSuperStaffId) veem e clicam
// nos botões, mas não enviam; só o bot posta os cards. Usado pelo canal de análise de inscrições.
// (Admins do Discord enxergam de qualquer forma — Administrator ignora overwrites.)
async function criarCanalStaff(guild, botUserId, opts = {}) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: botUserId, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ManageMessages] },
  ];
  for (const rid of [config.staffRoleId, config.roleSuperStaffId]) {
    if (rid) overwrites.push({ id: rid, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] });
  }
  return criarCanalBase(guild, { ...opts, overwrites });
}

module.exports = { criarCanalReadonly, criarCanalStaff };
