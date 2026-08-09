const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const canais = require('../utils/canais');
const rh = require('../utils/rh');
const { proximoNumero } = require('../utils/numeracao');
const { isAdmin, temCargo } = require('../utils/permissoes');
const { truncar } = require('../utils/texto');
const cruzamento = require('../utils/cruzamento');
const ficha = require('../utils/ficha');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');

const TIPO_LABEL = { PorteArma: 'Porte de Arma', TrocaNome: 'Troca de Nome', LimpezaFicha: 'Limpeza de Ficha' };

// Referência exibida pro Juiz — o bot não classifica sozinho, exige julgamento sobre prova.
const TABELA_RISCO = [
  '**0** — Alegação sem prova, B.O. único de furto sem violência, boato sem nome/testemunha, medo genérico → indeferimento automático',
  '**1** — B.O. único de roubo c/ grave ameaça sem repetição; ameaça verbal isolada, 1 testemunha, sem prova material → indício, não basta sozinho',
  '**2** — Cumpre 2+ de: autoria identificada, prova material objetiva, repetição (2+ registros em 30 dias), nexo causal claro → pode sustentar',
  '**3** — Ameaça de morte nominal c/ prova; tentativa de homicídio; sequestro/cárcere privado; confronto c/ disparo; lista de execução → basta isoladamente',
].join('\n');

const DOCUMENTOS_NECESSARIOS = {
  PorteArma: 'Certidão de antecedentes criminais negativa, certidão de não constar como investigado, e provas do risco (B.O., prints, laudos etc).',
  TrocaNome: 'Certidão de não constar como investigado.',
  LimpezaFicha: 'Declaração do empregador (vínculo nos últimos 15 dias) e certidão de não constar como investigado.',
};

// Porte ativo agora é rastreado pelo CPF do cliente, não pelo Discord de quem protocolou
// (o Advogado) — dois advogados diferentes pedindo pro mesmo cliente têm que enxergar o
// mesmo porte ativo.
function porteAtivo(cpfCliente) {
  const agora = Date.now();
  return db.buscarUm('peticoes', p => p.tipo === 'PorteArma' && p.cpfCliente === cpfCliente && p.status === 'Deferido' && p.validadeAte && new Date(p.validadeAte).getTime() > agora);
}

function embedPeticao(p) {
  const embed = new EmbedBuilder()
    .setTitle(`📄 Petição ${p.numero} — ${TIPO_LABEL[p.tipo]}`)
    .setColor(0x16a085)
    .addFields(
      { name: 'Advogado(a)', value: `<@${p.requerenteId}>`, inline: true },
      { name: 'Status', value: p.status, inline: true },
    );
  if (p.cpfCliente) {
    embed.addFields(
      { name: 'Cliente', value: p.nomeCliente || '—', inline: true },
      { name: 'CPF', value: p.cpfCliente, inline: true },
      { name: 'Endereço', value: truncar(p.enderecoCliente) || '—', inline: true },
      { name: 'Discord do cliente', value: p.discordIdCliente ? `<@${p.discordIdCliente}>` : 'Não vinculado', inline: true },
    );
  }
  if (p.juiz) embed.addFields({ name: 'Juiz', value: `<@${p.juiz}>`, inline: true });
  if (p.promotor) embed.addFields({ name: 'Promotor (fiscal)', value: `<@${p.promotor}>`, inline: true });
  embed.addFields({ name: '📎 Documentos a anexar nesta conversa', value: DOCUMENTOS_NECESSARIOS[p.tipo] });
  return embed;
}

