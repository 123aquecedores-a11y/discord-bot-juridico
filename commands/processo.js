const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isAdmin } = require('../utils/permissoes');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const config = require('../config');
const crimes = require('../data/crimes.json');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');

function extrairMencoes(texto) {
  if (!texto) return [];
  const matches = [...texto.matchAll(/<@!?(\d+)>/g)];
  return [...new Set(matches.map(m => m[1]))];
}

function resolverCrimes(texto) {
  if (!texto) return [];
  const ids = texto.split(',').map(s => s.trim()).filter(Boolean);
  return ids.map(id => crimes.find(c => c.id === id)).filter(Boolean);
}

function embedProcesso(p) {
  const crimesTxt = truncar((p.crimes || []).map(c => `• ${c.nome} (Art. ${c.artigo}) — sugestão: ${c.pena_meses} meses / $${c.multa}`).join('\n') || '—');
  const reusTxt = (p.reus || []).length ? p.reus.map(id => `<@${id}>`).join(', ') : '*A identificar*';
  const aprovadas = (p.habilitacoes || []).filter(h => h.status === 'Aprovado');
  const advogadosTxt = aprovadas.length ? aprovadas.map(h => `<@${h.advogadoId}> (defende <@${h.reuId}>)`).join('\n') : '—';

  const embed = new EmbedBuilder()
    .setTitle(`📁 Processo ${p.numero} (${p.tipo})`)
    .setColor(p.tipo === 'Penal' ? 0xe67e22 : 0x3498db)
    .addFields(
      { name: 'Status', value: p.status, inline: true },
      { name: 'Réu(s)', value: truncar(reusTxt) },
      { name: 'Motivo/Pedido', value: truncar(p.motivo) },
      { name: 'Advogados habilitados', value: truncar(advogadosTxt) },
    );

  if (p.tipo === 'Penal') embed.addFields({ name: 'Crimes', value: crimesTxt });
  if (p.delegado) embed.addFields({ name: 'Delegado', value: `<@${p.delegado}>`, inline: true });
  if (p.promotor) embed.addFields({ name: 'Promotor', value: `<@${p.promotor}>`, inline: true });
  if (p.autor) embed.addFields({ name: 'Autor (advogado)', value: `<@${p.autor}>`, inline: true });
  if (p.juiz) embed.addFields({ name: 'Juiz sorteado', value: `<@${p.juiz}>`, inline: true });
  if (p.medidaVinculada) embed.addFields({ name: 'Medida vinculada', value: p.medidaVinculada, inline: true });
  if (p.resultado) embed.addFields({ name: 'Resultado', value: p.resultado, inline: true });
  if (p.sentenca) embed.addFields({ name: 'Sentença', value: truncar(p.sentenca) });
  if (p.apelacaoNumero) embed.addFields({ name: 'Recurso', value: p.apelacaoNumero, inline: true });

  return embed;
}

function botoesDenuncia(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`processo:oferecer:${numero}`).setLabel('Oferecer denúncia').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`processo:arquivar:${numero}`).setLabel('Arquivar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Identificar réu').setStyle(ButtonStyle.Secondary),
  );
}

// Botões liberados assim que o processo tem Juiz sorteado (civil desde a abertura, penal
// desde a denúncia oferecida). Habilitação de advogado agora passa pelo Diário Oficial,
// não por um botão de autoatendimento aqui.
function botoesJuiz(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`processo:julgar:${numero}`).setLabel('Julgar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:gerenciardefesa:${numero}`).setLabel('Gerenciar defesa').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Adicionar parte tardia').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:intimar:${numero}`).setLabel('Emitir intimação').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  );
}

// Sempre aparece depois da sentença — o clique é que decide se quem apertou tem direito
// (só quem perdeu, conforme o resultado estruturado).
function botaoRecorrer(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:recorrer:${numero}`).setLabel('Recorrer').setStyle(ButtonStyle.Secondary),
  );
}

// Liberado desde a abertura do civil — o Juiz decide se a petição inicial segue ou não.
function botoesCivilAbertura(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:arquivarcivil:${numero}`).setLabel('Arquivar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:processo:recebereintimar:${numero}`).setLabel('Receber e intimar').setStyle(ButtonStyle.Success),
  );
}

async function criarProcessoPenal({ guild, delegadoId, promotorId, crimesTexto, motivo, reusTexto, medidaNumero }) {
  const crimesEscolhidos = resolverCrimes(crimesTexto);
  if (crimesEscolhidos.length === 0) return { erro: 'Nenhum crime válido informado. Use os IDs mostrados em `/crime buscar`.' };

  let promotorFinal = promotorId;
  if (!promotorFinal) {
    const promotores = rh.listarPorCargo('Promotor').filter(p => !p.licenca);
    if (promotores.length === 0) return { erro: 'Não há Promotor ativo. Informe um manualmente.' };
    promotorFinal = promotores[Math.floor(Math.random() * promotores.length)].discordId;
  }

  const numero = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');
  const reus = extrairMencoes(reusTexto);

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaProcessosPenaisId, prefixo: 'processo', numero,
    membros: [delegadoId, promotorFinal],
  });

  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Aguardando decisão do MP',
    crimes: crimesEscolhidos, motivo,
    reus, advogados: [], delegado: delegadoId, promotor: promotorFinal, juiz: null,
    canalId: canal.id, medidaVinculada: medidaNumero, sentenca: null,
  });

  // Réu é parte do processo desde que identificado — nunca fica trancado pra fora do canal.
  for (const reuId of reus) await canais.adicionarMembro(canal, reuId);

  const processo = db.buscarPorNumero('processos', numero);
  await canal.send({ content: `<@${delegadoId}> <@${promotorFinal}>`, embeds: [embedProcesso(processo)], components: [botoesDenuncia(numero)] });

  if (medidaNumero) db.atualizar('medidas', medidaNumero, { processoVinculado: numero });

  await auditoria.registrar(guild, { acao: 'Processo penal aberto', executorId: delegadoId, referencia: numero });
  return { numero, canal };
}

