const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const canais = require('../utils/canais');
const rh = require('../utils/rh');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isSuperStaff } = require('../utils/permissoes');
const { truncar } = require('../utils/texto');
const cruzamento = require('../utils/cruzamento');
const ficha = require('../utils/ficha');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const certidoes = require('../utils/certidoes');
const documentoPng = require('../services/gerarDocumentoPNG');
const { aguardarAnexoPDF } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');

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

// Padroniza as três petições administrativas com o mesmo padrão de anexo-PDF-via-botão que a
// petição inicial civil já usa (spec-andamentos-processuais_4.md, seção 8.4) — antes o pedido
// só dizia "anexe direto na conversa", sem virar `documento` de verdade nos autos.
function botaoAnexarDocumentoPeticao(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:peticao:anexardocumento:${numero}`).setLabel('📎 Anexar documento').setStyle(ButtonStyle.Primary);
}

async function anexarDocumentoPeticao(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  anexos.criarDocumento({
    tipo: 'documento_peticao', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: numero,
  });

  await interaction.followUp({ content: `📎 [${anexo.nomeArquivo}](${anexo.url}) juntado à petição ${numero}.` });
}

function botoesDecisao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:deferir:${numero}`).setLabel('Deferir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:indeferir:${numero}`).setLabel('Indeferir').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:diligencia:${numero}`).setLabel('Converter em diligência').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:certidao:${numero}`).setLabel('📄 Requisitar certidão').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:peticao:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  );
}

// Certidão de antecedentes/não constar como investigado — já era exigida informalmente em
// todas as três petições (ver DOCUMENTOS_NECESSARIOS acima); isso dá um jeito de requisitar de
// verdade, puxando CPF e nome já cadastrados na própria petição, sem digitar de novo.
async function solicitarCertidaoDaPeticao(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (!certidoes.podeSolicitarCertidao(interaction)) {
    return interaction.reply({ content: 'Só Juiz, Promotor, Desembargador ou Procurador podem requisitar certidão.', ephemeral: true });
  }
  const instituicao = certidoes.instituicaoDoSolicitante(interaction);
  const resultado = await certidoes.solicitarCertidao({
    guild: interaction.guild, cpf: peticao.cpfCliente, nomeCliente: peticao.nomeCliente || peticao.nomeNovo,
    finalidade: `Petição ${numero} (${TIPO_LABEL[peticao.tipo]})`, executorId: interaction.user.id, instituicao,
  });
  return interaction.reply({ content: `✅ Certidão ${resultado.numero} requisitada em ${resultado.canal}.`, ephemeral: true });
}

// Juiz/Promotor só são sorteados depois que o cliente é vinculado (ver `protocolarPeticao`) —
// sortear na abertura criava um beco sem saída real: o Juiz aparecia na fila, mas `decidir`
// bloqueia sem o vínculo, e nada nunca lembrava o Advogado de completar. Assim, a petição só
// "nasce pra valer" (com Juiz e prazo de decisão correndo) quando já está completa.
async function abrirTicketPeticao({ guild, tipo, sigla, requerenteId, dados }) {
  const numero = proximoNumero(db, 'peticoes', sigla, p => p.tipo === tipo);

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaPeticoesId, prefixo: 'peticao', numero,
    membros: [requerenteId],
  });

  db.inserir('peticoes', {
    numero, tipo, requerenteId, promotor: null, juiz: null, status: 'Aguardando vínculo', canalId: canal.id, ...dados,
  });

  // Só troca de nome deferida grava nomeCivil (ver ficha.registrarTrocaNome) — sem isso, a
  // ficha de quem só pediu porte de arma ou limpeza de ficha nunca tinha nome nenhum, e o
  // SISBAJUS não achava a pessoa buscando pelo nome que ela mesma informou na petição.
  if (dados.cpfCliente && dados.nomeCliente) ficha.definirNomeSeVazio(dados.cpfCliente, dados.nomeCliente, `Petição ${numero}`);

  return { numero, canal };
}

