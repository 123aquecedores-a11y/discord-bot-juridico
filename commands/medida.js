const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isAdmin } = require('../utils/permissoes');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const config = require('../config');
const rascunhoCrimes = require('../utils/rascunhoCrimes');
const crimePicker = require('../utils/crimePicker');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const { resolverGuild } = require('../utils/supervisao');

const TIPOS_MEDIDA = ['Busca e Apreensão', 'Prisão Preventiva', 'Interceptação Telefônica', 'Quebra de Sigilo Bancário', 'Outra'];

function embedMedida(medida) {
  return new EmbedBuilder()
    .setTitle(`📋 Medida Provisória ${medida.numero}`)
    .setColor(0xe67e22)
    .addFields(
      { name: 'Tipo', value: medida.tipo, inline: true },
      { name: 'Status', value: medida.status, inline: true },
      { name: 'Alvo', value: truncar(medida.alvo) },
      { name: 'Motivo/Indícios', value: truncar(medida.motivo) },
      { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
      { name: 'Promotor', value: `<@${medida.promotor}>`, inline: true },
      ...(medida.juiz ? [{ name: 'Juiz sorteado', value: `<@${medida.juiz}>`, inline: true }] : []),
    );
}

function botoesAnalise(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:aprovar:${numero}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`medida:negar:${numero}`).setLabel('Negar').setStyle(ButtonStyle.Danger),
  );
}

// Juiz recebe a medida já aprovada pelo MP e pode referendar (gera mandado) ou negar
// provimento (encerra sem mandado) — antes só existia a opção de referendar.
function botoesJuizMedida(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:referendar:${numero}`).setLabel('Referendar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:medida:negarjuiz:${numero}`).setLabel('Negar provimento').setStyle(ButtonStyle.Danger),
    botaoArquivarManual(numero),
  );
}

function botaoRecorrer(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:recorrer:${numero}`).setLabel('Juntar indícios e recorrer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:medida:pedirreconsideracao:${numero}`).setLabel('Pedir reconsideração (Procurador)').setStyle(ButtonStyle.Secondary),
  );
}

