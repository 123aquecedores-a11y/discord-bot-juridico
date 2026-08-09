const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { temCargo, isAdmin } = require('../utils/permissoes');
const rh = require('../utils/rh');
const crimes = require('../data/crimes.json');
const processoCmd = require('./processo');
const medidaCmd = require('./medida');
const mandadoCmd = require('./mandado');
const oficioCmd = require('./oficio');
const rhCmd = require('./rh');
const crimeCmd = require('./crime');
const rascunhoCrimes = require('../utils/rascunhoCrimes');
const crimePicker = require('../utils/crimePicker');
const supervisao = require('../utils/supervisao');
const peticaoCmd = require('./peticao');
const canais = require('../utils/canais');
const auditoria = require('../utils/auditoria');

// ---- Menu principal ----

function embedMenuPrincipal() {
  return new EmbedBuilder()
    .setTitle('⚖️ Painel Jurídico')
    .setColor(0x2c3e50)
    .setDescription('Escolha um módulo abaixo — mesmas funções dos comandos de barra, só que sem digitar.');
}

function botoesMenuPrincipal() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('painel:menu:processo').setLabel('📁 Processo').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('painel:menu:medida').setLabel('📋 Medida').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('painel:menu:mandado').setLabel('📜 Mandado').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('painel:menu:oficio').setLabel('✉️ Ofício').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('painel:menu:crime').setLabel('🔍 Crime').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('painel:menu:rh').setLabel('👥 RH').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('painel:menu:supervisao').setLabel('⚖️ Supervisão').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('painel:menu:peticao').setLabel('📄 Petição').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function botaoVoltar() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('painel:menu:home').setLabel('⬅️ Voltar ao menu').setStyle(ButtonStyle.Secondary),
  );
}

const TITULOS = {
  processo: '📁 Processo',
  medida: '📋 Medida',
  mandado: '📜 Mandado',
  oficio: '✉️ Ofício',
  crime: '🔍 Crime',
  rh: '👥 RH (Staff/Administração)',
  supervisao: '⚖️ Supervisão (Desembargador/Procurador/Staff)',
  peticao: '📄 Petição administrativa',
};

// Monta um botão só se `permitido` for true — usado pra cada pessoa ver só as ações que o
// próprio cargo libera, em vez de mostrar tudo e recusar depois de clicar.
function botaoSe(permitido, customId, label, style) {
  return permitido ? new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style) : null;
}

// Uma ActionRow com pelo menos 1 botão — descarta linhas que ficaram vazias depois do filtro
// (o Discord recusa um row sem componente nenhum).
function linha(...botoes) {
  const validos = botoes.filter(Boolean);
  return validos.length ? new ActionRowBuilder().addComponents(validos) : null;
}

