// Cadastro de instituições — destinatários de ofício (spec-atualizacoes-bot-juridico.md, seção
// 6). Editável em tempo real, sem mexer em código/deploy — o pedido explícito da spec.
const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { isAdmin, temCargo } = require('../utils/permissoes');
const instituicoes = require('../utils/instituicoes');

function podeGerenciar(interaction) {
  return isAdmin(interaction) || temCargo(interaction, 'Procurador');
}

function embedInstituicoes(lista) {
  const linhas = lista.map(i => `**${i.slug}** — ${i.nome}${i.pai ? ` _(sob ${i.pai})_` : ''}`);
  return new EmbedBuilder().setTitle('🏛️ Instituições cadastradas').setColor(0x34495e)
    .setDescription(linhas.join('\n') || 'Nenhuma instituição cadastrada ainda.');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('instituicao')
    .setDescription('Cadastro de instituições destinatárias de ofício')
    .addSubcommand(sub => sub.setName('adicionar').setDescription('Adiciona uma instituição ao cadastro'))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista as instituições cadastradas')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'adicionar') {
      if (!podeGerenciar(interaction)) {
        return interaction.reply({ content: 'Só Procurador ou Staff/Administração podem editar o cadastro de instituições.', ephemeral: true });
      }
      const modal = new ModalBuilder().setCustomId('painel:modal:instituicao:adicionar').setTitle('Adicionar instituição');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('slug').setLabel('ID (slug, ex: pm_novo_batalhao)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pai').setLabel('Órgão superior (ID do pai, ou "nenhum")').setStyle(TextInputStyle.Short).setRequired(false)),
      );
      return interaction.showModal(modal);
    }

    if (sub === 'listar') {
      return interaction.reply({ embeds: [embedInstituicoes(instituicoes.listar())], ephemeral: true });
    }
  },

  async processarModalAdicionar(interaction) {
    // Re-checa a permissão no submit do modal — a interação do modal é separada da que abriu o
    // formulário (execute), então não dá pra confiar só naquele gate anterior.
    if (!podeGerenciar(interaction)) {
      return interaction.reply({ content: 'Só Procurador ou Staff/Administração podem editar o cadastro de instituições.', ephemeral: true });
    }
    const nome = interaction.fields.getTextInputValue('nome');
    const slug = interaction.fields.getTextInputValue('slug').trim();
    const paiTexto = interaction.fields.getTextInputValue('pai').trim().toLowerCase();
    const paiSlug = !paiTexto || paiTexto === 'nenhum' ? null : paiTexto;

    const resultado = instituicoes.adicionar({ nome, slug, paiSlug });
    if (resultado.erro) return interaction.reply({ content: `❌ ${resultado.erro}`, ephemeral: true });

    return interaction.reply({ content: `✅ Instituição **${nome}** (\`${slug}\`) adicionada ao cadastro.`, ephemeral: true });
  },
};
