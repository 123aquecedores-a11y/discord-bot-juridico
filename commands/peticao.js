const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const canais = require('../utils/canais');
const rh = require('../utils/rh');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isSuperStaff, isAdmin, papelInstitucional } = require('../utils/permissoes');
const { truncar, extrairMencaoOuId } = require('../utils/texto');
const cruzamento = require('../utils/cruzamento');
const ficha = require('../utils/ficha');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const certidoes = require('../utils/certidoes');
const documentoPng = require('../services/gerarDocumentoPNG');
const { aguardarAnexoPDF } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');
const analiseDocumento = require('../utils/analiseDocumento');

const TIPO_LABEL = { PorteArma: 'Porte de Arma', TrocaNome: 'Troca de Nome', LimpezaFicha: 'Limpeza de Ficha', AlvaraEvento: 'Alvará de Evento' };

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
  AlvaraEvento: 'Certidão de não constar como investigado, e roteiro/plano do evento (local, horário e estrutura de segurança prevista).',
};

// Art. 66, incisos I e II — só informativo no card do pedido (não muda o fluxo de aprovação,
// a fiscalização em si é ação de RP fora do bot, ver Art. 69/70).
function classificarLotacao(pessoas) {
  if (pessoas >= 25) return { rotulo: 'muito alta', inciso: 'II' };
  if (pessoas >= 15) return { rotulo: 'alta', inciso: 'I' };
  return null;
}

// Porte ativo agora é rastreado pelo RG do cliente, não pelo Discord de quem protocolou
// (o Advogado) — dois advogados diferentes pedindo pro mesmo cliente têm que enxergar o
// mesmo porte ativo.
function porteAtivo(rgCliente) {
  const agora = Date.now();
  return db.buscarUm('peticoes', p => p.tipo === 'PorteArma' && p.rgCliente === rgCliente && p.status === 'Deferido' && p.validadeAte && new Date(p.validadeAte).getTime() > agora);
}

