const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const crimes = require('../data/crimes.json');
const { penaTexto, crimeLabel, buscarCrimes } = require('../utils/crimesTexto');

function embedCrime(crime) {
  return new EmbedBuilder()
    .setTitle(crimeLabel(crime))
    .setColor(crime.apuracao === 'corregedoria' ? 0x95a5a6 : 0xc0392b)
    .addFields(
      { name: 'Título', value: crime.titulo, inline: true },
      { name: 'Pena', value: penaTexto(crime), inline: true },
      { name: 'Elegível a atenuantes', value: crime.elegivel_atenuante ? 'Sim' : 'Não', inline: true },
      { name: 'Multa / medida', value: crime.multa_medida_obs },
      { name: 'Fiança sugerida (referência)', value: crime.fianca_sugerida || 'Não informada' },
      { name: 'Conduta resumida', value: crime.conduta_resumida },
      { name: 'ID pra usar em /processo penal', value: `\`${crime.id}\`` },
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('crime')
    .setDescription('Consulta a base de crimes do Código Penal')
    .addSubcommand(sub => sub.setName('buscar').setDescription('Busca um crime pelo nome ou artigo')
      .addStringOption(o => o.setName('termo').setDescription('Nome ou artigo do crime').setRequired(true).setAutocomplete(true))),

  async execute(interaction) {
    const termo = interaction.options.getString('termo');
    const crime = crimes.find(c => c.id === termo) || crimes.find(c => c.nome.toLowerCase() === termo.toLowerCase());

    if (!crime) {
      return interaction.reply({ content: 'Crime não encontrado. Use a busca com autocomplete pra achar o ID certo.', ephemeral: true });
    }

    return interaction.reply({ embeds: [embedCrime(crime)], ephemeral: true });
  },

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused();
    const resultados = buscarCrimes(foco).map(c => ({ name: crimeLabel(c).slice(0, 100), value: c.id }));
    await interaction.respond(resultados);
  },

  embedCrime,
};
