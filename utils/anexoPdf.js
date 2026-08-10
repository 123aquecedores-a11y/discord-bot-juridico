const canais = require('./canais');

// Padrão universal pra anexar PDF via botão — o ModalBuilder do discord.js só aceita
// TextInputComponent, não existe upload de arquivo dentro de modal (limitação da própria API
// do Discord). Reaproveitado em: cumprimento de ofício/mandado, petição inicial, contestação,
// indícios do delegado.
//
// Canal "bloqueado" (seção 8.7 — sem bate-papo livre) nega SendMessages pra todo mundo, mas
// quem está efetivamente anexando um documento pedido precisa poder mandar mensagem — libera
// pontualmente só pra quem clicou, e devolve o bloqueio no final (sucesso, PDF inválido ou
// tempo esgotado), sem deixar a exceção permanente.
async function aguardarAnexoPDF(interaction, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const minutos = Math.round(timeoutMs / 60000);
  // Edita a permission overwrite direto (não via canais.adicionarMembro) de propósito:
  // adicionarMembro agora PRESERVA o bloqueio pra quem entra num canal já bloqueado (é assim
  // que a seção 8.7 propaga pra participantes novos) — usá-lo aqui pra "liberar" seria
  // contraditório, já que ele re-negaria SendMessages exatamente na hora que eu quero liberar.
  const bloqueado = interaction.channel && canais.canalTemConversaBloqueada(interaction.channel);
  if (bloqueado) await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: true }).catch(() => {});

  await interaction.reply({
    content: `📎 Envie o PDF como anexo na sua próxima mensagem neste canal (você tem ${minutos} minutos).`,
    ephemeral: true,
  });

  const filter = (msg) =>
    msg.author.id === interaction.user.id &&
    msg.attachments.size > 0;

  const collected = await interaction.channel
    .awaitMessages({ filter, max: 1, time: timeoutMs, errors: ['time'] })
    .catch(() => null);

  const relockar = async () => {
    if (bloqueado) await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: false }).catch(() => {});
  };

  if (!collected || collected.size === 0) {
    await interaction.followUp({ content: '⏱️ Tempo esgotado. Nenhum anexo recebido.', ephemeral: true });
    await relockar();
    return null;
  }

  const msg = collected.first();
  const anexo = msg.attachments.find(a => a.name?.toLowerCase().endsWith('.pdf'));

  if (!anexo) {
    await interaction.followUp({ content: '⚠️ O anexo enviado não é um PDF. Operação cancelada.', ephemeral: true });
    await relockar();
    return null;
  }

  await relockar();
  return {
    url: anexo.url,
    nomeArquivo: anexo.name,
    autorId: msg.author.id,
    dataEnvio: new Date(),
  };
}

module.exports = { aguardarAnexoPDF };
