// "SISBAJUS": consulta o registro central de cidadão que o bot vai acumulando sozinho
// conforme as petições são protocoladas — nome atual + histórico, RG, toda conta de Discord
// já vinculada, endereço(s) e as petições já protocoladas em nome desse RG. Não é dado
// digitado na hora: é o que já existe na base por causa do uso normal do bot.
// Restrito a Promotor pra cima (Promotor/Juiz/Desembargador/Procurador/Staff) — Delegado e
// Advogado não têm acesso a esse tipo de busca consolidada.
const {
  SlashCommandBuilder, EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle,
  ButtonBuilder, ButtonStyle, UserSelectMenuBuilder,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const canais = require('../utils/canais');
const fichaUtil = require('../utils/ficha');
const cruzamento = require('../utils/cruzamento');
const auditoria = require('../utils/auditoria');
const { proximoNumero } = require('../utils/numeracao');
const { isAdmin, temCargo } = require('../utils/permissoes');
const { truncar, extrairMencaoOuId } = require('../utils/texto');

const TIPO_LABEL = { PorteArma: 'Porte de Arma', TrocaNome: 'Troca de Nome', LimpezaFicha: 'Limpeza de Ficha' };

function podeConsultar(interaction) {
  return isAdmin(interaction)
    || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Juiz')
    || temCargo(interaction, 'Desembargador') || temCargo(interaction, 'Procurador');
}

// Ficha completa — todo dado que o bot já acumulou sobre a pessoa, não só um resumo: nome
// atual + histórico completo (com data de troca), todo Discord já vinculado, todo endereço já
// declarado, toda petição, todo processo (como réu ou autor) e toda medida (como alvo).
function embedFicha(registro) {
  const nomeComOrigem = registro.nomeCivil
    ? `${registro.nomeCivil}${registro.nomeCivilOrigem ? `\n*Origem: ${registro.nomeCivilOrigem}*` : ''}`
    : '—';
  const embed = new EmbedBuilder()
    .setTitle(`🗂️ SISBAJUS — RG ${registro.rg}`)
    .setColor(0x2c3e50)
    .addFields(
      { name: 'Nome atual', value: nomeComOrigem, inline: true },
      { name: 'Trocas de nome', value: String(registro.trocasDeNome || 0), inline: true },
    );

  if ((registro.historicoNomes || []).length > 0) {
    embed.addFields({
      name: `Nomes anteriores (${registro.historicoNomes.length})`,
      value: truncar(registro.historicoNomes.map(h => `• ${h.nome} (até ${new Date(h.ate).toLocaleDateString('pt-BR')})`).join('\n')),
    });
  }

  // Cada vínculo mostra de onde veio (petição, vínculo manual, integração externa etc.) — sem
  // isso não dava pra saber se um Discord vinculado veio de uma petição de verdade ou de uma
  // fonte externa como a integração com a Polícia Civil.
  const discordIds = registro.discordIds || [];
  const origensPorId = new Map((registro.vinculosOrigem || []).map(v => [v.discordId, v.origem]));
  embed.addFields({
    name: 'Discord vinculado',
    value: discordIds.length > 0
      ? truncar(discordIds.map(id => `<@${id}>${origensPorId.has(id) ? ` — *${origensPorId.get(id)}*` : ''}`).join('\n'))
      : 'Nenhum vinculado ainda',
  });

  embed.addFields({
    name: `Endereço(s) (${(registro.enderecos || []).length})`,
    value: (registro.enderecos || []).length > 0
      ? truncar(registro.enderecos.map(e => `• ${e.endereco} (via ${e.origem})`).join('\n'))
      : '—',
  });

  if ((registro.telefones || []).length > 0) {
    embed.addFields({
      name: `Telefone(s) (${registro.telefones.length})`,
      value: truncar(registro.telefones.map(t => `• ${t.valor} (via ${t.origem})`).join('\n')),
    });
  }

  if ((registro.redesSociais || []).length > 0) {
    embed.addFields({
      name: `Rede(s) social(is) (${registro.redesSociais.length})`,
      value: truncar(registro.redesSociais.map(r => `• ${r.valor} (via ${r.origem})`).join('\n')),
    });
  }

  const peticoes = fichaUtil.peticoesDoRG(registro.rg);
  embed.addFields({
    name: `Petições protocoladas (${peticoes.length})`,
    value: peticoes.length > 0
      ? truncar(peticoes.map(p => `• ${p.numero} — ${TIPO_LABEL[p.tipo]} — *${p.status}*`).join('\n'))
      : '—',
  });

  const { processos, medidas } = fichaUtil.registrosRelacionados(registro);
  if (processos.length > 0) {
    embed.addFields({
      name: `Processos vinculados (${processos.length})`,
      value: truncar(processos.map(p => `• ${p.numero} (${p.tipo}) — *${p.status}*`).join('\n')),
    });
  }
  if (medidas.length > 0) {
    embed.addFields({
      name: `Medidas cautelares como alvo (${medidas.length})`,
      value: truncar(medidas.map(m => `• ${m.numero} (${m.tipo}) — *${m.status}*`).join('\n')),
    });
  }

  // Cruzamento por RG (Frente 7) — sempre exibido; funciona mesmo sem Discord vinculado à ficha.
  embed.addFields({ name: 'Cruzamento de antecedentes', value: truncar(cruzamento.resumoTextoPorRG(registro.rg)) });

  return embed;
}

// ---- Botão no /painel: abre um ticket com o resultado, em vez de resposta ephemeral solta —
// fica registrado quem consultou o quê, igual todo outro módulo do bot.
//
// Duas formas de buscar: selecionar a pessoa direto na lista nativa do Discord (que já filtra
// por nome/apelido enquanto digita — mais fácil quando não se sabe o RG de cor), ou informar
// o RG num modal (quando a pessoa não tem Discord vinculado ainda, ou não está mais no servidor).

function abrirConsulta(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const rowUser = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('painel:userselect:ficha:consultarpessoa').setPlaceholder('Buscar pessoa por nome/apelido no Discord'),
  );
  const rowOutros = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('painel:acao:ficha:consultarrg').setLabel('Buscar por RG').setStyle(ButtonStyle.Secondary),
    // O select acima só lista quem já está no servidor — pessoa vinculada por ID (ver
    // vincularmanual em peticao.js) mas que ainda não entrou não aparece ali. Esse botão
    // busca pelo ID digitado direto, sem depender de a pessoa ser membro.
    new ButtonBuilder().setCustomId('painel:acao:ficha:consultardiscordid').setLabel('Buscar por ID do Discord').setStyle(ButtonStyle.Secondary),
  );
  const rowLivre = new ActionRowBuilder().addComponents(
    // Cobre o que não é chave exata (RG/Discord) — nome, endereço, telefone, rede social. Pode
    // achar mais de uma pessoa (nomes/ruas parecidos), por isso o resultado é uma lista, não
    // direto a ficha completa.
    new ButtonBuilder().setCustomId('painel:acao:ficha:consultartermo').setLabel('Buscar por nome/endereço/telefone/rede').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: '🗂️ **SISBAJUS** — como quer buscar?',
    components: [rowUser, rowOutros, rowLivre], ephemeral: true,
  });
}

