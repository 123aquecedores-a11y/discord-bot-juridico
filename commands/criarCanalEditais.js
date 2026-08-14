const { SlashCommandBuilder } = require('discord.js');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const auditoria = require('../utils/auditoria');
const estado = require('../utils/estado');
const { criarCanalReadonly } = require('../utils/canalReadonly');

const CHAVE = 'canalEditaisId';

function podeStaff(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction);
}

// Cria (ou reaproveita) o canal público 📢│editais onde os editais são postados. @everyone vê e
// CLICA nos botões de inscrição, mas não envia mensagem; só o bot posta. O ID fica em
// estado.canalEditaisId (storage, não env — env é read-only em runtime). Idempotente.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('criar-canal-editais')
    .setDescription('(Staff) Cria o canal público de editais (ou reaproveita, se já existir)'),

  async execute(interaction) {
    if (!podeStaff(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode criar o canal de editais.', ephemeral: true });
    }

    // Idempotência: já tem ID salvo e o canal ainda existe → reaproveita.
    const idSalvo = estado.obter(CHAVE);
    if (idSalvo) {
      const jaExiste = await interaction.guild.channels.fetch(idSalvo).catch(() => null);
      if (jaExiste) {
        return interaction.reply({ content: `ℹ️ O canal de editais já existe: ${jaExiste} (ID \`${jaExiste.id}\`). Reaproveitando — nada foi criado.`, ephemeral: true });
      }
      // ID salvo mas o canal foi apagado → recria.
    }

    await interaction.deferReply({ ephemeral: true });
    const { canal, erroMsg } = await criarCanalReadonly(interaction.guild, interaction.client.user.id, {
      nome: '📢│editais',
      topic: 'Editais de processo seletivo — inscrições pelos botões abaixo de cada edital (somente leitura).',
    });
    if (erroMsg) return interaction.editReply(erroMsg);

    estado.definir(CHAVE, canal.id);
    await auditoria.registrar(interaction.guild, {
      acao: 'Canal de editais criado', executorId: interaction.user.id, referencia: `${canal} (ID ${canal.id})`,
    });
    return interaction.editReply(`✅ Canal de editais criado: ${canal} (ID \`${canal.id}\`) — somente-leitura. ID salvo em \`estado.canalEditaisId\`. Agora use \`/abrir-edital\`.`);
  },
};
