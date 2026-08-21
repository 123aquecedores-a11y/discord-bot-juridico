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

// ATOS POR CARGO (19/08/2026) — a ponte entre a interação do Discord e utils/atosPorCargo.js, que é
// puro e não conhece discord.js.
//
// Substitui o padrão que estava repetido em ~40 lugares:
//     if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) { recusa }
// por:
//     if (!podeAtuarNoCaso(interaction, processo, 'juiz')) { recusa }
//
// A diferença de comportamento: além do titular e da staff, agora QUEM TEM O CARGO também pode —
// um juiz cobre o outro. Só vale para magistratura e MP; delegado, autor e advogado continuam
// presos à identidade (ver CARGO_DO_CAMPO).
function podeAtuarNoCaso(interaction, registro, campo) {
  const atos = require('./atosPorCargo');
  const cargo = atos.CARGO_DO_CAMPO[campo];
  // Campo fora do mapa = não é papel compartilhável: mantém a regra antiga, identidade estrita.
  if (!cargo) return (registro && registro[campo]) === interaction.user.id || isSuperStaff(interaction);
  return atos.podeAtuar({
    usuarioId: interaction.user.id,
    cargo,
    titularId: registro ? registro[campo] : null,
    ehStaff: isSuperStaff(interaction) || isAdmin(interaction),
  });
}

// Mensagem de recusa correspondente, já com o nome do titular quando existe (ele continua sendo o
// dono do caso para notificação e organização — só deixou de ser o único que pode agir).
function recusaDoCaso(registro, campo, ato = 'praticar este ato') {
  const atos = require('./atosPorCargo');
  const cargo = atos.CARGO_DO_CAMPO[campo] || campo;
  const titular = registro && registro[campo];
  const dono = titular ? ` O responsável registrado é <@${titular}>.` : '';
  return `${atos.recusa(cargo, ato)}${dono}`;
}

// Mapa cargo → instituição do cabeçalho de documentos (ofício, certidão) — Frente 4a.3. Fonte
// única do mapa: ofício, certidão e petição chamam esta função direto (usa temCargo, então
// isAdmin também resolve, mantendo o comportamento de antes).
function papelInstitucional(interaction) {
  if (temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador')) return 'MINISTÉRIO PÚBLICO';
  if (temCargo(interaction, 'Delegado')) return 'POLÍCIA CIVIL';
  return 'PODER JUDICIÁRIO';
}


// ---------------------------------------------------------------------------
// PODER ADMINISTRATIVO — a função ÚNICA (21/08/2026)
// ---------------------------------------------------------------------------
// Antes disso, "quem pode administrar" era `isAdmin(x) || isSuperStaff(x)` repetido em ~15 pontos
// de commands/painel.js e mais alguns em rh.js. Espalhado assim, acrescentar um cargo significava
// caçar cada condicional — e esquecer uma é como um poder fica pela metade.
//
// LÊ O RH, NÃO A ROLE DO DISCORD, e é a diferença que importa:
//   - `isAdmin` olha `member.permissions.has(Administrator)` e a role de staff;
//   - `isSuperStaff` olha a role "Staff Salve".
// Os dois continuam valendo (staff é staff), mas Desembargador e Procurador entram pelo CARGO
// ATIVO NO RH — `rh.temCargo`, que não conhece discord.js. O RH é a fonte da verdade do projeto, e
// role do Discord já deu falso positivo aqui antes. Consequência prática: quem é demitido no /rh
// perde o poder no mesmo instante, sem ninguém precisar mexer em role.
//
// NÍVEL 1 E NÍVEL 2 numa função só, de propósito: hoje ninguém tem um sem o outro — staff tem os
// dois, e os dois cargos novos receberam os dois. Duas funções idênticas seriam duas coisas para
// divergir. Se um dia um nível se separar do outro, é AQUI que ele se separa.
const CARGOS_ADMINISTRATIVOS = ['Desembargador', 'Procurador'];

function podeAdministrar(interaction) {
  if (!interaction || !interaction.user) return false;
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
  return CARGOS_ADMINISTRATIVOS.some(cargo => rh.temCargo(interaction.user.id, cargo));
}

// Mensagem única da recusa — para os ~15 pontos não escreverem 15 textos diferentes para a mesma
// regra, e para quem lê saber POR QUE foi recusado.
const RECUSA_ADMINISTRATIVA = 'Só Staff/Administração, Desembargador ou Procurador podem usar isso. '
  + 'O poder vem do cargo ATIVO no `/rh` — se você foi demitido ou está de licença, ele cai junto.';

module.exports = { isAdmin, temCargo, isSuperStaff, papelInstitucional, podeAtuarNoCaso, recusaDoCaso,
  podeAdministrar, CARGOS_ADMINISTRATIVOS, RECUSA_ADMINISTRATIVA };