function embedPeticao(p) {
  // Frente 5.4 — reincidência (2ª vez ou mais) vira AVISO FORTE pro julgador em vez de exigir
  // justificativa do requerente: card fica vermelho e abre com um alerta no topo. É data-driven
  // (primeiraVez === false), então aparece em QUALQUER render do card — criação e hora de decidir.
  const reincidente = p.primeiraVez === false;
  const embed = new EmbedBuilder()
    .setTitle(`📄 Petição ${p.numero} — ${TIPO_LABEL[p.tipo]}`)
    .setColor(reincidente ? 0xc0392b : 0x16a085);
  if (reincidente) {
    const oQue = p.tipo === 'TrocaNome' ? 'troca de nome' : (p.tipo === 'LimpezaFicha' ? 'limpeza de ficha' : 'pedido deste tipo');
    embed.setDescription(`🚨 **REINCIDÊNCIA — ATENÇÃO DO JULGADOR**\nEste RG **já teve ${oQue} deferida antes**. O requerente não declara justificativa no formulário; se precisar do motivo ou de documento, converta em **diligência** (botão abaixo) antes de decidir.`);
  }
  embed.addFields(
    { name: 'Advogado(a)', value: `<@${p.requerenteId}>`, inline: true },
    { name: 'Status', value: p.status, inline: true },
  );
  if (p.rgCliente) {
    embed.addFields(
      { name: 'Cliente', value: p.nomeCliente || '—', inline: true },
      { name: 'RG', value: p.rgCliente, inline: true },
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
  return new ButtonBuilder().setCustomId(`painel:acao:peticao:anexardocumento:${numero}`).setLabel('📎 Anexar petição/documento').setStyle(ButtonStyle.Primary);
}

// Gate das ações de manutenção da petição (anexar documento, vincular cliente, mais dados): só
// quem é parte da petição (advogado requerente, Juiz ou Promotor do caso) ou Staff — não basta
// ter acesso ao canal. Antes essas ações rodavam sem nenhuma checagem de cargo/parte.
function podeMexerNaPeticao(interaction, peticao) {
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
  return [peticao.requerenteId, peticao.juiz, peticao.promotor].filter(Boolean).includes(interaction.user.id);
}

const RECUSA_MEXER_PETICAO = 'Só as partes desta petição (advogado requerente, Juiz/Promotor do caso) ou a Staff podem fazer isso.';

async function anexarDocumentoPeticao(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (!podeMexerNaPeticao(interaction, peticao)) return interaction.reply({ content: RECUSA_MEXER_PETICAO, ephemeral: true });

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  anexos.criarDocumento({
    tipo: 'documento_peticao', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: numero,
  });

  // IA "cartório" faz a análise estruturada do documento (best-effort).
  const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'documento_peticao', pdfUrl: anexo.url });
  await interaction.followUp({ content: `📎 [${anexo.nomeArquivo}](${anexo.url}) juntado à petição ${numero}.`, embeds: embedAnalise ? [embedAnalise] : [] });
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
// verdade, puxando RG e nome já cadastrados na própria petição, sem digitar de novo.
async function solicitarCertidaoDaPeticao(interaction, numero) {
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (!certidoes.podeSolicitarCertidao(interaction)) {
    return interaction.reply({ content: 'Só Juiz, Promotor, Desembargador ou Procurador podem requisitar certidão.', ephemeral: true });
  }
  const instituicao = papelInstitucional(interaction);
  const resultado = await certidoes.solicitarCertidao({
    guild: interaction.guild, rg: peticao.rgCliente, nomeCliente: peticao.nomeCliente || peticao.nomeNovo,
    finalidade: `Petição ${numero} (${TIPO_LABEL[peticao.tipo]})`, executorId: interaction.user.id, instituicao,
  });
  return interaction.reply({ content: `✅ Certidão ${resultado.numero} requisitada em ${resultado.canal}.`, ephemeral: true });
}

// Frente 7: identidade do cliente = nome + RG; o @ do Discord é OPCIONAL. A petição é PROTOCOLADA
// já na abertura (Juiz/Promotor sorteados por `protocolarPeticao`, chamado em enviarFollowUpsCadastro)
// com base em nome+RG — não espera vínculo de Discord nenhum. Vincular o Discord do cliente segue
// possível, mas opcional (só pra notificações/apelido) e nunca bloqueia a decisão.
async function abrirTicketPeticao({ guild, tipo, sigla, requerenteId, dados }) {
  const numero = proximoNumero(db, 'peticoes', sigla, p => p.tipo === tipo);

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaPeticoesId, prefixo: 'peticao', numero,
    membros: [requerenteId],
  });

  db.inserir('peticoes', {
    numero, tipo, requerenteId, promotor: null, juiz: null, status: 'Aguardando sorteio de juiz', canalId: canal.id, ...dados,
  });

  // Só troca de nome deferida grava nomeCivil (ver ficha.registrarTrocaNome) — sem isso, a
  // ficha de quem só pediu porte de arma ou limpeza de ficha nunca tinha nome nenhum, e o
  // SISBAJUS não achava a pessoa buscando pelo nome que ela mesma informou na petição.
  if (dados.rgCliente && dados.nomeCliente) ficha.definirNomeSeVazio(dados.rgCliente, dados.nomeCliente, `Petição ${numero}`);

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

  // Manifestação do MP (Parte 1): grava o instante do sorteio do promotor — base do prazo lazy de
  // 24h — e inicializa a lista de manifestações. É lista (não objeto): cada manifestação é um ato
  // que não se desfaz; se o promotor for trocado, o novo complementa, não sobrescreve.
  db.atualizar('peticoes', numero, {
    promotor: promotorId, juiz: juizId,
    status: juizId ? 'Pendente' : 'Aguardando sorteio de juiz',
    ...(promotorId ? { sorteioPromotorEm: new Date().toISOString(), manifestacoesMp: [] } : {}),
  });

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
// cliente (nome, RG, endereço), com o RG virando a chave de rastreio na ficha central
// (utils/ficha.js). O cliente em si não precisa ter conta no Discord — quando tiver, o
// Advogado vincula depois (follow-up com UserSelectMenu), o que também é o que faz o
// cruzamento automático de antecedentes funcionar de verdade.

async function criarPeticaoPorteArma({ guild, requerenteId, rgCliente, nomeCliente, enderecoCliente }) {
  const { numero, canal } = await abrirTicketPeticao({
    guild, tipo: 'PorteArma', sigla: 'PA', requerenteId,
    dados: { rgCliente, nomeCliente, enderecoCliente },
  });

  const ativo = porteAtivo(rgCliente);
  // Declaração de maioridade/residência e relação de ocorrências agora vêm no PDF (Frente 5.4);
  // o card mantém só os apoios que o SISTEMA calcula (porte ativo, cruzamento, tabela de risco).
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Já possui porte ativo?', value: ativo ? `⚠️ Sim — ${ativo.numero}, válido até <t:${Math.floor(new Date(ativo.validadeAte).getTime() / 1000)}:D>` : 'Não' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorRG(rgCliente)) },
      { name: 'Referência — nível de risco', value: truncar(TABELA_RISCO) },
    );

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.PorteArma}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de porte de arma aberta', executorId: requerenteId, referencia: `${numero}: RG ${rgCliente}` });
  return { numero, canal };
}