// Petição inicial em PDF é anexada depois, direto na conversa do canal — não precisa ser
// enviada no momento de abrir (Discord não permite anexo em modal, e pedir no slash command
// tirava a abertura do fluxo por botão). Autor não precisa comprovar identidade: abrir o
// processo já é prova suficiente de autoria.
async function criarProcessoCivil({ guild, advogadoId, autorNome, autorDiscordId, reuNome, reuDiscordId }) {
  const numero = proximoNumero(db, 'processos', 'CV', p => p.tipo === 'Civil');
  const reus = [reuDiscordId];

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaProcessosCiveisId, prefixo: 'processo', numero,
    membros: [...new Set([advogadoId, autorDiscordId, reuDiscordId])],
  });

  const juizId = rh.sortearJuiz({ excluirIds: [advogadoId] });
  if (juizId) await canais.adicionarMembro(canal, juizId);

  db.inserir('processos', {
    numero, tipo: 'Civil', status: juizId ? 'Aguardando defesa' : 'Aguardando sorteio de juiz',
    crimes: [], motivo: 'Petição inicial a ser anexada no canal deste processo.',
    autorNome, autorDiscordId, reuNome,
    reus, advogados: [advogadoId], delegado: null, promotor: null, juiz: juizId,
    juizDesde: juizId ? new Date().toISOString() : null,
    canalId: canal.id, medidaVinculada: null, sentenca: null, autor: advogadoId,
  });

  const processo = db.buscarPorNumero('processos', numero);
  const componentes = [botoesCivilAbertura(numero)];
  if (juizId) componentes.push(botoesJuiz(numero));
  await canal.send({
    content: `<@${advogadoId}>${juizId ? ` <@${juizId}>` : ''}\n📎 Anexe aqui, nesta conversa, a **petição inicial em PDF**.`,
    embeds: [embedProcesso(processo)], components: componentes,
  });

  await postarOuAtualizarDiario(guild, numero);
  await auditoria.registrar(guild, { acao: 'Processo civil aberto', executorId: advogadoId, referencia: numero });
  return { numero, canal };
}

// Penal só vira público depois que a denúncia é oferecida (sai da fase de inquérito).
// Civil já nasce público, porque autor e juiz já existem desde a abertura.
function processoPublico(p) {
  if (p.tipo === 'Civil') return true;
  return p.status !== 'Aguardando decisão do MP';
}

function temAcessoTotal(interaction, processo) {
  if (isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  if ([processo.delegado, processo.promotor, processo.juiz, processo.autor].includes(uid)) return true;
  return (processo.habilitacoes || []).some(h => h.advogadoId === uid && h.status === 'Aprovado');
}

// "Capa pública": os mesmos dados que aparecem no Diário Oficial — não o teor completo.
function embedCapaPublica(p) {
  const reusTxt = p.reuNome
    ? `${p.reuNome}${(p.reus || [])[0] ? ` (<@${p.reus[0]}>)` : ''}`
    : ((p.reus || []).length ? p.reus.map(id => `<@${id}>`).join(', ') : '*A identificar*');
  const embed = new EmbedBuilder()
    .setTitle(`📁 Processo ${p.numero} (${p.tipo})`)
    .setColor(p.tipo === 'Penal' ? 0xe67e22 : 0x3498db)
    .addFields(
      { name: 'Status', value: p.status, inline: true },
      { name: 'Réu(s)', value: truncar(reusTxt) },
    );
  if (p.autorNome) embed.addFields({ name: 'Autor', value: `${p.autorNome}${p.autorDiscordId ? ` (<@${p.autorDiscordId}>)` : ''}`, inline: true });
  else if (p.autor) embed.addFields({ name: 'Autor (advogado)', value: `<@${p.autor}>`, inline: true });
  embed.setFooter({ text: 'Capa pública — teor completo restrito às partes do processo.' });
  return embed;
}

function botaoSolicitarHabilitacao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:habilitacao:solicitar:${numero}`).setLabel('Solicitar habilitação').setStyle(ButtonStyle.Primary),
  );
}

// Publica a capa no Diário Oficial na primeira vez que o processo se torna público, e
// depois disso EDITA o mesmo post a cada mudança relevante (nunca duplica).
async function postarOuAtualizarDiario(guild, numero) {
  if (!config.canalDiarioOficialId) return;
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo || !processoPublico(processo)) return;

  const canal = await guild.channels.fetch(config.canalDiarioOficialId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) {
    console.error(`CANAL_DIARIO_OFICIAL_ID (${config.canalDiarioOficialId}) não é um canal de texto válido — capa do processo ${numero} não foi publicada.`);
    return;
  }

  const payload = { embeds: [embedCapaPublica(processo)], components: [botaoSolicitarHabilitacao(numero)] };

  try {
    if (processo.diarioMessageId) {
      const msg = await canal.messages.fetch(processo.diarioMessageId).catch(() => null);
      if (msg) {
        await msg.edit(payload);
        return;
      }
    }
    const msg = await canal.send(payload);
    db.atualizar('processos', numero, { diarioMessageId: msg.id });
  } catch (err) {
    console.error(`Falha ao publicar/atualizar Diário Oficial do processo ${numero}: ${err.message}`);
  }
}

async function verProcesso(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  if (temAcessoTotal(interaction, processo)) {
    return interaction.reply({ embeds: [embedProcesso(processo)], ephemeral: true });
  }
  if (!processoPublico(processo)) {
    return interaction.reply({ content: 'Esse processo está em fase de inquérito e não é público — sem acesso.', ephemeral: true });
  }
  return interaction.reply({ embeds: [embedCapaPublica(processo)], ephemeral: true });
}

async function listarProcessos(interaction, status) {
  let rows = db.todos('processos', status ? p => p.status === status : null);
  if (!isAdmin(interaction)) {
    rows = rows.filter(p => processoPublico(p) || temAcessoTotal(interaction, p));
  }
  rows = rows.slice(0, 15);
  if (rows.length === 0) return interaction.reply({ content: 'Nenhum processo encontrado.', ephemeral: true });

  const embed = new EmbedBuilder().setTitle('📁 Processos').setColor(0x3498db)
    .setDescription(rows.map(p => `**${p.numero}** (${p.tipo}) — *${p.status}*`).join('\n'));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// Acesso ao canal é liberado na hora pra quem for adicionado — é ação direta de autoridade
// (Delegado no inquérito, Juiz depois), não passa por habilitação.
async function vincularReu({ guild, numero, reusTexto, executorId = null }) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return { erro: 'Processo não encontrado.' };

  const novos = extrairMencoes(reusTexto);
  if (novos.length === 0) return { erro: 'Marque ao menos uma parte com @menção.' };

  const reus = [...new Set([...(processo.reus || []), ...novos])];
  db.atualizar('processos', numero, { reus });

  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    for (const reuId of novos) await canais.adicionarMembro(canal, reuId);
    await canal.send({ embeds: [embedProcesso(db.buscarPorNumero('processos', numero))] });
  }

  await postarOuAtualizarDiario(guild, numero);
  if (executorId) {
    await auditoria.registrar(guild, { acao: 'Parte tardia adicionada', executorId, referencia: `Processo ${numero}: ${novos.map(id => `<@${id}>`).join(', ')}` });
  }
  return { numero };
}

async function abrirModalParteTardia(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const ehDelegadoNoInquerito = processo.tipo === 'Penal' && !processo.juiz && interaction.user.id === processo.delegado;
  const ehJuiz = processo.juiz && interaction.user.id === processo.juiz;
  if (!ehDelegadoNoInquerito && !ehJuiz && !isAdmin(interaction)) {
    const motivo = processo.juiz
      ? `Só o Juiz deste processo pode adicionar parte tardia — no caso, <@${processo.juiz}>.`
      : `Só o Delegado responsável por este processo pode identificar réu nesta fase — no caso, <@${processo.delegado}>.`;
    return interaction.reply({ content: motivo, ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:partetardia:${numero}`).setTitle('Adicionar parte ao processo');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('reus').setLabel('Menções @ da(s) parte(s) a adicionar').setStyle(TextInputStyle.Short).setRequired(true),
  ));
  return interaction.showModal(modal);
}

