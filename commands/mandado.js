const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { truncar } = require('../utils/texto');

function embedMandado(mandado) {
  return new EmbedBuilder()
    .setTitle(`📜 Mandado ${mandado.numero}`)
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Tipo', value: mandado.tipo, inline: true },
      { name: 'Status', value: mandado.status, inline: true },
      { name: 'Alvo', value: truncar(mandado.alvo) },
      { name: 'Medida vinculada', value: mandado.medidaNumero, inline: true },
      { name: 'Emitido por (Juiz)', value: `<@${mandado.emitidoPor}>`, inline: true },
      { name: 'Cumprido por', value: mandado.cumpridoPor ? `<@${mandado.cumpridoPor}>` : '—', inline: true },
    );
}

// Mandados agora nascem automaticamente quando um Juiz referenda uma medida provisória
// (ver commands/medida.js -> referendar). Aqui ficam só consulta e listagem.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('mandado')
    .setDescription('Consulta mandados (emitidos automaticamente ao referendar uma medida)')
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de um mandado')
      .addStringOption(o => o.setName('numero').setDescription('Número do mandado').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista mandados')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status').addChoices(
        { name: 'Emitido', value: 'Emitido' },
        { name: 'Cumprido', value: 'Cumprido' },
      ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'ver') {
      const numero = interaction.options.getString('numero');
      const mandado = db.buscarPorNumero('mandados', numero);
      if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
      return interaction.reply({ embeds: [embedMandado(mandado)] });
    }

    if (sub === 'listar') {
      const status = interaction.options.getString('status');
      const rows = db.todos('mandados', status ? m => m.status === status : null).slice(0, 15);
      if (rows.length === 0) return interaction.reply({ content: 'Nenhum mandado encontrado.', ephemeral: true });
      const embed = new EmbedBuilder().setTitle('📜 Mandados').setColor(0x2ecc71)
        .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
      return interaction.reply({ embeds: [embed] });
    }
  },

  embedMandado,
};
