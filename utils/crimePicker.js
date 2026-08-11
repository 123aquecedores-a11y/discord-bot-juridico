// UI compartilhada de "adicionar crimes por busca" — usada tanto pelo /painel (abrir
// processo penal direto) quanto pelo fluxo de medida referendada (abrir processo a partir
// de medida). Ambos os pontos de entrada terminam aqui, guiados pelo mesmo rascunho.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const crimes = require('../data/crimes.json');
const rascunhos = require('./rascunhoCrimes');
const { truncar } = require('./texto');
const { crimeLabel } = require('./crimesTexto');

function embedRascunho(rascunho) {
  const lista = rascunho.crimes.map(id => crimes.find(c => c.id === id)).filter(Boolean);
  const txt = lista.length ? lista.map(c => `• ${crimeLabel(c)}`).join('\n') : '*nenhum crime adicionado ainda*';
  return new EmbedBuilder()
    .setTitle('📁 Novo processo penal — crimes')
    .setColor(0xe67e22)
    .setDescription('Busque e adicione ao menos um crime pra poder abrir o processo. Pode buscar quantas vezes quiser.')
    .addFields({ name: 'Crimes selecionados', value: truncar(txt) });
}

function botoesRascunho() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('painel:acao:crimepick:buscar').setLabel('🔍 Adicionar crime').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('painel:acao:crimepick:finalizar').setLabel('✅ Finalizar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('painel:acao:crimepick:cancelar').setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger),
  );
}

// interaction pode ser um modal submit (precisa de reply novo) ou um botão/select (usa update)
async function mostrarPainel(interaction, { novaMensagem }) {
  const rascunho = rascunhos.obter(interaction.user.id);
  if (!rascunho) {
    const payload = { content: 'Sessão expirada, comece de novo pelo painel.', embeds: [], components: [] };
    return novaMensagem ? interaction.reply({ ...payload, ephemeral: true }) : interaction.update(payload);
  }
  const payload = { embeds: [embedRascunho(rascunho)], components: [botoesRascunho()] };
  return novaMensagem ? interaction.reply({ ...payload, ephemeral: true }) : interaction.update(payload);
}

function modalBusca() {
  const modal = new ModalBuilder().setCustomId('painel:modal:crimepick:buscar').setTitle('Buscar crime');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('termo').setLabel('Nome ou artigo do crime').setStyle(TextInputStyle.Short).setRequired(true),
  ));
  return modal;
}

function selectResultados(resultados) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('painel:select:crimepick:resultado').setPlaceholder('Selecione um ou mais crimes')
      .setMinValues(1).setMaxValues(resultados.length)
      .addOptions(resultados.map(c => ({ label: crimeLabel(c).slice(0, 100), value: c.id }))),
  );
}

module.exports = { embedRascunho, botoesRascunho, mostrarPainel, modalBusca, selectResultados };
