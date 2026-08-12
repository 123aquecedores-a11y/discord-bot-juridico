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
  // Frente 6: Administrator do Discord NÃO age mais como cargo jurídico — fechava o furo de
  // qualquer admin/dono conseguir agir como Delegado/Promotor/Juiz/etc. sem ter a role de RP.
  // Staff DE VERDADE continua podendo (pela role TRIBUNAL/staffRoleId ou Staff Salve/SuperStaff),
  // pra conseguir administrar e contratar depois do reset. isAdmin/isSuperStaff seguem intactos.
  if (!interaction.member) return rh.temCargo(interaction.user.id, cargo);
  if (config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId)) return true;
  if (isSuperStaff(interaction)) return true;
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

// Mapa cargo → instituição do cabeçalho de documentos (ofício, certidão) — Frente 4a.3. Estava
// duplicado em oficio.js (instituicaoDoEmissor) e certidoes.js (instituicaoDoSolicitante), a de
// ofício só acrescentando o ramo do Delegado. Fonte única aqui (usa temCargo, então isAdmin
// também resolve, mantendo o comportamento de antes).
function papelInstitucional(interaction) {
  if (temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador')) return 'MINISTÉRIO PÚBLICO';
  if (temCargo(interaction, 'Delegado')) return 'POLÍCIA CIVIL';
  return 'PODER JUDICIÁRIO';
}

module.exports = { isAdmin, temCargo, isSuperStaff, papelInstitucional };