// ---- Habilitação de advogado (nome + CPF do cliente, réu específico, aprovação do Juiz) ----

async function abrirModalHabilitacao(interaction, numero) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem solicitar habilitação.', ephemeral: true });
  }
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!processoPublico(processo)) {
    return interaction.reply({ content: 'Esse processo ainda está em fase de inquérito, sem publicidade — aguarde a denúncia.', ephemeral: true });
  }
  if (!processo.juiz) {
    return interaction.reply({ content: 'Esse processo ainda não tem Juiz sorteado — tente novamente em instantes.', ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`painel:modal:habilitacao:solicitar:${numero}`).setTitle('Solicitar habilitação');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cpf').setLabel('CPF do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu').setLabel('Menção @ do réu que representa').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

async function criarHabilitacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const nomeCliente = interaction.fields.getTextInputValue('nome');
  const cpfCliente = interaction.fields.getTextInputValue('cpf');
  const reuId = extrairMencoes(interaction.fields.getTextInputValue('reu'))[0];

  if (!reuId || !(processo.reus || []).includes(reuId)) {
    return interaction.reply({ content: 'Marque (@menção) um réu que já faça parte deste processo.', ephemeral: true });
  }

  const habilitacoes = processo.habilitacoes || [];
  const novoId = habilitacoes.reduce((max, h) => Math.max(max, h.id || 0), 0) + 1;
  const habilitacao = { id: novoId, reuId, advogadoId: interaction.user.id, nomeCliente, cpfCliente, status: 'Pendente' };
  db.atualizar('processos', numero, { habilitacoes: [...habilitacoes, habilitacao] });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal && processo.juiz) {
    const embed = new EmbedBuilder()
      .setTitle(`⚖️ Pedido de habilitação — Processo ${numero}`)
      .setColor(0xf1c40f)
      .addFields(
        { name: 'Advogado', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Réu representado', value: `<@${reuId}>`, inline: true },
        { name: 'Cliente', value: truncar(`${nomeCliente} — CPF ${cpfCliente}`) },
      );
    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:habilitacao:aprovar:${numero}#${novoId}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:habilitacao:negar:${numero}#${novoId}`).setLabel('Negar').setStyle(ButtonStyle.Danger),
    );
    await canal.send({ content: `<@${processo.juiz}>`, embeds: [embed], components: [botoes] });
  }

  return interaction.reply({ content: 'Pedido de habilitação enviado ao Juiz do processo.', ephemeral: true });
}

