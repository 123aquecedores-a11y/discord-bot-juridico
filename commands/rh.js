const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const rh = require('../utils/rh');
const { isAdmin, isSuperStaff } = require('../utils/permissoes');
const config = require('../config');
const auditoria = require('../utils/auditoria');
const db = require('../database/db');

// Título que vai na frente do apelido quando o cargo é aprovado (ex: "Juiz Fulano").
// Desembargador abrevia pra caber no limite de 32 caracteres do apelido do Discord.
const TITULO = {
  Delegado: 'Delegado', Promotor: 'Promotor', Juiz: 'Juiz',
  Advogado: 'Advogado', Desembargador: 'Des.', Procurador: 'Procurador',
};

function roleIdPorCargo(cargo) {
  return {
    Delegado: config.roleDelegadoId,
    Promotor: config.rolePromotorId,
    Juiz: config.roleJuizId,
    Advogado: config.roleAdvogadoId,
    Desembargador: config.roleDesembargadorId,
    Procurador: config.roleProcuradorId,
  }[cargo];
}

// Aplica o apelido "Título Nome" (ex: "Juiz Fulano"). Pode falhar se o cargo do bot estiver
// abaixo do alvo na hierarquia ou faltar permissão "Gerenciar Apelidos" — retorna false nesse
// caso (sem quebrar o fluxo), pra quem chama avisar a staff.
async function aplicarApelido(membro, cargo, nomePersonagem) {
  if (!membro || !nomePersonagem) return null;
  const apelido = `${TITULO[cargo] || cargo} ${nomePersonagem}`.slice(0, 32);
  return membro.setNickname(apelido).then(() => true).catch(() => false);
}

async function contratarComRole(guild, usuarioId, cargo, executorId = null, nomePersonagem = null) {
  rh.contratar(usuarioId, cargo, nomePersonagem);
  const membro = await guild.members.fetch(usuarioId).catch(() => null);
  const roleId = roleIdPorCargo(cargo);
  if (roleId && membro) await membro.roles.add(roleId).catch(() => {});
  const apelidoOk = nomePersonagem ? await aplicarApelido(membro, cargo, nomePersonagem) : null;
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: contratação', executorId, referencia: `<@${usuarioId}> → ${cargo}${nomePersonagem ? ` ("${nomePersonagem}")` : ''}` });
  }
  return { apelidoOk };
}

async function demitirComRole(guild, usuarioId, executorId = null) {
  const registro = rh.getCargo(usuarioId);
  rh.demitir(usuarioId);
  if (registro) {
    const roleId = roleIdPorCargo(registro.cargo);
    if (roleId) {
      const membro = await guild.members.fetch(usuarioId).catch(() => null);
      if (membro) await membro.roles.remove(roleId).catch(() => {});
    }
  }
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'RH: demissão', executorId, referencia: `<@${usuarioId}>${registro ? ` (era ${registro.cargo})` : ''}` });
  }
  return registro;
}

// ---- Auto-atendimento de contratação (Parte 7) ----
// Fluxo: painel "Solicitar cargo" → select do cargo → modal do nome do personagem →
// solicitação pendente postada pra staff aprovar/negar. Ao aprovar: cargo + apelido + registro.

function selectCargoDesejado() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('painel:select:cargo:desejado')
      .setPlaceholder('Qual cargo você quer solicitar?')
      .addOptions(rh.CARGOS.map(c => ({ label: c, value: c }))),
  );
}

function modalSolicitacao(cargo) {
  const modal = new ModalBuilder()
    .setCustomId(`painel:modal:cargo:solicitar:${cargo}`)
    .setTitle(`Solicitar cargo — ${cargo}`.slice(0, 45));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('nome').setLabel('Nome do seu personagem')
      .setPlaceholder('Ex: Ricardo Fernandes').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
  ));
  return modal;
}