// Sorteia Promotor/Juiz e libera a petição pra decisão — chamado assim que o Advogado vincula
// o Discord do cliente (o único requisito pra "protocolar" de verdade). Exclui o próprio
// cliente do sorteio de Juiz: sem isso, nada impedia alguém de julgar o próprio pedido caso
// tivesse cargo de Juiz também.
async function protocolarPeticao(guild, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return;
  const canal = await guild.channels.fetch(peticao.canalId).catch(() => null);
  if (!canal) return;

  const promotorId = rh.sortearPorCargo('Promotor');
  const juizId = rh.sortearJuiz({ excluirIds: [peticao.requerenteId, peticao.discordIdCliente].filter(Boolean) });

  db.atualizar('peticoes', numero, { promotor: promotorId, juiz: juizId, status: juizId ? 'Pendente' : 'Aguardando sorteio de juiz' });

  if (promotorId) await canais.adicionarMembro(canal, promotorId);
  if (juizId) await canais.adicionarMembro(canal, juizId);

  if (juizId) {
    await canal.send({
      content: `<@${juizId}> petição protocolada e pronta pra decidir.${promotorId ? ` <@${promotorId}> entra como fiscal.` : ''}`,
      embeds: [embedPeticao(db.buscarPorNumero('peticoes', numero))], components: [botoesDecisao(numero)],
    });
  } else {
    await canal.send({ content: '⚠️ Petição protocolada, mas não há Juiz ativo disponível pro sorteio no momento — o sistema tenta o sorteio automaticamente a cada poucos minutos assim que houver um Juiz disponível.' });
  }
  await auditoria.registrar(guild, { acao: 'Petição protocolada (vínculo completo)', executorId: peticao.requerenteId, referencia: numero });
}

// ---- Criação (compartilhada entre /peticao e o /painel) ----
// As três petições agora seguem a mesma lógica: protocoladas pelo Advogado em nome do
// cliente (nome, CPF, endereço), com o CPF virando a chave de rastreio na ficha central
// (utils/ficha.js). O cliente em si não precisa ter conta no Discord — quando tiver, o
// Advogado vincula depois (follow-up com UserSelectMenu), o que também é o que faz o
// cruzamento automático de antecedentes funcionar de verdade.

async function criarPeticaoPorteArma({ guild, requerenteId, cpfCliente, nomeCliente, enderecoCliente, declaracao, relacaoOcorrencias }) {
  const { numero, canal } = await abrirTicketPeticao({
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

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.PorteArma}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de porte de arma aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente}` });
  return { numero, canal };
}

async function criarPeticaoTrocaNome({ guild, requerenteId, cpfCliente, nomeAtual, nomeNovo, enderecoCliente, justificativa, jaUsouGratuita }) {
  const { numero, canal } = await abrirTicketPeticao({
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

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.TrocaNome}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de troca de nome aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente} "${nomeAtual}" → "${nomeNovo}"` });
  return { numero, canal };
}

