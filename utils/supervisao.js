const { EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const rh = require('./rh');
const canais = require('./canais');
const auditoria = require('./auditoria');
const { temCargo, isAdmin } = require('./permissoes');
const { truncar } = require('./texto');
const processoCmd = require('../commands/processo');

function extrairMencao(texto) {
  const m = texto && texto.match(/<@!?(\d+)>/);
  return m ? m[1] : null;
}

// Botões clicados a partir de uma DM não têm interaction.guild (Discord não manda contexto de
// servidor em interação de DM) — cai pro guild configurado, senão os cliques que chegam de
// notificação por DM (ex: pedir revisão de arquivamento) quebrariam sempre.
async function resolverGuild(interaction) {
  return interaction.guild || interaction.client.guilds.fetch(config.guildId).catch(() => null);
}

function podeSupervisionar(interaction) {
  return isAdmin(interaction) || temCargo(interaction, 'Desembargador') || temCargo(interaction, 'Procurador');
}

// ---- Trocar Juiz (Desembargador) ----

function abrirModalTrocarJuiz(interaction) {
  if (!temCargo(interaction, 'Desembargador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Desembargadores podem trocar o Juiz de um processo.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:supervisao:trocarjuiz').setTitle('Trocar Juiz do processo');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel('Número do processo').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('novo').setLabel('Menção @ do novo Juiz').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo da troca').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function trocarJuiz(interaction) {
  const numero = interaction.fields.getTextInputValue('numero');
  const novoJuizId = extrairMencao(interaction.fields.getTextInputValue('novo'));
  const motivo = interaction.fields.getTextInputValue('motivo');

  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!novoJuizId) return interaction.reply({ content: 'Marque o novo Juiz com @menção.', ephemeral: true });
  if (!processo.juiz) return interaction.reply({ content: 'Esse processo ainda não tem Juiz — use os fluxos normais de sorteio.', ephemeral: true });

  const juizAntigo = processo.juiz;
  const reabrindo = processo.status === 'Arquivado sem julgamento de mérito';
  db.atualizar('processos', numero, {
    juiz: novoJuizId,
    juizDesde: new Date().toISOString(),
    ...(reabrindo ? { status: 'Instrução' } : {}),
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    if (reabrindo) await canais.reabrirCanal(canal, [processo.delegado, processo.promotor, processo.autor, ...(processo.reus || [])].filter(Boolean));
    await canais.adicionarMembro(canal, novoJuizId);
    await canal.permissionOverwrites.delete(juizAntigo).catch(() => {});
    await canal.send({
      content: `<@${novoJuizId}> passa a ser o Juiz deste processo (trocado por decisão do Desembargador <@${interaction.user.id}>)${reabrindo ? ' — processo reaberto pra instrução' : ''}. Motivo: ${motivo}`,
    });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Troca de Juiz', executorId: interaction.user.id,
    referencia: `Processo ${numero}: <@${juizAntigo}> → <@${novoJuizId}>`, motivo,
  });

  return interaction.reply({ content: `Juiz do processo ${numero} trocado para <@${novoJuizId}>.`, ephemeral: true });
}

// ---- Trocar Promotor (Procurador) ----

function abrirModalTrocarPromotor(interaction) {
  if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Procuradores podem trocar o Promotor de um processo.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:supervisao:trocarpromotor').setTitle('Trocar Promotor do processo');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel('Número do processo').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('novo').setLabel('Menção @ do novo Promotor').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo da troca').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function trocarPromotor(interaction) {
  const numero = interaction.fields.getTextInputValue('numero');
  const novoPromotorId = extrairMencao(interaction.fields.getTextInputValue('novo'));
  const motivo = interaction.fields.getTextInputValue('motivo');

  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!novoPromotorId) return interaction.reply({ content: 'Marque o novo Promotor com @menção.', ephemeral: true });
  if (!processo.promotor) return interaction.reply({ content: 'Esse processo não tem Promotor atribuído.', ephemeral: true });

  const promotorAntigo = processo.promotor;
  db.atualizar('processos', numero, { promotor: novoPromotorId });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canais.adicionarMembro(canal, novoPromotorId);
    await canal.permissionOverwrites.delete(promotorAntigo).catch(() => {});
    await canal.send({ content: `<@${novoPromotorId}> passa a ser o Promotor deste processo (trocado por decisão do Procurador <@${interaction.user.id}>). Motivo: ${motivo}` });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Troca de Promotor', executorId: interaction.user.id,
    referencia: `Processo ${numero}: <@${promotorAntigo}> → <@${novoPromotorId}>`, motivo,
  });

  return interaction.reply({ content: `Promotor do processo ${numero} trocado para <@${novoPromotorId}>.`, ephemeral: true });
}

// ---- Forçar denúncia (Procurador reverte arquivamento do Promotor) ----

