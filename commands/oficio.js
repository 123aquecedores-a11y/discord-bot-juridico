const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { proximoNumeroClassico } = require('../utils/numeracao');
const { temCargo, isAdmin } = require('../utils/permissoes');
const config = require('../config');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');

async function criarOficio({ guild, processoNumero, destinatario, assunto, conteudo, emitidoPorId, emitidoPorTag }) {
  const processo = db.buscarPorNumero('processos', processoNumero);
  if (!processo) return { erro: 'Processo não encontrado.' };

  const numero = proximoNumeroClassico(db, 'oficios', 'OFI');
  db.inserir('oficios', { numero, processoNumero, destinatario, assunto, conteudo, emitidoPor: emitidoPorId });

  const embed = new EmbedBuilder()
    .setTitle(`✉️ Ofício ${numero}`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Processo', value: processoNumero, inline: true },
      { name: 'Destinatário', value: truncar(destinatario), inline: true },
      { name: 'Assunto', value: truncar(assunto) },
      { name: 'Conteúdo', value: truncar(conteudo) },
    )
    .setFooter({ text: `Emitido por ${emitidoPorTag}` });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) await canal.send({ embeds: [embed] });

  await auditoria.registrar(guild, { acao: 'Ofício emitido', executorId: emitidoPorId, referencia: `${numero} (processo ${processoNumero})` });
  return { numero };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('oficio')
    .setDescription('Emite ofícios vinculados a um processo')
    .addSubcommand(sub => sub.setName('criar').setDescription('Cria um ofício')
      .addStringOption(o => o.setName('processo').setDescription('Número do processo vinculado').setRequired(true))
      .addStringOption(o => o.setName('destinatario').setDescription('Destinatário').setRequired(true))
      .addStringOption(o => o.setName('assunto').setDescription('Assunto').setRequired(true))
      .addStringOption(o => o.setName('conteudo').setDescription('Conteúdo').setRequired(true))),

  async execute(interaction) {
    const permitido = temCargo(interaction, 'Delegado') || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Juiz') || isAdmin(interaction);
    if (!permitido) return interaction.reply({ content: 'Só Delegado, Promotor, Juiz ou Staff/Administração podem emitir ofício.', ephemeral: true });

    const resultado = await criarOficio({
      guild: interaction.guild,
      processoNumero: interaction.options.getString('processo'),
      destinatario: interaction.options.getString('destinatario'),
      assunto: interaction.options.getString('assunto'),
      conteudo: interaction.options.getString('conteudo'),
      emitidoPorId: interaction.user.id,
      emitidoPorTag: interaction.user.tag,
    });

    if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
    return interaction.reply({ content: `Ofício ${resultado.numero} registrado no canal do processo.`, ephemeral: true });
  },

  criarOficio,
};
