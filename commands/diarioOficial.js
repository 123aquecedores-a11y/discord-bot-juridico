const { SlashCommandBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const auditoria = require('../utils/auditoria');
const diario = require('../utils/diarioOficial');
const { criarCanalReadonly } = require('../utils/canalReadonly');

function podeStaff(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction);
}

// Modais do Discord NÃO aceitam upload de arquivo — o PDF vem da opção de anexo do /comunicado.
// Guardamos { url, name } por usuário até o submit do modal, aí anexamos na publicação.
const pdfComunicadoPendente = new Map();

// ---- Publicar comunicado no Diário Oficial (staff) — botão do hub ou /comunicado (com PDF) ----
async function abrirModalComunicado(interaction, pdf = null) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode publicar comunicados.', ephemeral: true });
  if (pdf) {
    const ehPdf = pdf.contentType === 'application/pdf' || (pdf.name || '').toLowerCase().endsWith('.pdf');
    if (!ehPdf) return interaction.reply({ content: 'O anexo precisa ser um **PDF**.', ephemeral: true });
    pdfComunicadoPendente.set(interaction.user.id, { url: pdf.url, name: pdf.name || 'anexo.pdf' });
  } else {
    pdfComunicadoPendente.delete(interaction.user.id); // esta emissão não tem PDF
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:comunicado:publicar').setTitle('Publicar comunicado');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('titulo').setLabel('Título').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('corpo').setLabel('Corpo (aceita markdown)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('links').setLabel('Links (opcional, um por linha)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
  );
  return interaction.showModal(modal);
}

async function publicarComunicado(interaction) {
  if (!podeStaff(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode publicar comunicados.', ephemeral: true });
  const titulo = (interaction.fields.getTextInputValue('titulo') || '').trim();
  const corpo = (interaction.fields.getTextInputValue('corpo') || '').trim();
  const linksRaw = (interaction.fields.getTextInputValue('links') || '').trim();
  if (!titulo || !corpo) return interaction.reply({ content: 'Título e corpo são obrigatórios.', ephemeral: true });
  if (!diario.getCanalId()) return interaction.reply({ content: '⚠️ O Diário Oficial ainda não existe. Rode **/criar-diario-oficial** primeiro (ou aguarde o boot criá-lo).', ephemeral: true });

  // Um link por linha → vira uma seção clicável (URL crua é linkada pelo Discord na description).
  const linksTexto = linksRaw
    ? linksRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => `• ${l}`).join('\n')
    : '';

  // PDF anexado via /comunicado (guardado no abrirModalComunicado) — consome e limpa. O
  // discord.js baixa a URL do anexo e reenvia como arquivo permanente na mensagem do Diário.
  const pdf = pdfComunicadoPendente.get(interaction.user.id);
  pdfComunicadoPendente.delete(interaction.user.id);
  const files = pdf ? [{ attachment: pdf.url, name: pdf.name }] : undefined;

  await interaction.deferReply({ ephemeral: true });
  let publicou = false;
  try {
    publicou = await diario.publicarNoDiario(interaction.guild, 'comunicado', { titulo, corpo, linksTexto, files });
  } catch (e) { console.error('[comunicado] falha ao publicar (ignorado):', e.message); }

  await auditoria.registrar(interaction.guild, { acao: 'Comunicado publicado no Diário', executorId: interaction.user.id, referencia: `"${titulo.slice(0, 100)}"${pdf ? ' [com PDF]' : ''}` });
  return interaction.editReply(publicou
    ? `✅ Comunicado publicado no Diário Oficial${pdf ? ' (com PDF anexo)' : ''}.`
    : '⚠️ Não consegui publicar no Diário Oficial (canal ausente ou sem permissão) — a ação foi registrada no log.');
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

  abrirModalComunicado,
  publicarComunicado,
};
