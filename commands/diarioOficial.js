const { SlashCommandBuilder } = require('discord.js');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const auditoria = require('../utils/auditoria');
const diario = require('../utils/diarioOficial');
const { criarCanalReadonly } = require('../utils/canalReadonly');

function podeStaff(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction);
}

// Cria (ou reaproveita) o canal do Diário Oficial Eletrônico — somente-leitura, público. O ID
// fica em estado.diarioOficialId. Idempotente: se já existe/o canal está lá, reaproveita e avisa.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('criar-diario-oficial')
    .setDescription('(Staff) Cria o canal somente-leitura do Diário Oficial (ou reaproveita, se já existir)'),

  async execute(interaction) {
    if (!podeStaff(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode criar o Diário Oficial.', ephemeral: true });
    }

    // Idempotência: já tem ID salvo e o canal ainda existe → reaproveita, não duplica.
    const idSalvo = diario.getCanalId();
    if (idSalvo) {
      const jaExiste = await interaction.guild.channels.fetch(idSalvo).catch(() => null);
      if (jaExiste) {
        return interaction.reply({ content: `ℹ️ O Diário Oficial já existe: ${jaExiste} (ID \`${jaExiste.id}\`). Reaproveitando — nada foi criado.`, ephemeral: true });
      }
      // ID salvo mas o canal foi apagado → cai adiante e recria.
    }

    await interaction.deferReply({ ephemeral: true });
    const { canal, erroMsg } = await criarCanalReadonly(interaction.guild, interaction.client.user.id, {
      nome: '📜│diário-oficial',
      topic: 'Diário Oficial Eletrônico — publicações automáticas de atos oficiais (somente leitura).',
    });
    if (erroMsg) return interaction.editReply(erroMsg);

    diario.setCanalId(canal.id);
    await auditoria.registrar(interaction.guild, {
      acao: 'Diário Oficial criado', executorId: interaction.user.id, referencia: `${canal} (ID ${canal.id})`,
    });
    // Marco de inauguração (também confirma que o bot consegue postar no canal).
    await diario.publicarNoDiario(interaction.guild, 'default', {
      texto: `Diário Oficial Eletrônico instituído por <@${interaction.user.id}>. A partir desta data, os atos oficiais (editais, sentenças, acórdãos, nomeações e mandados) são publicados automaticamente neste canal.`,
    }).catch(() => {});

    return interaction.editReply(`✅ Diário Oficial criado: ${canal} (ID \`${canal.id}\`) — somente-leitura. ID salvo em \`estado.diarioOficialId\`.`);
  },
};