function abrirModalForcarDenuncia(interaction) {
  if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Procuradores podem forçar denúncia.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:supervisao:forcardenuncia').setTitle('Forçar denúncia');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel('Número do processo').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// Mesmo botão de "forçar denúncia", só que o número já vem embutido no customId — usado
// quando o Procurador clica direto na notificação de "pedido de revisão" (por DM ou no painel),
// sem precisar redigitar o número do processo.
function abrirModalForcarDenunciaDireto(interaction, numero) {
  if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Procuradores podem forçar denúncia.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`painel:modal:supervisao:forcardenunciadireto:${numero}`).setTitle('Forçar denúncia');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function executarForcarDenuncia(interaction, numero, motivo) {
  const guild = await resolverGuild(interaction);
  if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.tipo !== 'Penal' || processo.status !== 'Arquivado') {
    return interaction.reply({ content: 'Só é possível forçar denúncia num processo penal arquivado.', ephemeral: true });
  }

  const juizId = rh.sortearJuiz({ excluirIds: [processo.delegado, processo.promotor].filter(Boolean) });
  if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

  db.atualizar('processos', numero, { status: 'Instrução', juiz: juizId, juizDesde: new Date().toISOString(), revisaoArquivamento: 'Decidida' });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canais.adicionarMembro(canal, juizId);
    await canal.send({
      content: `Denúncia forçada pelo Procurador <@${interaction.user.id}> — <@${juizId}> sorteado para o caso. Motivo: ${motivo}`,
      components: [processoCmd.botoesJuiz(numero)],
    });
  }

  await auditoria.registrar(guild, { acao: 'Denúncia forçada', executorId: interaction.user.id, referencia: `Processo ${numero}`, motivo });
  await processoCmd.postarOuAtualizarDiario(guild, numero);

  return interaction.reply({ content: `Denúncia forçada. Processo ${numero} agora em Instrução com <@${juizId}> como Juiz.`, ephemeral: true });
}

async function forcarDenuncia(interaction) {
  const numero = interaction.fields.getTextInputValue('numero');
  const motivo = interaction.fields.getTextInputValue('motivo');
  return executarForcarDenuncia(interaction, numero, motivo);
}

async function forcarDenunciaDireto(interaction, numero) {
  const motivo = interaction.fields.getTextInputValue('motivo');
  return executarForcarDenuncia(interaction, numero, motivo);
}

// ---- Filas pendentes ----

async function filasPendentes(interaction) {
  if (!podeSupervisionar(interaction)) {
    return interaction.reply({ content: 'Só Desembargador, Procurador ou Staff podem ver isso.', ephemeral: true });
  }

  const mandadosPendentes = db.todos('mandados', m => m.status === 'Emitido');
  const processosAguardandoMP = db.todos('processos', p => p.status === 'Aguardando decisão do MP');
  const medidasAguardandoMP = db.todos('medidas', m => m.status === 'Aguardando MP');
  // Civil nunca passa por status==='Instrução' (fica em "Aguardando defesa"/"Aguardando
  // sorteio de juiz" até Julgar/Arquivar) — checar por "tem Juiz e não é terminal" pega os dois tipos.
  const STATUS_TERMINAIS = ['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'];
  const aguardandoJulgamento = db.todos('processos', p => p.juiz && !STATUS_TERMINAIS.includes(p.status));
  const habilitacoesPendentes = db.todos('processos')
    .flatMap(p => (p.habilitacoes || []).filter(h => h.status === 'Pendente').map(() => p.numero));
  const revisoesPendentes = db.todos('processos', p => p.revisaoArquivamento === 'Pendente');
  const apelacoesPendentes = db.todos('apelacoes', a => a.status === 'Aguardando decisão');

  const linha = (lista, chave) => (lista.length ? lista.map(x => x[chave] ?? x).join(', ') : '—');

  const embed = new EmbedBuilder().setTitle('📋 Filas pendentes').setColor(0x34495e)
    .addFields(
      { name: 'Mandados não cumpridos', value: linha(mandadosPendentes, 'numero') },
      { name: 'Processos aguardando decisão do MP', value: linha(processosAguardandoMP, 'numero') },
      { name: 'Medidas aguardando decisão do MP', value: linha(medidasAguardandoMP, 'numero') },
      { name: 'Processos em instrução (aguardando julgamento)', value: linha(aguardandoJulgamento, 'numero') },
      { name: 'Habilitações pendentes de aprovação', value: truncar(linha(habilitacoesPendentes, null)) },
      { name: 'Revisões de arquivamento pendentes', value: linha(revisoesPendentes, 'numero') },
      { name: 'Apelações pendentes de decisão', value: linha(apelacoesPendentes, 'numero') },
    );

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = {
  resolverGuild,
  podeSupervisionar,
  abrirModalTrocarJuiz, trocarJuiz,
  abrirModalTrocarPromotor, trocarPromotor,
  abrirModalForcarDenuncia, forcarDenuncia,
  abrirModalForcarDenunciaDireto, forcarDenunciaDireto,
  filasPendentes,
};