async function criarPeticaoTrocaNome({ guild, requerenteId, rgCliente, nomeAtual, nomeNovo, enderecoCliente, jaUsouGratuita }) {
  const { numero, canal } = await abrirTicketPeticao({
    guild, tipo: 'TrocaNome', sigla: 'TN', requerenteId,
    dados: { rgCliente, nomeCliente: nomeNovo, nomeAtual, nomeNovo, enderecoCliente, primeiraVez: !jaUsouGratuita },
  });

  // Justificativa saiu do formulário (Frente 5.4) — vai no PDF. A reincidência vira aviso forte no
  // card (embedPeticao, via primeiraVez === false); aqui fica só a nota da gratuidade (1ª vez).
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Nome atual', value: nomeAtual, inline: true },
      { name: 'Nome pretendido', value: nomeNovo, inline: true },
      { name: 'Primeira troca deste RG (gratuita)?', value: jaUsouGratuita ? '⚠️ Não — é a 2ª vez ou mais' : 'Sim' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorRG(rgCliente)) },
    );

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.TrocaNome}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de troca de nome aberta', executorId: requerenteId, referencia: `${numero}: RG ${rgCliente} "${nomeAtual}" → "${nomeNovo}"` });
  return { numero, canal };
}

// Limpeza de ficha e troca de nome rastreiam reincidência (jaTeveAntes/jaTrocou): a 2ª vez não
// exige mais justificativa do requerente (Frente 5.4) — vira aviso forte pro julgador, que pede
// esclarecimento por diligência se quiser. Porte de arma nem rastreia (renovação é rotina).
async function criarPeticaoLimpezaFicha({ guild, requerenteId, rgCliente, nomeCliente, enderecoCliente, jaTeveAntes }) {
  const { numero, canal } = await abrirTicketPeticao({
    guild, tipo: 'LimpezaFicha', sigla: 'LF', requerenteId,
    dados: { rgCliente, nomeCliente, enderecoCliente, primeiraVez: !jaTeveAntes },
  });

  // Justificativa saiu do formulário (Frente 5.4) — vai no PDF. A reincidência vira aviso forte no
  // card (embedPeticao, via primeiraVez === false); aqui ficam só os apoios calculados pelo sistema.
  const temNovoAntecedente = cruzamento.temNovoAntecedenteEmPorRG(rgCliente, null, 15);
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Novo antecedente nos últimos 15 dias?', value: temNovoAntecedente ? '⚠️ Sim — indeferimento sumário indicado' : '✅ Não' },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorRG(rgCliente)) },
    );

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.LimpezaFicha}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de limpeza de ficha aberta', executorId: requerenteId, referencia: `${numero}: RG ${rgCliente}` });
  return { numero, canal };
}

// Alvará de Evento (Decreto 003/2026) — "cliente" aqui é o organizador do evento, mesmo padrão
// de rastreio por RG dos outros três tipos. Lotação (Art. 66, I/II) é só um selo informativo
// no card do pedido; não bloqueia nem muda o rito de decisão do Juiz.
async function criarPeticaoAlvaraEvento({ guild, requerenteId, rgCliente, nomeCliente, nomeEvento, localEvento, numeroPessoas }) {
  const { numero, canal } = await abrirTicketPeticao({
    guild, tipo: 'AlvaraEvento', sigla: 'AE', requerenteId,
    dados: { rgCliente, nomeCliente, enderecoCliente: localEvento, nomeEvento, localEvento, numeroPessoas },
  });

  const lotacao = classificarLotacao(numeroPessoas);
  const embed = embedPeticao(db.buscarPorNumero('peticoes', numero))
    .addFields(
      { name: 'Evento', value: truncar(nomeEvento), inline: true },
      { name: 'Local', value: truncar(localEvento), inline: true },
      {
        name: 'Número estimado de pessoas',
        value: lotacao ? `${numeroPessoas} — ⚠️ lotação ${lotacao.rotulo} (Art. 66, inciso ${lotacao.inciso})` : `${numeroPessoas}`,
      },
      { name: 'Cruzamento automático', value: truncar(cruzamento.resumoTextoPorRG(rgCliente)) },
    );

  await canal.send({ embeds: [embed] });
  await canal.send({
    content: `📋 **Checklist de documentos exigidos:**\n${DOCUMENTOS_NECESSARIOS.AlvaraEvento}`,
    components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero))],
  });
  await auditoria.registrar(guild, { acao: 'Petição de alvará de evento aberta', executorId: requerenteId, referencia: `${numero}: RG ${rgCliente} — "${nomeEvento}" (${numeroPessoas} pessoas)` });
  return { numero, canal };
}

// ---- Follow-ups pós-criação: vincular Discord do cliente (obrigatório) + endereço adicional ----
// Modal do Discord só aceita 5 campos de texto — RG, nome e endereço já lotam o modal, então
// o vínculo com uma conta de Discord (que exigiria um select, não um campo de texto) acontece
// depois, como uma mensagem NO PRÓPRIO CANAL da petição (não ephemeral) — assim não se perde
// se a pessoa fechar a mensagem, e o Juiz consegue ver que ainda falta antes de decidir.
// É obrigatório: sem vincular, a petição não pode ser deferida nem indeferida (ver `decidir`).