// Limpeza de ficha exige justificativa a partir da 2ª vez, igual troca de nome — mas porte de
// arma NÃO (a renovação de 15 em 15 dias é rotina, exigir justificativa toda vez só atrapalha).
async function criarPeticaoLimpezaFicha({ guild, requerenteId, cpfCliente, nomeCliente, enderecoCliente, justificativa, jaTeveAntes }) {
  const { numero, canal } = await abrirTicketPeticao({
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

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.LimpezaFicha}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de limpeza de ficha aberta', executorId: requerenteId, referencia: `${numero}: CPF ${cpfCliente}` });
  return { numero, canal };
}

// ---- Follow-ups pós-criação: vincular Discord do cliente (obrigatório) + endereço adicional ----
// Modal do Discord só aceita 5 campos de texto — CPF, nome e endereço já lotam o modal, então
// o vínculo com uma conta de Discord (que exigiria um select, não um campo de texto) acontece
// depois, como uma mensagem NO PRÓPRIO CANAL da petição (não ephemeral) — assim não se perde
// se a pessoa fechar a mensagem, e o Juiz consegue ver que ainda falta antes de decidir.
// É obrigatório: sem vincular, a petição não pode ser deferida nem indeferida (ver `decidir`).

async function enviarFollowUpsCadastro(interaction, numero, cpfCliente, canal) {
  // O select nativo do Discord só lista quem já está no servidor — se o cliente ainda não
  // entrou, o Advogado não consegue selecionar ninguém e o vínculo trava. O botão ao lado
  // deixa informar o ID/@menção na mão; quando a pessoa entrar depois, o bot sincroniza sozinho
  // (ver guildMemberAdd em index.js).
  const rowUser = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`painel:userselect:peticao:vincularcliente#${numero}`).setPlaceholder('Selecione o cliente no Discord'),
  );
  const rowManual = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:vincularmanual:${numero}`).setLabel('Cliente ainda não está no servidor').setStyle(ButtonStyle.Secondary),
  );
  await canal.send({
    content: `<@${interaction.user.id}> ⚠️ **Vínculo obrigatório**: selecione a conta de Discord do cliente abaixo antes que esta petição possa ser decidida. Isso é o que garante o cruzamento de antecedentes e mantém a ficha do cliente correta.`,
    components: [rowUser, rowManual],
  });

  await perguntarMaisDados(interaction, numero, cpfCliente);
}

function extrairMencaoOuId(texto) {
  if (!texto) return null;
  const t = texto.trim();
  const m = t.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  return /^\d{15,25}$/.test(t) ? t : null;
}

function abrirModalVincularManual(interaction, numero) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:peticao:vincularmanual:${numero}`).setTitle('Cliente ainda não está no servidor');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('discord').setLabel('ID ou @menção do Discord do cliente').setStyle(TextInputStyle.Short).setRequired(true),
  ));
  return interaction.showModal(modal);
}

async function processarVincularManual(interaction, numero) {
  const usuarioId = extrairMencaoOuId(interaction.fields.getTextInputValue('discord'));
  if (!usuarioId) {
    return interaction.reply({ content: 'Não reconheci isso como um ID ou @menção do Discord válido. Pra pegar o ID: Configurações > Avançado > Modo desenvolvedor ligado, aí clique com botão direito no perfil da pessoa > Copiar ID.', ephemeral: true });
  }
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (peticao.discordIdCliente) return interaction.reply({ content: 'Essa petição já tem cliente vinculado.', ephemeral: true });

  ficha.vincularDiscordId(peticao.cpfCliente, usuarioId, `Petição ${numero} — vínculo manual`);
  db.atualizar('peticoes', numero, { discordIdCliente: usuarioId });
  await interaction.reply({
    content: `✅ Cliente vinculado: <@${usuarioId}> — se ainda não estiver no servidor, o apelido e os outros dados são aplicados automaticamente assim que entrar. Protocolando petição ${numero}...`,
    ephemeral: true,
  });
  return protocolarPeticao(interaction.guild, numero);
}

// Pergunta única (não mais um loop de sim/não só pra endereço) — quanto mais dado a ficha
// acumula, mais fácil o SISBAJUS acha essa pessoa depois sem precisar de CPF nem Discord.
async function perguntarMaisDados(interaction, numero, cpfCliente) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:maisdados:${numero}#${cpfCliente}`).setLabel('📎 Registrar mais dados do cliente').setStyle(ButtonStyle.Secondary),
  );
  await interaction.followUp({
    content: '📎 Quer registrar mais algum dado do cliente na ficha (outro endereço, telefone, rede social)? Ajuda a achar essa pessoa depois mesmo sem saber CPF ou Discord dela. Opcional.',
    components: [row], ephemeral: true,
  });
}