async function decidirHabilitacao(interaction, chave, aprovar) {
  const [numero, idTexto] = chave.split('#');
  const habId = Number(idTexto);
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decidir habilitação — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }

  const habilitacoes = processo.habilitacoes || [];
  const alvo = habilitacoes.find(h => h.id === habId);
  if (!alvo || alvo.status !== 'Pendente') {
    return interaction.reply({ content: 'Esse pedido não existe mais ou já foi decidido.', ephemeral: true });
  }

  const novoStatus = aprovar ? 'Aprovado' : 'Negado';
  const atualizadas = habilitacoes.map(h => h.id === habId ? { ...h, status: novoStatus } : h);
  db.atualizar('processos', numero, { habilitacoes: atualizadas });

  if (aprovar) {
    const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canal) await canais.adicionarMembro(canal, alvo.advogadoId);
  }

  await auditoria.registrar(interaction.guild, {
    acao: `Habilitação ${novoStatus.toLowerCase()}`, executorId: interaction.user.id,
    referencia: `Processo ${numero}: <@${alvo.advogadoId}> defendendo <@${alvo.reuId}>`,
  });

  const embed = new EmbedBuilder()
    .setColor(aprovar ? 0x2ecc71 : 0xe74c3c)
    .setDescription(`Habilitação de <@${alvo.advogadoId}> para defender <@${alvo.reuId}> foi **${novoStatus.toLowerCase()}**.`);
  return interaction.update({ embeds: [embed], components: [] });
}

// ---- Remoção de advogado habilitado (só o Juiz, via select menu) ----

async function abrirGerenciarDefesa(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode gerenciar a defesa — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const aprovadas = (processo.habilitacoes || []).filter(h => h.status === 'Aprovado');
  if (aprovadas.length === 0) return interaction.reply({ content: 'Nenhum advogado habilitado neste processo ainda.', ephemeral: true });

  const opcoes = await Promise.all(aprovadas.map(async h => {
    const adv = await interaction.guild.members.fetch(h.advogadoId).catch(() => null);
    const reu = await interaction.guild.members.fetch(h.reuId).catch(() => null);
    return {
      label: `${adv?.displayName || 'Advogado'} — defende ${reu?.displayName || 'réu'}`.slice(0, 100),
      value: String(h.id),
    };
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:habilitacao:remover:${numero}`).setPlaceholder('Selecione quem remover').addOptions(opcoes),
  );
  return interaction.reply({ content: 'Quem remover da defesa?', components: [row], ephemeral: true });
}

async function removerHabilitacao(interaction, numero, habIdTexto) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode remover advogados — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }

  const habilitacoes = processo.habilitacoes || [];
  const alvo = habilitacoes.find(h => h.id === Number(habIdTexto));
  if (!alvo) return interaction.reply({ content: 'Habilitação não encontrada.', ephemeral: true });

  const atualizadas = habilitacoes.map(h => h.id === alvo.id ? { ...h, status: 'Removido' } : h);
  db.atualizar('processos', numero, { habilitacoes: atualizadas });

  const aindaTemAcesso = atualizadas.some(h => h.advogadoId === alvo.advogadoId && h.status === 'Aprovado');
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    if (!aindaTemAcesso) await canal.permissionOverwrites.delete(alvo.advogadoId).catch(() => {});
    await canal.send({ content: `<@${alvo.advogadoId}> foi removido da defesa de <@${alvo.reuId}> pelo Juiz. O réu mantém acesso ao canal.` });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Advogado removido da defesa', executorId: interaction.user.id,
    referencia: `Processo ${numero}: <@${alvo.advogadoId}> (defendia <@${alvo.reuId}>)`,
  });

  return interaction.update({ content: `Removido. <@${alvo.advogadoId}> não representa mais <@${alvo.reuId}> neste processo.`, components: [] });
}

// ---- Intimação (Juiz) ----

function textoIntimacao({ numero, destinatarioId, teor }) {
  const dataExtenso = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  return [
    '**PODER JUDICIÁRIO**',
    `**Processo nº ${numero}**`,
    '',
    '**INTIMAÇÃO**',
    '',
    `Fica <@${destinatarioId}> intimado(a) nos autos do processo em epígrafe.`,
    '',
    teor,
    '',
    `Comarca, ${dataExtenso}.`,
  ].join('\n');
}

function modalIntimacao(numero, { destinatarioId, teorPadrao } = {}) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimar:${numero}`).setTitle('Emitir intimação');
  const campoDest = new TextInputBuilder().setCustomId('destinatario').setLabel('Menção @ do destinatário').setStyle(TextInputStyle.Short).setRequired(true);
  if (destinatarioId) campoDest.setValue(`<@${destinatarioId}>`);
  const campoTeor = new TextInputBuilder().setCustomId('teor').setLabel('Teor da intimação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  if (teorPadrao) campoTeor.setValue(teorPadrao);
  modal.addComponents(new ActionRowBuilder().addComponents(campoDest), new ActionRowBuilder().addComponents(campoTeor));
  return modal;
}

async function abrirModalIntimacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode emitir intimação — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  return interaction.showModal(modalIntimacao(numero));
}

async function abrirModalReceberEIntimar(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode receber a petição inicial — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const reuId = (processo.reus || [])[0];
  const teorPadrao = 'Fica Vossa Senhoria intimado(a) a apresentar defesa no prazo de 3 (três) dias, sob pena de revelia.';
  return interaction.showModal(modalIntimacao(numero, { destinatarioId: reuId, teorPadrao }));
}

async function emitirIntimacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const destId = extrairMencoes(interaction.fields.getTextInputValue('destinatario'))[0];
  const teor = interaction.fields.getTextInputValue('teor');
  if (!destId) return interaction.reply({ content: 'Marque o destinatário com @menção.', ephemeral: true });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) await canal.send({ content: textoIntimacao({ numero, destinatarioId: destId, teor }) });

  return interaction.reply({ content: 'Intimação emitida e postada no canal do processo.', ephemeral: true });
}

// ---- Arquivar petição inicial (civil) ----