// Frente 1.2 — reversibilidade dos estados terminais automáticos. Quando um timer cancela (vínculo
// não feito em 1h) ou indefere (diligência não cumprida em 24h) uma petição, o canal NÃO some
// (arquivar só bloqueia envio, mantém a visibilidade), e fica ali um botão "Reabrir" pra Supervisão
// ou Staff ressuscitar o caso — voltando ao status anterior com prazo novo. Casos legítimos não
// morrem só porque os jogadores não estavam online no timer.
function podeReabrir(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction) || temCargo(interaction, 'Desembargador') || temCargo(interaction, 'Procurador');
}

function botaoReabrirCaso(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:peticao:reabrir:${numero}`).setLabel('♻️ Reabrir caso (Supervisão/Staff)').setStyle(ButtonStyle.Secondary);
}

async function reabrirCaso(interaction, numero) {
  if (!podeReabrir(interaction)) {
    return interaction.reply({ content: 'Só a Supervisão (Desembargador/Procurador) ou a Staff podem reabrir um caso encerrado por decurso de prazo.', ephemeral: true });
  }
  const p = db.buscarPorNumero('peticoes', numero);
  if (!p) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  const canal = p.canalId ? await interaction.guild.channels.fetch(p.canalId).catch(() => null) : null;

  if (p.status === 'Cancelada — prazo de vínculo expirado') {
    db.atualizar('peticoes', numero, { status: 'Aguardando vínculo', criado_em: new Date().toLocaleString('pt-BR'), lembreteVinculoEnviado: false });
    if (canal) {
      await canais.reabrirCanal(canal, [p.requerenteId].filter(Boolean));
      const rowUser = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`painel:userselect:peticao:vincularcliente#${numero}`).setPlaceholder('Selecione o cliente no Discord'));
      const rowManual = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`painel:acao:peticao:vincularmanual:${numero}`).setLabel('Cliente ainda não está no servidor').setStyle(ButtonStyle.Secondary));
      await canal.send({ content: `♻️ **Petição reaberta** por <@${interaction.user.id}> (Supervisão/Staff). <@${p.requerenteId}>, vincule novamente a conta do cliente — há novo prazo de 1 (uma) hora.`, components: [rowUser, rowManual] });
    }
    return interaction.reply({ content: `Petição ${numero} reaberta — aguardando novo vínculo do cliente.`, ephemeral: true });
  }

  if (p.status === 'Indeferido' && p.indeferidoPorDiligencia) {
    db.atualizar('peticoes', numero, { status: 'Diligência', diligenciaDesde: new Date().toISOString(), lembreteDiligenciaEnviado: false, indeferidoPorDiligencia: false });
    if (canal) {
      await canais.reabrirCanal(canal, [p.requerenteId, p.juiz].filter(Boolean));
      await canal.send({
        content: `♻️ **Petição reaberta** por <@${interaction.user.id}> (Supervisão/Staff). Diligência retomada — <@${p.requerenteId}>, cumpra a diligência (anexe o documento solicitado); ${p.juiz ? `<@${p.juiz}> ` : 'o Juízo '}decide em seguida. Novo prazo de 24 (vinte e quatro) horas.`,
        components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero)), botoesDecisao(numero)],
      });
    }
    return interaction.reply({ content: `Petição ${numero} reaberta — diligência retomada.`, ephemeral: true });
  }

  return interaction.reply({ content: `A petição ${numero} não está num estado reabrível automaticamente (status atual: "${p.status}"). Reabertura por prazo vale só para cancelamento por vínculo ou indeferimento por diligência.`, ephemeral: true });
}

