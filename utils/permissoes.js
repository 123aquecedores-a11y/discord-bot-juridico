const { PermissionFlagsBits } = require('discord.js');
const rh = require('./rh');
const config = require('../config');

// Staff/dono do Discord: fora da hierarquia jurídica, controle total (visão + ação em tudo).
// interaction.member é null quando a interação vem de DM (ex: botão de notificação) — sem
// contexto de servidor não dá pra checar permissão/cargo administrativo, só cai pro cargo
// jurídico normal (que já é checado por ID, sem depender de member).
function isAdmin(interaction) {
  if (!interaction.member) return false;
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId)) return true;
  return false;
}

function temCargo(interaction, cargo) {
  if (isAdmin(interaction)) return true;
  return rh.temCargo(interaction.user.id, cargo);
}

module.exports = { isAdmin, temCargo };