function botaoCumprir(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:cumprir:${numero}`).setLabel('Cumprir mandado').setStyle(ButtonStyle.Success),
  );
}

function botaoAbrirProcesso(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`medida:abrirprocesso:${numero}`).setLabel('Abrir processo penal').setStyle(ButtonStyle.Primary),
  );
}

// Disponível pra Delegado/Promotor/Juiz da medida (ou Desembargador/Staff) em qualquer fase
// depois da análise inicial — move o canal pra categoria Arquivados e trava novas mensagens.
function botaoArquivarManual(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:medida:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary);
}

async function solicitarMedida({ guild, delegadoId, promotorId, tipo, alvo, motivo }) {
  let promotorFinal = promotorId;
  if (!promotorFinal) {
    const promotores = rh.listarPorCargo('Promotor').filter(p => !p.licenca);
    if (promotores.length === 0) return { erro: 'Não há Promotor ativo cadastrado. Informe um manualmente na opção `promotor`.' };
    promotorFinal = promotores[Math.floor(Math.random() * promotores.length)].discordId;
  }

  const numero = proximoNumero(db, 'medidas', 'MD');

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaMedidasId,
    prefixo: 'medida',
    numero,
    membros: [delegadoId, promotorFinal],
  });

  db.inserir('medidas', {
    numero, tipo, alvo, motivo, status: 'Aguardando MP',
    delegado: delegadoId, promotor: promotorFinal, juiz: null,
    canalId: canal.id,
  });

  const medida = db.buscarPorNumero('medidas', numero);
  await canal.send({ content: `<@${delegadoId}> <@${promotorFinal}>`, embeds: [embedMedida(medida)], components: [botoesAnalise(numero)] });

  await auditoria.registrar(guild, { acao: 'Medida provisória solicitada', executorId: delegadoId, referencia: numero });
  return { numero, canal };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('medida')
    .setDescription('Pedidos de medida provisória (fase de inquérito, antes de processo formal)')
    .addSubcommand(sub => sub.setName('solicitar').setDescription('Solicita uma medida provisória ao MP')
      .addStringOption(o => {
        o.setName('tipo').setDescription('Tipo de medida').setRequired(true);
        TIPOS_MEDIDA.forEach(t => o.addChoices({ name: t, value: t }));
        return o;
      })
      .addStringOption(o => o.setName('alvo').setDescription('Pessoa/local alvo').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Motivo/indícios que fundamentam o pedido').setRequired(true))
      .addUserOption(o => o.setName('promotor').setDescription('Promotor responsável por analisar')))
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de uma medida')
      .addStringOption(o => o.setName('numero').setDescription('Número da medida').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista medidas provisórias')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status').addChoices(
        { name: 'Aguardando MP', value: 'Aguardando MP' },
        { name: 'Negada', value: 'Negada' },
        { name: 'Deferida', value: 'Deferida' },
      ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solicitar') {
      if (!temCargo(interaction, 'Delegado')) {
        return interaction.reply({ content: 'Só Delegados podem solicitar medida provisória.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resultado = await solicitarMedida({
        guild: interaction.guild,
        delegadoId: interaction.user.id,
        promotorId: interaction.options.getUser('promotor')?.id || null,
        tipo: interaction.options.getString('tipo'),
        alvo: interaction.options.getString('alvo'),
        motivo: interaction.options.getString('motivo'),
      });

      if (resultado.erro) return interaction.editReply({ content: resultado.erro });
      return interaction.editReply({ content: `Medida ${resultado.numero} registrada em ${resultado.canal}.` });
    }

    if (sub === 'ver') {
      const numero = interaction.options.getString('numero');
      const medida = db.buscarPorNumero('medidas', numero);
      if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
      return interaction.reply({ embeds: [embedMedida(medida)] });
    }

    if (sub === 'listar') {
      const status = interaction.options.getString('status');
      const rows = db.todos('medidas', status ? m => m.status === status : null).slice(0, 15);
      if (rows.length === 0) return interaction.reply({ content: 'Nenhuma medida encontrada.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('📋 Medidas provisórias')
        .setColor(0xe67e22)
        .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
      return interaction.reply({ embeds: [embed] });
    }
  },

  // ---- Handlers de botão (chamados pelo roteador central em interactions/botoes.js) ----

  // Aprovar exige que o Promotor escreva a fundamentação do pedido — sem isso o Juiz recebia
  // só um "aprovado" sem nenhum texto pra deliberar em cima.
  async aprovar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:aprovarmp:${numero}`).setTitle('Aprovar pedido — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do MP').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  async processarAprovacaoMP(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    const fundamentacao = interaction.fields.getTextInputValue('fundamentacao');

    const juizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor] });
    if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

    db.atualizar('medidas', numero, { status: 'Aprovada - aguardando juiz', juiz: juizId, fundamentacaoPromotor: fundamentacao });
    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) await canais.adicionarMembro(canal, juizId);
    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

    if (canal) {
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: medida.tipo, titulo: 'MANIFESTAÇÃO DO MINISTÉRIO PÚBLICO — PELO DEFERIMENTO',
          texto: fundamentacao, autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça',
        }),
      });
      await canal.send({ content: `<@${juizId}> você foi sorteado para deliberar sobre esta medida.`, embeds: [embedMedida(db.buscarPorNumero('medidas', numero))], components: [botoesJuizMedida(numero)] });
    }
    await auditoria.registrar(interaction.guild, { acao: 'Medida aprovada pelo MP', executorId: interaction.user.id, referencia: `${numero} → Juiz <@${juizId}>` });
    return interaction.reply({ content: `Medida ${numero} aprovada e encaminhada a <@${juizId}>.`, ephemeral: true });
  },

  async negar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode decidir — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { status: 'Negada' });
    await interaction.update({
      embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
      components: [botaoRecorrer(numero), new ActionRowBuilder().addComponents(botaoArquivarManual(numero))],
    });
    await auditoria.registrar(interaction.guild, { acao: 'Medida negada pelo MP', executorId: interaction.user.id, referencia: numero });
  },

  async recorrer(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.delegado && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Delegado que abriu esta medida pode juntar indícios e recorrer — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { status: 'Aguardando MP' });
    await interaction.update({ embeds: [embedMedida(db.buscarPorNumero('medidas', numero))], components: [botoesAnalise(numero)] });
  },

  // Pedido de reconsideração ao Procurador ganha um ticket próprio, mesmo critério da apelação
  // ao Desembargador: canal dedicado numa categoria própria, não uma mensagem no canal da medida.
  async pedirReconsideracao(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.delegado && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Delegado que abriu esta medida pode pedir reconsideração — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }
    if (medida.status !== 'Negada') return interaction.reply({ content: 'Essa medida não está negada.', ephemeral: true });
    if (medida.reconsideracao === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de reconsideração pendente.', ephemeral: true });

    const procuradores = rh.listarPorCargo('Procurador').filter(p => !p.licenca);
    const canalRecon = await canais.criarCanalTicket(interaction.guild, {
      categoriaId: config.categoriaReconsideracoesId, prefixo: 'reconsideracao', numero,
      membros: [medida.delegado, medida.promotor, ...procuradores.map(p => p.discordId)],
    });

    db.atualizar('medidas', numero, { reconsideracao: 'Pendente', reconsideracaoCanalId: canalRecon.id });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Reconsideração — medida ${numero} negada`)
      .setColor(0xf39c12)
      .addFields(
        { name: 'Delegado', value: `<@${medida.delegado}>`, inline: true },
        { name: 'Promotor que negou', value: `<@${medida.promotor}>`, inline: true },
        { name: 'Tipo', value: medida.tipo, inline: true },
        { name: 'Alvo', value: truncar(medida.alvo) },
        { name: 'Motivo/Indícios originais', value: truncar(medida.motivo) },
      );
    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracao:${numero}#aprovar`).setLabel('Aprovar e enviar a Juiz').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:medida:decidirreconsideracao:${numero}#manter`).setLabel('Manter negativa').setStyle(ButtonStyle.Danger),
    );
    await canalRecon.send({
      content: procuradores.length ? procuradores.map(p => `<@${p.discordId}>`).join(' ') : 'Nenhum Procurador ativo cadastrado no momento — o pedido fica pendente até haver um.',
      embeds: [embed], components: [botoes],
    });

    await auditoria.registrar(interaction.guild, { acao: 'Reconsideração de medida solicitada', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Pedido de reconsideração aberto em ${canalRecon}.`, ephemeral: true });
  },

  // Decisão do Procurador acontece no ticket de reconsideração, mas o resultado também é
  // avisado no canal original da medida — é lá que o Juiz vai agir se for aprovada.
  async decidirReconsideracao(interaction, extra) {
    const [numero, decisao] = extra.split('#');
    if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Procuradores podem decidir um pedido de reconsideração.', ephemeral: true });
    }
    const guild = await resolverGuild(interaction);
    if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (medida.reconsideracao !== 'Pendente') return interaction.reply({ content: 'Esse pedido de reconsideração já foi decidido.', ephemeral: true });

    const canalMedida = await guild.channels.fetch(medida.canalId).catch(() => null);
    const canalRecon = medida.reconsideracaoCanalId ? await guild.channels.fetch(medida.reconsideracaoCanalId).catch(() => null) : null;

    if (decisao === 'aprovar') {
      const juizId = rh.sortearJuiz({ excluirIds: [medida.delegado, medida.promotor] });
      if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

      db.atualizar('medidas', numero, { status: 'Aprovada - aguardando juiz', juiz: juizId, reconsideracao: 'Aprovada' });
      if (canalMedida) {
        await canais.adicionarMembro(canalMedida, juizId);
        await canalMedida.send({
          content: `Reconsideração aprovada pelo Procurador <@${interaction.user.id}> — a negativa do MP foi revertida. <@${juizId}> foi sorteado para deliberar.`,
          embeds: [embedMedida(db.buscarPorNumero('medidas', numero))],
          components: [botoesJuizMedida(numero)],
        });
      }
      if (canalRecon) {
        await canalRecon.send({ content: `✅ Reconsideração **aprovada**. Medida encaminhada a <@${juizId}> no canal ${canalMedida || medida.canalId}.` });
        await canais.arquivarCanal(canalRecon);
      }
      await auditoria.registrar(guild, { acao: 'Reconsideração de medida aprovada', executorId: interaction.user.id, referencia: `${numero} → Juiz <@${juizId}>` });
      return interaction.reply({ content: `Reconsideração aprovada. Medida ${numero} encaminhada a <@${juizId}>.`, ephemeral: true });
    }

    db.atualizar('medidas', numero, { reconsideracao: 'Mantida' });
    if (canalMedida) {
      await canalMedida.send({ content: `O Procurador <@${interaction.user.id}> analisou o pedido de reconsideração e **manteve a negativa** do MP.` });
    }
    if (canalRecon) {
      await canalRecon.send({ content: `❌ Negativa **mantida** pelo Procurador <@${interaction.user.id}>.` });
      await canais.arquivarCanal(canalRecon);
    }
    await auditoria.registrar(guild, { acao: 'Reconsideração de medida mantida', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Negativa da medida ${numero} mantida.`, ephemeral: true });
  },

  // Referendar (deferir) e negar provimento agora exigem a fundamentação do Juiz por escrito —
  // sem isso o mandado saía só com um embed genérico, sem nenhum texto jurídico de verdade.
  async referendar(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:referendar:${numero}`).setTitle('Referendar — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do Juízo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  async processarReferendo(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode referendá-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = interaction.fields.getTextInputValue('fundamentacao');
    db.atualizar('medidas', numero, { status: 'Deferida', fundamentacaoJuiz });

    const numeroMandado = proximoNumero(db, 'mandados', 'MO');
    db.inserir('mandados', {
      numero: numeroMandado, medidaNumero: numero, tipo: medida.tipo, alvo: medida.alvo,
      status: 'Emitido', emitidoPor: medida.juiz, cumpridoPor: null,
    });

    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});
    const medidaAtualizada = db.buscarPorNumero('medidas', numero);

    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) {
      await canal.send({
        content: `<@${medida.delegado}>\n\n${documentos.textoMandado({
          numero: numeroMandado, medida: medidaAtualizada,
          fundamentacaoPromotor: medida.fundamentacaoPromotor, fundamentacaoJuiz,
        })}`,
        components: [botaoCumprir(numeroMandado)],
      });
      await canal.send({ content: `<@${medida.promotor}> quando quiser, pode transformar esta medida em processo penal formal, herdando os dados automaticamente.`, components: [botaoAbrirProcesso(numero)] });
    }
    await auditoria.registrar(interaction.guild, { acao: 'Medida referendada — mandado emitido', executorId: interaction.user.id, referencia: `${numero} → Mandado ${numeroMandado}` });
    return interaction.reply({ content: `Medida ${numero} referendada. Mandado ${numeroMandado} emitido.`, ephemeral: true });
  },

  async abrirModalNegarJuiz(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:negarjuiz:${numero}`).setTitle('Negar provimento — fundamentação');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do Juízo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  },

  async negarJuiz(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.juiz && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para esta medida pode decidi-la — no caso, <@${medida.juiz}>.`, ephemeral: true });
    }
    const fundamentacaoJuiz = interaction.fields.getTextInputValue('fundamentacao');
    db.atualizar('medidas', numero, { status: 'Indeferida pelo Juiz', fundamentacaoJuiz });

    if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

    const canal = await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
    if (canal) {
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: medida.tipo, titulo: 'DECISÃO — INDEFERIMENTO DA MEDIDA',
          texto: fundamentacaoJuiz, autorId: interaction.user.id, cargoAutor: 'Juiz(a) de Direito',
        }),
        components: [new ActionRowBuilder().addComponents(botaoArquivarManual(numero))],
      });
    }
    await auditoria.registrar(interaction.guild, { acao: 'Medida indeferida pelo Juiz', executorId: interaction.user.id, referencia: numero });
    return interaction.reply({ content: `Medida ${numero} indeferida.`, ephemeral: true });
  },

  async cumprirMandado(interaction, numero) {
    const mandado = db.buscarPorNumero('mandados', numero);
    if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
    const medida = db.buscarPorNumero('medidas', mandado.medidaNumero);
    if (medida && interaction.user.id !== medida.delegado && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Delegado responsável por essa medida pode cumprir este mandado — no caso, <@${medida.delegado}>.`, ephemeral: true });
    }

    db.atualizar('mandados', numero, { status: 'Cumprido', cumpridoPor: interaction.user.id });
    await interaction.update({ components: [] });
    const componentesArquivar = mandado.medidaNumero
      ? [new ActionRowBuilder().addComponents(botaoArquivarManual(mandado.medidaNumero))]
      : [];
    await interaction.followUp({ content: `Mandado ${numero} cumprido por <@${interaction.user.id}>.`, components: componentesArquivar });
    await auditoria.registrar(interaction.guild, { acao: 'Mandado cumprido', executorId: interaction.user.id, referencia: numero });
  },

  async abrirProcesso(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    if (interaction.user.id !== medida.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por esta medida pode abrir o processo — no caso, <@${medida.promotor}>.`, ephemeral: true });
    }
    if (medida.processoVinculado) {
      return interaction.reply({ content: `Essa medida já gerou o processo ${medida.processoVinculado}.`, ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(`medida:processomodal:${numero}`).setTitle(`Abrir processo — ${numero}`.slice(0, 45));

    const campoMotivo = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/fatos (edite se quiser)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(medida.motivo.slice(0, 4000));
    const campoReus = new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus, se já identificados')
      .setStyle(TextInputStyle.Short).setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(campoMotivo),
      new ActionRowBuilder().addComponents(campoReus),
    );
    await interaction.showModal(modal);
  },

  async criarProcessoModal(interaction, numero) {
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });

    rascunhoCrimes.iniciar(interaction.user.id, {
      tipo: 'penal-medida',
      dados: {
        delegadoId: medida.delegado,
        promotorId: medida.promotor,
        motivo: interaction.fields.getTextInputValue('motivo'),
        reusTexto: interaction.fields.getTextInputValue('reus'),
        medidaNumero: numero,
      },
    });

    return crimePicker.mostrarPainel(interaction, { novaMensagem: true });
  },

  TIPOS_MEDIDA,
  embedMedida,
  solicitarMedida,
};