async function enviarFollowUpsCadastro(interaction, numero, rgCliente, canal) {
  // Frente 7: protocola JÁ (sorteia Juiz/Promotor) com base em nome+RG — não espera vínculo nenhum.
  await protocolarPeticao(interaction.guild, numero);

  // Vincular o Discord do cliente continua possível, mas OPCIONAL: serve pra aplicar o apelido (se
  // a pessoa existir/entrar no servidor) e pra notificações. Nunca bloqueia a decisão nem cancela a
  // petição. O select nativo só lista quem já está no servidor; o botão ao lado aceita ID/@ na mão.
  const rowUser = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`painel:userselect:peticao:vincularcliente#${numero}`).setPlaceholder('Vincular Discord do cliente (opcional)'),
  );
  const rowManual = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:vincularmanual:${numero}`).setLabel('Informar @/ID na mão').setStyle(ButtonStyle.Secondary),
  );
  await canal.send({
    content: `<@${interaction.user.id}> 📎 *(Opcional)* Se o cliente tiver conta de Discord, dá pra vincular abaixo — só pra notificações e apelido. **Não é obrigatório**: a petição já foi protocolada por **nome + RG**.`,
    components: [rowUser, rowManual],
  });

  await perguntarMaisDados(interaction, numero, rgCliente);
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
  if (!podeMexerNaPeticao(interaction, peticao)) return interaction.reply({ content: RECUSA_MEXER_PETICAO, ephemeral: true });
  if (peticao.discordIdCliente) return interaction.reply({ content: 'Essa petição já tem cliente vinculado.', ephemeral: true });

  ficha.vincularDiscordId(peticao.rgCliente, usuarioId, `Petição ${numero} — vínculo manual`);
  db.atualizar('peticoes', numero, { discordIdCliente: usuarioId });
  // Frente 7: opcional, não re-protocola (a petição já nasceu protocolada por nome+RG).
  return interaction.reply({
    content: `✅ Discord do cliente vinculado: <@${usuarioId}> — se ainda não estiver no servidor, o apelido é aplicado quando entrar. *(Opcional — a petição já estava protocolada por nome+RG.)*`,
    ephemeral: true,
  });
}

// Pergunta única (não mais um loop de sim/não só pra endereço) — quanto mais dado a ficha
// acumula, mais fácil o SISBAJUS acha essa pessoa depois sem precisar de RG nem Discord.
async function perguntarMaisDados(interaction, numero, rgCliente) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:peticao:maisdados:${numero}#${rgCliente}`).setLabel('📎 Registrar mais dados do cliente').setStyle(ButtonStyle.Secondary),
  );
  await interaction.followUp({
    content: '📎 Quer registrar mais algum dado do cliente na ficha (outro endereço, telefone, rede social)? Ajuda a achar essa pessoa depois mesmo sem saber RG ou Discord dela. Opcional.',
    components: [row], ephemeral: true,
  });
}

function abrirModalMaisDados(interaction, extra) {
  const [numero, rg] = extra.split('#');
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (!podeMexerNaPeticao(interaction, peticao)) return interaction.reply({ content: RECUSA_MEXER_PETICAO, ephemeral: true });
  const modal = new ModalBuilder().setCustomId(`painel:modal:peticao:maisdados:${numero}#${rg}`).setTitle('Mais dados do cliente (opcional)');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço adicional').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('telefone').setLabel('Telefone').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rede').setLabel('Rede social (ex: @usuario, Instagram)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

async function processarMaisDados(interaction, extra) {
  const [numero, rg] = extra.split('#');
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.reply({ content: 'Petição não encontrada.', ephemeral: true });
  if (!podeMexerNaPeticao(interaction, peticao)) return interaction.reply({ content: RECUSA_MEXER_PETICAO, ephemeral: true });
  const endereco = interaction.fields.getTextInputValue('endereco');
  const telefone = interaction.fields.getTextInputValue('telefone');
  const rede = interaction.fields.getTextInputValue('rede');

  if (!endereco && !telefone && !rede) {
    return interaction.reply({ content: 'Nenhum campo preenchido — nada foi registrado.', ephemeral: true });
  }
  if (endereco) ficha.adicionarEndereco(rg, endereco, numero);
  if (telefone) ficha.adicionarTelefone(rg, telefone, numero);
  if (rede) ficha.adicionarRedeSocial(rg, rede, numero);

  const salvos = [endereco && 'endereço', telefone && 'telefone', rede && 'rede social'].filter(Boolean).join(', ');
  return interaction.reply({ content: `Registrado na ficha do RG ${rg}: ${salvos}.`, ephemeral: true });
}

async function vincularClienteDiscord(interaction, numero) {
  const usuarioId = interaction.values[0];
  const peticao = db.buscarPorNumero('peticoes', numero);
  if (!peticao) return interaction.update({ content: 'Petição não encontrada.', components: [] });
  if (!podeMexerNaPeticao(interaction, peticao)) return interaction.reply({ content: RECUSA_MEXER_PETICAO, ephemeral: true });
  if (peticao.discordIdCliente) return interaction.update({ content: 'Essa petição já tem cliente vinculado.', components: [] });
  ficha.vincularDiscordId(peticao.rgCliente, usuarioId, `Petição ${numero}`);
  db.atualizar('peticoes', numero, { discordIdCliente: usuarioId });
  // Frente 7: a petição já foi protocolada por nome+RG na abertura — vincular o Discord é opcional
  // e não re-protocola nada (só passa a permitir apelido/notificações pra essa conta).
  return interaction.update({ content: `✅ Discord do cliente vinculado: <@${usuarioId}> *(opcional — a petição já estava protocolada por nome+RG)*.`, components: [] });
}

// ---- Modais do /painel ----

function abrirModalPorteArma(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar porte de arma, em nome do cliente.', ephemeral: true });
  }
  // Frente 5.4 — formulário só com IDENTIDADE. Declaração de maioridade/residência e relação de
  // ocorrências são conteúdo da petição e vão no PDF anexado (checklist), não em campo de modal.
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:porte-arma').setTitle('Porte de arma — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
  );
  return interaction.showModal(modal);
}

