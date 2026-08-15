const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { textoVersao } = require('../utils/versao');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');

// /versao — mostra o commit/build em execução. Só Staff: é informação de operação, não de RP.
// Serve pra confirmar, sem adivinhar por sintoma, QUAL código está no ar (ex.: se as correções de
// segurança já subiram). Lembrete: como é slash command novo, rode `npm run deploy` uma vez depois
// do deploy pra ele aparecer no servidor.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('versao')
    .setDescription('Mostra a versão/commit do bot em execução (Staff)'),
  async execute(interaction) {
    if (!isAdmin(interaction) && !isSuperStaff(interaction)) {
      return interaction.reply({ content: 'Só a Staff/Administração pode ver a versão do sistema.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle('🔖 Versão do sistema em execução')
      .setColor(0x34495e)
      .setDescription(textoVersao());
    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
