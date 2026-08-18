const canais = require('./canais');
const anexos = require('./anexos');

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

  // ACK PRIMEIRO — precisa reconhecer a interação dentro da janela de 3s do Discord ANTES de
  // qualquer chamada de API que possa demorar. A edição de permission overwrite abaixo é
  // fortemente rate-limited (bucket de edição de canal); sob carga ela passa dos 3s e, se
  // rodasse antes do reply, o token da interação expiraria → DiscordAPIError[10062] "Unknown
  // interaction", que é o "interação falhou" que o usuário vê. Por isso responde já, mexe na
  // permissão depois (o usuário leva alguns segundos pra anexar o PDF de qualquer forma, então
  // a liberação completa bem antes de ele conseguir mandar a mensagem).
  await interaction.reply({
    content: `📎 Envie o PDF como anexo na sua próxima mensagem neste canal (você tem ${minutos} minutos).`,
    ephemeral: true,
  });

  // Canal "bloqueado" (seção 8.7 — sem bate-papo livre) nega SendMessages pra todo mundo, mas
  // quem está efetivamente anexando um documento pedido precisa poder mandar mensagem — libera
  // pontualmente só pra quem clicou, e devolve o bloqueio no final (relockar).
  // Edita a permission overwrite direto (não via canais.adicionarMembro) de propósito:
  // adicionarMembro agora PRESERVA o bloqueio pra quem entra num canal já bloqueado (é assim
  // que a seção 8.7 propaga pra participantes novos) — usá-lo aqui pra "liberar" seria
  // contraditório, já que ele re-negaria SendMessages exatamente na hora que eu quero liberar.
  const bloqueado = interaction.channel && canais.canalTemConversaBloqueada(interaction.channel);
  if (bloqueado) await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: true }).catch(() => {});

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
    // A URL do CDN é link ASSINADO e expira em 24h — fica aqui só como atalho de curta duração.
    // O que dura é o par canal+mensagem: link de mensagem do Discord não expira, e é a partir dele
    // que os autos apontam para o documento. Ver utils/anexos.js -> linkMensagem.
    url: anexo.url,
    canalId: msg.channelId,
    mensagemId: msg.id,
    nomeArquivo: anexo.name,
    autorId: msg.author.id,
    dataEnvio: new Date(),
  };
}

// Variante do aguardarAnexoPDF para "Anexar prova" (lote 5, Função 5): coleta VÁRIOS arquivos de
// QUALQUER tipo (foto/vídeo/PDF/etc.) do mesmo autor, num único fato. Abre a mesma janela
// temporária de SendMessages (só pro autor, num canal bloqueado) e a fecha no final. NÃO apaga as
// mensagens do autor — apagar mataria o link do anexo (requisito "provas nunca somem"). A janela
// fecha por inatividade (idleMs sem novo anexo) OU pelo teto total (timeoutMs). Retorna
// { arquivos: [{ url, nomeArquivo }], autorId, dataEnvio } ou null se nada foi enviado.
async function aguardarAnexos(interaction, { timeoutMs = 90 * 1000, idleMs = 25 * 1000, mensagem = null, silenciarVazio = false } = {}) {
  const seg = Math.round(timeoutMs / 1000);
  const segIdle = Math.round(idleMs / 1000);

  // ACK dentro dos 3s ANTES de mexer em permissão (mesma razão do aguardarAnexoPDF acima).
  await interaction.reply({
    content: mensagem || `📎 Envie o(s) arquivo(s) como anexo nas próximas mensagens deste canal — pode mandar vários do mesmo fato. A janela fecha após ${segIdle}s sem novo envio (ou ${seg}s no total).`,
    ephemeral: true,
  });

  const bloqueado = interaction.channel && canais.canalTemConversaBloqueada(interaction.channel);
  if (bloqueado) await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: true }).catch(() => {});
  const relockar = async () => {
    if (bloqueado) await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: false }).catch(() => {});
  };

  const arquivos = [];
  const collector = interaction.channel.createMessageCollector({
    filter: (msg) => msg.author.id === interaction.user.id && msg.attachments.size > 0,
    time: timeoutMs,
    idle: idleMs,
  });
  await new Promise((resolve) => {
    collector.on('collect', (msg) => {
      for (const anexo of msg.attachments.values()) {
        // canalId/mensagemId junto com a url: a url expira em 24h, o par não. Ver comentário em
        // aguardarAnexoPDF.
        arquivos.push({
          url: anexo.url, canalId: msg.channelId, mensagemId: msg.id,
          nomeArquivo: anexo.name || 'arquivo',
        });
      }
    });
    collector.on('end', () => resolve());
  });

  await relockar();
  if (arquivos.length === 0) {
    // silenciarVazio: pra fluxos onde o anexo é OPCIONAL (ex.: manifestação do MP só-texto) — não
    // avisa "tempo esgotado", quem chamou trata o retorno null como "sem documento".
    if (!silenciarVazio) await interaction.followUp({ content: '⏱️ Tempo esgotado. Nenhum arquivo recebido.', ephemeral: true }).catch(() => {});
    return null;
  }
  return { arquivos, autorId: interaction.user.id, dataEnvio: new Date() };
}

// R2/R4 — núcleo compartilhado do "anexar PDF": espera o PDF e o registra como documento dos
// autos (atoOrigemId = numero em todos os chamadores). Retorna { anexo, documento } ou null quando
// nada válido veio (aguardarAnexoPDF já avisou). O gate, a remoção de botão, o followUp e a análise
// ficam em CADA chamador — divergem de verdade entre os fluxos, por isso não entram aqui.
async function coletarAnexoPdf(interaction, { numero, tipo, protocolo }) {
  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return null;
  const documento = anexos.criarDocumento({
    tipo, url: anexo.url, canalId: anexo.canalId, mensagemId: anexo.mensagemId,
    nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: protocolo,
  });
  return { anexo, documento };
}

module.exports = { aguardarAnexoPDF, aguardarAnexos, coletarAnexoPdf };