function abrirModalTrocaNome(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar troca de nome, em nome do cliente.', ephemeral: true });
  }
  // Frente 5.4 — formulário só com IDENTIDADE. A justificativa (inclusive na reincidência) vai no
  // PDF; o sistema detecta a 2ª vez sozinho e avisa o julgador, que pode pedir esclarecimento por
  // diligência. Nome pretendido fica (é dado estruturado — vira o nome do cliente se deferido).
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:troca-nome').setTitle('Troca de nome — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome_atual').setLabel('Nome atual do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome_novo').setLabel('Nome pretendido').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
  );
  return interaction.showModal(modal);
}

function abrirModalLimpezaFicha(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar limpeza de ficha, em nome do cliente.', ephemeral: true });
  }
  // Frente 5.4 — formulário só com IDENTIDADE. A justificativa (inclusive na reincidência) vai no
  // PDF; o sistema detecta a 2ª vez sozinho e avisa o julgador, que pode pedir esclarecimento por
  // diligência (fluxo já existente) — sem trava no formulário.
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:limpeza-ficha').setTitle('Limpeza de ficha — dados do cliente');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endereco').setLabel('Endereço do cliente').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
  );
  return interaction.showModal(modal);
}

// Art. 68 — mesma checagem de habilitação (cargo Advogado) já usada pros outros três tipos de
// petição administrativa; não existe um cadastro de habilitação separado pra isso.
function abrirModalAlvaraEvento(interaction) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem protocolar alvará de evento, em nome do organizador (Art. 68).', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('painel:modal:peticao:alvara-evento').setTitle('Alvará de evento — dados do pedido');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do organizador').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do organizador').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('evento').setLabel('Nome/descrição do evento').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('local').setLabel('Local do evento').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pessoas').setLabel('Número estimado de pessoas').setStyle(TextInputStyle.Short).setRequired(true)),
  );
  return interaction.showModal(modal);
}

// ---- Submissão compartilhada SLASH × MODAL (uma função por tipo) ----
// Cada tipo tem UMA função de submissão: o handler /slash e o processador do modal só extraem os
// campos do seu jeito (options.getString vs fields.getTextInputValue) e delegam aqui todo o resto
// (defer → criarPeticao* → grava endereço na ficha → resposta → follow-ups). O comportamento e a
// ordem dos passos são idênticos aos dois fluxos originais.
async function submeterPorteArma(interaction, { rg, nome, endereco }) {
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await criarPeticaoPorteArma({
    guild: interaction.guild, requerenteId: interaction.user.id, rgCliente: rg,
    nomeCliente: nome, enderecoCliente: endereco,
  });
  ficha.adicionarEndereco(rg, endereco, numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, rg, canal);
}

async function submeterTrocaNome(interaction, { rg, nomeAtual, nomeNovo, endereco }) {
  // Frente 5.4 — sem trava de 2ª vez no formulário. A reincidência é detectada pelo sistema
  // (jaTrocouNomeAntes) e vira AVISO forte no card do julgador; a justificativa, se necessária,
  // vem no PDF ou por diligência do juiz.
  const jaTrocou = ficha.jaTrocouNomeAntes(rg);
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await criarPeticaoTrocaNome({
    guild: interaction.guild, requerenteId: interaction.user.id, rgCliente: rg,
    nomeAtual, nomeNovo, enderecoCliente: endereco, jaUsouGratuita: jaTrocou,
  });
  ficha.adicionarEndereco(rg, endereco, numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, rg, canal);
}

async function submeterLimpezaFicha(interaction, { rg, nome, endereco }) {
  // Frente 5.4 — sem trava de 2ª vez no formulário. A reincidência é detectada pelo sistema
  // (jaTeveLimpezaFichaDeferida) e vira AVISO forte no card do julgador; a justificativa, se
  // necessária, vem no PDF ou por diligência do juiz.
  const jaTeveAntes = ficha.jaTeveLimpezaFichaDeferida(rg);
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await criarPeticaoLimpezaFicha({
    guild: interaction.guild, requerenteId: interaction.user.id, rgCliente: rg,
    nomeCliente: nome, enderecoCliente: endereco, jaTeveAntes,
  });
  ficha.adicionarEndereco(rg, endereco, numero);
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, rg, canal);
}

