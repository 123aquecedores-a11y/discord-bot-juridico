const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Cria um canal de texto PÚBLICO e SOMENTE-LEITURA: @everyone vê, lê o histórico e pode clicar
// em botões (interação não exige enviar mensagem), mas NÃO envia texto; só o bot posta. Ponto
// único usado por /criar-diario-oficial e /criar-canal-editais (não duplica a lógica de criação).
// Retorna { canal } em caso de sucesso, ou { erroMsg } (falta de permissão / falha) sem lançar.
async function criarCanalReadonly(guild, botUserId, { nome, topic }) {
  const eu = guild.members.me;
  if (!eu || !eu.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { erroMsg: '⚠️ Não tenho a permissão **Gerenciar Canais** — conceda ao bot e rode o comando de novo.' };
  }
  try {
    const canal = await guild.channels.create({
      name: nome,
      type: ChannelType.GuildText,
      topic,
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