function botoesDecisao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:deferir:${numero}`).setLabel('Deferir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:indeferir:${numero}`).setLabel('Indeferir').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:diligencia:${numero}`).setLabel('Converter em diligência').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  );
}

async function abrirTicketPeticao({ guild, tipo, sigla, requerenteId, dados }) {
  const numero = proximoNumero(db, 'peticoes', sigla, p => p.tipo === tipo);
  const promotorId = rh.sortearPorCargo('Promotor');
  const juizId = rh.sortearJuiz({ excluirIds: [requerenteId] });

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaPeticoesId, prefixo: 'peticao', numero,
    membros: [requerenteId, promotorId, juizId].filter(Boolean),
  });

  db.inserir('peticoes', {
    numero, tipo, requerenteId, promotor: promotorId, juiz: juizId, status: 'Pendente', canalId: canal.id, ...dados,
  });

  return { numero, canal, promotorId, juizId };
}

// ---- Criação (compartilhada entre /peticao e o /painel) ----
// As três petições agora seguem a mesma lógica: protocoladas pelo Advogado em nome do
// cliente (nome, CPF, endereço), com o CPF virando a chave de rastreio na ficha central
// (utils/ficha.js). O cliente em si não precisa ter conta no Discord — quando tiver, o
// Advogado vincula depois (follow-up com UserSelectMenu), o que também é o que faz o
// cruzamento automático de antecedentes funcionar de verdade.

async function criarPeticaoPorteArma({ guild, requerenteId, cpfCliente, nomeCliente, enderecoCliente, declaracao, relacaoOcorrencias }) {
  const { numero, canal, juizId, promotorId } = await abrirTicketPeticao({
    guild, tipo: 'PorteArma', sigla: 'PA', requerenteId,
    dados: { cpfCliente, nomeCliente, enderecoCliente, declaracao, relacaoOcorrencias: relacaoOcorrencias || null },
  });

  const ativo = porteAtivo(cpfCliente);
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Declaração (maioridade/residência)', value: truncar(declaracao) },
      { name: 'Já possui porte ativo?', value: ativo ? `⚠️ Sim — ${ativo.numero}, válido até <t:${Math.floor(new Date(ativo.validadeAte).getTime() / 1000)}:D>` : 'Não' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorCPF(cpfCliente)) },
      { name: 'Referência — nível de risco', value: truncar(TABELA_RISCO) },
    );
  if (relacaoOcorrencias) embed.addFields({ name: 'Relação de ocorrências', value: truncar(relacaoOcorrencias) });

  await canal.send({
    content: `<@${juizId || '—'}> nova petição de porte de arma pra decidir.${promotorId ? ` <@${promotorId}> entra como fiscal.` : ''}`,
    embeds: [embed], components: juizId ? [botoesDecisao(numero)] : [],
  });
  await auditoria.registrar(guild, { acao: 'Petição de porte de arma aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente}` });
  return { numero, canal };
}