// Alvará NÃO grava o local do evento como endereço pessoal na ficha do organizador — é onde o
// evento acontece, não onde a pessoa mora; o local fica só no registro da própria petição. Por
// isso, ao contrário dos outros três tipos, esta submissão não chama ficha.adicionarEndereco.
async function submeterAlvaraEvento(interaction, { rg, nome, evento, local, numeroPessoas }) {
  await interaction.deferReply({ ephemeral: true });
  const { numero, canal } = await criarPeticaoAlvaraEvento({
    guild: interaction.guild, requerenteId: interaction.user.id, rgCliente: rg,
    nomeCliente: nome, nomeEvento: evento, localEvento: local, numeroPessoas,
  });
  await interaction.editReply({ content: `Petição ${numero} aberta em ${canal}. 📎 Anexe os documentos pedidos direto na conversa.` });
  return enviarFollowUpsCadastro(interaction, numero, rg, canal);
}

async function processarModalAlvaraEvento(interaction) {
  const pessoasTexto = interaction.fields.getTextInputValue('pessoas');
  const numeroPessoas = parseInt(pessoasTexto, 10);
  if (!Number.isFinite(numeroPessoas) || numeroPessoas < 0 || String(numeroPessoas) !== pessoasTexto.trim()) {
    return interaction.reply({ content: `"${pessoasTexto}" não é um número válido de pessoas. Abra a petição de novo e informe só o número (ex: 20).`, ephemeral: true });
  }
  return submeterAlvaraEvento(interaction, {
    rg: interaction.fields.getTextInputValue('rg'),
    nome: interaction.fields.getTextInputValue('nome'),
    evento: interaction.fields.getTextInputValue('evento'),
    local: interaction.fields.getTextInputValue('local'),
    numeroPessoas,
  });
}

function processarModalPorteArma(interaction) {
  return submeterPorteArma(interaction, {
    rg: interaction.fields.getTextInputValue('rg'),
    nome: interaction.fields.getTextInputValue('nome'),
    endereco: interaction.fields.getTextInputValue('endereco'),
  });
}

function processarModalTrocaNome(interaction) {
  return submeterTrocaNome(interaction, {
    rg: interaction.fields.getTextInputValue('rg'),
    nomeAtual: interaction.fields.getTextInputValue('nome_atual'),
    nomeNovo: interaction.fields.getTextInputValue('nome_novo'),
    endereco: interaction.fields.getTextInputValue('endereco'),
  });
}

