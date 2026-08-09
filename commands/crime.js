const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const crimes = require('../data/crimes.json');

function embedCrime(crime) {
  return new EmbedBuilder()
    .setTitle(`${crime.nome} (Art. ${crime.artigo})`)
    .setColor(crime.esfera === 'militar' ? 0x95a5a6 : 0xc0392b)
    .addFields(
      { name: 'Capítulo', value: crime.capitulo, inline: true },
      { name: 'Esfera', value: crime.esfera === 'militar' ? 'Militar (CPM)' : 'Civil', inline: true },
      { name: 'Afiançável', value: crime.afiancavel ? 'Sim' : 'Não', inline: true },
      { name: 'Pena sugerida', value: `${crime.pena_meses} meses`, inline: true },
      { name: 'Multa sugerida', value: `$${crime.multa}`, inline: true },
      { name: 'Descrição', value: crime.descricao },
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
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = crimes
      .filter(c => c.nome.toLowerCase().includes(foco) || c.artigo.toLowerCase().includes(foco) || c.id.includes(foco))
      .slice(0, 25)
      .map(c => ({ name: `${c.nome} (Art. ${c.artigo})`.slice(0, 100), value: c.id }));
    await interaction.respond(resultados);
  },

  embedCrime,
};