async function solicitarCargo(interaction, cargo) {
  if (!rh.CARGOS.includes(cargo)) {
    return interaction.reply({ content: 'Cargo inválido.', ephemeral: true });
  }
  const nome = interaction.fields.getTextInputValue('nome').trim();
  if (!nome) return interaction.reply({ content: 'Informe o nome do personagem.', ephemeral: true });

  // Uma solicitação pendente por vez, pra não encher a staff de pedidos repetidos.
  const pendente = db.buscarUm('solicitacoesCargo', s => s.discordId === interaction.user.id && s.status === 'Pendente');
  if (pendente) {
    return interaction.reply({ content: 'Você já tem uma solicitação pendente aguardando a staff. Espere a decisão dela antes de pedir de novo.', ephemeral: true });
  }

  const sol = db.inserir('solicitacoesCargo', {
    discordId: interaction.user.id, cargo, nomePersonagem: nome,
    status: 'Pendente', criadoEm: new Date().toISOString(),
  });

  const embed = new EmbedBuilder()
    .setTitle('🪪 Nova solicitação de cargo')
    .setColor(0xf1c40f)
    .addFields(
      { name: 'Solicitante', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Cargo pedido', value: cargo, inline: true },
      { name: 'Nome do personagem', value: nome },
    )
    .setFooter({ text: `Solicitação #${sol.id}` });

  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:cargo:aprovar:${sol.id}`).setLabel('✅ Aprovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:cargo:negar:${sol.id}`).setLabel('❌ Negar').setStyle(ButtonStyle.Danger),
  );

  const canalId = config.canalContratacoesId || config.canalAuditoriaId;
  const canalStaff = canalId ? await interaction.guild.channels.fetch(canalId).catch(() => null) : null;
  const destino = canalStaff && canalStaff.isTextBased?.() ? canalStaff : interaction.channel;
  await destino.send({ embeds: [embed], components: [botoes] }).catch(() => {});

  return interaction.reply({
    content: `✅ Solicitação enviada! A staff vai analisar seu pedido de **${cargo}** (personagem: **${nome}**). Você é avisado por DM quando for decidido.`,
    ephemeral: true,
  });
}

async function aprovarSolicitacao(interaction, id) {
  if (!isAdmin(interaction) && !isSuperStaff(interaction)) {
    return interaction.reply({ content: 'Só a staff pode aprovar solicitações de cargo.', ephemeral: true });
  }
  const sol = db.buscarUm('solicitacoesCargo', s => s.id === Number(id));
  if (!sol) return interaction.reply({ content: 'Solicitação não encontrada.', ephemeral: true });
  if (sol.status !== 'Pendente') return interaction.reply({ content: `Essa solicitação já foi **${sol.status.toLowerCase()}**.`, ephemeral: true });

  await interaction.deferUpdate();
  db.atualizarPorFiltro('solicitacoesCargo', s => s.id === Number(id), {
    status: 'Aprovada', decididoPor: interaction.user.id, decididoEm: new Date().toISOString(),
  });

  const { apelidoOk } = await contratarComRole(interaction.guild, sol.discordId, sol.cargo, interaction.user.id, sol.nomePersonagem);

  const membro = await interaction.guild.members.fetch(sol.discordId).catch(() => null);
  if (membro) membro.send(`✅ Sua solicitação de **${sol.cargo}** foi **aprovada**! Seu cargo e apelido já foram aplicados no servidor.`).catch(() => {});

  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(0x2ecc71).setTitle('🪪 Solicitação de cargo — APROVADA')
    .addFields({ name: 'Decidido por', value: `<@${interaction.user.id}>` });
  await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});

  const aviso = apelidoOk === false
    ? '\n⚠️ O cargo foi dado, mas **não consegui trocar o apelido** — verifique se o cargo do bot está **acima** do cargo dado na hierarquia e se ele tem a permissão "Gerenciar Apelidos". Ajuste o apelido na mão.'
    : '';
  return interaction.followUp({
    content: `✅ <@${sol.discordId}> agora é **${sol.cargo}** — apelido: \`${TITULO[sol.cargo] || sol.cargo} ${sol.nomePersonagem}\`.${aviso}`,
    ephemeral: true,
  });
}

