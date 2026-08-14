const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// Cria um canal de texto PÚBLICO e SOMENTE-LEITURA: @everyone vê, lê o histórico e pode clicar
// em botões (interação não exige enviar mensagem), mas NÃO envia texto; só o bot posta. Ponto
// único usado por /criar-diario-oficial, /criar-canal-editais e pela auto-criação no boot
// (garantirCanais) — não duplica a lógica de criação. Retorna { canal } em caso de sucesso, ou
// { erroMsg } (falta de permissão / falha), SEM lançar.
async function criarCanalReadonly(guild, botUserId, { nome, topic, parentId } = {}) {
  // guild.members.me pode não estar populado logo no boot (evento ready) — cai pro fetchMe().
  const eu = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!eu || !eu.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { erroMsg: '⚠️ Não tenho a permissão **Gerenciar Canais** — conceda ao bot e tente de novo.' };
  }
  // Categoria pai: usa a informada, senão CATEGORIA_ID (config), senão a raiz do servidor.
  const parent = parentId || config.categoriaPublicacoesId || null;
  try {
    const canal = await guild.channels.create({
      name: nome,
      type: ChannelType.GuildText,
      topic,
      ...(parent ? { parent } : {}),
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.AddReactions],
        },
        {
          id: botUserId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages],
        },
      ],
    });
    return { canal };
  } catch (e) {
    return { erroMsg: `❌ Não consegui criar o canal: \`${e.message}\`. Verifique a permissão "Gerenciar Canais" e a posição do cargo do bot na hierarquia.` };
  }
}

module.exports = { criarCanalReadonly };