async function arquivarCivil(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode arquivar a petição inicial — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }

  db.atualizar('processos', numero, { status: 'Arquivado' });
  await interaction.update({ embeds: [embedProcesso(db.buscarPorNumero('processos', numero))], components: [] });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canal.send({
      content: documentos.textoDespacho({
        numero, tipo: 'Civil', titulo: 'DESPACHO DE INDEFERIMENTO DA PETIÇÃO INICIAL',
        texto: 'Analisados os requisitos de admissibilidade, INDEFIRO a petição inicial, ante a ausência de requisitos essenciais para o regular prosseguimento do feito, e determino o arquivamento.',
        autorId: interaction.user.id, cargoAutor: 'Juiz(a) de Direito',
      }),
    });
    await canais.arquivarCanal(canal);
  }

  await auditoria.registrar(interaction.guild, { acao: 'Petição inicial arquivada (civil)', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  await postarOuAtualizarDiario(interaction.guild, numero);
}

// ---- Revisão de arquivamento (Delegado pede, Procurador decide — ver commands/supervisao.js) ----

function botaoPedirRevisao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:pedirrevisao:${numero}`).setLabel('Pedir revisão').setStyle(ButtonStyle.Secondary),
  );
}

async function pedirRevisaoArquivamento(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.delegado && !isAdmin(interaction)) {
    return interaction.reply({ content: `Só o Delegado responsável por este processo pode pedir revisão — no caso, <@${processo.delegado}>.`, ephemeral: true });
  }
  if (processo.status !== 'Arquivado') return interaction.reply({ content: 'Esse processo não está arquivado.', ephemeral: true });
  if (processo.revisaoArquivamento === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de revisão pendente.', ephemeral: true });

  db.atualizar('processos', numero, { revisaoArquivamento: 'Pendente' });

  // Avisa os Procuradores direto por DM, com o botão de ação já vinculado a este processo —
  // sem isso, a única forma de agir era descobrir manualmente em Filas Pendentes e redigitar
  // o número numa modal separada.
  const embed = new EmbedBuilder()
    .setTitle('📋 Pedido de revisão de arquivamento')
    .setColor(0xf39c12)
    .addFields(
      { name: 'Processo', value: numero, inline: true },
      { name: 'Delegado', value: `<@${processo.delegado}>`, inline: true },
      { name: 'Promotor que arquivou', value: `<@${processo.promotor}>`, inline: true },
    );
  const botao = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:supervisao:forcardenunciadireto:${numero}`).setLabel('Forçar denúncia').setStyle(ButtonStyle.Success),
  );
  const procuradores = rh.listarPorCargo('Procurador').filter(p => !p.licenca);
  for (const p of procuradores) {
    const user = await interaction.client.users.fetch(p.discordId).catch(() => null);
    if (user) await user.send({ embeds: [embed], components: [botao] }).catch(() => {});
  }

  return interaction.reply({ content: `Pedido de revisão registrado${procuradores.length ? ` — ${procuradores.length} Procurador(es) avisado(s) por DM.` : ' — não há Procurador ativo cadastrado no momento, mas o pedido fica visível em `/painel` > Supervisão > Filas pendentes assim que houver um.'}` });
}

// ---- Recurso/Apelação (só quem perdeu, conforme o resultado estruturado da sentença) ----

