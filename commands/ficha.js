// "Puxar ficha": consulta o registro central de cidadão que o bot vai acumulando sozinho
// conforme as petições são protocoladas — nome atual + histórico, CPF, toda conta de Discord
// já vinculada, endereço(s) e as petições já protocoladas em nome desse CPF. Não é dado
// digitado na hora: é o que já existe na base por causa do uso normal do bot.
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const rh = require('../utils/rh');
const fichaUtil = require('../utils/ficha');
const cruzamento = require('../utils/cruzamento');
const { isAdmin } = require('../utils/permissoes');
const { truncar } = require('../utils/texto');

const TIPO_LABEL = { PorteArma: 'Porte de Arma', TrocaNome: 'Troca de Nome', LimpezaFicha: 'Limpeza de Ficha' };

function podeConsultar(interaction) {
  return isAdmin(interaction) || !!rh.getCargo(interaction.user.id);
}

function embedFicha(registro) {
  const embed = new EmbedBuilder()
    .setTitle(`🗂️ Ficha — CPF ${registro.cpf}`)
    .setColor(0x2c3e50)
    .addFields(
      { name: 'Nome atual', value: registro.nomeCivil || '—', inline: true },
      { name: 'Trocas de nome', value: String(registro.trocasDeNome || 0), inline: true },
    );

  if ((registro.historicoNomes || []).length > 0) {
    embed.addFields({ name: 'Nomes anteriores', value: truncar(registro.historicoNomes.map(h => h.nome).join(', ')) });
  }

  embed.addFields({
    name: 'Discord vinculado',
    value: (registro.discordIds || []).length > 0 ? registro.discordIds.map(id => `<@${id}>`).join(', ') : 'Nenhum vinculado ainda',
  });

  embed.addFields({
    name: `Endereço(s) (${(registro.enderecos || []).length})`,
    value: (registro.enderecos || []).length > 0
      ? truncar(registro.enderecos.map(e => `• ${e.endereco} (via ${e.origem})`).join('\n'))
      : '—',
  });

  const peticoes = fichaUtil.peticoesDoCPF(registro.cpf);
  embed.addFields({
    name: `Petições protocoladas (${peticoes.length})`,
    value: peticoes.length > 0
      ? truncar(peticoes.map(p => `• ${p.numero} — ${TIPO_LABEL[p.tipo]} — *${p.status}*`).join('\n'))
      : '—',
  });

  if ((registro.discordIds || []).length > 0) {
    embed.addFields({ name: 'Cruzamento de antecedentes', value: truncar(cruzamento.resumoTextoPorCPF(registro.cpf)) });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ficha')
    .setDescription('Consulta a ficha central de um cidadão (dados acumulados pelo uso do bot)')
    .addSubcommand(sub => sub.setName('buscar').setDescription('Busca a ficha por CPF ou por conta de Discord')
      .addStringOption(o => o.setName('cpf').setDescription('CPF do cidadão'))
      .addUserOption(o => o.setName('discord').setDescription('Conta de Discord vinculada ao cidadão'))),

  async execute(interaction) {
    if (!podeConsultar(interaction)) {
      return interaction.reply({ content: 'Só quem tem cargo jurídico (ou Staff) pode consultar fichas.', ephemeral: true });
    }

    const cpf = interaction.options.getString('cpf');
    const discordUser = interaction.options.getUser('discord');
    if (!cpf && !discordUser) {
      return interaction.reply({ content: 'Informe `cpf` ou `discord` pra buscar.', ephemeral: true });
    }

    const registro = cpf ? fichaUtil.buscarPorCPF(cpf) : fichaUtil.buscarPorDiscordId(discordUser.id);
    if (!registro) {
      return interaction.reply({ content: 'Nenhuma ficha encontrada com esse critério — ainda não há petição registrada pra essa pessoa.', ephemeral: true });
    }

    return interaction.reply({ embeds: [embedFicha(registro)], ephemeral: true });
  },
};
