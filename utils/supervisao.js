const { EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const rh = require('./rh');
const canais = require('./canais');
const auditoria = require('./auditoria');
const { temCargo, isAdmin, isSuperStaff } = require('./permissoes');
const { truncar, extrairMencao } = require('./texto');
const andamentos = require('./andamentos');
const documentoPng = require('../services/gerarDocumentoPNG');
const documentos = require('./documentos');
const { crimeLabel } = require('./crimesTexto');
// processoCmd é requerido sob demanda (não no topo do arquivo) de propósito: processo.js -> medida.js
// -> supervisao.js -> processo.js forma um ciclo, e um require no topo aqui pega o module.exports
// de processo.js ainda incompleto (objeto vazio, dependendo da ordem em que os arquivos carregam
// na inicialização), fazendo `processoCmd.botoesJuiz` virar undefined silenciosamente até alguém
// clicar. Resolvendo dentro da função, o require só roda depois que todo o boot já terminou.

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

// ---- Designar Juiz (Supervisão/Staff) a um caso que ficou SEM julgador ----
// Diferente de "Trocar Juiz" (que exige um Juiz já atribuído): isto atribui um Juiz a um processo
// ou petição preso porque o sorteio automático não achou cargo elegível. Gate: Supervisão
// (Desembargador/Procurador) ou Staff — nunca abre pra qualquer um. É o caminho manual que o aviso
// "sem Juiz disponível" (utils/prazos.js) oferece, pra o caso nunca congelar mudo.
function podeDesignar(interaction) {
  return podeSupervisionar(interaction) || isSuperStaff(interaction);
}

function abrirModalDesignarJulgador(interaction, numero) {
  if (!podeDesignar(interaction)) {
    return interaction.reply({ content: 'Só a Supervisão (Desembargador/Procurador) ou a Staff podem designar um Juiz a um caso sem julgador.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`painel:modal:supervisao:designarjulgador:${numero}`).setTitle(`Designar Juiz — ${numero}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('novo').setLabel('Menção @ do Juiz a designar').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function designarJulgador(interaction, numero) {
  if (!podeDesignar(interaction)) {
    return interaction.reply({ content: 'Sem permissão para designar Juiz.', ephemeral: true });
  }
  const juizId = extrairMencao(interaction.fields.getTextInputValue('novo'));
  if (!juizId) return interaction.reply({ content: 'Marque o Juiz com @menção.', ephemeral: true });
  if (!rh.temCargo(juizId, 'Juiz')) return interaction.reply({ content: 'A pessoa indicada não é um Juiz ativo no quadro (RH).', ephemeral: true });

  // O caso pode ser um processo OU uma petição administrativa (numeração diferente).
  const processo = db.buscarPorNumero('processos', numero);
  const peticao = processo ? null : db.buscarPorNumero('peticoes', numero);
  const alvo = processo || peticao;
  if (!alvo) return interaction.reply({ content: 'Caso não encontrado.', ephemeral: true });
  if (alvo.juiz) return interaction.reply({ content: `Este caso já tem Juiz (<@${alvo.juiz}>). Para substituir, use "Trocar Juiz".`, ephemeral: true });
  const tabela = processo ? 'processos' : 'peticoes';

  await interaction.deferReply({ ephemeral: true });
  const { distribuirJuizAoCaso } = require('./distribuicaoJuiz');
  const guild = await resolverGuild(interaction);
  const ok = await distribuirJuizAoCaso(guild, { tabela, numero }, juizId, { origem: 'designacao', designadoPor: interaction.user.id });
  if (!ok) return interaction.editReply({ content: 'Não foi possível designar (o caso pode já ter Juiz agora).' });

  await auditoria.registrar(guild, {
    acao: 'Designação de Juiz', executorId: interaction.user.id,
    referencia: `${tabela === 'peticoes' ? 'Petição' : 'Processo'} ${numero} → <@${juizId}>`,
  });
  return interaction.editReply({ content: `Juiz <@${juizId}> designado ao caso ${numero}.` });
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

// ---- Trocar Desembargador de uma apelação ----
// Sem isso, uma apelação sorteada pra um Desembargador que ficasse indisponível (licença,
// saiu do cargo) ficava presa pra sempre — só o `desembargadorId` original podia decidir.

function abrirModalTrocarDesembargador(interaction) {
  if (!temCargo(interaction, 'Desembargador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Desembargadores podem trocar o relator de uma apelação.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:supervisao:trocardesembargador').setTitle('Trocar relator da apelação');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('numero').setLabel('Número da apelação').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('novo').setLabel('Menção @ do novo Desembargador').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo da troca').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function trocarDesembargador(interaction) {
  const numero = interaction.fields.getTextInputValue('numero');
  const novoId = extrairMencao(interaction.fields.getTextInputValue('novo'));
  const motivo = interaction.fields.getTextInputValue('motivo');

  const apelacao = db.buscarPorNumero('apelacoes', numero);
  if (!apelacao) return interaction.reply({ content: 'Apelação não encontrada.', ephemeral: true });
  if (!novoId) return interaction.reply({ content: 'Marque o novo Desembargador com @menção.', ephemeral: true });
  if (apelacao.status !== 'Aguardando decisão') return interaction.reply({ content: 'Essa apelação já foi decidida.', ephemeral: true });

  const antigoId = apelacao.desembargadorId;
  db.atualizar('apelacoes', numero, { desembargadorId: novoId });

  const canal = await interaction.guild.channels.fetch(apelacao.canalId).catch(() => null);
  if (canal) {
    await canais.adicionarMembro(canal, novoId);
    if (antigoId) await canal.permissionOverwrites.delete(antigoId).catch(() => {});
    await canal.send({ content: `<@${novoId}> passa a ser o Desembargador relator desta apelação (trocado por decisão de <@${interaction.user.id}>). Motivo: ${motivo}` });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Troca de relator (apelação)', executorId: interaction.user.id,
    referencia: `Apelação ${numero}: <@${antigoId}> → <@${novoId}>`, motivo,
  });

  return interaction.reply({ content: `Relator da apelação ${numero} trocado para <@${novoId}>.`, ephemeral: true });
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
  const processoCmd = require('../commands/processo');
  const guild = await resolverGuild(interaction);
  if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.tipo !== 'Penal' || processo.status !== 'Arquivado') {
    return interaction.reply({ content: 'Só é possível forçar denúncia num processo penal arquivado.', ephemeral: true });
  }

  const juizId = rh.sortearJuiz({ excluirIds: [processo.delegado, processo.promotor].filter(Boolean) });
  if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a denúncia sendo forçada com sucesso.
  await interaction.deferReply({ ephemeral: true });
  db.atualizar('processos', numero, { status: 'Instrução', juiz: juizId, juizDesde: new Date().toISOString(), revisaoArquivamento: 'Decidida' });

  // Peça formal da decisão do Procurador (igual parecer do MP) — antes ia só texto solto no
  // canal, sem nenhum documento nos autos representando a revisão em si.
  const nomeProcurador = await documentoPng.nomeExibicao(guild, interaction.user.id);
  const nomeReuTxt = (processo.reus || []).length
    ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(guild, id)))).join(' e ')
    : 'o(a) indiciado(a)';
  const crimeDescricao = (processo.crimes || []).map(c => crimeLabel(c)).join(', ') || 'crime não especificado';
  const pngDecisao = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'decisao_revisao_forcar', orgaoEmissor: 'ministerio_publico', subunidade: '1ª Promotoria de Justiça Criminal',
    tituloDocumento: 'DECISÃO EM REVISÃO DE ARQUIVAMENTO', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: 'Autos', corpoTexto: motivo, nomeReu: nomeReuTxt, crimeDescricao,
    nomeAssinante: nomeProcurador, cargoAssinante: 'Procurador de Justiça',
  }).catch(err => { console.error('Falha ao gerar PNG da decisão (forçar denúncia):', err.message); return null; });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  let msgPainel = null;
  if (canal) {
    await canais.adicionarMembro(canal, juizId);
    await canal.send({
      content: `📋 Decisão do Procurador <@${interaction.user.id}> em revisão de arquivamento:`,
      ...(pngDecisao ? { files: [{ attachment: pngDecisao, name: `Decisao-Revisao-${numero}.png` }] } : {}),
    });
    msgPainel = await canal.send({
      content: `Denúncia forçada — <@${juizId}> sorteado para o caso.`,
      components: processoCmd.montarPainelAcoes(db.buscarPorNumero('processos', numero)),
    });
    db.atualizar('processos', numero, { painelMsgId: msgPainel.id });
  }

  const canalRevisao = processo.revisaoArquivamentoCanalId ? await guild.channels.fetch(processo.revisaoArquivamentoCanalId).catch(() => null) : null;
  if (canalRevisao) {
    await canalRevisao.send({ content: `Denúncia forçada por <@${interaction.user.id}> — processo ${numero} reaberto pra instrução. Revisão encerrada.` });
    await canais.arquivarCanal(canalRevisao);
  }

  await andamentos.registrar(guild, numero, {
    tipo: 'revisao_arquivamento_decidida', titulo: '📋 Denúncia forçada em revisão de arquivamento',
    detalhe: `Procurador <@${interaction.user.id}> forçou a denúncia. Motivo: ${motivo}`,
    executorId: interaction.user.id, metadata: { resultado: 'Denuncia forcada', novoJuiz: juizId },
  });
  await processoCmd.postarOuAtualizarDiario(guild, numero);

  return interaction.editReply({ content: `Denúncia forçada. Processo ${numero} agora em Instrução com <@${juizId}> como Juiz.` });
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