function abrirModalMaisDados(interaction, extra) {
  const [numero, cpf] = extra.split('#');
  const modal = new ModalBuilder().setCustomId(`painel:modal:peticao:maisdados:${numero}#${cpf}`).setTitle('Mais dados do cliente (opcional)');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço adicional').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('telefone').setLabel('Telefone').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rede').setLabel('Rede social (ex: @usuario, Instagram)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

async function processarMaisDados(interaction, extra) {
  const [numero, cpf] = extra.split('#');
  const endereco = interaction.fields.getTextInputValue('endereco');
  const telefone = interaction.fields.getTextInputValue('telefone');
  const rede = interaction.fields.getTextInputValue('rede');

  if (!endereco && !telefone && !rede) {
    return interaction.reply({ content: 'Nenhum campo preenchido — nada foi registrado.', ephemeral: true });
  }
  if (endereco) ficha.adicionarEndereco(cpf, endereco, numero);
  if (telefone) ficha.adicionarTelefone(cpf, telefone, numero);
  if (rede) ficha.adicionarRedeSocial(cpf, rede, numero);

  const salvos = [endereco && 'endereço', telefone && 'telefone', rede && 'rede social'].filter(Boolean).join(', ');
  return interaction.reply({ content: `Registrado na ficha do CPF ${cpf}: ${salvos}.`, ephemeral: true });
}

async function vincularClienteDiscord(interaction, numero) {
  const usuarioId = interaction.values[0];
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.update({ content: 'Petição não encontrada.', components: [] });
  if (peticao.discordIdCliente) return interaction.update({ content: 'Essa petição já tem cliente vinculado.', components: [] });
  ficha.vincularDiscordId(peticao.cpfCliente, usuarioId, `Petição ${numero}`);
  db.atualizar('peticoes', numero, { discordIdCliente: usuarioId });
  await interaction.update({ content: `✅ Cliente vinculado: <@${usuarioId}>. Protocolando petição ${numero}...`, components: [] });
  return protocolarPeticao(interaction.guild, numero);
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
  return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
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
  return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
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
  return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
}

// ---- Decisão (Juiz) ----

async function finalizarDecisao(guild, numero, status, extras = {}, executorId = null) {
  const campos = { status, ...extras };
  const peticaoAtual = db.buscarPorNumero('peticoes', numero);
  if (status === 'Deferido' && peticaoAtual.tipo === 'PorteArma') {
    campos.validadeAte = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  }
  // Diligência tem prazo de 24h (ver utils/prazos.js) — cada vez que entra em diligência de
  // novo (Juiz pediu outro documento depois do primeiro), o prazo e o aviso reiniciam.
  if (status === 'Diligência') {
    campos.diligenciaDesde = new Date().toISOString();
    campos.lembreteDiligenciaEnviado = false;
  }
  db.atualizar('peticoes', numero, campos);
  const peticao = db.buscarPorNumero('peticoes', numero);

  // Nome civil só passa a valer de fato quando o Juiz defere — vinculado ao CPF do cliente,
  // não ao ID de quem protocolou (o Advogado), já que é o cliente quem muda de nome.
  let apelidoAlterado = null;
  if (status === 'Deferido' && peticao.tipo === 'TrocaNome' && peticao.cpfCliente) {
    ficha.registrarTrocaNome(peticao.cpfCliente, peticao.nomeNovo);

    // Vínculo do Discord do cliente é obrigatório antes de deferir (ver `decidir`), então
    // sempre tem um ID aqui pra aplicar o apelido de verdade no servidor.
    if (peticao.discordIdCliente) {
      const membro = await guild.members.fetch(peticao.discordIdCliente).catch(() => null);
      if (membro) {
        apelidoAlterado = await membro.setNickname(peticao.nomeNovo.slice(0, 32)).then(() => true).catch(() => false);
      }
    }
  }

  const canal = await guild.channels.fetch(peticao.canalId).catch(() => null);
  if (canal) {
    if (status === 'Diligência') {
      // Diligência agora é uma intimação formal de verdade — o Juiz aponta exatamente o que
      // falta, e o texto já deixa claro o prazo e a consequência (indeferimento automático em
      // 24h, ver utils/prazos.js), em vez de um embed genérico "está incompleto".
      const [nomeRequerente, nomeJuiz] = await Promise.all([
        documentoPng.nomeExibicao(guild, peticao.requerenteId),
        documentoPng.nomeExibicao(guild, peticao.juiz),
      ]);
      const pngIntimacao = await documentoPng.gerarDocumentoPNG({
        tipoDocumento: 'intimacao',
        orgaoEmissor: 'judiciario',
        subunidade: 'Comarca de São Paulo — Vara Única',
        tituloDocumento: 'INTIMAÇÃO',
        numeroProcesso: numero,
        dataEmissao: documentos.dataExtenso(),
        destinatario: nomeRequerente,
        corpoTexto: [
          extras.motivo,
          '',
          'Prazo: 24 (vinte e quatro) horas, contadas desta intimação.',
          'Consequência do não atendimento: indeferimento automático do pedido, por ausência de comprovação.',
        ].join('\n'),
        nomeAssinante: nomeJuiz,
        cargoAssinante: 'Juiz de Direito',
      }).catch(err => { console.error('Falha ao gerar PNG da intimação:', err.message); return null; });

      await canal.send({
        content: documentos.textoIntimacao({
          numero, rotulo: 'Petição', destinatarioId: peticao.requerenteId,
          teor: extras.motivo,
          prazo: '24 (vinte e quatro) horas, contadas desta intimação.',
          consequencia: 'Indeferimento automático do pedido, por ausência de comprovação.',
        }),
        ...(pngIntimacao ? { files: [{ attachment: pngIntimacao, name: `Intimacao-${numero}.png` }] } : {}),
      });
      // Não é terminal — reposta os botões pra não precisar rolar o canal inteiro pra achar
      // os antigos assim que o documento pedido for anexado.
      await canal.send({
        content: `<@${peticao.requerenteId}> assim que anexar o que foi pedido, avise <@${peticao.juiz}> pra decidir de novo.`,
        components: [botoesDecisao(numero)],
      });
    } else {
      // Deferido/Indeferido: mesma sentença formal e padrão pros três tipos de petição.
      const nomeJuiz = await documentoPng.nomeExibicao(guild, peticao.juiz);
      const pngSentencaPeticao = await documentoPng.gerarDocumentoPNG({
        orgaoEmissor: 'judiciario',
        subunidade: 'Comarca de São Paulo — Vara Única',
        tituloDocumento: `SENTENÇA — ${TIPO_LABEL[peticao.tipo]}`,
        numeroProcesso: numero,
        dataEmissao: documentos.dataExtenso(),
        destinatario: peticao.nomeCliente || peticao.nomeNovo || 'Requerente',
        corpoTexto: `Resultado: ${status}\n\n${extras.motivo || '—'}`,
        nomeAssinante: nomeJuiz,
        cargoAssinante: 'Juiz de Direito',
      }).catch(err => { console.error('Falha ao gerar PNG da sentença de petição:', err.message); return null; });

      await canal.send({
        content: documentos.textoSentencaPeticao({ peticao, status, motivo: extras.motivo }),
        ...(pngSentencaPeticao ? { files: [{ attachment: pngSentencaPeticao, name: `Sentenca-${numero}.png` }] } : {}),
      });
      // Nota de cumprimento — segue a sentença acima, mas em registro de cartório (não é
      // mais um ato decisório, é o sistema executando o que já foi decidido). Por isso o
      // texto evita jargão de Discord ("apelido", "servidor") e fala em nome civil/registro.
      const extrasLinhas = [];
      if (extras.nivelRisco !== undefined) extrasLinhas.push(`Nível de risco reconhecido pelo Juízo: ${extras.nivelRisco}`);
      if (peticao.validadeAte) extrasLinhas.push(`Validade da autorização: até <t:${Math.floor(new Date(peticao.validadeAte).getTime() / 1000)}:D>`);
      if (apelidoAlterado === true) extrasLinhas.push(`✅ Nome civil retificado nos registros do sistema, em cumprimento à sentença supra.`);
      if (apelidoAlterado === false) extrasLinhas.push(`⚠️ Retificação de registro pendente — o sistema não conseguiu atualizar o nome civil automaticamente. Regularização manual necessária junto à Secretaria.`);
      if (extrasLinhas.length) {
        await canal.send({
          embeds: [new EmbedBuilder()
            .setColor(status === 'Deferido' ? 0x2ecc71 : 0xe74c3c)
            .setTitle('📋 Cumprimento de sentença')
            .setDescription(extrasLinhas.join('\n'))],
        });
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
  if (interaction.user.id !== peticao.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz responsável por esta petição pode decidir — no caso, <@${peticao.juiz}>.`, ephemeral: true });
  }
  // "Diligência" não é terminal — o Juiz pode (e deve) decidir de novo depois que o documento
  // pedido for anexado na conversa. Só bloqueia se já foi Deferido/Indeferido de verdade.
  if (!['Pendente', 'Diligência'].includes(peticao.status)) {
    return interaction.reply({ content: 'Essa petição já foi decidida (deferida ou indeferida).', ephemeral: true });
  }
  // Vínculo do Discord do cliente é obrigatório pra decisão final — é o que garante que a
  // ficha e o cruzamento de antecedentes fiquem corretos. "Diligência" ainda é permitido, já
  // que não é uma decisão final e pode inclusive servir de lembrete pro Advogado vincular.
  if ((acao === 'deferir' || acao === 'indeferir') && !peticao.discordIdCliente) {
    return interaction.reply({
      content: `Essa petição ainda não tem o Discord do cliente vinculado — é obrigatório antes de decidir. Peça pro Advogado <@${peticao.requerenteId}> selecionar no menu que apareceu neste canal quando a petição foi aberta.`,
      ephemeral: true,
    });
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
      // Diligência vira intimação formal (ver finalizarDecisao) — o Juiz precisa apontar
      // exatamente o que falta, não só "está incompleto", pra intimação fazer sentido.
      .setLabel(acao === 'indeferir' ? 'Motivo do indeferimento' : 'O que falta (ex: juntar documento X)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
  ));
  return interaction.showModal(modal);
}

async function confirmarDeferimento(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (interaction.user.id !== peticao.juiz && !isSuperStaff(interaction)) {
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
  // Defesa em profundidade — mesmo raciocínio de salvarSentenca: o commit final da decisão
  // de mérito reverifica o Juiz responsável, não confia só na trava dos passos anteriores.
  const peticaoAlvo = db.buscarPorNumero('peticoes', numero);
  if (!peticaoAlvo) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (interaction.user.id !== peticaoAlvo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz responsável por esta petição pode decidir — no caso, <@${peticaoAlvo.juiz}>.`, ephemeral: true });
  }

  const nivel = Number(interaction.values[0]);
  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a petição sendo deferida com sucesso.
  await interaction.deferUpdate();
  await finalizarDecisao(interaction.guild, numero, 'Deferido', { nivelRisco: nivel }, interaction.user.id);
  return interaction.editReply({ content: `Nível de risco ${nivel} registrado. Petição ${numero} deferida (porte válido por 15 dias).`, components: [] });
}

async function processarModalDecisao(interaction, numero, acao) {
  const peticaoAlvo = db.buscarPorNumero('peticoes', numero);
  if (!peticaoAlvo) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (interaction.user.id !== peticaoAlvo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz responsável por esta petição pode decidir — no caso, <@${peticaoAlvo.juiz}>.`, ephemeral: true });
  }

  const motivo = interaction.fields.getTextInputValue('motivo');
  const status = acao === 'indeferir' ? 'Indeferido' : 'Diligência';
  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a decisão sendo registrada com sucesso.
  await interaction.deferReply({ ephemeral: true });
  await finalizarDecisao(interaction.guild, numero, status, { motivo }, interaction.user.id);
  return interaction.editReply({ content: `Petição ${numero}: ${status.toLowerCase()}.` });
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
      return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
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
      return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
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
      return enviarFollowUpsCadastro(interaction, numero, cpf, canal);
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
  abrirModalMaisDados, processarMaisDados,
  vincularClienteDiscord, protocolarPeticao,
  abrirModalVincularManual, processarVincularManual,
  embedPeticao, botoesDecisao, solicitarCertidaoDaPeticao,
  anexarDocumentoPeticao,
};