function processarModalLimpezaFicha(interaction) {
  return submeterLimpezaFicha(interaction, {
    rg: interaction.fields.getTextInputValue('rg'),
    nome: interaction.fields.getTextInputValue('nome'),
    endereco: interaction.fields.getTextInputValue('endereco'),
  });
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

  // Nome civil só passa a valer de fato quando o Juiz defere — vinculado ao RG do cliente,
  // não ao ID de quem protocolou (o Advogado), já que é o cliente quem muda de nome.
  let apelidoAlterado = null;
  let trocaNomeSemVinculo = false;
  if (status === 'Deferido' && peticao.tipo === 'TrocaNome' && peticao.rgCliente) {
    ficha.registrarTrocaNome(peticao.rgCliente, peticao.nomeNovo);

    // O vínculo do Discord do cliente é OPCIONAL (Frente 7) — `decidir` não o exige mais. Sem ele
    // o nome civil é retificado no registro, mas não há conta pra aplicar o apelido no servidor:
    // avisa explicitamente em vez de pular em silêncio.
    if (peticao.discordIdCliente) {
      const membro = await guild.members.fetch(peticao.discordIdCliente).catch(() => null);
      if (membro) {
        apelidoAlterado = await membro.setNickname(peticao.nomeNovo.slice(0, 32)).then(() => true).catch(() => false);
      }
    } else {
      trocaNomeSemVinculo = true;
    }
  }

  const canal = await guild.channels.fetch(peticao.canalId).catch(() => null);
  if (canal) {
    if (status === 'Diligência') {
      // Diligência agora é uma intimação formal de verdade — o Juiz aponta exatamente o que
      // falta, e o texto já deixa claro o prazo e a consequência (indeferimento automático em
      // 24h, ver utils/prazos.js), em vez de um embed genérico "está incompleto".
      // Assinatura = quem decidiu (executorId, quem clicou); em decisão automática (sem clique) cai no Juiz da petição.
      const [nomeRequerente, nomeAssinante] = await Promise.all([
        documentoPng.nomeExibicao(guild, peticao.requerenteId),
        documentoPng.nomeExibicao(guild, executorId || peticao.juiz),
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
        nomeAssinante,
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
        content: `<@${peticao.requerenteId}> — clique em **"📎 Anexar petição/documento"** abaixo pra juntar o que o Juiz pediu; depois avise <@${peticao.juiz}> pra decidir de novo.`,
        components: [new ActionRowBuilder().addComponents(botaoAnexarDocumentoPeticao(numero)), botoesDecisao(numero)],
      });
    } else {
      // Deferido/Indeferido: mesma sentença formal e padrão pros três tipos de petição.
      // Assinatura = quem decidiu (executorId, quem clicou); decisão automática cai no Juiz da petição.
      const nomeAssinante = await documentoPng.nomeExibicao(guild, executorId || peticao.juiz);
      const pngSentencaPeticao = await documentoPng.gerarDocumentoPNG({
        orgaoEmissor: 'judiciario',
        subunidade: 'Comarca de São Paulo — Vara Única',
        tituloDocumento: `SENTENÇA — ${TIPO_LABEL[peticao.tipo]}`,
        numeroProcesso: numero,
        dataEmissao: documentos.dataExtenso(),
        destinatario: peticao.nomeCliente || peticao.nomeNovo || 'Requerente',
        corpoTexto: `Resultado: ${status}\n\n${extras.motivo || '—'}`,
        nomeAssinante,
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
      if (trocaNomeSemVinculo) extrasLinhas.push(`ℹ️ Nome civil retificado nos registros, mas o cliente **não tem conta de Discord vinculada** a esta petição — o apelido no servidor **não será alterado** automaticamente. Vincule o Discord do cliente (ou ajuste o apelido à mão) se for o caso.`);
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
  // Frente 7: o Discord do cliente NÃO é mais exigido pra decidir — identidade = nome + RG, e o
  // cruzamento de antecedentes já funciona por RG. Vincular Discord é opcional.

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
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
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
      .addStringOption(o => o.setName('rg').setDescription('RG do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome').setDescription('Nome completo do cliente').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true)))
    .addSubcommand(sub => sub.setName('troca-nome').setDescription('Advogado protocola troca de nome do cliente (anexe a certidão depois, no canal)')
      .addStringOption(o => o.setName('rg').setDescription('RG do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome_atual').setDescription('Nome completo atual do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome_novo').setDescription('Nome completo pretendido').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true)))
    .addSubcommand(sub => sub.setName('limpeza-ficha').setDescription('Advogado protocola limpeza de ficha do cliente (anexe os documentos depois, no canal)')
      .addStringOption(o => o.setName('rg').setDescription('RG do cliente').setRequired(true))
      .addStringOption(o => o.setName('nome').setDescription('Nome completo do cliente').setRequired(true))
      .addStringOption(o => o.setName('endereco').setDescription('Endereço do cliente').setRequired(true)))
    .addSubcommand(sub => sub.setName('alvara-evento').setDescription('Advogado protocola alvará de evento em nome do organizador (Art. 68, Decreto 003/2026)')
      .addStringOption(o => o.setName('rg').setDescription('RG do organizador').setRequired(true))
      .addStringOption(o => o.setName('nome').setDescription('Nome completo do organizador').setRequired(true))
      .addStringOption(o => o.setName('evento').setDescription('Nome/descrição do evento').setRequired(true))
      .addStringOption(o => o.setName('local').setDescription('Local do evento').setRequired(true))
      .addIntegerOption(o => o.setName('pessoas').setDescription('Número estimado de pessoas no evento').setRequired(true).setMinValue(0))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!temCargo(interaction, 'Advogado')) {
      return interaction.reply({ content: 'Só Advogados podem protocolar petições administrativas, em nome do cliente.', ephemeral: true });
    }

    if (sub === 'porte-arma') {
      return submeterPorteArma(interaction, {
        rg: interaction.options.getString('rg'),
        nome: interaction.options.getString('nome'),
        endereco: interaction.options.getString('endereco'),
      });
    }

    if (sub === 'troca-nome') {
      return submeterTrocaNome(interaction, {
        rg: interaction.options.getString('rg'),
        nomeAtual: interaction.options.getString('nome_atual'),
        nomeNovo: interaction.options.getString('nome_novo'),
        endereco: interaction.options.getString('endereco'),
      });
    }

    if (sub === 'limpeza-ficha') {
      return submeterLimpezaFicha(interaction, {
        rg: interaction.options.getString('rg'),
        nome: interaction.options.getString('nome'),
        endereco: interaction.options.getString('endereco'),
      });
    }

    if (sub === 'alvara-evento') {
      return submeterAlvaraEvento(interaction, {
        rg: interaction.options.getString('rg'),
        nome: interaction.options.getString('nome'),
        evento: interaction.options.getString('evento'),
        local: interaction.options.getString('local'),
        numeroPessoas: interaction.options.getInteger('pessoas'),
      });
    }
  },

  abrirModalPorteArma, abrirModalTrocaNome, abrirModalLimpezaFicha, abrirModalAlvaraEvento,
  processarModalPorteArma, processarModalTrocaNome, processarModalLimpezaFicha, processarModalAlvaraEvento,
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
  botaoReabrirCaso, reabrirCaso,
  // Exportadas pro simulador de demo (scripts/simuladorDemo.js) criar petições sem passar pelo modal.
  criarPeticaoPorteArma, criarPeticaoTrocaNome, criarPeticaoLimpezaFicha, criarPeticaoAlvaraEvento,
};