function abrirModalConsultaRG(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:ficha:consultarrg').setTitle('SISBAJUS — buscar por RG');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// Busca por ID/@menção digitado — não precisa que a pessoa esteja no servidor, já que
// fichaUtil.buscarPorDiscordId só olha o banco, não a lista de membros do Discord.
function abrirModalConsultaDiscordId(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:ficha:consultardiscordid').setTitle('SISBAJUS — buscar por ID do Discord');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord').setLabel('ID ou @menção do Discord').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// Busca livre — não precisa de RG nem Discord: acha pela pessoa a partir de qualquer nome
// (atual ou anterior), endereço, telefone ou rede social já registrado em alguma ficha.
function abrirModalConsultaTermo(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:ficha:consultartermo').setTitle('SISBAJUS — busca livre');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('termo').setLabel('Nome, endereço, telefone ou rede social').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function processarModalConsultaTermo(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const termo = interaction.fields.getTextInputValue('termo').trim();
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await abrirTicketConsultaTermo(interaction, termo);
  return interaction.editReply({ content: `Consulta ${numero} aberta em ${canal}.` });
}

async function processarModalConsultaDiscordId(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const discordId = extrairMencaoOuId(interaction.fields.getTextInputValue('discord'));
  if (!discordId) {
    return interaction.reply({ content: 'Não reconheci isso como um ID ou @menção do Discord válido.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await abrirTicketConsulta(interaction, { discordId });
  return interaction.editReply({ content: `Consulta ${numero} aberta em ${canal}.` });
}

// Núcleo compartilhado pelas duas formas de busca: registra a consulta, abre o ticket e posta
// o resultado (encontrado ou não).
async function abrirTicketConsulta(interaction, { rg, discordId }) {
  const registro = rg ? fichaUtil.buscarPorRG(rg) : fichaUtil.buscarPorDiscordId(discordId);
  const numero = proximoNumero(db, 'consultas', 'SB');
  const canal = await canais.criarCanalTicket(interaction.guild, {
    categoriaId: config.categoriaSisbajusId, prefixo: 'sisbajus', numero,
    membros: [interaction.user.id],
  });

  db.inserir('consultas', {
    numero, executorId: interaction.user.id, criterioRg: rg, criterioDiscordId: discordId,
    encontrado: !!registro, canalId: canal.id,
  });

  const criterioTexto = rg ? `RG ${rg}` : `Discord <@${discordId}>`;
  if (registro) {
    await canal.send({ content: `Consulta ${numero} — solicitada por <@${interaction.user.id}>.`, embeds: [embedFicha(registro)] });
  } else {
    await canal.send({
      content: `Consulta ${numero} — solicitada por <@${interaction.user.id}>.\n\n🔎 Nenhuma ficha encontrada com esse critério (${criterioTexto}) — ainda não há petição registrada em nome dessa pessoa.`,
    });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Consulta SISBAJUS', executorId: interaction.user.id,
    referencia: `${numero}: ${criterioTexto} — ${registro ? 'encontrado' : 'não encontrado'}`,
  });

  return { numero, canal };
}

// Busca livre pode achar 0, 1 ou várias fichas (nomes/ruas parecidos) — diferente da busca por
// RG/Discord, que é sempre uma chave exata. Com 1 resultado, mostra a ficha completa igual às
// outras buscas; com mais de um, mostra uma lista resumida pra ajudar a identificar qual é.
async function abrirTicketConsultaTermo(interaction, termo) {
  const resultados = fichaUtil.buscarPorTermo(termo);
  const numero = proximoNumero(db, 'consultas', 'SB');
  const canal = await canais.criarCanalTicket(interaction.guild, {
    categoriaId: config.categoriaSisbajusId, prefixo: 'sisbajus', numero,
    membros: [interaction.user.id],
  });

  db.inserir('consultas', {
    numero, executorId: interaction.user.id, criterioTermo: termo,
    encontrado: resultados.length > 0, canalId: canal.id,
  });

  if (resultados.length === 0) {
    await canal.send({
      content: `Consulta ${numero} — solicitada por <@${interaction.user.id}>.\n\n🔎 Nenhuma ficha encontrada com o termo "${termo}".`,
    });
  } else if (resultados.length === 1) {
    await canal.send({ content: `Consulta ${numero} — solicitada por <@${interaction.user.id}>.`, embeds: [embedFicha(resultados[0])] });
  } else {
    const linhas = resultados.map(r => {
      const endereco = (r.enderecos || [])[0]?.endereco;
      return `• **RG ${r.rg}** — ${r.nomeCivil || 'sem nome registrado'}${endereco ? ` — ${endereco}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`🔎 SISBAJUS — ${resultados.length} resultado(s) para "${termo}"`)
      .setColor(0xf39c12)
      .setDescription(truncar(linhas.join('\n'), 3800))
      .setFooter({ text: 'Mais de uma pessoa bateu com o termo — busque por RG pra ver a ficha completa de uma delas.' });
    await canal.send({ content: `Consulta ${numero} — solicitada por <@${interaction.user.id}>.`, embeds: [embed] });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Consulta SISBAJUS (busca livre)', executorId: interaction.user.id,
    referencia: `${numero}: "${termo}" — ${resultados.length} resultado(s)`,
  });

  return { numero, canal };
}

async function consultarPorPessoaSelecionada(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.update({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', components: [] });
  }
  const discordId = interaction.values[0];
  await interaction.update({ content: 'Buscando...', components: [] });
  const { numero, canal } = await abrirTicketConsulta(interaction, { discordId });
  return interaction.followUp({ content: `Consulta ${numero} aberta em ${canal}.`, ephemeral: true });
}

async function processarModalConsultaRG(interaction) {
  if (!podeConsultar(interaction)) {
    return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
  }
  const rg = interaction.fields.getTextInputValue('rg').trim();
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await abrirTicketConsulta(interaction, { rg });
  return interaction.editReply({ content: `Consulta ${numero} aberta em ${canal}.` });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ficha')
    .setDescription('SISBAJUS — consulta a ficha central de um cidadão (Promotor pra cima)')
    .addSubcommand(sub => sub.setName('buscar').setDescription('Busca a ficha por RG, Discord, ou nome/endereço/telefone/rede social')
      .addStringOption(o => o.setName('rg').setDescription('RG do cidadão'))
      .addUserOption(o => o.setName('discord').setDescription('Conta de Discord vinculada ao cidadão (precisa estar no servidor)'))
      .addStringOption(o => o.setName('discord_id').setDescription('ID do Discord — use se a pessoa ainda não estiver no servidor'))
      .addStringOption(o => o.setName('termo').setDescription('Nome, endereço, telefone ou rede social — pode achar mais de uma pessoa').setAutocomplete(true))),

  async execute(interaction) {
    if (!podeConsultar(interaction)) {
      return interaction.reply({ content: 'Só Promotor, Juiz, Desembargador, Procurador ou Staff podem consultar o SISBAJUS.', ephemeral: true });
    }

    const rg = interaction.options.getString('rg');
    const discordUser = interaction.options.getUser('discord');
    const discordIdTexto = interaction.options.getString('discord_id');
    const discordId = discordUser?.id || extrairMencaoOuId(discordIdTexto);
    const termo = interaction.options.getString('termo');
    if (!rg && !discordId && !termo) {
      return interaction.reply({ content: 'Informe `rg`, `discord`, `discord_id` ou `termo` pra buscar.', ephemeral: true });
    }

    if (termo) {
      const resultados = fichaUtil.buscarPorTermo(termo);
      if (resultados.length === 0) return interaction.reply({ content: `Nenhuma ficha encontrada com o termo "${termo}".`, ephemeral: true });
      if (resultados.length === 1) return interaction.reply({ embeds: [embedFicha(resultados[0])], ephemeral: true });
      const linhas = resultados.map(r => {
        const endereco = (r.enderecos || [])[0]?.endereco;
        return `• **RG ${r.rg}** — ${r.nomeCivil || 'sem nome registrado'}${endereco ? ` — ${endereco}` : ''}`;
      });
      const embed = new EmbedBuilder()
        .setTitle(`🔎 ${resultados.length} resultado(s) para "${termo}"`)
        .setColor(0xf39c12)
        .setDescription(truncar(linhas.join('\n'), 3800))
        .setFooter({ text: 'Mais de uma pessoa bateu com o termo — busque por RG pra ver a ficha completa de uma delas.' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const registro = rg ? fichaUtil.buscarPorRG(rg) : fichaUtil.buscarPorDiscordId(discordId);
    if (!registro) {
      return interaction.reply({ content: 'Nenhuma ficha encontrada com esse critério — ainda não há petição registrada pra essa pessoa.', ephemeral: true });
    }

    return interaction.reply({ embeds: [embedFicha(registro)], ephemeral: true });
  },

  // Busca em tempo real: conforme o usuário digita "rua", "joão", telefone etc, o Discord
  // consulta esse handler a cada tecla e mostra até 25 fichas que já batem — igual a
  // /crime buscar. O value de cada sugestão é o RG (chave única), então ao escolher uma
  // sugestão a busca final já resolve pra ficha certa, mesmo que várias pessoas tenham nome
  // ou rua parecida.
  async autocomplete(interaction) {
    if (!podeConsultar(interaction)) return interaction.respond([]);
    if (interaction.options.getSubcommand() !== 'buscar') return interaction.respond([]);
    const foco = interaction.options.getFocused();
    if (!foco || foco.trim().length < 2) return interaction.respond([]);
    const resultados = fichaUtil.buscarPorTermo(foco).slice(0, 25).map(r => {
      const endereco = (r.enderecos || [])[0]?.endereco;
      const label = `${r.nomeCivil || 'sem nome'} — RG ${r.rg}${endereco ? ` — ${endereco}` : ''}`;
      return { name: label.slice(0, 100), value: r.rg };
    });
    await interaction.respond(resultados);
  },

  podeConsultar, abrirConsulta, abrirModalConsultaRG, processarModalConsultaRG, consultarPorPessoaSelecionada,
  abrirModalConsultaDiscordId, processarModalConsultaDiscordId,
  abrirModalConsultaTermo, processarModalConsultaTermo,
};
