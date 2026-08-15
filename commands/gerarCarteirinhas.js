const { SlashCommandBuilder } = require('discord.js');
const rh = require('../utils/rh');
const carteirinha = require('../utils/carteirinha');
const { isAdmin } = require('../utils/permissoes');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backfill (staff): (re)gera e reenvia a carteira CERTA (OAB p/ Advogado; matrícula funcional p/
// Juiz/Desembargador/Promotor/Procurador) na DM de TODOS os detentores atuais desses cargos.
// Idempotente: quem já tem OAB/matrícula mantém o número (emitirCarteirinha só gera quando falta).
// Rate-limit entre envios e DM fechada tratada (a própria emitirCarteirinha captura e só loga).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('gerar-carteirinhas')
    .setDescription('(Staff) (Re)gera e reenvia as carteiras (OAB/Juiz/Desemb./Promotor/Procurador) nas DMs'),

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode rodar o backfill de carteiras.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    // Junta os detentores de todos os cargos com carteira, sem repetir a mesma pessoa.
    const vistos = new Set();
    const alvos = [];
    for (const cargo of carteirinha.CARGOS_COM_CARTEIRA) {
      for (const m of rh.listarPorCargo(cargo)) {
        if (!vistos.has(m.discordId)) { vistos.add(m.discordId); alvos.push(m); }
      }
    }
    if (!alvos.length) return interaction.editReply('Nenhum detentor de cargo com carteira encontrado.');

    let enviadas = 0, dmFechada = 0, falha = 0;
    const linhas = [];
    for (const alvo of alvos) {
      const r = await carteirinha.emitirCarteirinha(interaction.guild, alvo.discordId).catch(() => null);
      if (!r || !r.ok) { falha++; linhas.push(`❌ <@${alvo.discordId}> (${alvo.cargo}) — falha ao gerar`); }
      else if (r.dmOk) { enviadas++; linhas.push(`✅ <@${alvo.discordId}> (${alvo.cargo}) — nº ${r.numero} (DM enviada)`); }
      else { dmFechada++; linhas.push(`⚠️ <@${alvo.discordId}> (${alvo.cargo}) — nº ${r.numero} (DM fechada)`); }
      await sleep(1200); // rate-limit entre renders/DMs
    }

    const resumo = `🪪 **Backfill de carteiras** — ${alvos.length} pessoa(s):\n`
      + `✅ ${enviadas} enviada(s) · ⚠️ ${dmFechada} com DM fechada · ❌ ${falha} falha(s)\n\n`
      + linhas.join('\n');
    return interaction.editReply(resumo.slice(0, 1900));
  },
};