async function criarPeticaoTrocaNome({ guild, requerenteId, cpfCliente, nomeAtual, nomeNovo, enderecoCliente, justificativa, jaUsouGratuita }) {
  const { numero, canal, juizId, promotorId } = await abrirTicketPeticao({
    guild, tipo: 'TrocaNome', sigla: 'TN', requerenteId,
    dados: { cpfCliente, nomeCliente: nomeNovo, nomeAtual, nomeNovo, enderecoCliente, justificativa: justificativa || null, primeiraVez: !jaUsouGratuita },
  });

  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Nome atual', value: nomeAtual, inline: true },
      { name: 'Nome pretendido', value: nomeNovo, inline: true },
      { name: 'Primeira troca deste CPF (gratuita)?', value: jaUsouGratuita ? '⚠️ Não — é a 2ª vez ou mais' : 'Sim' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorCPF(cpfCliente)) },
    );
  if (justificativa) embed.addFields({ name: 'Justificativa', value: truncar(justificativa) });

  await canal.send({
    content: `<@${juizId || '—'}> nova petição de troca de nome pra decidir.${promotorId ? ` <@${promotorId}> entra como fiscal.` : ''}`,
    embeds: [embed], components: juizId ? [botoesDecisao(numero)] : [],
  });
  await auditoria.registrar(guild, { acao: 'Petição de troca de nome aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente} "${nomeAtual}" → "${nomeNovo}"` });
  return { numero, canal };
}

// Limpeza de ficha exige justificativa a partir da 2ª vez, igual troca de nome — mas porte de
// arma NÃO (a renovação de 15 em 15 dias é rotina, exigir justificativa toda vez só atrapalha).
async function criarPeticaoLimpezaFicha({ guild, requerenteId, cpfCliente, nomeCliente, enderecoCliente, justificativa, jaTeveAntes }) {
  const { numero, canal, juizId, promotorId } = await abrirTicketPeticao({
    guild, tipo: 'LimpezaFicha', sigla: 'LF', requerenteId,
    dados: { cpfCliente, nomeCliente, enderecoCliente, justificativa: justificativa || null, primeiraVez: !jaTeveAntes },
  });

  const temNovoAntecedente = cruzamento.temNovoAntecedenteEmPorCPF(cpfCliente, null, 15);
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Já teve limpeza de ficha deferida antes?', value: jaTeveAntes ? '⚠️ Sim — é a 2ª vez ou mais' : 'Não' },
      { name: 'Novo antecedente nos últimos 15 dias?', value: temNovoAntecedente ? '⚠️ Sim — indeferimento sumário indicado' : '✅ Não' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorCPF(cpfCliente)) },
    );
  if (justificativa) embed.addFields({ name: 'Justificativa', value: truncar(justificativa) });

  await canal.send({
    content: `<@${juizId || '—'}> nova petição de limpeza de ficha pra decidir.${promotorId ? ` <@${promotorId}> entra como fiscal.` : ''}`,
    embeds: [embed], components: juizId ? [botoesDecisao(numero)] : [],
  });
  await auditoria.registrar(guild, { acao: 'Petição de limpeza de ficha aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente}` });
  return { numero, canal };
}

// ---- Follow-ups pós-criação: vincular Discord do cliente + registrar endereço adicional ----
// Modal do Discord só aceita 5 campos de texto — CPF, nome e endereço já lotam o modal, então
// o vínculo com uma conta de Discord (que exigiria um select, não um campo de texto) e a
// pergunta sobre outros endereços acontecem depois, como mensagens ephemeral separadas.

async function enviarFollowUpsCadastro(interaction, numero, cpfCliente) {
  const rowUser = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`painel:userselect:peticao:vincularcliente#${numero}`).setPlaceholder('Selecione o cliente no Discord (opcional)'),
  );
  const rowSkip = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:pularvinculo:${numero}`).setLabel('Cliente não tem Discord / pular').setStyle(ButtonStyle.Secondary),
  );
  await interaction.followUp({
    content: 'Se o cliente tiver conta no Discord, vincule abaixo — isso é o que faz o cruzamento automático de antecedentes funcionar de verdade nas próximas petições dele.',
    components: [rowUser, rowSkip], ephemeral: true,
  });

  await perguntarEnderecoAdicional(interaction, numero, cpfCliente);
}

async function perguntarEnderecoAdicional(interaction, numero, cpfCliente) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:enderecoextra:${numero}#${cpfCliente}`).setLabel('Sim, tem outro endereço').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:semenderecoextra:${numero}`).setLabel('Não').setStyle(ButtonStyle.Secondary),
  );
  await interaction.followUp({ content: '📍 O cliente possui mais de um endereço em nome dele que também deva constar na ficha?', components: [row], ephemeral: true });
}

async function abrirModalEnderecoExtra(interaction, extra) {
  const [numero, cpf] = extra.split('#');
  const modal = new ModalBuilder().setCustomId(`painel:modal:peticao:enderecoextra:${numero}#${cpf}`).setTitle('Endereço adicional do cliente');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('endereco').setLabel('Endereço adicional').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200),
  ));
  return interaction.showModal(modal);
}

async function processarEnderecoExtra(interaction, extra) {
  const [numero, cpf] = extra.split('#');
  const endereco = interaction.fields.getTextInputValue('endereco');
  ficha.adicionarEndereco(cpf, endereco, numero);
  await interaction.reply({ content: `Endereço adicional salvo na ficha do CPF ${cpf}.`, ephemeral: true });
  return perguntarEnderecoAdicional(interaction, numero, cpf);
}