async function negarSolicitacao(interaction, id) {
  if (!isAdmin(interaction) && !isSuperStaff(interaction)) {
    return interaction.reply({ content: 'Só a staff pode negar solicitações de cargo.', ephemeral: true });
  }
  const sol = db.buscarUm('solicitacoesCargo', s => s.id === Number(id));
  if (!sol) return interaction.reply({ content: 'Solicitação não encontrada.', ephemeral: true });
  if (sol.status !== 'Pendente') return interaction.reply({ content: `Essa solicitação já foi **${sol.status.toLowerCase()}**.`, ephemeral: true });

  await interaction.deferUpdate();
  db.atualizarPorFiltro('solicitacoesCargo', s => s.id === Number(id), {
    status: 'Negada', decididoPor: interaction.user.id, decididoEm: new Date().toISOString(),
  });

  const membro = await interaction.guild.members.fetch(sol.discordId).catch(() => null);
  if (membro) membro.send(`❌ Sua solicitação de **${sol.cargo}** foi **negada** pela staff.`).catch(() => {});

  await auditoria.registrar(interaction.guild, { acao: 'Contratação negada (auto-atendimento)', executorId: interaction.user.id, referencia: `<@${sol.discordId}> → ${sol.cargo}` });

  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(0xe74c3c).setTitle('🪪 Solicitação de cargo — NEGADA')
    .addFields({ name: 'Decidido por', value: `<@${interaction.user.id}>` });
  return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rh')
    .setDescription('Gestão de cargos jurídicos (só Staff/Administração)')
    .addSubcommand(sub => sub.setName('contratar').setDescription('Atribui um cargo jurídico a alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai receber o cargo').setRequired(true))
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c })))))
    .addSubcommand(sub => sub.setName('demitir').setDescription('Remove o cargo jurídico de alguém')
      .addUserOption(o => o.setName('usuario').setDescription('Quem vai perder o cargo').setRequired(true)))
    .addSubcommand(sub => sub.setName('licenca').setDescription('Marca/desmarca alguém como afastado')
      .addUserOption(o => o.setName('usuario').setDescription('Quem entra/sai de licença').setRequired(true))
      .addBooleanOption(o => o.setName('afastado').setDescription('true = entra de licença, false = volta ativo').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista quem está em cada cargo')
      .addStringOption(o => o.setName('cargo').setDescription('Cargo jurídico').setRequired(true)
        .addChoices(...rh.CARGOS.map(c => ({ name: c, value: c }))))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });
    }

    if (sub === 'contratar') {
      const usuario = interaction.options.getUser('usuario');
      const cargo = interaction.options.getString('cargo');
      await contratarComRole(interaction.guild, usuario.id, cargo, interaction.user.id);
      return interaction.reply({ content: `${usuario} agora é **${cargo}**.` });
    }

    if (sub === 'demitir') {
      const usuario = interaction.options.getUser('usuario');
      await demitirComRole(interaction.guild, usuario.id, interaction.user.id);
      return interaction.reply({ content: `${usuario} foi removido do cargo jurídico.` });
    }

    if (sub === 'licenca') {
      const usuario = interaction.options.getUser('usuario');
      const afastado = interaction.options.getBoolean('afastado');
      const atualizado = rh.setLicenca(usuario.id, afastado);
      if (!atualizado) return interaction.reply({ content: 'Essa pessoa não tem cargo jurídico ativo.', ephemeral: true });
      await auditoria.registrar(interaction.guild, {
        acao: `RH: ${afastado ? 'licença' : 'retorno de licença'}`, executorId: interaction.user.id, referencia: `${usuario}`,
      });
      return interaction.reply({ content: `${usuario} agora está ${afastado ? '**de licença**' : '**ativo**'}.` });
    }

    if (sub === 'listar') {
      const cargo = interaction.options.getString('cargo');
      const lista = rh.listarPorCargo(cargo);
      if (lista.length === 0) return interaction.reply({ content: `Ninguém com o cargo ${cargo} no momento.`, ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle(`Cargo: ${cargo}`)
        .setColor(0x3498db)
        .setDescription(lista.map(r => `<@${r.discordId}>${r.licenca ? ' — *de licença*' : ''}`).join('\n'));

      return interaction.reply({ embeds: [embed] });
    }
  },

  contratarComRole,
  demitirComRole,
  aplicarApelido,
  selectCargoDesejado,
  modalSolicitacao,
  solicitarCargo,
  aprovarSolicitacao,
  negarSolicitacao,
};