function podeRecorrer(interaction, processo) {
  if (isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  const perdeuReu = (processo.tipo === 'Penal' && processo.resultado === 'Condenado') || (processo.tipo === 'Civil' && processo.resultado === 'Procedente');
  const perdeuAcusacao = (processo.tipo === 'Penal' && processo.resultado === 'Absolvido') || (processo.tipo === 'Civil' && processo.resultado === 'Improcedente');

  if (perdeuReu) {
    if ((processo.reus || []).includes(uid)) return true;
    return (processo.habilitacoes || []).some(h => h.advogadoId === uid && h.status === 'Aprovado');
  }
  if (perdeuAcusacao) return processo.tipo === 'Penal' ? uid === processo.promotor : uid === processo.autor;
  return false;
}

// Explica o motivo real da recusa, não só a regra abstrata — quem tenta recorrer sem
// ter perdido precisa entender que perdeu por não ter perdido, não só "você não pode".
function explicarNegacaoRecurso(interaction, processo) {
  const uid = interaction.user.id;
  const ehReuOuDefesa = (processo.reus || []).includes(uid) || (processo.habilitacoes || []).some(h => h.advogadoId === uid && h.status === 'Aprovado');
  const ehAutorOuPromotor = processo.tipo === 'Penal' ? uid === processo.promotor : uid === processo.autor;

  if (!ehReuOuDefesa && !ehAutorOuPromotor) {
    return 'Você não pode recorrer: você não é parte deste processo (nem réu/defesa, nem autor/Promotor).';
  }

  const papel = ehReuOuDefesa ? 'réu/defesa' : (processo.tipo === 'Penal' ? 'Promotor' : 'autor');
  const resumoResultado = {
    Condenado: 'o réu foi condenado',
    Absolvido: 'o réu foi absolvido',
    Procedente: 'o pedido foi julgado procedente',
    Improcedente: 'o pedido foi julgado improcedente',
  }[processo.resultado] || 'a sentença ainda não tem um resultado estruturado registrado';

  return `Você não pode recorrer: você é ${papel} neste processo, e ${resumoResultado} — ou seja, você venceu a causa. Só quem perdeu tem o recurso liberado.`;
}

function parteContrariaDoRecurso(processo) {
  const perdeuReu = (processo.tipo === 'Penal' && processo.resultado === 'Condenado') || (processo.tipo === 'Civil' && processo.resultado === 'Procedente');
  if (perdeuReu) return processo.tipo === 'Penal' ? processo.promotor : processo.autor;
  return (processo.reus || [])[0] || null;
}

async function abrirModalRecorrer(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.apelacaoNumero) return interaction.reply({ content: `Esse processo já tem recurso aberto: ${processo.apelacaoNumero}.`, ephemeral: true });
  if (!podeRecorrer(interaction, processo)) return interaction.reply({ content: explicarNegacaoRecurso(interaction, processo), ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:recorrer:${numero}`).setTitle('Recorrer da sentença');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('razoes').setLabel('Razões do recurso').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
  ));
  return interaction.showModal(modal);
}

async function criarApelacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.apelacaoNumero) return interaction.reply({ content: `Esse processo já tem recurso aberto: ${processo.apelacaoNumero}.`, ephemeral: true });
  if (!podeRecorrer(interaction, processo)) return interaction.reply({ content: explicarNegacaoRecurso(interaction, processo), ephemeral: true });

  const razoes = interaction.fields.getTextInputValue('razoes');
  const recorrenteId = interaction.user.id;
  const parteContrariaId = parteContrariaDoRecurso(processo);

  const desembargadorId = rh.sortearPorCargo('Desembargador');
  if (!desembargadorId) return interaction.reply({ content: 'Não há Desembargador ativo cadastrado.', ephemeral: true });

  const numeroApelacao = proximoNumero(db, 'apelacoes', 'AP');

  const canal = await canais.criarCanalTicket(interaction.guild, {
    categoriaId: config.categoriaApelacoesId, prefixo: 'apelacao', numero: numeroApelacao,
    membros: [recorrenteId, parteContrariaId, desembargadorId].filter(Boolean),
  });

  db.inserir('apelacoes', {
    numero: numeroApelacao, processoOriginalNumero: numero, tipo: processo.tipo,
    recorrenteId, parteContrariaId, desembargadorId, razoes,
    status: 'Aguardando decisão', decisao: null, canalId: canal.id,
  });
  db.atualizar('processos', numero, { apelacaoNumero: numeroApelacao });

  const embed = new EmbedBuilder()
    .setTitle(`⚖️ Apelação ${numeroApelacao}`)
    .setColor(0x8e44ad)
    .addFields(
      { name: 'Processo original', value: numero, inline: true },
      { name: 'Recorrente', value: `<@${recorrenteId}>`, inline: true },
      { name: 'Parte contrária', value: parteContrariaId ? `<@${parteContrariaId}>` : '—', inline: true },
      { name: 'Razões do recurso', value: truncar(razoes) },
    );
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:apelacao:manter:${numeroApelacao}`).setLabel('Manter').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:apelacao:reformar:${numeroApelacao}`).setLabel('Reformar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`painel:acao:apelacao:anular:${numeroApelacao}`).setLabel('Anular').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:apelacao:arquivarmanual:${numeroApelacao}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  );
  await canal.send({ content: `<@${desembargadorId}>`, embeds: [embed], components: [botoes] });

  await auditoria.registrar(interaction.guild, { acao: 'Recurso interposto', executorId: recorrenteId, referencia: `Processo ${numero} → Apelação ${numeroApelacao}` });
  return interaction.reply({ content: `Recurso ${numeroApelacao} aberto em ${canal}.`, ephemeral: true });
}

async function validarDecisaoApelacao(interaction, numeroApelacao) {
  const apelacao = db.buscarPorNumero('apelacoes', numeroApelacao);
  if (!apelacao) {
    await interaction.reply({ content: 'Apelação não encontrada.', ephemeral: true });
    return null;
  }
  if (interaction.user.id !== apelacao.desembargadorId && !isAdmin(interaction)) {
    await interaction.reply({ content: `Só o Desembargador sorteado para esta apelação pode decidi-la — no caso, <@${apelacao.desembargadorId}>.`, ephemeral: true });
    return null;
  }
  if (apelacao.status !== 'Aguardando decisão') {
    await interaction.reply({ content: 'Essa apelação já foi decidida.', ephemeral: true });
    return null;
  }
  return apelacao;
}

// Reformar precisa de um novo resultado antes de finalizar — sem isso não existe reforma de
// verdade, só uma etiqueta na apelação sem efeito nenhum no processo original.
async function abrirSelecaoResultadoReforma(interaction, numeroApelacao) {
  const apelacao = await validarDecisaoApelacao(interaction, numeroApelacao);
  if (!apelacao) return;
  const processoOriginal = db.buscarPorNumero('processos', apelacao.processoOriginalNumero);
  if (!processoOriginal) return interaction.reply({ content: 'Processo original não encontrado.', ephemeral: true });

  const opcoes = processoOriginal.tipo === 'Penal'
    ? [{ label: 'Condenado', value: 'Condenado' }, { label: 'Absolvido', value: 'Absolvido' }]
    : [{ label: 'Procedente', value: 'Procedente' }, { label: 'Improcedente', value: 'Improcedente' }];

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:apelacao:resultado:${numeroApelacao}`).setPlaceholder('Novo resultado').addOptions(opcoes),
  );
  return interaction.reply({ content: 'Reformando a sentença — qual o novo resultado?', components: [row], ephemeral: true });
}

function abrirModalFundamentacaoReforma(interaction, numeroApelacao) {
  const novoResultado = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`painel:modal:apelacao:reformar:${numeroApelacao}#${novoResultado}`).setTitle('Fundamentação da reforma');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do relator').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
  ));
  return interaction.showModal(modal);
}

// Manter e Anular, ao contrário de Reformar, disparavam a decisão direto no clique do botão —
// sem nenhum texto do Desembargador, o acórdão saía só com a linha padrão da decisão, sem a
// fundamentação de verdade que o processo original recebe.
const TITULO_DECISAO = { manter: 'Manter a sentença', anular: 'Anular a sentença' };
async function abrirModalFundamentacaoDecisao(interaction, numeroApelacao, decisao) {
  const apelacao = await validarDecisaoApelacao(interaction, numeroApelacao);
  if (!apelacao) return;
  const modal = new ModalBuilder().setCustomId(`painel:modal:apelacao:decidir:${numeroApelacao}#${decisao}`).setTitle(TITULO_DECISAO[decisao]);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do relator').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
  ));
  return interaction.showModal(modal);
}