function semEnderecoExtra(interaction) {
  return interaction.update({ content: 'Ok, nenhum endereço adicional registrado.', components: [] });
}

function pularVinculoDiscord(interaction) {
  return interaction.update({ content: 'Ok, cliente segue sem conta de Discord vinculada — o cruzamento automático de antecedentes fica limitado até vincular.', components: [] });
}

async function vincularClienteDiscord(interaction, numero) {
  const usuarioId = interaction.values[0];
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.update({ content: 'Petição não encontrada.', components: [] });
  ficha.vincularDiscordId(peticao.cpfCliente, usuarioId);
  db.atualizar('peticoes', numero, { discordIdCliente: usuarioId });
  return interaction.update({ content: `Cliente vinculado: <@${usuarioId}>. As próximas petições desse CPF já vão cruzar antecedentes automaticamente.`, components: [] });
}

// ---- Modais do /painel ----

function abrirModalPorteArma(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar porte de arma, em nome do cliente.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:porte-arma').setTitle('Porte de arma — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cpf').setLabel('CPF do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('declaracao').setLabel('Declaração: maioridade e residência fixa').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('relacao').setLabel('Relação de ocorrências (se repetição)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)),
  );
  return interaction.showModal(modal);
}

function abrirModalTrocaNome(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar troca de nome, em nome do cliente.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:troca-nome').setTitle('Troca de nome — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cpf').setLabel('CPF do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome_atual').setLabel('Nome atual do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome_novo').setLabel('Nome pretendido').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('justificativa').setLabel('Justificativa (obrigatório da 2ª vez)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)),
  );
  return interaction.showModal(modal);
}

function abrirModalLimpezaFicha(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar limpeza de ficha, em nome do cliente.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:limpeza-ficha').setTitle('Limpeza de ficha — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cpf').setLabel('CPF do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('justificativa').setLabel('Justificativa (obrigatório da 2ª vez)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)),
  );
  return interaction.showModal(modal);
}

async function processarModalPorteArma(interaction) {
  const cpf = interaction.fields.getTextInputValue('cpf');
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await criarPeticaoPorteArma({
    guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
    nomeCliente: interaction.fields.getTextInputValue('nome'),
    enderecoCliente: interaction.fields.getTextInputValue('endereco'),
    declaracao: interaction.fields.getTextInputValue('declaracao'),
    relacaoOcorrencias: interaction.fields.getTextInputValue('relacao'),
  });
  ficha.adicionarEndereco(cpf, interaction.fields.getTextInputValue('endereco'), numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, cpf);
}