// Contraparte de "Forçar denúncia" — faltava um jeito de o Procurador simplesmente concordar
// com o arquivamento do Promotor. Sem isso, `revisaoArquivamento` ficava travado em 'Pendente'
// pra sempre (nenhuma ação disponível resolvia esse estado) e o Delegado nem podia pedir uma
// nova revisão depois (bloqueado pelo guard de "já existe pedido pendente"). Modal com motivo
// pra ficar simétrico com "Forçar denúncia" — os dois desfechos da mesma decisão merecem o
// mesmo nível de fundamentação e o mesmo documento formal nos autos.
function abrirModalManterArquivamento(interaction, numero) {
  if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Procuradores podem decidir uma revisão de arquivamento.', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`painel:modal:supervisao:manterarquivamento:${numero}`).setTitle('Manter arquivamento');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function manterArquivamento(interaction, numero) {
  const motivo = interaction.fields.getTextInputValue('motivo');
  if (!temCargo(interaction, 'Procurador') && !isAdmin(interaction)) {
    return interaction.reply({ content: 'Só Procuradores podem decidir uma revisão de arquivamento.', ephemeral: true });
  }
  const guild = await resolverGuild(interaction);
  if (!guild) return interaction.reply({ content: 'Não consegui identificar o servidor — tente pelo /painel direto no Discord.', ephemeral: true });

  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.revisaoArquivamento !== 'Pendente') {
    return interaction.reply({ content: 'Essa revisão já foi decidida ou não existe.', ephemeral: true });
  }

  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a decisão sendo registrada com sucesso.
  await interaction.deferReply({ ephemeral: true });
  db.atualizar('processos', numero, { revisaoArquivamento: 'Decidida' });

  const canalRevisao = processo.revisaoArquivamentoCanalId ? await guild.channels.fetch(processo.revisaoArquivamentoCanalId).catch(() => null) : null;
  if (canalRevisao) {
    await canalRevisao.send({ content: `Arquivamento do processo ${numero} mantido pelo Procurador <@${interaction.user.id}>.` });
    await canais.arquivarCanal(canalRevisao);
  }

  // Peça formal da decisão (igual parecer do MP) — antes ia só texto solto no canal.
  const nomeProcurador = await documentoPng.nomeExibicao(guild, interaction.user.id);
  const nomeReuTxt = (processo.reus || []).length
    ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(guild, id)))).join(' e ')
    : 'o(a) indiciado(a)';
  const crimeDescricao = (processo.crimes || []).map(c => crimeLabel(c)).join(', ') || 'crime não especificado';
  const pngDecisao = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'decisao_revisao_manter', orgaoEmissor: 'ministerio_publico', subunidade: '1ª Promotoria de Justiça Criminal',
    tituloDocumento: 'DECISÃO EM REVISÃO DE ARQUIVAMENTO', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: 'Autos', corpoTexto: motivo, nomeReu: nomeReuTxt, crimeDescricao,
    nomeAssinante: nomeProcurador, cargoAssinante: 'Procurador de Justiça',
  }).catch(err => { console.error('Falha ao gerar PNG da decisão (manter arquivamento):', err.message); return null; });

  const canalProcesso = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canalProcesso) {
    await canalProcesso.send({
      content: `📋 O Procurador <@${interaction.user.id}> revisou o pedido do Delegado e manteve o arquivamento deste processo.`,
      ...(pngDecisao ? { files: [{ attachment: pngDecisao, name: `Decisao-Revisao-${numero}.png` }] } : {}),
    });
  }

  await andamentos.registrar(guild, numero, {
    tipo: 'revisao_arquivamento_decidida', titulo: '📋 Arquivamento mantido em revisão',
    detalhe: `Procurador <@${interaction.user.id}> manteve o arquivamento. Motivo: ${motivo}`,
    executorId: interaction.user.id, metadata: { resultado: 'Mantido' },
  });

  return interaction.editReply({ content: `Arquivamento do processo ${numero} mantido.` });
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
  abrirModalTrocarDesembargador, trocarDesembargador,
  abrirModalForcarDenuncia, forcarDenuncia,
  abrirModalForcarDenunciaDireto, forcarDenunciaDireto,
  abrirModalManterArquivamento, manterArquivamento,
  abrirModalDesignarJulgador, designarJulgador,
  filasPendentes,
};