async function finalizarApelacao(interaction, numeroApelacao, decisao, extras = {}) {
  const apelacao = await validarDecisaoApelacao(interaction, numeroApelacao);
  if (!apelacao) return;

  if (interaction.isModalSubmit()) await interaction.deferReply({ ephemeral: true });
  else await interaction.deferUpdate();

  const statusFinal = { manter: 'Mantida', reformar: 'Reformada', anular: 'Anulada' }[decisao];
  db.atualizar('apelacoes', numeroApelacao, { status: statusFinal });

  const processoOriginal = db.buscarPorNumero('processos', apelacao.processoOriginalNumero);

  if (decisao === 'reformar' && processoOriginal) {
    const notaReforma = `\n\n[REFORMADA EM GRAU DE RECURSO — ${numeroApelacao}]\nNovo resultado: ${extras.novoResultado}\nFundamentação do relator: ${extras.fundamentacao}`;
    db.atualizar('processos', processoOriginal.numero, {
      resultado: extras.novoResultado,
      sentenca: `${processoOriginal.sentenca || ''}${notaReforma}`,
    });
  }

  if (decisao === 'anular' && processoOriginal) {
    const novoJuizId = rh.sortearJuiz({ excluirIds: [processoOriginal.delegado, processoOriginal.promotor, processoOriginal.juiz].filter(Boolean) });
    db.atualizar('processos', processoOriginal.numero, {
      status: 'Instrução', juiz: novoJuizId, juizDesde: new Date().toISOString(), sentenca: null, resultado: null, apelacaoNumero: null,
    });
    const canalOriginalParaJuiz = await interaction.guild.channels.fetch(processoOriginal.canalId).catch(() => null);
    if (canalOriginalParaJuiz) {
      // A sentença original já tinha travado e arquivado esse canal — anular reabre o caso
      // pra instrução, então o canal precisa voltar a ser editável e sair da categoria Arquivados.
      const partes = [processoOriginal.delegado, processoOriginal.promotor, processoOriginal.autor, novoJuizId, ...(processoOriginal.reus || []), ...(processoOriginal.advogados || [])].filter(Boolean);
      await canais.reabrirCanal(canalOriginalParaJuiz, partes);
      if (novoJuizId) await canais.adicionarMembro(canalOriginalParaJuiz, novoJuizId);
      await canalOriginalParaJuiz.send({
        content: `Apelação ${numeroApelacao} anulou a sentença.${novoJuizId ? ` <@${novoJuizId}> foi sorteado para novo julgamento.` : ' Nenhum Juiz disponível pra sorteio — atribua manualmente.'}`,
        components: novoJuizId ? [botoesJuiz(processoOriginal.numero)] : [],
      });
    }
  }

  const textoDoc = documentos.textoAcordao({ apelacao, decisaoTexto: extras.fundamentacao, statusFinal });
  if (interaction.channel) {
    await interaction.channel.send({ content: textoDoc });
    // Apelação decidida é resolução final dela mesma — trava o canal, mesmo quando anula
    // (a continuação do caso acontece no canal do processo original, não aqui).
    await canais.arquivarCanal(interaction.channel);
  }

  if (processoOriginal) {
    const canalOriginal = await interaction.guild.channels.fetch(processoOriginal.canalId).catch(() => null);
    if (canalOriginal) {
      const processoAtualizado = db.buscarPorNumero('processos', processoOriginal.numero);
      await canalOriginal.send({
        content: `📋 Resultado do recurso ${numeroApelacao}:\n\n${textoDoc}`,
        embeds: [embedProcesso(processoAtualizado)],
      });
    }
    await postarOuAtualizarDiario(interaction.guild, processoOriginal.numero);
  }

  await auditoria.registrar(interaction.guild, {
    acao: `Apelação decidida: ${statusFinal}`, executorId: interaction.user.id, referencia: `${numeroApelacao} (processo ${apelacao.processoOriginalNumero})`,
  });

  const embedResultado = new EmbedBuilder().setColor(0x8e44ad).setDescription(`Apelação ${numeroApelacao}: sentença **${statusFinal}**. Acórdão publicado no canal.`);
  return interaction.editReply({ embeds: [embedResultado], components: [] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('processo')
    .setDescription('Gerencia processos penais e civis')
    .addSubcommand(sub => sub.setName('penal').setDescription('Abre um processo penal (inquérito) — Delegado')
      .addStringOption(o => o.setName('crimes').setDescription('IDs dos crimes separados por vírgula (use /crime buscar)').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Descrição objetiva dos fatos').setRequired(true))
      .addUserOption(o => o.setName('promotor').setDescription('Promotor responsável'))
      .addStringOption(o => o.setName('reus').setDescription('Menções @ dos réus, se já identificados'))
      .addStringOption(o => o.setName('medida').setDescription('Número da medida provisória vinculada, se houver')))
    .addSubcommand(sub => sub.setName('civil').setDescription('Abre um processo civil — Advogado (anexe a petição inicial depois, no canal)')
      .addStringOption(o => o.setName('autor_nome').setDescription('Nome completo do autor').setRequired(true))
      .addUserOption(o => o.setName('autor_discord').setDescription('Usuário Discord do autor').setRequired(true))
      .addStringOption(o => o.setName('reu_nome').setDescription('Nome completo do réu').setRequired(true))
      .addUserOption(o => o.setName('reu_discord').setDescription('Usuário Discord do réu').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista processos')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status')))
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de um processo')
      .addStringOption(o => o.setName('numero').setDescription('Número do processo').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'penal') {
      if (!temCargo(interaction, 'Delegado')) {
        return interaction.reply({ content: 'Só Delegados podem abrir processo penal.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resultado = await criarProcessoPenal({
        guild: interaction.guild,
        delegadoId: interaction.user.id,
        promotorId: interaction.options.getUser('promotor')?.id || null,
        crimesTexto: interaction.options.getString('crimes'),
        motivo: interaction.options.getString('motivo'),
        reusTexto: interaction.options.getString('reus'),
        medidaNumero: interaction.options.getString('medida') || null,
      });

      if (resultado.erro) return interaction.editReply({ content: resultado.erro });
      return interaction.editReply({ content: `Processo penal ${resultado.numero} aberto em ${resultado.canal}.` });
    }

    if (sub === 'civil') {
      if (!temCargo(interaction, 'Advogado')) {
        return interaction.reply({ content: 'Só Advogados podem abrir processo civil.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resultado = await criarProcessoCivil({
        guild: interaction.guild,
        advogadoId: interaction.user.id,
        autorNome: interaction.options.getString('autor_nome'),
        autorDiscordId: interaction.options.getUser('autor_discord').id,
        reuNome: interaction.options.getString('reu_nome'),
        reuDiscordId: interaction.options.getUser('reu_discord').id,
      });

      return interaction.editReply({ content: `Processo civil ${resultado.numero} aberto em ${resultado.canal}.` });
    }

    if (sub === 'listar') {
      return listarProcessos(interaction, interaction.options.getString('status'));
    }

    if (sub === 'ver') {
      return verProcesso(interaction, interaction.options.getString('numero'));
    }
  },

  // ---- Handlers de botão/modal ----

  async oferecer(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
    }

    const excluir = [processo.delegado, processo.promotor];
    const juizId = rh.sortearJuiz({ excluirIds: excluir });
    if (!juizId) return interaction.reply({ content: 'Não há Juiz ativo disponível para sorteio.', ephemeral: true });

    db.atualizar('processos', numero, { status: 'Instrução', juiz: juizId, juizDesde: new Date().toISOString() });
    const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canal) await canais.adicionarMembro(canal, juizId);

    await interaction.update({ embeds: [embedProcesso(db.buscarPorNumero('processos', numero))], components: [] });
    if (canal) {
      const reusTxt = (processo.reus || []).map(id => `<@${id}>`).join(', ') || 'réu(s) a identificar';
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: processo.tipo, titulo: 'DESPACHO DE RECEBIMENTO DA DENÚNCIA',
          texto: `Recebo a denúncia oferecida pelo Ministério Público em desfavor de ${reusTxt}. Distribuído por sorteio a <@${juizId}>. Cite-se o(s) réu(s) para instrução e julgamento.`,
          autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça',
        }),
        components: [botoesJuiz(numero)],
      });
    }

    await auditoria.registrar(interaction.guild, { acao: 'Denúncia oferecida', executorId: interaction.user.id, referencia: `Processo ${numero} → Juiz <@${juizId}>` });
    await postarOuAtualizarDiario(interaction.guild, numero);
  },

  async arquivar(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.promotor && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
    }

    db.atualizar('processos', numero, { status: 'Arquivado' });
    await interaction.update({ embeds: [embedProcesso(db.buscarPorNumero('processos', numero))], components: [] });

    const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canal) {
      await canais.arquivarCanal(canal);
      await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: processo.tipo, titulo: 'DESPACHO DE ARQUIVAMENTO',
          texto: 'Ante a ausência de elementos suficientes para o oferecimento de denúncia, determino o arquivamento do presente inquérito, sem prejuízo de reabertura caso surjam novas provas ou seja provido pedido de revisão.',
          autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça',
        }),
      });
      await canal.send({ content: `<@${processo.delegado}>`, components: [botaoPedirRevisao(numero)] });
    }

    await auditoria.registrar(interaction.guild, { acao: 'Processo arquivado (MP)', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  },

  async julgar(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.juiz && !isAdmin(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processo.juiz}>.`, ephemeral: true });
    }

    const opcoes = processo.tipo === 'Penal'
      ? [{ label: 'Condenado', value: 'Condenado' }, { label: 'Absolvido', value: 'Absolvido' }]
      : [{ label: 'Procedente', value: 'Procedente' }, { label: 'Improcedente', value: 'Improcedente' }];

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:processo:resultado:${numero}`).setPlaceholder('Qual o resultado?').addOptions(opcoes),
    );
    return interaction.reply({ content: 'Qual o resultado da sentença?', components: [row], ephemeral: true });
  },

  async salvarSentenca(interaction, numero, resultado) {
    const texto = interaction.fields.getTextInputValue('texto');
    db.atualizar('processos', numero, { status: 'Encerrado', sentenca: texto, resultado });

    const processo = db.buscarPorNumero('processos', numero);
    await interaction.reply({ content: documentos.textoSentenca(processo), embeds: [embedProcesso(processo)], components: [botaoRecorrer(numero)] });

    const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canal) await canais.arquivarCanal(canal);

    await auditoria.registrar(interaction.guild, { acao: `Sentença: ${resultado}`, executorId: interaction.user.id, referencia: `Processo ${numero}` });
    await postarOuAtualizarDiario(interaction.guild, numero);
  },

  criarProcessoPenal,
  criarProcessoCivil,
  vincularReu,
  embedProcesso,
  embedCapaPublica,
  processoPublico,
  temAcessoTotal,
  verProcesso,
  listarProcessos,
  postarOuAtualizarDiario,
  abrirModalParteTardia,
  abrirModalHabilitacao,
  criarHabilitacao,
  decidirHabilitacao,
  abrirGerenciarDefesa,
  removerHabilitacao,
  abrirModalIntimacao,
  abrirModalReceberEIntimar,
  emitirIntimacao,
  arquivarCivil,
  botoesJuiz,
  pedirRevisaoArquivamento,
  abrirModalRecorrer,
  criarApelacao,
  abrirSelecaoResultadoReforma,
  abrirModalFundamentacaoReforma,
  abrirModalFundamentacaoDecisao,
  finalizarApelacao,
  extrairMencoes,
};
