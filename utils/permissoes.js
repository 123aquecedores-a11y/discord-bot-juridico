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

// Distinto de propósito de isAdmin(): isAdmin() aceita QUALQUER conta com permissão de
// Administrator do Discord (o dono do servidor tem isso automaticamente) — foi exatamente essa
// generalidade que causou o bug real de um Delegado conseguir aprovar medida (a conta de quem
// testava tinha Administrator). isSuperStaff() só aceita quem tem a role "Staff Salve"
// especificamente, atribuída à mão — não vem de graça com Administrator nem com dono do
// servidor. Usado só nas decisões de mérito com responsável definido (aprovar/negar/referendar
// medida, sentença, decisão de petição/apelação) — é o único lugar onde um "coringa" com
// acesso irrestrito de verdade foi pedido explicitamente.
function isSuperStaff(interaction) {
  if (!interaction.member) return false;
  return !!(config.roleSuperStaffId && interaction.member.roles.cache.has(config.roleSuperStaffId));
}

module.exports = { isAdmin, temCargo, isSuperStaff };