async function processarModalTrocaNome(interaction) {
  const cpf = interaction.fields.getTextInputValue('cpf');
  const justificativa = interaction.fields.getTextInputValue('justificativa');
  const jaTrocou = ficha.jaTrocouNomeAntes(cpf);
  if (jaTrocou && !justificativa) {
    return interaction.reply({ content: `Esse CPF (${cpf}) já teve uma troca de nome deferida antes — a partir da segunda vez é obrigatório preencher \`justificativa\` com o motivo da nova troca. Abra a petição de novo e preencha o campo.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const endereco = interaction.fields.getTextInputValue('endereco');
  const { numero, canal } = await criarPeticaoTrocaNome({
    guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
    nomeAtual: interaction.fields.getTextInputValue('nome_atual'),
    nomeNovo: interaction.fields.getTextInputValue('nome_novo'),
    enderecoCliente: endereco,
    justificativa, jaUsouGratuita: jaTrocou,
  });
  ficha.adicionarEndereco(cpf, endereco, numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, cpf);
}

async function processarModalLimpezaFicha(interaction) {
  const cpf = interaction.fields.getTextInputValue('cpf');
  const justificativa = interaction.fields.getTextInputValue('justificativa');
  const jaTeveAntes = ficha.jaTeveLimpezaFichaDeferida(cpf);
  if (jaTeveAntes && !justificativa) {
    return interaction.reply({ content: `Esse CPF (${cpf}) já teve limpeza de ficha deferida antes — a partir da segunda vez é obrigatório preencher \`justificativa\`.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const endereco = interaction.fields.getTextInputValue('endereco');
  const { numero, canal } = await criarPeticaoLimpezaFicha({
    guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
    nomeCliente: interaction.fields.getTextInputValue('nome'),
    enderecoCliente: endereco,
    justificativa, jaTeveAntes,
  });
  ficha.adicionarEndereco(cpf, endereco, numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, cpf);
}

// ---- Decisão (Juiz) ----

async function finalizarDecisao(guild, numero, status, extras = {}, executorId = null) {
  const campos = { status, ...extras };
  const peticaoAtual = db.buscarPorNumero('peticoes', numero);
  if (status === 'Deferido' && peticaoAtual.tipo === 'PorteArma') {
    campos.validadeAte = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  }
  db.atualizar('peticoes', numero, campos);
  const peticao = db.buscarPorNumero('peticoes', numero);

  // Nome civil só passa a valer de fato quando o Juiz defere — vinculado ao CPF do cliente,
  // não ao ID de quem protocolou (o Advogado), já que é o cliente quem muda de nome.
  if (status === 'Deferido' && peticao.tipo === 'TrocaNome' && peticao.cpfCliente) {
    ficha.registrarTrocaNome(peticao.cpfCliente, peticao.nomeNovo);
  }

  const canal = await guild.channels.fetch(peticao.canalId).catch(() => null);
  if (canal) {
    if (status === 'Diligência') {
      const cor = 0xf39c12;
      const linhas = [`Petição ${numero}: **${status}**`];
      if (extras.motivo) linhas.push(`Documento/diligência pendente: ${extras.motivo}`);
      await canal.send({ embeds: [new EmbedBuilder().setColor(cor).setDescription(linhas.join('\n'))] });
      // Não é terminal — reposta os botões pra não precisar rolar o canal inteiro pra achar
      // os antigos assim que o documento pedido for anexado.
      await canal.send({
        content: `<@${peticao.requerenteId}> assim que anexar o que foi pedido, avise <@${peticao.juiz}> pra decidir de novo.`,
        components: [botoesDecisao(numero)],
      });
    } else {
      // Deferido/Indeferido: mesma sentença formal e padrão pros três tipos de petição.
      await canal.send({ content: documentos.textoSentencaPeticao({ peticao, status, motivo: extras.motivo }) });
      const extrasLinhas = [];
      if (extras.nivelRisco !== undefined) extrasLinhas.push(`Nível de risco reconhecido: ${extras.nivelRisco}`);
      if (peticao.validadeAte) extrasLinhas.push(`Válido até: <t:${Math.floor(new Date(peticao.validadeAte).getTime() / 1000)}:D>`);
      if (extrasLinhas.length) {
        await canal.send({ embeds: [new EmbedBuilder().setColor(status === 'Deferido' ? 0x2ecc71 : 0xe74c3c).setDescription(extrasLinhas.join('\n'))] });
      }
      await canais.arquivarCanal(canal);
    }
  }

  if (executorId) {
    await auditoria.registrar(guild, {
      acao: `Petição ${TIPO_LABEL[peticao.tipo]}: ${status}`,
      executorId, referencia: numero, motivo: extras.motivo || '—',
    });
  }

  return peticao;
}

async function decidir(interaction, numero, acao) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (interaction.user.id !== peticao.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz responsável por esta petição pode decidir — no caso, <@${peticao.juiz}>.`, ephemeral: true });
  }
  // "Diligência" não é terminal — o Juiz pode (e deve) decidir de novo depois que o documento
  // pedido for anexado na conversa. Só bloqueia se já foi Deferido/Indeferido de verdade.
  if (!['Pendente', 'Diligência'].includes(peticao.status)) {
    return interaction.reply({ content: 'Essa petição já foi decidida (deferida ou indeferida).', ephemeral: true });
  }

  if (acao === 'deferir') {
    // Documento não é mais exigido na abertura — só vive como mensagem no canal. Por isso o
    // Juiz precisa confirmar explicitamente que conferiu antes de qualquer coisa ser deferida.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:peticao:confirmardeferir:${numero}`).setLabel('Sim, já conferi — deferir').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:peticao:cancelardecisao:${numero}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `⚠️ Confirma que os documentos exigidos foram anexados e conferidos nesta conversa?\n📎 ${DOCUMENTOS_NECESSARIOS[peticao.tipo]}`,
      components: [row], ephemeral: true,
    });
  }

  const titulo = acao === 'indeferir' ? 'Indeferir petição' : 'Converter em diligência';
  const modal = new ModalBuilder().setCustomId(`painel:modal:peticao:${acao}:${numero}`).setTitle(titulo);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('motivo')
      .setLabel(acao === 'indeferir' ? 'Motivo do indeferimento' : 'Documento/diligência pendente')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
  ));
  return interaction.showModal(modal);
}

