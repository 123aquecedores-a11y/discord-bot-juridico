const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const rh = require('../utils/rh');
const { isAdmin } = require('../utils/permissoes');
const config = require('../config');
const auditoria = require('../utils/auditoria');

function roleIdPorCargo(cargo) {
  return {
    Delegado: config.roleDelegadoId,
    Promotor: config.rolePromotorId,
    Juiz: config.roleJuizId,
    Advogado: config.roleAdvogadoId,
    Desembargador: config.roleDesembargadorId,
    Procurador: config.roleProcuradorId,
  }[cargo];
}

async function contratarComRole(guild, usuarioId, cargo, executorId = null) {
  rh.contratar(usuarioId, cargo);
  const roleId = roleIdPorCargo(cargo);
  if (roleId) {
    const membro = await guild.members.fetch(usuarioId).catch(() => null);
    if (membro) await membro.roles.add(roleId).catch(() => {});
  }
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: contratação', executorId, referencia: `<@${usuarioId}> → ${cargo}` });
  }
}

async function demitirComRole(guild, usuarioId, executorId = null) {
  const registro = rh.getCargo(usuarioId);
  rh.demitir(usuarioId);
  if (registro) {
    const roleId = roleIdPorCargo(registro.cargo);
    if (roleId) {
      const membro = await guild.members.fetch(usuarioId).catch(() => null);
      if (membro) await membro.roles.remove(roleId).catch(() => {});
    }
  }
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: demissão', executorId, referencia: `<@${usuarioId}>${registro ? ` (era ${registro.cargo})` : ''}` });
  }
  return registro;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rh')
    .setDescription('Gestão de cargos jurídicos (só Staff/Administração)')
    .addSubcommand(sub => sub.setName('contratar').setDescription('Atribui um cargo jurídico a alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai receber o cargo').setRequired(true))
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c })))))
    .addSubcommand(sub => sub.setName('demitir').setDescription('Remove o cargo jurídico de alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai perder o cargo').setRequired(true)))
    .addSubcommand(sub => sub.setName('licenca').setDescription('Marca/desmarca alguém como afastado')
      .addUserOption(o => o.setName('usuario').setDescription('Quem entra/sai de licença').setRequired(true))
      .addBooleanOption(o => o.setName('afastado').setDescription('true = entra de licença, false = volta ativo').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista quem está em cada cargo')
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c }))))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });
    }

    if (sub === 'contratar') {
      const usuario = interaction.options.getUser('usuario');
      const cargo = interaction.options.getString('cargo');
      await contratarComRole(interaction.guild, usuario.id, cargo, interaction.user.id);
      return interaction.reply({ content: `${usuario} agora é **${cargo}**.` });
    }

    if (sub === 'demitir') {
      const usuario = interaction.options.getUser('usuario');
      await demitirComRole(interaction.guild, usuario.id, interaction.user.id);
      return interaction.reply({ content: `${usuario} foi removido do cargo jurídico.` });
    }

    if (sub === 'licenca') {
      const usuario = interaction.options.getUser('usuario');
      const afastado = interaction.options.getBoolean('afastado');
      const atualizado = rh.setLicenca(usuario.id, afastado);
      if (!atualizado) return interaction.reply({ content: 'Essa pessoa não tem cargo jurídico ativo.', ephemeral: true });
      await auditoria.registrar(interaction.guild, {
        acao: `RH: ${afastado ? 'licença' : 'retorno de licença'}`, executorId: interaction.user.id, referencia: `${usuario}`,
      });
      return interaction.reply({ content: `${usuario} agora está ${afastado ? '**de licença**' : '**ativo**'}.` });
    }

    if (sub === 'listar') {
      const cargo = interaction.options.getString('cargo');
      const lista = rh.listarPorCargo(cargo);
      if (lista.length === 0) return interaction.reply({ content: `Ninguém com o cargo ${cargo} no momento.`, ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle(`Cargo: ${cargo}`)
        .setColor(0x3498db)
        .setDescription(lista.map(r => `<@${r.discordId}>${r.licenca ? ' — *de licença*' : ''}`).join('\n'));

      return interaction.reply({ embeds: [embed] });
    }
  },

  contratarComRole,
  demitirComRole,
};
