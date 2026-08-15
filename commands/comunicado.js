const { SlashCommandBuilder } = require('discord.js');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const diarioCmd = require('./diarioOficial');

// /comunicado — publica um comunicado no Diário Oficial, opcionalmente com um PDF anexo. O anexo
// só é possível por aqui (modais do Discord não aceitam upload): o PDF vem na opção do comando,
// depois abre o MESMO modal (título/corpo/links) e a publicação junta o embed + o PDF. Sem a
// opção pdf, funciona igual ao botão "📢 Publicar comunicado" do painel. Gate no handler.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('comunicado')
    .setDescription('(Staff) Publica um comunicado no Diário Oficial (opcionalmente com um PDF anexo)')
    .addAttachmentOption(o => o.setName('pdf').setDescription('Anexo PDF (opcional)').setRequired(false)),

  async execute(interaction) {
    if (!isAdmin(interaction) && !isSuperStaff(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode publicar comunicados.', ephemeral: true });
    }
    const pdf = interaction.options.getAttachment('pdf');
    return diarioCmd.abrirModalComunicado(interaction, pdf);
  },
};