function submenuProcesso(interaction) {
  return [
    linha(
      botaoSe(temCargo(interaction, 'Delegado'), 'painel:acao:processo:penal', 'Abrir Penal', ButtonStyle.Success),
      botaoSe(temCargo(interaction, 'Advogado'), 'painel:acao:processo:civil', 'Abrir Civil', ButtonStyle.Success),
    ),
    linha(
      botaoSe(true, 'painel:acao:processo:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:processo:listar', 'Listar recentes', ButtonStyle.Primary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuMedida(interaction) {
  return [
    linha(
      botaoSe(temCargo(interaction, 'Delegado'), 'painel:acao:medida:solicitar', 'Solicitar', ButtonStyle.Success),
      botaoSe(true, 'painel:acao:medida:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:medida:listar', 'Listar recentes', ButtonStyle.Primary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuMandado() {
  return [
    linha(
      botaoSe(true, 'painel:acao:mandado:ver', 'Ver', ButtonStyle.Primary),
      botaoSe(true, 'painel:acao:mandado:listar', 'Listar recentes', ButtonStyle.Primary),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuOficio(interaction) {
  return [
    linha(
      botaoSe(podeEmitirOficio(interaction), 'painel:acao:oficio:criar', 'Criar', ButtonStyle.Success),
    ),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuCrime() {
  return [
    linha(botaoSe(true, 'painel:acao:crime:buscar', 'Buscar', ButtonStyle.Primary)),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuRh() {
  return [
    linha(
      new ButtonBuilder().setCustomId('painel:acao:rh:contratar').setLabel('Contratar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('painel:acao:rh:demitir').setLabel('Demitir').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('painel:acao:rh:licenca').setLabel('Licença').setStyle(ButtonStyle.Secondary),
    ),
    linha(new ButtonBuilder().setCustomId('painel:acao:rh:listar').setLabel('Listar cargos').setStyle(ButtonStyle.Primary)),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuSupervisao(interaction) {
  return [
    linha(
      botaoSe(temCargo(interaction, 'Desembargador') || isAdmin(interaction), 'painel:acao:supervisao:trocarjuiz', 'Trocar Juiz', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Procurador') || isAdmin(interaction), 'painel:acao:supervisao:trocarpromotor', 'Trocar Promotor', ButtonStyle.Primary),
      botaoSe(temCargo(interaction, 'Procurador') || isAdmin(interaction), 'painel:acao:supervisao:forcardenuncia', 'Forçar denúncia', ButtonStyle.Danger),
    ),
    linha(botaoSe(true, 'painel:acao:supervisao:filas', 'Filas pendentes', ButtonStyle.Secondary)),
    botaoVoltar(),
  ].filter(Boolean);
}

function submenuPeticao(interaction) {
  const podeProtocolar = temCargo(interaction, 'Advogado') || isAdmin(interaction);
  return [
    linha(
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirportearma', 'Porte de Arma', ButtonStyle.Success),
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirtrocanome', 'Troca de Nome', ButtonStyle.Success),
      botaoSe(podeProtocolar, 'painel:acao:peticao:abrirlimpezaficha', 'Limpeza de Ficha', ButtonStyle.Success),
    ),
    !podeProtocolar ? new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('painel:disabled').setLabel('Só Advogados protocolam petições').setStyle(ButtonStyle.Secondary).setDisabled(true)) : null,
    botaoVoltar(),
  ].filter(Boolean);
}

const SUBMENUS = {
  processo: submenuProcesso,
  medida: submenuMedida,
  mandado: submenuMandado,
  oficio: submenuOficio,
  crime: submenuCrime,
  rh: submenuRh,
  supervisao: submenuSupervisao,
  peticao: submenuPeticao,
};

async function abrirSubmenu(interaction, modulo) {
  if (modulo === 'rh' && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });
  }
  if (modulo === 'supervisao' && !supervisao.podeSupervisionar(interaction)) {
    return interaction.reply({ content: 'Só Desembargador, Procurador ou Staff/Administração podem usar isso.', ephemeral: true });
  }
  const embed = new EmbedBuilder().setTitle(TITULOS[modulo]).setColor(0x2c3e50).setDescription('Escolha uma ação:');
  return interaction.update({ embeds: [embed], components: SUBMENUS[modulo](interaction) });
}

// ---- Listagens diretas ----

function embedListaMedidas(rows) {
  return new EmbedBuilder().setTitle('📋 Medidas provisórias').setColor(0xe67e22)
    .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
}
function embedListaMandados(rows) {
  return new EmbedBuilder().setTitle('📜 Mandados').setColor(0x2ecc71)
    .setDescription(rows.map(m => `**${m.numero}** — ${m.tipo} — *${m.status}*`).join('\n'));
}

async function listarEResponder(interaction, tabela, embedFn) {
  const rows = db.todos(tabela).slice(0, 15);
  if (rows.length === 0) return interaction.reply({ content: 'Nenhum registro encontrado.', ephemeral: true });
  return interaction.reply({ embeds: [embedFn(rows)], ephemeral: true });
}

// ---- Modais ----

function abrirModalProcessoPenal(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:processo:penal').setTitle('Abrir processo penal');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Descrição objetiva dos fatos').setStyle(TextInputStyle.Paragraph).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus (opcional)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('medida').setLabel('Nº da medida vinculada (opcional)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

async function finalizarProcessoPenal(interaction) {
  const rascunho = rascunhoCrimes.obter(interaction.user.id);
  if (!rascunho) return interaction.update({ content: 'Sessão expirada, comece de novo pelo painel.', embeds: [], components: [] });
  if (rascunho.crimes.length === 0) return interaction.reply({ content: 'Adicione ao menos um crime antes de finalizar.', ephemeral: true });

  await interaction.deferUpdate();
  try {
    const resultado = await processoCmd.criarProcessoPenal({
      guild: interaction.guild,
      delegadoId: rascunho.dados.delegadoId,
      promotorId: rascunho.dados.promotorId || null,
      crimesTexto: rascunho.crimes.join(','),
      motivo: rascunho.dados.motivo,
      reusTexto: rascunho.dados.reusTexto,
      medidaNumero: rascunho.dados.medidaNumero,
    });

    if (resultado.erro) return interaction.editReply({ content: resultado.erro, embeds: [], components: [] });

    if (rascunho.tipo === 'penal-medida' && rascunho.dados.medidaNumero) {
      const medida = db.buscarPorNumero('medidas', rascunho.dados.medidaNumero);
      const canalMedida = medida && await interaction.guild.channels.fetch(medida.canalId).catch(() => null);
      if (canalMedida) await canalMedida.send({ content: `Processo ${resultado.numero} aberto a partir desta medida: ${resultado.canal}` });
    }

    return interaction.editReply({ content: `Processo penal ${resultado.numero} aberto em ${resultado.canal}.`, embeds: [], components: [] });
  } finally {
    // Sempre limpa o rascunho — sucesso ou erro — pra um clique repetido em "Finalizar"
    // nunca tentar criar o processo (e o canal) de novo com os mesmos dados.
    rascunhoCrimes.limpar(interaction.user.id);
  }
}

// A petição inicial em PDF é anexada depois, direto na conversa do canal — então abrir
// civil não precisa mais de slash command, cabe inteiro num modal.
function abrirModalProcessoCivil(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:processo:civil').setTitle('Abrir processo civil');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('autor_nome').setLabel('Nome completo do autor').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('autor_discord').setLabel('Menção @ do autor').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_nome').setLabel('Nome completo do réu').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu_discord').setLabel('Menção @ do réu').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalVerNumero(interaction, modulo) {
  const rotulos = { processo: 'Número do processo', medida: 'Número da medida', mandado: 'Número do mandado' };
  const modal = new ModalBuilder().setCustomId(`painel:modal:${modulo}:ver`).setTitle('Consultar');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel(rotulos[modulo]).setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalOficio(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:oficio:criar').setTitle('Criar ofício');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('processo').setLabel('Número do processo vinculado').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('destinatario').setLabel('Destinatário').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('assunto').setLabel('Assunto').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('conteudo').setLabel('Conteúdo').setStyle(TextInputStyle.Paragraph).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function abrirModalCrime(interaction) {
  const modal = new ModalBuilder().setCustomId('painel:modal:crime:buscar').setTitle('Buscar crime');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('termo').setLabel('Nome ou artigo do crime').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

function podeEmitirOficio(interaction) {
  return temCargo(interaction, 'Delegado') || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Juiz') || isAdmin(interaction);
}

// ---- Botões de ação (dentro de cada submódulo) ----

const TABELAS_ARQUIVAR = { processo: 'processos', medida: 'medidas', apelacao: 'apelacoes', peticao: 'peticoes' };

// Arquivamento manual: independe do status jurídico do caso (não altera decisão nem prazo),
// só tira o canal de circulação — mesma trava de mensagens + mudança de categoria que já
// acontece automaticamente quando um processo/apelação/petição chega num status terminal.
// Existe pra dar um jeito de encerrar visualmente casos parados, abandonados ou já resolvidos
// antes dessa automação existir.
function podeArquivarManualmente(interaction, modulo, entidade) {
  if (isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  if (modulo === 'processo') return uid === entidade.juiz || temCargo(interaction, 'Desembargador');
  if (modulo === 'medida') return [entidade.delegado, entidade.promotor, entidade.juiz].includes(uid) || temCargo(interaction, 'Desembargador');
  if (modulo === 'apelacao') return uid === entidade.desembargadorId || temCargo(interaction, 'Desembargador');
  if (modulo === 'peticao') return [entidade.juiz, entidade.promotor].includes(uid) || temCargo(interaction, 'Procurador');
  return false;
}

async function arquivarManual(interaction, modulo, numero) {
  const tabela = TABELAS_ARQUIVAR[modulo];
  if (!tabela) return interaction.reply({ content: 'Tipo inválido.', ephemeral: true });
  const entidade = db.buscarPorNumero(tabela, numero);
  if (!entidade) return interaction.reply({ content: `${numero} não encontrado.`, ephemeral: true });
  if (!podeArquivarManualmente(interaction, modulo, entidade)) {
    return interaction.reply({ content: 'Você não tem permissão pra arquivar isso — só quem está responsável pelo caso, um Desembargador/Procurador ou Staff.', ephemeral: true });
  }
  if (!entidade.canalId) return interaction.reply({ content: 'Esse item não tem canal associado.', ephemeral: true });

  const canal = await interaction.guild.channels.fetch(entidade.canalId).catch(() => null);
  if (!canal) return interaction.reply({ content: 'Canal não encontrado (já pode ter sido apagado).', ephemeral: true });

  await canais.arquivarCanal(canal);
  await auditoria.registrar(interaction.guild, { acao: `Arquivado manualmente (${modulo})`, executorId: interaction.user.id, referencia: numero });

  return interaction.reply({ content: `📦 ${numero} arquivado — canal travado e movido pra categoria Arquivados.`, ephemeral: true });
}

async function executarAcaoBotao(interaction, modulo, acao, extra) {
  if (acao === 'arquivarmanual') return arquivarManual(interaction, modulo, extra);

  if (modulo === 'processo') {
    if (acao === 'penal') {
      if (!temCargo(interaction, 'Delegado')) return interaction.reply({ content: 'Só Delegados podem abrir processo penal.', ephemeral: true });
      return abrirModalProcessoPenal(interaction);
    }
    if (acao === 'civil') {
      if (!temCargo(interaction, 'Advogado')) return interaction.reply({ content: 'Só Advogados podem abrir processo civil.', ephemeral: true });
      return abrirModalProcessoCivil(interaction);
    }
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'processo');
    if (acao === 'listar') return processoCmd.listarProcessos(interaction, null);
    if (acao === 'partetardia') return processoCmd.abrirModalParteTardia(interaction, extra);
    if (acao === 'gerenciardefesa') return processoCmd.abrirGerenciarDefesa(interaction, extra);
    if (acao === 'intimar') return processoCmd.abrirModalIntimacao(interaction, extra);
    if (acao === 'arquivarcivil') return processoCmd.arquivarCivil(interaction, extra);
    if (acao === 'recebereintimar') return processoCmd.abrirModalReceberEIntimar(interaction, extra);
    if (acao === 'pedirrevisao') return processoCmd.pedirRevisaoArquivamento(interaction, extra);
    if (acao === 'recorrer') return processoCmd.abrirModalRecorrer(interaction, extra);
  }

  if (modulo === 'habilitacao') {
    if (acao === 'solicitar') return processoCmd.abrirModalHabilitacao(interaction, extra);
    if (acao === 'aprovar') return processoCmd.decidirHabilitacao(interaction, extra, true);
    if (acao === 'negar') return processoCmd.decidirHabilitacao(interaction, extra, false);
  }

  if (modulo === 'apelacao') {
    if (acao === 'manter' || acao === 'anular') return processoCmd.abrirModalFundamentacaoDecisao(interaction, extra, acao);
    if (acao === 'reformar') return processoCmd.abrirSelecaoResultadoReforma(interaction, extra);
  }

  if (modulo === 'supervisao') {
    if (acao === 'trocarjuiz') return supervisao.abrirModalTrocarJuiz(interaction);
    if (acao === 'trocarpromotor') return supervisao.abrirModalTrocarPromotor(interaction);
    if (acao === 'forcardenuncia') return supervisao.abrirModalForcarDenuncia(interaction);
    if (acao === 'forcardenunciadireto') return supervisao.abrirModalForcarDenunciaDireto(interaction, extra);
    if (acao === 'filas') return supervisao.filasPendentes(interaction);
  }

  if (modulo === 'peticao') {
    if (acao === 'deferir' || acao === 'indeferir' || acao === 'diligencia') {
      return peticaoCmd.decidir(interaction, extra, acao);
    }
    if (acao === 'abrirportearma') return peticaoCmd.abrirModalPorteArma(interaction);
    if (acao === 'abrirtrocanome') return peticaoCmd.abrirModalTrocaNome(interaction);
    if (acao === 'abrirlimpezaficha') return peticaoCmd.abrirModalLimpezaFicha(interaction);
    if (acao === 'confirmardeferir') return peticaoCmd.confirmarDeferimento(interaction, extra);
    if (acao === 'cancelardecisao') return peticaoCmd.cancelarDecisao(interaction);
    if (acao === 'pularvinculo') return peticaoCmd.pularVinculoDiscord(interaction);
    if (acao === 'enderecoextra') return peticaoCmd.abrirModalEnderecoExtra(interaction, extra);
    if (acao === 'semenderecoextra') return peticaoCmd.semEnderecoExtra(interaction);
  }

  if (modulo === 'medida') {
    if (acao === 'solicitar') {
      if (!temCargo(interaction, 'Delegado')) return interaction.reply({ content: 'Só Delegados podem solicitar medida provisória.', ephemeral: true });
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('painel:select:medida:tipo').setPlaceholder('Tipo de medida')
          .addOptions(medidaCmd.TIPOS_MEDIDA.map((t, i) => ({ label: t, value: String(i) }))),
      );
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0xe67e22).setDescription('Qual o tipo de medida?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'medida');
    if (acao === 'listar') return listarEResponder(interaction, 'medidas', embedListaMedidas);
    if (acao === 'negarjuiz') return medidaCmd.abrirModalNegarJuiz(interaction, extra);
    if (acao === 'pedirreconsideracao') return medidaCmd.pedirReconsideracao(interaction, extra);
    if (acao === 'decidirreconsideracao') return medidaCmd.decidirReconsideracao(interaction, extra);
  }

  if (modulo === 'mandado') {
    if (acao === 'ver') return abrirModalVerNumero(interaction, 'mandado');
    if (acao === 'listar') return listarEResponder(interaction, 'mandados', embedListaMandados);
  }

  if (modulo === 'oficio') {
    if (acao === 'criar') {
      if (!podeEmitirOficio(interaction)) return interaction.reply({ content: 'Só Delegado, Promotor, Juiz ou Staff/Administração podem emitir ofício.', ephemeral: true });
      return abrirModalOficio(interaction);
    }
  }

  if (modulo === 'crime') {
    if (acao === 'buscar') return abrirModalCrime(interaction);
  }

  if (modulo === 'crimepick') {
    if (acao === 'buscar') return interaction.showModal(crimePicker.modalBusca());
    if (acao === 'cancelar') {
      rascunhoCrimes.limpar(interaction.user.id);
      return interaction.update({ content: 'Abertura de processo cancelada.', embeds: [], components: [] });
    }
    if (acao === 'finalizar') return finalizarProcessoPenal(interaction);
  }

  if (modulo === 'rh') {
    if (!isAdmin(interaction)) return interaction.reply({ content: 'Só Staff/Administração pode usar comandos de RH.', ephemeral: true });

    if (acao === 'contratar') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:contratar').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem vai receber um cargo?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'demitir') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:demitir').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem vai perder o cargo?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'licenca') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('painel:userselect:rh:licenca').setPlaceholder('Selecione a pessoa'));
      return interaction.update({ embeds: [new EmbedBuilder().setDescription('Quem entra/sai de licença?')], components: [row, botaoVoltar()] });
    }
    if (acao === 'listar') {
      const embed = new EmbedBuilder().setTitle('👥 Cargos jurídicos').setColor(0x3498db);
      for (const cargo of rh.CARGOS) {
        const lista = rh.listarPorCargo(cargo);
        embed.addFields({ name: cargo, value: lista.length ? lista.map(r => `<@${r.discordId}>${r.licenca ? ' *(licença)*' : ''}`).join('\n') : '—' });
      }
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (acao === 'licencaon' || acao === 'licencaoff') {
      const usuarioId = extra;
      const afastado = acao === 'licencaon';
      const atualizado = rh.setLicenca(usuarioId, afastado);
      if (atualizado) {
        await auditoria.registrar(interaction.guild, {
          acao: `RH: ${afastado ? 'licença' : 'retorno de licença'}`, executorId: interaction.user.id, referencia: `<@${usuarioId}>`,
        });
      }
      const embed = new EmbedBuilder()
        .setColor(atualizado ? 0x2ecc71 : 0xe74c3c)
        .setDescription(atualizado ? `<@${usuarioId}> agora está ${afastado ? '**de licença**' : '**ativo**'}.` : 'Essa pessoa não tem cargo jurídico ativo.');
      return interaction.update({ embeds: [embed], components: [botaoVoltar()] });
    }
  }
}

// ---- Select menus (string) ----

async function tratarSelect(interaction, modulo, campo, extra) {
  if (modulo === 'medida' && campo === 'tipo') {
    const tipoIndex = interaction.values[0];
    const tipo = medidaCmd.TIPOS_MEDIDA[Number(tipoIndex)];
    const modal = new ModalBuilder().setCustomId(`painel:modal:medida:solicitar:${tipoIndex}`).setTitle(`Solicitar medida — ${tipo}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('alvo').setLabel('Pessoa/local alvo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/indícios').setStyle(TextInputStyle.Paragraph).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  if (modulo === 'apelacao' && campo === 'resultado') {
    return processoCmd.abrirModalFundamentacaoReforma(interaction, extra);
  }

  if (modulo === 'peticao' && campo === 'risco') {
    return peticaoCmd.processarDecisaoRisco(interaction, extra);
  }

  if (modulo === 'processo' && campo === 'resultado') {
    const numero = extra;
    const resultado = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`painel:modal:processo:sentenca:${numero}#${resultado}`).setTitle('Sentença');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('texto').setLabel('Fundamentação e decisão').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ));
    return interaction.showModal(modal);
  }

  if (modulo === 'rh' && campo === 'cargo') {
    const usuarioId = extra;
    const cargo = interaction.values[0];
    await rhCmd.contratarComRole(interaction.guild, usuarioId, cargo);
    const embed = new EmbedBuilder().setColor(0x2ecc71).setDescription(`<@${usuarioId}> agora é **${cargo}**.`);
    return interaction.update({ embeds: [embed], components: [botaoVoltar()] });
  }

  if (modulo === 'crime' && campo === 'resultado') {
    const crime = crimes.find(c => c.id === interaction.values[0]);
    if (!crime) return interaction.update({ content: 'Crime não encontrado.', embeds: [], components: [botaoVoltar()] });
    return interaction.update({ content: null, embeds: [crimeCmd.embedCrime(crime)], components: [botaoVoltar()] });
  }

  if (modulo === 'crimepick' && campo === 'resultado') {
    const rascunho = rascunhoCrimes.adicionarCrimes(interaction.user.id, interaction.values);
    if (!rascunho) return interaction.update({ content: 'Sessão expirada, comece de novo pelo painel.', embeds: [], components: [] });
    return crimePicker.mostrarPainel(interaction, { novaMensagem: false });
  }

  if (modulo === 'habilitacao' && campo === 'remover') {
    return processoCmd.removerHabilitacao(interaction, extra, interaction.values[0]);
  }
}

// ---- Select menus (usuário) ----

async function tratarUserSelect(interaction, modulo, campo) {
  const usuarioId = interaction.values[0];

  if (modulo === 'rh' && campo === 'contratar') {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:rh:cargo:${usuarioId}`).setPlaceholder('Escolha o cargo')
        .addOptions(rh.CARGOS.map(c => ({ label: c, value: c }))),
    );
    const embed = new EmbedBuilder().setDescription(`Qual cargo para <@${usuarioId}>?`);
    return interaction.update({ embeds: [embed], components: [row, botaoVoltar()] });
  }

  if (modulo === 'rh' && campo === 'demitir') {
    const registro = await rhCmd.demitirComRole(interaction.guild, usuarioId);
    const embed = new EmbedBuilder().setColor(registro ? 0xe74c3c : 0x95a5a6)
      .setDescription(registro ? `<@${usuarioId}> foi removido do cargo jurídico.` : `<@${usuarioId}> não tinha cargo jurídico ativo.`);
    return interaction.update({ embeds: [embed], components: [botaoVoltar()] });
  }

  if (modulo === 'peticao' && campo.startsWith('vincularcliente#')) {
    const numero = campo.split('#')[1];
    return peticaoCmd.vincularClienteDiscord(interaction, numero);
  }

  if (modulo === 'rh' && campo === 'licenca') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:rh:licencaon:${usuarioId}`).setLabel('Colocar de licença').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`painel:acao:rh:licencaoff:${usuarioId}`).setLabel('Tirar de licença').setStyle(ButtonStyle.Success),
    );
    const embed = new EmbedBuilder().setDescription(`O que fazer com <@${usuarioId}>?`);
    return interaction.update({ embeds: [embed], components: [row, botaoVoltar()] });
  }
}

// ---- Envio dos modais ----

async function tratarModal(interaction, modulo, acao, extra) {
  if (modulo === 'processo' && acao === 'penal') {
    rascunhoCrimes.iniciar(interaction.user.id, {
      tipo: 'penal-direto',
      dados: {
        delegadoId: interaction.user.id,
        promotorId: null,
        motivo: interaction.fields.getTextInputValue('motivo'),
        reusTexto: interaction.fields.getTextInputValue('reus'),
        medidaNumero: interaction.fields.getTextInputValue('medida') || null,
      },
    });
    return crimePicker.mostrarPainel(interaction, { novaMensagem: true });
  }

  if (modulo === 'processo' && acao === 'civil') {
    const autorDiscordId = processoCmd.extrairMencoes(interaction.fields.getTextInputValue('autor_discord'))[0];
    const reuDiscordId = processoCmd.extrairMencoes(interaction.fields.getTextInputValue('reu_discord'))[0];
    if (!autorDiscordId || !reuDiscordId) {
      return interaction.reply({ content: 'Marque autor e réu com @menção (selecione a pessoa na lista do Discord ao digitar @).', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const resultado = await processoCmd.criarProcessoCivil({
      guild: interaction.guild, advogadoId: interaction.user.id,
      autorNome: interaction.fields.getTextInputValue('autor_nome'),
      autorDiscordId,
      reuNome: interaction.fields.getTextInputValue('reu_nome'),
      reuDiscordId,
    });
    return interaction.editReply({ content: `Processo civil ${resultado.numero} aberto em ${resultado.canal}.` });
  }

  if (modulo === 'crimepick' && acao === 'buscar') {
    const termo = interaction.fields.getTextInputValue('termo').toLowerCase();
    const resultados = crimes
      .filter(c => c.nome.toLowerCase().includes(termo) || c.artigo.toLowerCase().includes(termo) || c.id.includes(termo))
      .slice(0, 25);
    if (resultados.length === 0) return interaction.reply({ content: 'Nenhum crime encontrado com esse termo. Tente de novo.', ephemeral: true });
    return interaction.reply({ content: `${resultados.length} resultado(s) — selecione um ou mais:`, components: [crimePicker.selectResultados(resultados)], ephemeral: true });
  }

  if (modulo === 'processo' && acao === 'partetardia') {
    const resultado = await processoCmd.vincularReu({
      guild: interaction.guild,
      numero: extra,
      reusTexto: interaction.fields.getTextInputValue('reus'),
      executorId: interaction.user.id,
    });
    if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
    return interaction.reply({ content: `Parte(s) adicionada(s) ao processo ${resultado.numero}, com acesso liberado no canal.`, ephemeral: true });
  }

  if (modulo === 'processo' && acao === 'intimar') {
    return processoCmd.emitirIntimacao(interaction, extra);
  }

  if (modulo === 'processo' && acao === 'sentenca') {
    const [numero, resultado] = extra.split('#');
    return processoCmd.salvarSentenca(interaction, numero, resultado);
  }

  if (modulo === 'processo' && acao === 'recorrer') {
    return processoCmd.criarApelacao(interaction, extra);
  }

  if (modulo === 'habilitacao' && acao === 'solicitar') {
    return processoCmd.criarHabilitacao(interaction, extra);
  }

  if (modulo === 'supervisao' && acao === 'trocarjuiz') {
    return supervisao.trocarJuiz(interaction);
  }

  if (modulo === 'supervisao' && acao === 'trocarpromotor') {
    return supervisao.trocarPromotor(interaction);
  }

  if (modulo === 'supervisao' && acao === 'forcardenuncia') {
    return supervisao.forcarDenuncia(interaction);
  }

  if (modulo === 'supervisao' && acao === 'forcardenunciadireto') {
    return supervisao.forcarDenunciaDireto(interaction, extra);
  }

  if (modulo === 'peticao' && (acao === 'indeferir' || acao === 'diligencia')) {
    return peticaoCmd.processarModalDecisao(interaction, extra, acao);
  }

  if (modulo === 'apelacao' && acao === 'reformar') {
    const [numeroApelacao, novoResultado] = extra.split('#');
    return processoCmd.finalizarApelacao(interaction, numeroApelacao, 'reformar', {
      novoResultado, fundamentacao: interaction.fields.getTextInputValue('fundamentacao'),
    });
  }

  if (modulo === 'apelacao' && acao === 'decidir') {
    const [numeroApelacao, decisao] = extra.split('#');
    return processoCmd.finalizarApelacao(interaction, numeroApelacao, decisao, {
      fundamentacao: interaction.fields.getTextInputValue('fundamentacao'),
    });
  }

  if (modulo === 'medida' && acao === 'aprovarmp') return medidaCmd.processarAprovacaoMP(interaction, extra);
  if (modulo === 'medida' && acao === 'referendar') return medidaCmd.processarReferendo(interaction, extra);
  if (modulo === 'medida' && acao === 'negarjuiz') return medidaCmd.negarJuiz(interaction, extra);

  if (modulo === 'peticao' && acao === 'porte-arma') return peticaoCmd.processarModalPorteArma(interaction);
  if (modulo === 'peticao' && acao === 'troca-nome') return peticaoCmd.processarModalTrocaNome(interaction);
  if (modulo === 'peticao' && acao === 'limpeza-ficha') return peticaoCmd.processarModalLimpezaFicha(interaction);
  if (modulo === 'peticao' && acao === 'enderecoextra') return peticaoCmd.processarEnderecoExtra(interaction, extra);

  if (modulo === 'processo' && acao === 'ver') {
    return processoCmd.verProcesso(interaction, interaction.fields.getTextInputValue('numero'));
  }

  if (modulo === 'medida' && acao === 'ver') {
    const numero = interaction.fields.getTextInputValue('numero');
    const medida = db.buscarPorNumero('medidas', numero);
    if (!medida) return interaction.reply({ content: 'Medida não encontrada.', ephemeral: true });
    return interaction.reply({ embeds: [medidaCmd.embedMedida(medida)], ephemeral: true });
  }

  if (modulo === 'medida' && acao === 'solicitar') {
    await interaction.deferReply({ ephemeral: true });
    const tipo = medidaCmd.TIPOS_MEDIDA[Number(extra)];
    const resultado = await medidaCmd.solicitarMedida({
      guild: interaction.guild, delegadoId: interaction.user.id, promotorId: null,
      tipo,
      alvo: interaction.fields.getTextInputValue('alvo'),
      motivo: interaction.fields.getTextInputValue('motivo'),
    });
    if (resultado.erro) return interaction.editReply({ content: resultado.erro });
    return interaction.editReply({ content: `Medida ${resultado.numero} registrada em ${resultado.canal}.` });
  }

  if (modulo === 'mandado' && acao === 'ver') {
    const numero = interaction.fields.getTextInputValue('numero');
    const mandado = db.buscarPorNumero('mandados', numero);
    if (!mandado) return interaction.reply({ content: 'Mandado não encontrado.', ephemeral: true });
    return interaction.reply({ embeds: [mandadoCmd.embedMandado(mandado)], ephemeral: true });
  }

  if (modulo === 'oficio' && acao === 'criar') {
    const resultado = await oficioCmd.criarOficio({
      guild: interaction.guild,
      processoNumero: interaction.fields.getTextInputValue('processo'),
      destinatario: interaction.fields.getTextInputValue('destinatario'),
      assunto: interaction.fields.getTextInputValue('assunto'),
      conteudo: interaction.fields.getTextInputValue('conteudo'),
      emitidoPorId: interaction.user.id,
      emitidoPorTag: interaction.user.tag,
    });
    if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
    return interaction.reply({ content: `Ofício ${resultado.numero} registrado no canal do processo.`, ephemeral: true });
  }

  if (modulo === 'crime' && acao === 'buscar') {
    const termo = interaction.fields.getTextInputValue('termo').toLowerCase();
    const resultados = crimes
      .filter(c => c.nome.toLowerCase().includes(termo) || c.artigo.toLowerCase().includes(termo) || c.id.includes(termo))
      .slice(0, 25);
    if (resultados.length === 0) return interaction.reply({ content: 'Nenhum crime encontrado.', ephemeral: true });
    if (resultados.length === 1) return interaction.reply({ embeds: [crimeCmd.embedCrime(resultados[0])], ephemeral: true });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('painel:select:crime:resultado').setPlaceholder('Selecione o crime')
        .addOptions(resultados.map(c => ({ label: `${c.nome} (Art. ${c.artigo})`.slice(0, 100), value: c.id }))),
    );
    return interaction.reply({ content: `${resultados.length} resultados encontrados:`, components: [row], ephemeral: true });
  }
}

// ---- Roteador central (chamado pelo index.js para tudo que começa com "painel:") ----

async function router(interaction) {
  const partes = interaction.customId.split(':');
  const tipo = partes[1];

  if (interaction.isButton()) {
    if (tipo === 'menu') {
      const alvo = partes[2];
      if (alvo === 'home') return interaction.update({ embeds: [embedMenuPrincipal()], components: botoesMenuPrincipal() });
      return abrirSubmenu(interaction, alvo);
    }
    if (tipo === 'acao') {
      const [, , modulo, acao, extra] = partes;
      return executarAcaoBotao(interaction, modulo, acao, extra);
    }
  }

  if (interaction.isStringSelectMenu()) {
    const [, , modulo, campo, extra] = partes;
    return tratarSelect(interaction, modulo, campo, extra);
  }

  if (interaction.isUserSelectMenu()) {
    const [, , modulo, campo] = partes;
    return tratarUserSelect(interaction, modulo, campo);
  }

  if (interaction.isModalSubmit()) {
    const [, , modulo, acao, extra] = partes;
    return tratarModal(interaction, modulo, acao, extra);
  }
}

// Deixa uma única mensagem fixa no canal configurado, sempre a mesma (edita em vez de
// duplicar a cada restart) — os botões respondem sempre de forma ephemeral (só quem clicou
// vê), então o canal nunca enche de mensagem por trás de ninguém usando o painel.
async function postarPainelFixo(guild, client) {
  if (!config.canalPainelId) return;
  const canal = await guild.channels.fetch(config.canalPainelId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) {
    console.error(`CANAL_PAINEL_ID (${config.canalPainelId}) não é um canal de texto válido.`);
    return;
  }

  const payload = {
    embeds: [embedMenuPrincipal().setDescription(
      'Escolha um módulo abaixo. Toda resposta é privada — só você vê o que clicar, ninguém mais no canal enxerga sua navegação.',
    )],
    components: botoesMenuPrincipal(),
  };

  const mensagens = await canal.messages.fetch({ limit: 20 }).catch(() => null);
  const existente = mensagens?.find(m => m.author.id === client.user.id && m.components.length > 0);
  if (existente) await existente.edit(payload).catch(() => {});
  else await canal.send(payload);
}

module.exports = {
  data: new SlashCommandBuilder().setName('painel').setDescription('Abre o painel interativo com todos os módulos em botões'),

  async execute(interaction) {
    return interaction.reply({ embeds: [embedMenuPrincipal()], components: botoesMenuPrincipal(), ephemeral: true });
  },

  router,
  postarPainelFixo,
};