async function confirmarDeferimento(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (interaction.user.id !== peticao.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz responsável por esta petição pode decidir — no caso, <@${peticao.juiz}>.`, ephemeral: true });
  }
  if (!['Pendente', 'Diligência'].includes(peticao.status)) {
    return interaction.update({ content: 'Essa petição já foi decidida (deferida ou indeferida).', components: [] });
  }

  if (peticao.tipo === 'PorteArma') {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:peticao:risco:${numero}`).setPlaceholder('Nível de risco (0-3)')
        .addOptions([0, 1, 2, 3].map(n => ({ label: `Nível ${n}`, value: String(n) }))),
    );
    return interaction.update({ content: `Qual o nível de risco, com base nas provas?\n\n${TABELA_RISCO}`, components: [row] });
  }

  await interaction.deferUpdate();
  await finalizarDecisao(interaction.guild, numero, 'Deferido', {}, interaction.user.id);
  return interaction.editReply({ content: `Petição ${numero} deferida.`, components: [] });
}

function cancelarDecisao(interaction) {
  return interaction.update({ content: 'Decisão cancelada — nada foi alterado.', components: [] });
}

async function processarDecisaoRisco(interaction, numero) {
  const nivel = Number(interaction.values[0]);
  await finalizarDecisao(interaction.guild, numero, 'Deferido', { nivelRisco: nivel }, interaction.user.id);
  return interaction.update({ content: `Nível de risco ${nivel} registrado. Petição ${numero} deferida (porte válido por 15 dias).`, components: [] });
}

