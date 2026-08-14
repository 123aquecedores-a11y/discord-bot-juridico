const { SlashCommandBuilder } = require('discord.js');
const rh = require('../utils/rh');
const carteirinha = require('../utils/carteirinha');
const { isAdmin } = require('../utils/permissoes');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backfill (Update 2.4): percorre os advogados já cadastrados, atribui OAB a quem não tem,
// (re)gera a carteirinha e envia na DM de cada um. Rate-limit entre envios e DM fechada tratada
// (a própria emitirCarteirinha captura o erro de DM e só loga). Idempotente: quem já tem OAB
// mantém o número (emitirCarteirinha só gera quando falta).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('gerar-carteirinhas')
    .setDescription('(Staff) Atribui OAB e envia a carteirinha na DM de todos os advogados'),

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode rodar o backfill de carteirinhas.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const advogados = rh.listarPorCargo('Advogado');
    if (!advogados.length) return interaction.editReply('Nenhum advogado cadastrado.');

    let enviadas = 0, dmFechada = 0, falha = 0;
    const linhas = [];
    for (const adv of advogados) {
      const r = await carteirinha.emitirCarteirinha(interaction.guild, adv.discordId).catch(() => null);
      if (!r || !r.ok) { falha++; linhas.push(`❌ <@${adv.discordId}> — falha ao gerar carteirinha`); }
      else if (r.dmOk) { enviadas++; linhas.push(`✅ <@${adv.discordId}> — OAB ${r.oab} (DM enviada)`); }
      else { dmFechada++; linhas.push(`⚠️ <@${adv.discordId}> — OAB ${r.oab} (DM fechada)`); }
      await sleep(1200); // rate-limit entre renders/DMs
    }

    const resumo = `🪪 **Backfill de carteirinhas** — ${advogados.length} advogado(s):\n`
      + `✅ ${enviadas} enviada(s) · ⚠️ ${dmFechada} com DM fechada · ❌ ${falha} falha(s)\n\n`
      + linhas.join('\n');
    return interaction.editReply(resumo.slice(0, 1900));
  },
};