async function processarModalDecisao(interaction, numero, acao) {
  const motivo = interaction.fields.getTextInputValue('motivo');
  const status = acao === 'indeferir' ? 'Indeferido' : 'Diligência';
  await finalizarDecisao(interaction.guild, numero, status, { motivo }, interaction.user.id);
  return interaction.reply({ content: `Petição ${numero}: ${status.toLowerCase()}.`, ephemeral: true });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('peticao')
    .setDescription('Petições administrativas — protocoladas por Advogado em nome do cliente')
    .addSubcommand(sub => sub.setName('porte-arma').setDescription('Advogado protocola porte de arma do cliente (anexe os documentos depois, no canal)')
      .addStringOption(o => o.setName('cpf').setDescription('CPF do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome').setDescription('Nome completo do cliente').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true))
      .addStringOption(o => o.setName('declaracao').setDescription('Declaração de maioridade civil e residência fixa').setRequired(true))
      .addStringOption(o => o.setName('relacao_ocorrencias').setDescription('Relação objetiva das ocorrências, se alegar repetição')))
    .addSubcommand(sub => sub.setName('troca-nome').setDescription('Advogado protocola troca de nome do cliente (anexe a certidão depois, no canal)')
      .addStringOption(o => o.setName('cpf').setDescription('CPF do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome_atual').setDescription('Nome completo atual do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome_novo').setDescription('Nome completo pretendido').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true))
      .addStringOption(o => o.setName('justificativa').setDescription('Obrigatório a partir da 2ª troca deste CPF')))
    .addSubcommand(sub => sub.setName('limpeza-ficha').setDescription('Advogado protocola limpeza de ficha do cliente (anexe os documentos depois, no canal)')
      .addStringOption(o => o.setName('cpf').setDescription('CPF do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome').setDescription('Nome completo do cliente').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true))
      .addStringOption(o => o.setName('justificativa').setDescription('Obrigatório a partir da 2ª vez deste CPF'))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!temCargo(interaction, 'Advogado')) {
      return interaction.reply({ content: 'Só Advogados podem protocolar petições administrativas, em nome do cliente.', ephemeral: true });
    }

    if (sub === 'porte-arma') {
      const cpf = interaction.options.getString('cpf');
      await interaction.deferReply({ ephemeral: true });
      const endereco = interaction.options.getString('endereco');
      const { numero, canal } = await criarPeticaoPorteArma({
        guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
        nomeCliente: interaction.options.getString('nome'), enderecoCliente: endereco,
        declaracao: interaction.options.getString('declaracao'),
        relacaoOcorrencias: interaction.options.getString('relacao_ocorrencias'),
      });
      ficha.adicionarEndereco(cpf, endereco, numero);
      await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
      return enviarFollowUpsCadastro(interaction, numero, cpf);
    }

    if (sub === 'troca-nome') {
      const cpf = interaction.options.getString('cpf');
      const justificativa = interaction.options.getString('justificativa');
      const jaTrocou = ficha.jaTrocouNomeAntes(cpf);
      if (jaTrocou && !justificativa) {
        return interaction.reply({ content: `Esse CPF (${cpf}) já teve uma troca de nome deferida antes — a partir da segunda vez é obrigatório informar \`justificativa\`.`, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const endereco = interaction.options.getString('endereco');
      const { numero, canal } = await criarPeticaoTrocaNome({
        guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
        nomeAtual: interaction.options.getString('nome_atual'),
        nomeNovo: interaction.options.getString('nome_novo'),
        enderecoCliente: endereco,
        justificativa, jaUsouGratuita: jaTrocou,
      });
      ficha.adicionarEndereco(cpf, endereco, numero);
      await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
      return enviarFollowUpsCadastro(interaction, numero, cpf);
    }

    if (sub === 'limpeza-ficha') {
      const cpf = interaction.options.getString('cpf');
      const justificativa = interaction.options.getString('justificativa');
      const jaTeveAntes = ficha.jaTeveLimpezaFichaDeferida(cpf);
      if (jaTeveAntes && !justificativa) {
        return interaction.reply({ content: `Esse CPF (${cpf}) já teve limpeza de ficha deferida antes — a partir da segunda vez é obrigatório informar \`justificativa\`.`, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const endereco = interaction.options.getString('endereco');
      const { numero, canal } = await criarPeticaoLimpezaFicha({
        guild: interaction.guild, requerenteId: interaction.user.id, cpfCliente: cpf,
        nomeCliente: interaction.options.getString('nome'), enderecoCliente: endereco,
        justificativa, jaTeveAntes,
      });
      ficha.adicionarEndereco(cpf, endereco, numero);
      await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
      return enviarFollowUpsCadastro(interaction, numero, cpf);
    }
  },

  abrirModalPorteArma, abrirModalTrocaNome, abrirModalLimpezaFicha,
  processarModalPorteArma, processarModalTrocaNome, processarModalLimpezaFicha,
  decidir,
  confirmarDeferimento,
  cancelarDecisao,
  processarDecisaoRisco,
  processarModalDecisao,
  finalizarDecisao,
  abrirModalEnderecoExtra, processarEnderecoExtra, semEnderecoExtra,
  pularVinculoDiscord, vincularClienteDiscord,
};
