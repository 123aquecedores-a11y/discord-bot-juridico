const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const { temCargo, isAdmin, isSuperStaff } = require('../utils/permissoes');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const config = require('../config');
const crimes = require('../data/crimes.json');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const { historicoDoProcesso } = require('../utils/historico');
const documentoPng = require('../services/gerarDocumentoPNG');
const devolutivaPoliciaCivil = require('../utils/devolutivaPoliciaCivil');
const dossie = require('../utils/dossie');
const { aguardarAnexoPDF } = require('../utils/anexoPdf');
const anexos = require('../utils/anexos');
const mandadoCmd = require('./mandado');
const medidaCmd = require('./medida');
const dossieJulgamento = require('../utils/dossieJulgamento');
const partesProcesso = require('../utils/partesProcesso');
const andamentos = require('../utils/andamentos');

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
  if (p.atoMpVinculado) embed.addFields({ name: 'Ato do MP de origem', value: p.atoMpVinculado, inline: true });
  if (p.prazoContestacaoAte) {
    const ts = Math.floor(new Date(p.prazoContestacaoAte).getTime() / 1000);
    embed.addFields({ name: 'Prazo de contestação', value: p.status === 'Aguardando contestação' ? `até <t:${ts}:D>` : `venceu <t:${ts}:D>`, inline: true });
  }
  if (p.revelia) embed.addFields({ name: 'Revelia', value: 'Decretada', inline: true });
  if (p.resultado) embed.addFields({ name: 'Resultado', value: p.resultado, inline: true });
  if (p.pena) embed.addFields({ name: 'Pena', value: p.pena, inline: true });
  if (p.regime) embed.addFields({ name: 'Regime inicial', value: p.regime, inline: true });
  if (p.sentenca) embed.addFields({ name: 'Sentença', value: truncar(p.sentenca) });
  if (p.apelacaoNumero) embed.addFields({ name: 'Recurso', value: p.apelacaoNumero, inline: true });

  return embed;
}

function botoesDenuncia(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`processo:oferecer:${numero}`).setLabel('Oferecer denúncia').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`processo:arquivar:${numero}`).setLabel('Arquivar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Identificar réu').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:historicoclique:${numero}`).setLabel('📜 Histórico (autos)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:processo:anexarrelatorio:${numero}`).setLabel('📎 Anexar relatório de inquérito').setStyle(ButtonStyle.Secondary),
  );
}

// Parecer do MP (spec-atualizacoes-bot-juridico.md, seção 1) — mesmo campo único serve pra
// Oferecer denúncia ou Arquivar, só muda o título e o que acontece depois da confirmação.
function modalParecerMp(numero, acao) {
  const titulo = acao === 'oferecer' ? 'Parecer do MP — Oferecer denúncia' : 'Parecer do MP — Arquivamento';
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:parecermp:${numero}#${acao}`).setTitle(titulo.slice(0, 45));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('parecer').setLabel('Parecer do Ministério Público').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
  ));
  return modal;
}

async function confirmarParecerMp(interaction, chave) {
  const [numero, acao] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
  }

  const parecer = interaction.fields.getTextInputValue('parecer');
  const nomeReu = processo.reuNome || (
    (processo.reus || []).length
      ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(interaction.guild, id)))).join(' e ')
      : 'o(a) indiciado(a)'
  );
  const crimeDescricao = (processo.crimes || []).map(c => `${c.nome} (art. ${c.artigo})`).join(', ') || 'crime não especificado';
  const nomePromotor = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const tituloParecer = acao === 'oferecer' ? 'PARECER DO MINISTÉRIO PÚBLICO — OFERECIMENTO DE DENÚNCIA' : 'PARECER DO MINISTÉRIO PÚBLICO — ARQUIVAMENTO';

  // PDF do parecer — mesmo pipeline Puppeteer dos outros documentos (seção 1, passo 6).
  const pngParecer = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: acao === 'oferecer' ? 'parecer_mp_denuncia' : 'parecer_mp_arquivamento',
    orgaoEmissor: 'ministerio_publico', subunidade: '1ª Promotoria de Justiça Criminal',
    tituloDocumento: tituloParecer, numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: 'Autos', corpoTexto: parecer, nomeReu, crimeDescricao,
    nomeAssinante: nomePromotor, cargoAssinante: 'Promotor de Justiça',
  }).catch(err => { console.error('Falha ao gerar PNG do parecer do MP:', err.message); return null; });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  let mensagemParecer = null;
  if (canal) {
    mensagemParecer = await canal.send({
      content: documentos.textoDespacho({ numero, tipo: processo.tipo, titulo: tituloParecer, texto: parecer, autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça' }),
      ...(pngParecer ? { files: [{ attachment: pngParecer, name: `Parecer-MP-${numero}.png` }] } : {}),
    });
  }
  // Parecer vai pros autos como documento vinculado, igual qualquer outro anexo (seção 1, passo 6).
  const urlParecer = mensagemParecer?.attachments?.first()?.url;
  if (urlParecer) {
    anexos.criarDocumento({ tipo: 'parecer_mp', url: urlParecer, nomeArquivo: `Parecer-MP-${numero}.png`, autorId: interaction.user.id, atoOrigemId: numero, protocoloVinculado: numero });
  }

  if (interaction.message) {
    await interaction.message.edit({ embeds: [embedProcesso(processo)], components: [] }).catch(() => {});
  }

  if (acao === 'oferecer') {
    // Exclui também o(s) réu(s) já identificado(s) — sem isso, nada impedia sortear como Juiz
    // a mesma conta que é ré no próprio processo que estaria julgando.
    const excluir = [processo.delegado, processo.promotor, ...(processo.reus || [])];
    const juizId = rh.sortearJuiz({ excluirIds: excluir });
    if (!juizId) {
      return interaction.reply({ content: `Parecer registrado no processo ${numero}, mas não há Juiz ativo disponível para sorteio — a denúncia fica pendente até haver um.`, ephemeral: true });
    }

    db.atualizar('processos', numero, { status: 'Instrução', juiz: juizId, juizDesde: new Date().toISOString() });
    if (canal) {
      await canais.adicionarMembro(canal, juizId);
      const reusTxt = (processo.reus || []).map(id => `<@${id}>`).join(', ') || 'réu(s) a identificar';
      const msgPainel = await canal.send({
        content: documentos.textoDespacho({
          numero, tipo: processo.tipo, titulo: 'DESPACHO DE RECEBIMENTO DA DENÚNCIA',
          texto: `Recebo a denúncia oferecida pelo Ministério Público em desfavor de ${reusTxt}. Distribuído por sorteio a <@${juizId}>. Cite-se o(s) réu(s) para instrução e julgamento.`,
          autorId: interaction.user.id, cargoAutor: 'Promotor de Justiça',
        }),
        components: montarPainelAcoes(db.buscarPorNumero('processos', numero)),
      });
      db.atualizar('processos', numero, { painelMsgId: msgPainel.id });
    }

    await auditoria.registrar(interaction.guild, { acao: 'Denúncia oferecida', executorId: interaction.user.id, referencia: `Processo ${numero} → Juiz <@${juizId}>` });
    await postarOuAtualizarDiario(interaction.guild, numero);
    return interaction.reply({ content: `Denúncia oferecida no processo ${numero}. Juiz sorteado: <@${juizId}>.`, ephemeral: true });
  }

  db.atualizar('processos', numero, { status: 'Arquivado' });
  if (canal) {
    await canais.arquivarCanal(canal);
    await canal.send({ content: `<@${processo.delegado}>`, components: [botaoPedirRevisao(numero)] });
  }
  await auditoria.registrar(interaction.guild, { acao: 'Processo arquivado (MP)', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  return interaction.reply({ content: `Processo ${numero} arquivado.`, ephemeral: true });
}

// Botões liberados assim que o processo tem Juiz sorteado (civil desde a abertura, penal
// desde a denúncia oferecida). Habilitação de advogado agora passa pelo Diário Oficial,
// não por um botão de autoatendimento aqui.
// Retorna DUAS linhas (a primeira já estava cheia, 5/5 — limite do Discord por ActionRow) —
// quem chama precisa espalhar o array em vez de embrulhar num array só, ver call sites.
function botoesJuiz(numero) {
  const linhas = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`processo:julgar:${numero}`).setLabel('Julgar').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`painel:acao:processo:gerenciardefesa:${numero}`).setLabel('Gerenciar defesa').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Adicionar parte tardia').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`painel:acao:processo:intimar:${numero}`).setLabel('Emitir intimação').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`painel:acao:processo:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:processo:historicoclique:${numero}`).setLabel('📜 Histórico (autos)').setStyle(ButtonStyle.Secondary),
    ),
  ];

  // Mandado/medida coercitiva só fazem sentido em processo penal (painel-contexto-e-tipo-mandado.md,
  // seção 3) — civil não tem Delegado nem essas figuras. botoesJuiz é usado nos dois tipos, então
  // decide aqui olhando o processo de verdade em vez de espalhar esse "if" em cada call site.
  const processo = db.buscarPorNumero('processos', numero);
  if (processo?.tipo === 'Penal') {
    const linha3 = new ActionRowBuilder().addComponents(mandadoCmd.botaoEmitirMandado(numero));
    if (processo.promotor) linha3.addComponents(medidaCmd.botaoSolicitarMedidaDireta(numero));
    linha3.addComponents(botaoRegistrarDepoimento(numero));
    linhas.push(linha3);
  }

  return linhas;
}

// ---- Catálogo central de ações do painel (spec-andamentos-processuais_4.md, seção 8.6) ----
// Cada ação do painel é declarada UMA VEZ aqui: quando aparece (tipo/status do processo) e
// quem executa (cargo — a checagem de verdade continua no clique, via temCargo/isSuperStaff;
// isso aqui só documenta e decide se o botão nasce visível). Ação nova que se aplique a
// qualquer processo (ex: "Solicitar documento externo") entra uma vez só e já aparece em todo
// lugar onde a condição bater — não precisa lembrar de adicionar em cada painel hardcoded.
const STATUS_TERMINAIS_PAINEL = ['Encerrado', 'Arquivado'];
const faseDenunciaMp = (p) => p.tipo === 'Penal' && !p.juiz;
const faseComJuiz = (p) => !!p.juiz;

const CATALOGO_ACOES = [
  // ---- Fase Delegado/Promotor (Penal, sem Juiz ainda) ----
  {
    id: 'oferecer_denuncia', grupo: 1, cargo: ['Promotor'],
    quando: faseDenunciaMp,
    botao: (numero) => new ButtonBuilder().setCustomId(`processo:oferecer:${numero}`).setLabel('Oferecer denúncia').setStyle(ButtonStyle.Success),
  },
  {
    id: 'arquivar_mp', grupo: 1, cargo: ['Promotor'],
    quando: faseDenunciaMp,
    botao: (numero) => new ButtonBuilder().setCustomId(`processo:arquivar:${numero}`).setLabel('Arquivar').setStyle(ButtonStyle.Danger),
  },
  {
    id: 'identificar_reu', grupo: 1, cargo: ['Delegado'],
    quando: faseDenunciaMp,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Identificar réu').setStyle(ButtonStyle.Secondary),
  },
  {
    id: 'anexar_relatorio', grupo: 1, cargo: ['Delegado'],
    quando: faseDenunciaMp,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:anexarrelatorio:${numero}`).setLabel('📎 Anexar relatório de inquérito').setStyle(ButtonStyle.Secondary),
  },

  // ---- Fase com Juiz (Penal em instrução, ou Civil desde a abertura) ----
  {
    id: 'julgar', grupo: 1, cargo: ['Juiz'],
    quando: faseComJuiz,
    botao: (numero) => new ButtonBuilder().setCustomId(`processo:julgar:${numero}`).setLabel('Julgar').setStyle(ButtonStyle.Primary),
  },
  {
    id: 'gerenciar_defesa', grupo: 1, cargo: ['Juiz'],
    quando: faseComJuiz,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:gerenciardefesa:${numero}`).setLabel('Gerenciar defesa').setStyle(ButtonStyle.Secondary),
  },
  {
    id: 'parte_tardia', grupo: 1, cargo: ['Juiz'],
    quando: faseComJuiz,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:partetardia:${numero}`).setLabel('Adicionar parte tardia').setStyle(ButtonStyle.Secondary),
  },
  {
    id: 'emitir_intimacao', grupo: 1, cargo: ['Juiz'],
    quando: faseComJuiz,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:intimar:${numero}`).setLabel('Emitir intimação').setStyle(ButtonStyle.Primary),
  },
  {
    id: 'arquivar_manual', grupo: 1, cargo: ['Juiz'],
    quando: faseComJuiz,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  },

  // ---- Disponível em qualquer fase não-terminal (o gate de status já é aplicado antes) ----
  {
    id: 'historico', grupo: 2, cargo: ['qualquer'],
    quando: () => true,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:historicoclique:${numero}`).setLabel('📜 Histórico (autos)').setStyle(ButtonStyle.Secondary),
  },

  // ---- Só Penal com Juiz — mandado/medida coercitiva/depoimento não existem no civil ----
  {
    id: 'emitir_mandado', grupo: 3, cargo: ['Juiz'],
    quando: (p) => faseComJuiz(p) && p.tipo === 'Penal',
    botao: (numero) => mandadoCmd.botaoEmitirMandado(numero),
  },
  {
    id: 'solicitar_medida', grupo: 3, cargo: ['Promotor'],
    quando: (p) => faseComJuiz(p) && p.tipo === 'Penal' && !!p.promotor,
    botao: (numero) => medidaCmd.botaoSolicitarMedidaDireta(numero),
  },
  {
    id: 'registrar_depoimento', grupo: 3, cargo: ['Juiz', 'Promotor', 'Delegado'],
    quando: (p) => faseComJuiz(p) && p.tipo === 'Penal',
    botao: (numero) => botaoRegistrarDepoimento(numero),
  },

  // ---- Disponível em qualquer fase não-terminal, qualquer tipo (spec-andamentos-processuais_4.md,
  // seção 8.5) — antes só existia dentro da petição de limpeza de ficha; agora é ação de
  // qualquer processo, junto de Histórico. Handler mora em painel.js (mesmo lugar do resto da
  // lógica de instituição/ofício).
  {
    id: 'solicitar_documento_externo', grupo: 2, cargo: ['qualquer'],
    quando: () => true,
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:solicitardocumento:${numero}`).setLabel('📨 Solicitar documento externo').setStyle(ButtonStyle.Secondary),
  },
  // Advogado peticiona "a qualquer momento" (seção 8.8) — qualquer fase não-terminal, os dois
  // tipos de processo (a checagem de cargo de verdade acontece no clique, isso aqui só decide
  // se o botão nasce visível).
  {
    id: 'peticionar', grupo: 2, cargo: ['Advogado'],
    quando: () => true,
    botao: (numero) => botaoPeticionar(numero),
  },
];

// Monta o painel de ações a partir do catálogo acima, filtrando pelo tipo/status do processo e
// empacotando por `grupo` em ActionRows (máx. 5 botões por linha, limite do Discord). Substitui
// botoesJuiz/botoesDenuncia como fonte da verdade — as duas funções continuam existindo por
// compatibilidade com quem já as chama direto, mas passam a ser espelho deste catálogo.
function montarPainelAcoes(processo) {
  if (STATUS_TERMINAIS_PAINEL.includes(processo.status)) return [];
  if (!faseDenunciaMp(processo) && !faseComJuiz(processo)) return []; // civil sem juiz ainda (raro)

  const aplicaveis = CATALOGO_ACOES.filter(a => a.quando(processo));
  const porGrupo = new Map();
  for (const acao of aplicaveis) {
    if (!porGrupo.has(acao.grupo)) porGrupo.set(acao.grupo, []);
    porGrupo.get(acao.grupo).push(acao.botao(processo.numero));
  }

  const linhas = [];
  for (const botoesDoGrupo of porGrupo.values()) {
    for (let i = 0; i < botoesDoGrupo.length; i += 5) {
      linhas.push(new ActionRowBuilder().addComponents(botoesDoGrupo.slice(i, i + 5)));
    }
  }
  return linhas;
}

// Painel geral de ações do processo (Autos Digitais, seção 6) — a MESMA combinação embed+botões
// que já seria enviada em qualquer ponto de distribuição/denúncia, só que recomposta sob demanda.
// Não modela nenhum estado novo: lê do catálogo acima, na hora que for chamada.
function painelAtual(processo) {
  const componentes = montarPainelAcoes(processo);
  if (componentes.length === 0) return null;
  return { embeds: [embedProcesso(processo)], components: componentes };
}

// Reposta o painel geral no fim do canal e limpa os componentes da cópia anterior, pra ele nunca
// ficar enterrado abaixo de um andamento novo. Chamado pelos handlers logo depois de postarem a
// narrativa do andamento no canal DO PROCESSO — não serve pra mensagens postadas em outro canal
// (ex.: ticket de ofício, canal de uma medida ainda sem processo vinculado).
async function repostarPainel(guild, processoOuNumero) {
  const processo = typeof processoOuNumero === 'string' ? db.buscarPorNumero('processos', processoOuNumero) : processoOuNumero;
  if (!processo) return;
  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (!canal) return;

  if (processo.painelMsgId) {
    const antiga = await canal.messages.fetch(processo.painelMsgId).catch(() => null);
    if (antiga) await antiga.edit({ components: [] }).catch(() => {});
  }

  const painel = painelAtual(processo);
  if (!painel) {
    db.atualizar('processos', processo.numero, { painelMsgId: null });
    return;
  }

  const nova = await canal.send(painel).catch(() => null);
  db.atualizar('processos', processo.numero, { painelMsgId: nova?.id || null });
}

// ---- Depoimento de testemunha (spec-atualizacoes-bot-juridico.md, seção 0) ----
// Juiz, Promotor ou Delegado — qualquer um dos três pode colher, sem exclusividade. Testemunha
// só existe depois de entrar em processo.partes (abertura não traz testemunha, só "Adicionar
// parte tardia" traz — ver utils/partesProcesso.js).

function botaoRegistrarDepoimento(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:regdepoimento:${numero}`).setLabel('🗣️ Registrar depoimento').setStyle(ButtonStyle.Secondary);
}

function podeColherDepoimento(interaction, processo) {
  return [processo.juiz, processo.promotor, processo.delegado].includes(interaction.user.id) || isSuperStaff(interaction);
}

function papelDeQuemColhe(interaction, processo) {
  if (interaction.user.id === processo.juiz) return 'juiz';
  if (interaction.user.id === processo.promotor) return 'promotor';
  if (interaction.user.id === processo.delegado) return 'delegado';
  return 'staff'; // isSuperStaff clicando sem ocupar nenhum dos três papéis no processo
}

async function abrirSelectTestemunha(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeColherDepoimento(interaction, processo)) {
    return interaction.reply({ content: 'Só o Juiz, o Promotor ou o Delegado deste processo podem registrar depoimento.', ephemeral: true });
  }

  const testemunhas = partesProcesso.listarTestemunhas(processo);
  if (testemunhas.length === 0) {
    return interaction.reply({ content: 'Nenhuma testemunha registrada neste processo ainda — adicione uma via "Adicionar parte tardia".', ephemeral: true });
  }

  const rotuloPapel = { testemunha_acusacao: 'Test. Acusação', testemunha_defesa: 'Test. Defesa' };
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:processo:testemunhadepoimento:${numero}`).setPlaceholder('De qual testemunha?')
      .addOptions(testemunhas.slice(0, 25).map(p => ({ label: `[${rotuloPapel[p.papel] || p.papel}] ${p.nome || 'sem nome'}`.slice(0, 100), value: p.id }))),
  );
  return interaction.reply({ content: 'De qual testemunha é o depoimento?', components: [row], ephemeral: true });
}

async function processarSelecaoTestemunha(interaction, numero) {
  const parteId = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:depoimento:${numero}#${parteId}`).setTitle('Registrar depoimento');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('texto').setLabel('Depoimento').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
  ));
  return interaction.showModal(modal);
}

async function registrarDepoimentoHandler(interaction, chave) {
  const [numero, parteId] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeColherDepoimento(interaction, processo)) {
    return interaction.reply({ content: 'Só o Juiz, o Promotor ou o Delegado deste processo podem registrar depoimento.', ephemeral: true });
  }
  const parte = (processo.partes || []).find(p => p.id === parteId);
  if (!parte) return interaction.reply({ content: 'Essa parte não existe mais no processo.', ephemeral: true });

  const texto = interaction.fields.getTextInputValue('texto');
  partesProcesso.registrarDepoimento(numero, {
    parteId, colhidoPor: interaction.user.id, papelDeQuemColheu: papelDeQuemColhe(interaction, processo), texto,
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canal.send({
      content: `🗣️ Depoimento de **${parte.nome || 'testemunha'}** registrado por <@${interaction.user.id}>:\n${truncar(texto, 1500)}`,
    });
  }

  await auditoria.registrar(interaction.guild, { acao: 'Depoimento registrado', executorId: interaction.user.id, referencia: `Processo ${numero}: ${parte.nome || parteId}` });
  return interaction.reply({ content: 'Depoimento registrado nos autos.', ephemeral: true });
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

// Botão do Advogado do autor pra juntar a petição inicial em PDF aos autos (aguardarAnexoPDF —
// Discord não aceita upload dentro de modal). Some depois de usado uma vez.
function botaoAnexarPeticaoInicial(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:anexarpeticaoinicial:${numero}`).setLabel('📎 Anexar petição inicial').setStyle(ButtonStyle.Primary),
  );
}

// Botão do advogado habilitado pra juntar a contestação em PDF (mesma mecânica). Postado
// quando a habilitação é aprovada (se já houve citação) ou quando a citação acontece (se já
// havia habilitação aprovada) — ver decidirHabilitacao/emitirIntimacao.
function botaoAnexarContestacao(numero, habId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:anexarcontestacao:${numero}#${habId}`).setLabel('📎 Anexar contestação').setStyle(ButtonStyle.Primary),
  );
}

// Só o Juiz vê — decisão de mérito por ausência de contestação continua manual (o job de
// prazos só avisa que venceu, nunca decide sozinho — ver utils/prazos.js).
function botaoDecretarRevelia(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:decretarrevelia:${numero}`).setLabel('⚠️ Decretar revelia').setStyle(ButtonStyle.Danger),
  );
}

async function criarProcessoPenal({ guild, delegadoId, promotorId, crimesTexto, motivo, reusTexto, medidaNumero, atoMpNumero }) {
  const crimesEscolhidos = resolverCrimes(crimesTexto);
  if (crimesEscolhidos.length === 0) return { erro: 'Nenhum crime válido informado. Use os IDs mostrados em `/crime buscar`.' };

  const reus = extrairMencoes(reusTexto);

  let promotorFinal = promotorId;
  if (!promotorFinal) {
    // Se o(s) réu(s) já foi(ram) identificado(s) na abertura, exclui do sorteio — mesmo
    // problema de conflito de interesse corrigido no sorteio de Juiz (ver `oferecer` e
    // `criarProcessoCivil`), só que aqui pro Promotor que vai oferecer a denúncia.
    const promotores = rh.listarPorCargo('Promotor').filter(p => !p.licenca && !reus.includes(p.discordId));
    if (promotores.length === 0) return { erro: 'Não há Promotor ativo. Informe um manualmente.' };
    promotorFinal = promotores[Math.floor(Math.random() * promotores.length)].discordId;
  }

  const numero = proximoNumero(db, 'processos', 'PN', p => p.tipo === 'Penal');

  // delegadoId pode ser nulo: denúncia nascida direto de um ato do MP (Requisição/Inquérito
  // Civil), sem inquérito policial por trás — o Promotor que expediu o ato é quem abre.
  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaProcessosPenaisId, prefixo: 'processo', numero,
    membros: [delegadoId, promotorFinal].filter(Boolean), bloquearConversa: true,
  });

  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Aguardando decisão do MP',
    crimes: crimesEscolhidos, motivo,
    reus, advogados: [], delegado: delegadoId || null, promotor: promotorFinal, juiz: null,
    canalId: canal.id, medidaVinculada: medidaNumero || null, atoMpVinculado: atoMpNumero || null, sentenca: null,
    // Registro unificado de partes (spec-atualizacoes-bot-juridico.md, seção 0) — réu(s) já
    // identificado(s) na abertura nascem espelhados aqui também, sem substituir `reus`.
    partes: partesProcesso.espelharPartesDaAbertura({ reus, adicionadoPor: delegadoId || promotorFinal }),
  });

  // Réu é parte do processo desde que identificado — nunca fica trancado pra fora do canal.
  for (const reuId of reus) await canais.adicionarMembro(canal, reuId);

  const processo = db.buscarPorNumero('processos', numero);
  const mencoes = [delegadoId, promotorFinal].filter(Boolean).map(id => `<@${id}>`).join(' ');
  const msgAbertura = await canal.send({ content: mencoes, embeds: [embedProcesso(processo)], components: [botoesDenuncia(numero)] });
  // A mensagem de abertura JÁ É o painel geral (mesmo conteúdo que painelAtual produziria pra
  // um Penal sem juiz) — grava o id agora pra repostarPainel achar e limpar ela mais tarde, em
  // vez de deixá-la pra trás com botões vivos na primeira vez que algum andamento futuro repostar.
  db.atualizar('processos', numero, { painelMsgId: msgAbertura.id });

  await andamentos.registrar(guild, numero, {
    tipo: 'processo_aberto', titulo: `📁 Processo Penal ${numero} aberto`,
    detalhe: motivo, executorId: delegadoId || promotorFinal,
    metadata: { origem: medidaNumero ? 'medida' : (atoMpNumero ? 'ato_mp' : 'manual') },
  });

  if (medidaNumero) {
    db.atualizar('medidas', medidaNumero, { processoVinculado: numero });
    // Autos do processo já nascem com o histórico completo (medida de origem, Inquérito
    // Policial, mandados) — defesa (quando habilitada), acusação e Juiz enxergam a linhagem
    // completa do caso desde o primeiro dia, não só a partir da denúncia.
    const historico = historicoDoProcesso(numero);
    if (historico) await canal.send({ embeds: [embedHistorico(historico)] });

    // Dossiê do inquérito (Polícia Civil): se essa medida tinha protocolo externo, todo
    // documento e mandado que a Polícia Civil pediu ao longo do inquérito passa a apontar
    // pra este processo — a defesa, quando se habilitar, enxerga a fase de inquérito inteira,
    // não só o que aconteceu depois da denúncia.
    const medidaOrigem = db.buscarPorNumero('medidas', medidaNumero);
    if (medidaOrigem?.codigoExterno) dossie.vincularProcesso(medidaOrigem.codigoExterno, numero);
  }

  await auditoria.registrar(guild, { acao: 'Processo penal aberto', executorId: delegadoId || promotorFinal, referencia: numero });
  return { numero, canal };
}

// Petição inicial em PDF é anexada depois, direto na conversa do canal — não precisa ser
// enviada no momento de abrir (Discord não permite anexo em modal, e pedir no slash command
// tirava a abertura do fluxo por botão). Autor não precisa comprovar identidade: abrir o
// processo já é prova suficiente de autoria.
async function criarProcessoCivil({ guild, advogadoId, nomeAcao, autorNome, autorDiscordId, reuNome, reuDiscordId }) {
  const numero = proximoNumero(db, 'processos', 'CV', p => p.tipo === 'Civil');
  const reus = [reuDiscordId];

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaProcessosCiveisId, prefixo: 'processo', numero,
    membros: [...new Set([advogadoId, autorDiscordId, reuDiscordId])], bloquearConversa: true,
  });

  // Exclui não só o advogado que abriu, mas autor e réu de verdade — nada impede que a mesma
  // conta que joga de Juiz também seja autor/réu numa causa civil pessoal dela.
  const juizId = rh.sortearJuiz({ excluirIds: [advogadoId, autorDiscordId, reuDiscordId] });
  if (juizId) await canais.adicionarMembro(canal, juizId);

  db.inserir('processos', {
    numero, tipo: 'Civil', status: juizId ? 'Aguardando defesa' : 'Aguardando sorteio de juiz',
    crimes: [], motivo: nomeAcao,
    autorNome, autorDiscordId, reuNome,
    reus, advogados: [advogadoId], delegado: null, promotor: null, juiz: juizId,
    juizDesde: juizId ? new Date().toISOString() : null,
    canalId: canal.id, medidaVinculada: null, sentenca: null, autor: advogadoId,
    // Registro unificado de partes (spec-atualizacoes-bot-juridico.md, seção 0) — autor e réu já
    // nascem espelhados aqui também, sem substituir autorNome/reuNome/reus.
    partes: partesProcesso.espelharPartesDaAbertura({ reus, reuNome, autorId: autorDiscordId, autorNome, adicionadoPor: advogadoId }),
  });

  const processo = db.buscarPorNumero('processos', numero);
  const componentes = [botoesCivilAbertura(numero), botaoAnexarPeticaoInicial(numero)];
  if (juizId) componentes.push(...botoesJuiz(numero));
  await canal.send({
    content: `<@${advogadoId}>${juizId ? ` <@${juizId}>` : ''}\n📎 Clique em **"Anexar petição inicial"** abaixo pra juntar o PDF aos autos.`,
    embeds: [embedProcesso(processo)], components: componentes,
  });

  await andamentos.registrar(guild, numero, {
    tipo: 'processo_aberto', titulo: `📁 Processo Civil ${numero} aberto`,
    detalhe: `Autor: ${autorNome} — Réu: ${reuNome}`, executorId: advogadoId, metadata: {},
  });
  // Sem gravar painelMsgId aqui: a mensagem de abertura mistura o painel geral com botões de
  // uso único desta fase ("Anexar petição inicial") — se repostarPainel limpasse os componentes
  // dela mais tarde, apagaria também um botão que ainda pode ser necessário.

  await postarOuAtualizarDiario(guild, numero);
  await auditoria.registrar(guild, { acao: 'Processo civil aberto', executorId: advogadoId, referencia: numero });
  return { numero, canal };
}

// Petição inicial em PDF (seção 3, passo 1 da spec de anexo/vínculo processual) — vira
// `documento` tipo 'peticao_inicial' vinculado ao número do processo.
async function anexarPeticaoInicial(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.autor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Advogado responsável pela autoria pode anexar a petição inicial — no caso, <@${processo.autor}>.`, ephemeral: true });
  }
  if (anexos.listarPorProtocolo(numero).some(d => d.tipo === 'peticao_inicial')) {
    return interaction.reply({ content: 'A petição inicial já foi anexada a este processo.', ephemeral: true });
  }

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return; // aguardarAnexoPDF já avisou o motivo (tempo esgotado ou não é PDF)

  anexos.criarDocumento({
    tipo: 'peticao_inicial', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: numero,
  });

  const componentesRestantes = (interaction.message?.components || []).filter(row =>
    !(row.components || []).some(c => c.customId === `painel:acao:processo:anexarpeticaoinicial:${numero}`),
  );
  if (interaction.message) await interaction.message.edit({ components: componentesRestantes }).catch(() => {});

  await interaction.followUp({ content: `📎 Petição inicial anexada por <@${interaction.user.id}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos.` });
  await auditoria.registrar(interaction.guild, { acao: 'Petição inicial anexada', executorId: interaction.user.id, referencia: numero });
}

// Relatório de inquérito (spec-atualizacoes-bot-juridico.md, seção 1) — fallback manual pro
// Delegado anexar quando o webhook encerramento_inquerito não veio com relatorio_pdf_url (ou
// quando o processo nem veio de webhook nenhum, foi aberto manualmente mesmo). Diferente de
// anexarPeticaoInicial, esse botão convive na MESMA linha que Oferecer/Arquivar — remove só o
// próprio botão da linha ao usar, não a linha inteira.
async function anexarRelatorioInquerito(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.delegado && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Delegado responsável por este inquérito pode anexar o relatório — no caso, <@${processo.delegado}>.`, ephemeral: true });
  }
  if (anexos.listarPorProtocolo(numero).some(d => d.tipo === 'relatorio_inquerito')) {
    return interaction.reply({ content: 'O relatório de inquérito já foi anexado a este processo.', ephemeral: true });
  }

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  anexos.criarDocumento({
    tipo: 'relatorio_inquerito', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: numero,
  });

  const linhasAtualizadas = (interaction.message?.components || []).map(row => {
    const mantidos = (row.components || []).filter(c => c.customId !== `painel:acao:processo:anexarrelatorio:${numero}`);
    return mantidos.length ? new ActionRowBuilder().addComponents(...mantidos) : null;
  }).filter(Boolean);
  if (interaction.message) await interaction.message.edit({ components: linhasAtualizadas }).catch(() => {});

  await interaction.followUp({ content: `📎 Relatório de inquérito anexado por <@${interaction.user.id}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos.` });
  await auditoria.registrar(interaction.guild, { acao: 'Relatório de inquérito anexado', executorId: interaction.user.id, referencia: numero });
}

// Contestação em PDF (seção 3, passo 5) — só o advogado com habilitação Aprovada pra esse réu.
// Ao anexar, o processo fica Concluso para julgamento (passo 6).
async function anexarContestacao(interaction, chave) {
  const [numero, idTexto] = chave.split('#');
  const habId = Number(idTexto);
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const habilitacao = (processo.habilitacoes || []).find(h => h.id === habId);
  if (!habilitacao || habilitacao.status !== 'Aprovado') {
    return interaction.reply({ content: 'Essa habilitação não existe mais ou não está aprovada.', ephemeral: true });
  }
  if (interaction.user.id !== habilitacao.advogadoId && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só <@${habilitacao.advogadoId}>, advogado(a) habilitado(a) para esta defesa, pode anexar a contestação.`, ephemeral: true });
  }
  if (processo.status !== 'Aguardando contestação') {
    return interaction.reply({ content: `Este processo não está aguardando contestação no momento (status atual: "${processo.status}").`, ephemeral: true });
  }

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  anexos.criarDocumento({
    tipo: 'contestacao', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: numero, protocoloVinculado: numero,
  });
  db.atualizar('processos', numero, { status: 'Concluso para julgamento', contestacaoEm: new Date().toISOString() });

  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const processoAtualizado = db.buscarPorNumero('processos', numero);
  await interaction.followUp({
    content: `📎 Contestação anexada por <@${interaction.user.id}> em nome de <@${habilitacao.reuId}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos. Processo concluso para julgamento.`,
    embeds: [embedProcesso(processoAtualizado)],
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    if (processo.juiz) await canal.send({ content: `<@${processo.juiz}> — contestação anexada, processo concluso para julgamento.` });
    // Dossiê de conclusão (dossie-conclusao-reabertura.md) — compila autor/réus/documentos dos
    // autos num cartão único, com o botão de Julgar já ali, sem o Juiz ter que garimpar o canal.
    await dossieJulgamento.postarDossie(canal, processoAtualizado, anexos.listarPorProtocolo(numero));
  }

  await auditoria.registrar(interaction.guild, { acao: 'Contestação anexada', executorId: interaction.user.id, referencia: numero });
}

// Revelia continua decisão do Juiz (o job de prazos em utils/prazos.js só avisa quando o
// prazo vence, nunca decide sozinho). Só pode ser decretada depois que o prazo realmente
// venceu — antes disso a defesa ainda está no prazo legal pra contestar.
async function decretarRevelia(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decretar revelia — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.status !== 'Aguardando contestação') {
    return interaction.reply({ content: `Revelia só pode ser decretada enquanto o processo aguarda contestação (status atual: "${processo.status}").`, ephemeral: true });
  }
  if (processo.prazoContestacaoAte && Date.now() < new Date(processo.prazoContestacaoAte).getTime()) {
    const ts = Math.floor(new Date(processo.prazoContestacaoAte).getTime() / 1000);
    return interaction.reply({ content: `O prazo de contestação ainda não venceu — termina <t:${ts}:F>. Revelia só pode ser decretada após o decurso do prazo.`, ephemeral: true });
  }

  db.atualizar('processos', numero, { status: 'Concluso para julgamento', revelia: true });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const processoAtualizado = db.buscarPorNumero('processos', numero);
  const reusTxt = (processo.reus || []).map(id => `<@${id}>`).join(', ') || 'o(a) réu(ré)';
  await interaction.followUp({
    content: documentos.textoDespacho({
      numero, tipo: 'Civil', titulo: 'DECRETO DE REVELIA',
      texto: `Decorrido o prazo de contestação sem manifestação de ${reusTxt}, decreto a revelia, nos termos do art. 344 do Código de Processo Civil. Processo concluso para julgamento.`,
      autorId: interaction.user.id, cargoAutor: 'Juiz de Direito',
    }),
    embeds: [embedProcesso(processoAtualizado)],
  });

  const canalRevelia = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canalRevelia) await dossieJulgamento.postarDossie(canalRevelia, processoAtualizado, anexos.listarPorProtocolo(numero));

  await auditoria.registrar(interaction.guild, { acao: 'Revelia decretada', executorId: interaction.user.id, referencia: numero });
}

// ---- Reabertura de instrução (dossie-conclusao-reabertura.md, seção 4) — só existe depois de
// uma anulação (o botão só é postado quando postarDossie recebe `acordao`). Ciclo instrução ->
// dossiê -> julgar ou pedir mais prova -> instrução de novo, quantas vezes o Juiz precisar.

function botaoConcluirInstrucao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:concluirinstrucao:${numero}`).setLabel('Concluir instrução novamente').setStyle(ButtonStyle.Success),
  );
}

async function requererNovasProvas(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode requerer novas provas — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.status !== 'Concluso para julgamento') {
    return interaction.reply({ content: `Este processo não está concluso para julgamento no momento (status atual: "${processo.status}").`, ephemeral: true });
  }

  db.atualizar('processos', numero, { status: 'Em instrução' });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    // "Emitir intimação" e "Ofício" já ficam liberados de novo por conta própria — não são
    // exclusivos de nenhum status específico, sempre estiveram disponíveis pro Juiz/Promotor.
    await canal.send({
      content: `<@${interaction.user.id}> reabriu a instrução — o processo volta a aceitar intimação e ofício à vontade. Quando estiver pronto, clique em **"Concluir instrução novamente"**.`,
      components: [botaoConcluirInstrucao(numero)],
    });
  }

  await auditoria.registrar(interaction.guild, { acao: 'Instrução reaberta (novas provas requeridas)', executorId: interaction.user.id, referencia: numero });
  return interaction.reply({ content: `Processo ${numero} voltou pra instrução.`, ephemeral: true });
}

async function concluirInstrucaoNovamente(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode concluir a instrução — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.status !== 'Em instrução') {
    return interaction.reply({ content: `Este processo não está em instrução no momento (status atual: "${processo.status}").`, ephemeral: true });
  }

  db.atualizar('processos', numero, { status: 'Concluso para julgamento' });
  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  const processoAtualizado = db.buscarPorNumero('processos', numero);
  // Sem acordao — essa rodada não veio de anulação, é o próprio Juiz decidindo que já tem o
  // suficiente (dossie-conclusao-reabertura.md, seção 4).
  if (canal) await dossieJulgamento.postarDossie(canal, processoAtualizado, anexos.listarPorProtocolo(numero));

  await auditoria.registrar(interaction.guild, { acao: 'Instrução concluída novamente', executorId: interaction.user.id, referencia: numero });
  return interaction.reply({ content: `Processo ${numero} concluso para julgamento novamente.`, ephemeral: true });
}

// Penal só vira público depois que a denúncia é oferecida (sai da fase de inquérito).
// Civil já nasce público, porque autor e juiz já existem desde a abertura.
function processoPublico(p) {
  if (p.tipo === 'Civil') return true;
  return p.status !== 'Aguardando decisão do MP';
}

function temAcessoTotal(interaction, processo) {
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
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

// "Autos do processo" — histórico completo em ordem cronológica: a medida de origem (com o
// Inquérito Policial, se veio da Polícia Civil), mandados, ofícios do MP, habilitações, sentença,
// apelação. Mesmo controle de acesso de verProcesso (só quem é parte do caso ou tem defesa
// habilitada vê o teor completo) — não é informação pública.
function embedHistorico({ processo, eventos }) {
  const embed = new EmbedBuilder()
    .setTitle(`📜 Autos do processo ${processo.numero} — histórico completo`)
    .setColor(0x34495e);

  if (eventos.length === 0) {
    embed.setDescription('Nenhum evento registrado além da abertura do processo.');
    return embed;
  }

  const linhas = eventos.map(e => `**${e.titulo}**${e.dataFormatada ? ` — ${e.dataFormatada}` : ''}\n${truncar(e.detalhe, 300)}`);
  embed.setDescription(truncar(linhas.join('\n\n'), 4000));
  if (linhas.join('\n\n').length > 4000) {
    embed.setFooter({ text: 'Histórico truncado — use os números individuais (medida/mandado/ofício) pra ver o teor completo de cada item.' });
  }
  return embed;
}

async function verHistoricoProcesso(interaction, numero) {
  const resultado = historicoDoProcesso(numero);
  if (!resultado) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!temAcessoTotal(interaction, resultado.processo)) {
    return interaction.reply({ content: 'Só as partes deste processo (delegado, promotor, juiz, autor ou defesa habilitada) podem ver o histórico completo.', ephemeral: true });
  }
  return interaction.reply({ embeds: [embedHistorico(resultado)], ephemeral: true });
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
    await andamentos.registrar(guild, numero, {
      tipo: 'parte_tardia_reu', titulo: '🧑‍⚖️ Réu adicionado ao processo',
      detalhe: `${novos.map(id => `<@${id}>`).join(', ')} adicionado(s) como réu por <@${executorId}>.`,
      executorId, metadata: { discordIds: novos },
    });
    await repostarPainel(guild, numero);
  }
  return { numero };
}

// Papel da parte (spec-atualizacoes-bot-juridico.md, seção 2) — substitui o antigo modal único
// de "@menções separadas por vírgula" por um fluxo botão -> select de papel -> modal com uma
// parte por vez (Discord não permite selecionar papel dentro do próprio modal).
const ROTULO_PAPEL_PARTE = { reu: 'Réu', testemunha_acusacao: 'Testemunha de Acusação', testemunha_defesa: 'Testemunha de Defesa' };

function podeAdicionarParteTardia(interaction, processo) {
  const ehDelegadoNoInquerito = processo.tipo === 'Penal' && !processo.juiz && interaction.user.id === processo.delegado;
  const ehJuiz = processo.juiz && interaction.user.id === processo.juiz;
  return ehDelegadoNoInquerito || ehJuiz || isSuperStaff(interaction);
}

async function abrirSelectPapelParteTardia(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeAdicionarParteTardia(interaction, processo)) {
    const motivo = processo.juiz
      ? `Só o Juiz deste processo pode adicionar parte tardia — no caso, <@${processo.juiz}>.`
      : `Só o Delegado responsável por este processo pode identificar réu nesta fase — no caso, <@${processo.delegado}>.`;
    return interaction.reply({ content: motivo, ephemeral: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:processo:papelpartetardia:${numero}`).setPlaceholder('Qual o papel dessa parte?')
      .addOptions(
        { label: 'Réu', value: 'reu' },
        { label: 'Testemunha de Acusação', value: 'testemunha_acusacao' },
        { label: 'Testemunha de Defesa', value: 'testemunha_defesa' },
      ),
  );
  return interaction.reply({ content: 'Qual o papel dessa parte no processo?', components: [row], ephemeral: true });
}

async function processarSelecaoPapelParteTardia(interaction, numero) {
  const papel = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:partetardia:${numero}#${papel}`).setTitle(`Adicionar ${ROTULO_PAPEL_PARTE[papel]}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mencao').setLabel('Menção @ Discord').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo (opcional)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return interaction.showModal(modal);
}

async function confirmarParteTardia(interaction, chave) {
  const [numero, papel] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeAdicionarParteTardia(interaction, processo)) {
    return interaction.reply({ content: 'Você não tem permissão pra adicionar parte a este processo.', ephemeral: true });
  }

  const nomeCompleto = interaction.fields.getTextInputValue('nomeCompleto') || null;
  const discordId = extrairMencoes(interaction.fields.getTextInputValue('mencao'))[0];
  if (!discordId) return interaction.reply({ content: 'Marque a parte com @menção válida do Discord.', ephemeral: true });

  if (papel === 'reu') {
    // Reaproveita vincularReu — mesma lógica de sempre (acesso ao canal liberado na hora, embed
    // atualizado, Diário Oficial, auditoria) — só acrescenta o espelho em partes por cima.
    const resultado = await vincularReu({ guild: interaction.guild, numero, reusTexto: `<@${discordId}>`, executorId: interaction.user.id });
    if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
    partesProcesso.adicionarParte(numero, { papel: 'reu', nome: nomeCompleto, discordId, origem: 'parte_tardia', adicionadoPor: interaction.user.id });
    return interaction.reply({ content: `Réu adicionado ao processo ${numero}, com acesso liberado no canal.`, ephemeral: true });
  }

  // Testemunha NÃO ganha acesso ao canal — só fica registrada, disponível pra depoimento
  // (seção 0) e, nas próximas fases, pra mandado/intimação escolherem ela como destinatário.
  partesProcesso.adicionarParte(numero, { papel, nome: nomeCompleto, discordId, origem: 'parte_tardia', adicionadoPor: interaction.user.id });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canal.send({ content: `📋 <@${interaction.user.id}> registrou ${nomeCompleto ? `**${nomeCompleto}**` : `<@${discordId}>`} como **${ROTULO_PAPEL_PARTE[papel]}** neste processo (sem acesso ao canal).` });
  }
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'parte_tardia_testemunha', titulo: `🧑‍⚖️ ${ROTULO_PAPEL_PARTE[papel]} adicionada`,
    detalhe: `${nomeCompleto ? `**${nomeCompleto}**` : `<@${discordId}>`} registrada como ${ROTULO_PAPEL_PARTE[papel]} por <@${interaction.user.id}>.`,
    executorId: interaction.user.id, metadata: { papel, discordId, nome: nomeCompleto },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.reply({ content: `${ROTULO_PAPEL_PARTE[papel]} registrada no processo ${numero} (sem acesso ao canal).`, ephemeral: true });
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
  const habilitacao = { id: novoId, reuId, advogadoId: interaction.user.id, nomeCliente, cpfCliente, status: 'Pendente', criadoEm: new Date().toISOString() };
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

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'habilitacao_solicitada', titulo: '🖋️ Habilitação de advogado solicitada',
    detalhe: `<@${interaction.user.id}> pediu habilitação para defender <@${reuId}> (cliente: ${nomeCliente}).`,
    executorId: interaction.user.id, metadata: { habilitacaoId: novoId, advogadoId: interaction.user.id, reuId },
  });
  await repostarPainel(interaction.guild, numero);

  return interaction.reply({ content: 'Pedido de habilitação enviado ao Juiz do processo.', ephemeral: true });
}

async function decidirHabilitacao(interaction, chave, aprovar) {
  const [numero, idTexto] = chave.split('#');
  const habId = Number(idTexto);
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
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
    if (canal) {
      await canais.adicionarMembro(canal, alvo.advogadoId);
      // Só faz sentido oferecer o botão de contestação se a citação já aconteceu — se ainda
      // não, o botão é postado depois, no momento da citação (ver emitirIntimacao).
      if (processo.tipo === 'Civil' && processo.status === 'Aguardando contestação') {
        await canal.send({ content: `<@${alvo.advogadoId}> — clique abaixo para anexar a contestação em nome de <@${alvo.reuId}>.`, components: [botaoAnexarContestacao(numero, alvo.id)] });
      }
    }
  }

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'habilitacao_decidida', titulo: `🖋️ Habilitação ${novoStatus.toLowerCase()}`,
    detalhe: `Habilitação de <@${alvo.advogadoId}> para defender <@${alvo.reuId}> foi ${novoStatus.toLowerCase()}.`,
    executorId: interaction.user.id, metadata: { habilitacaoId: habId, resultado: novoStatus },
  });
  await repostarPainel(interaction.guild, numero);

  const embed = new EmbedBuilder()
    .setColor(aprovar ? 0x2ecc71 : 0xe74c3c)
    .setDescription(`Habilitação de <@${alvo.advogadoId}> para defender <@${alvo.reuId}> foi **${novoStatus.toLowerCase()}**.`);
  return interaction.update({ embeds: [embed], components: [] });
}

// ---- Remoção de advogado habilitado (só o Juiz, via select menu) ----

async function abrirGerenciarDefesa(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
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
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
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
// Texto formal vem de utils/documentos.js (textoIntimacao) — compartilhado com a diligência
// de petição, que também precisa intimar alguém a fazer algo dentro de um prazo.

function modalIntimacao(numero, { destinatarioId, teorPadrao } = {}) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimar:${numero}`).setTitle('Emitir intimação');
  const campoDest = new TextInputBuilder().setCustomId('destinatario').setLabel('Menção @ do destinatário').setStyle(TextInputStyle.Short).setRequired(true);
  if (destinatarioId) campoDest.setValue(`<@${destinatarioId}>`);
  const campoTeor = new TextInputBuilder().setCustomId('teor').setLabel('Teor da intimação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  if (teorPadrao) campoTeor.setValue(teorPadrao);
  modal.addComponents(new ActionRowBuilder().addComponents(campoDest), new ActionRowBuilder().addComponents(campoTeor));
  return modal;
}

// Destinatário + teor pré-setado (spec-atualizacoes-bot-juridico.md, seção 4) — só pro botão
// GENÉRICO "Emitir intimação". O "Receber e intimar" da petição inicial civil (abaixo) continua
// exatamente como sempre foi, com preenchimento automático próprio — não usa nada disto.

const TEOR_PRESETS_INTIMACAO = {
  depoimento: { label: 'Prestar depoimento como testemunha', texto: 'Fica Vossa Senhoria intimado(a) a comparecer para prestar depoimento como testemunha nos autos deste processo, em data e local a serem informados.' },
  defesa: { label: 'Apresentar defesa', texto: 'Fica Vossa Senhoria intimado(a) a apresentar defesa nos autos deste processo, no prazo legal.' },
  audiencia: { label: 'Comparecer à audiência', texto: 'Fica Vossa Senhoria intimado(a) a comparecer à audiência designada nos autos deste processo.' },
  esclarecimentos: { label: 'Prestar esclarecimentos', texto: 'Fica Vossa Senhoria intimado(a) a comparecer para prestar esclarecimentos nos autos deste processo.' },
  determinacao: { label: 'Cumprir determinação judicial', texto: 'Fica Vossa Senhoria intimado(a) a cumprir a determinação judicial constante nos autos deste processo.' },
  outro: { label: 'Outro', texto: '' },
};

function selectTeorIntimacao(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Qual o teor da intimação?')
      .addOptions(Object.entries(TEOR_PRESETS_INTIMACAO).map(([value, { label }]) => ({ label, value }))),
  );
}

// Reaproveitada tanto pelo fluxo genérico (abaixo) quanto por emitirIntimacao (citação/intimação
// clássica) — mesmo PNG, mesmo texto formal, só muda de onde vêm destinatário e teor.
async function postarIntimacaoNoCanal({ guild, processo, numero, destinatarioId, destinatarioNome, teor }) {
  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (!canal) return null;

  const [nomeDestinatario, nomeJuiz] = await Promise.all([
    destinatarioId ? documentoPng.nomeExibicao(guild, destinatarioId) : Promise.resolve(destinatarioNome || 'Destinatário'),
    documentoPng.nomeExibicao(guild, processo.juiz),
  ]);
  const pngIntimacao = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'intimacao', orgaoEmissor: 'judiciario',
    subunidade: processo.tipo === 'Penal' ? 'Comarca de São Paulo — Vara Criminal' : 'Comarca de São Paulo — Vara Cível',
    tituloDocumento: 'INTIMAÇÃO', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: nomeDestinatario, corpoTexto: teor, nomeAssinante: nomeJuiz, cargoAssinante: 'Juiz de Direito',
  }).catch(err => { console.error('Falha ao gerar PNG da intimação:', err.message); return null; });

  await canal.send({
    content: documentos.textoIntimacao({ numero, rotulo: 'Processo', destinatarioId, destinatarioNome, teor }),
    ...(pngIntimacao ? { files: [{ attachment: pngIntimacao, name: `Intimacao-${numero}.png` }] } : {}),
  });
  return canal;
}

async function abrirSelectDestinatarioIntimacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode emitir intimação — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  return interaction.reply({
    content: 'Quem é o destinatário da intimação?',
    components: [partesProcesso.selectDestinatario(`painel:select:processo:destinatariointimacao:${numero}`, processo)],
    ephemeral: true,
  });
}

async function processarSelecaoDestinatarioIntimacao(interaction, numero) {
  const destinatarioRef = interaction.values[0];
  if (destinatarioRef === 'fora') {
    const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimarforadestinatario:${numero}`).setTitle('Pessoa fora do processo');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idTexto').setLabel('CPF ou Discord ID').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }
  return interaction.reply({
    content: 'Qual o teor da intimação?',
    components: [selectTeorIntimacao(`painel:select:processo:teorintimacao:${numero}#${destinatarioRef}`)],
    ephemeral: true,
  });
}

// Pessoa "fora do processo" já vira parte de verdade assim que nome/ID são coletados — o resto
// do fluxo (teor pré-setado, modal final) trata ela igual a qualquer outra parte, usando o id
// novo que acabou de ganhar.
async function confirmarDestinatarioForaIntimacao(interaction, numero) {
  const nomeCompleto = interaction.fields.getTextInputValue('nomeCompleto');
  const idTexto = interaction.fields.getTextInputValue('idTexto');
  const { discordId, cpf } = partesProcesso.classificarIdLivre(idTexto);
  const novaParte = partesProcesso.adicionarParte(numero, { papel: 'terceiro', nome: nomeCompleto, discordId, cpf, origem: 'manual_mandado', adicionadoPor: interaction.user.id });
  return interaction.reply({
    content: 'Qual o teor da intimação?',
    components: [selectTeorIntimacao(`painel:select:processo:teorintimacao:${numero}#${novaParte.id}`)],
    ephemeral: true,
  });
}

async function processarSelecaoTeorIntimacao(interaction, chaveDestinatario) {
  const [numero, destinatarioRef] = chaveDestinatario.split('#');
  const preset = TEOR_PRESETS_INTIMACAO[interaction.values[0]];
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimargenerico:${numero}#${destinatarioRef}`).setTitle(`Intimação — ${preset.label}`.slice(0, 45));
  const campoTeor = new TextInputBuilder().setCustomId('teor').setLabel('Teor da intimação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  if (preset.texto) campoTeor.setValue(preset.texto);
  modal.addComponents(new ActionRowBuilder().addComponents(campoTeor));
  return interaction.showModal(modal);
}

async function confirmarIntimacaoGenerica(interaction, chave) {
  const [numero, destinatarioRef] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode emitir intimação — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }

  const teor = interaction.fields.getTextInputValue('teor');
  const parte = (processo.partes || []).find(p => p.id === destinatarioRef);
  await postarIntimacaoNoCanal({ guild: interaction.guild, processo, numero, destinatarioId: parte?.discordId || null, destinatarioNome: parte?.nome || null, teor });

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_emitida', titulo: '✉️ Intimação emitida',
    detalhe: `Destinatário: ${parte?.discordId ? `<@${parte.discordId}>` : (parte?.nome || 'não identificado')}\nTeor: ${teor}`,
    executorId: interaction.user.id, metadata: { destinatarioId: parte?.discordId || null, destinatarioNome: parte?.nome || null, ehCitacao: false },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.reply({ content: 'Intimação emitida e postada no canal do processo.', ephemeral: true });
}

async function abrirModalReceberEIntimar(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode receber a petição inicial — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const reuId = (processo.reus || [])[0];
  const teorPadrao = `Fica Vossa Senhoria citado(a) para, querendo, apresentar contestação no prazo de ${config.prazoContestacaoDias} dias corridos, contados desta citação, sob pena de revelia.`;
  return interaction.showModal(modalIntimacao(numero, { destinatarioId: reuId, teorPadrao }));
}

async function emitirIntimacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const destId = extrairMencoes(interaction.fields.getTextInputValue('destinatario'))[0];
  const teor = interaction.fields.getTextInputValue('teor');
  if (!destId) return interaction.reply({ content: 'Marque o destinatário com @menção.', ephemeral: true });

  // "Receber e intimar" (abertura do civil) usa o MESMO modal/customId que "Emitir intimação"
  // genérico — não dá pra distinguir pelo customId. O que diferencia é o momento: só é uma
  // CITAÇÃO (com prazo automático de contestação) quando o civil ainda está na fase pré-citação.
  const ehCitacaoCivil = processo.tipo === 'Civil' && processo.status === 'Aguardando defesa';

  const canal = await postarIntimacaoNoCanal({ guild: interaction.guild, processo, numero, destinatarioId: destId, teor });

  let prazoContestacaoAte = null;
  if (ehCitacaoCivil) {
    prazoContestacaoAte = new Date(Date.now() + config.prazoContestacaoDias * 24 * 60 * 60 * 1000).toISOString();
    db.atualizar('processos', numero, {
      status: 'Aguardando contestação', citacaoEm: new Date().toISOString(), prazoContestacaoAte, avisoPrazoContestacaoEnviado: false,
    });

    if (canal) {
      await canal.send({
        content: `⚖️ A partir desta citação, corre o prazo de ${config.prazoContestacaoDias} dias corridos para contestação (até <t:${Math.floor(new Date(prazoContestacaoAte).getTime() / 1000)}:D>).`,
        components: [botaoDecretarRevelia(numero)],
      });

      // Se algum advogado já estava habilitado antes desta citação (ordem incomum, mas
      // possível), o botão de contestação ainda não tinha sido postado — posta agora.
      const jaHabilitados = (processo.habilitacoes || []).filter(h => h.status === 'Aprovado');
      for (const h of jaHabilitados) {
        await canal.send({ content: `<@${h.advogadoId}> — clique abaixo para anexar a contestação em nome de <@${h.reuId}>.`, components: [botaoAnexarContestacao(numero, h.id)] });
      }
    }
  }

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_emitida', titulo: ehCitacaoCivil ? '✉️ Citação emitida' : '✉️ Intimação emitida',
    detalhe: `Destinatário: <@${destId}>\nTeor: ${teor}`,
    executorId: interaction.user.id, metadata: { destinatarioId: destId, ehCitacao: ehCitacaoCivil, prazoContestacaoAte },
  });
  await repostarPainel(interaction.guild, numero);

  return interaction.reply({ content: 'Intimação emitida e postada no canal do processo.', ephemeral: true });
}

// ---- Arquivar petição inicial (civil) ----

async function arquivarCivil(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
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
  if (interaction.user.id !== processo.delegado && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Delegado responsável por este processo pode pedir revisão — no caso, <@${processo.delegado}>.`, ephemeral: true });
  }
  if (processo.status !== 'Arquivado') return interaction.reply({ content: 'Esse processo não está arquivado.', ephemeral: true });
  if (processo.revisaoArquivamento === 'Pendente') return interaction.reply({ content: 'Já existe um pedido de revisão pendente.', ephemeral: true });

  // Ticket dedicado numa categoria própria — mesmo critério já usado pra reconsideração de
  // medida negada e de indeferimento judicial. Por DM o pedido ficava fora de qualquer canal
  // (sem histórico visível pra outros Procuradores, sem rastro no servidor); um canal de
  // verdade é o padrão consistente do resto do bot.
  const procuradores = rh.listarPorCargo('Procurador').filter(p => !p.licenca);
  const canalRevisao = await canais.criarCanalTicket(interaction.guild, {
    categoriaId: config.categoriaReconsideracoesId, prefixo: 'revisao', numero,
    membros: [processo.delegado, processo.promotor, ...procuradores.map(p => p.discordId)],
  });

  db.atualizar('processos', numero, { revisaoArquivamento: 'Pendente', revisaoArquivamentoCanalId: canalRevisao.id });

  const embed = new EmbedBuilder()
    .setTitle('📋 Pedido de revisão de arquivamento')
    .setColor(0xf39c12)
    .addFields(
      { name: 'Processo', value: numero, inline: true },
      { name: 'Delegado', value: `<@${processo.delegado}>`, inline: true },
      { name: 'Promotor que arquivou', value: `<@${processo.promotor}>`, inline: true },
    );
  const botao = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:supervisao:manterarquivamento:${numero}`).setLabel('Manter arquivamento').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`painel:acao:supervisao:forcardenunciadireto:${numero}`).setLabel('Forçar denúncia').setStyle(ButtonStyle.Success),
  );
  await canalRevisao.send({
    content: procuradores.length ? procuradores.map(p => `<@${p.discordId}>`).join(' ') : 'Nenhum Procurador ativo cadastrado no momento — o pedido fica pendente até haver um.',
    embeds: [embed], components: [botao],
  });

  // Autos do inquérito (relatório do Delegado, indícios, cumprimentos etc.) juntados aqui —
  // o Procurador precisa ver o processo inteiro pra decidir, não só o resumo do embed acima.
  // Processo com muitos documentos facilmente estoura os 2000 caracteres do Discord numa
  // mensagem só (bug real encontrado em teste) — manda em blocos em vez de tudo de uma vez.
  const documentosDoCaso = anexos.listarPorProtocolo(numero);
  if (documentosDoCaso.length) {
    const linhas = documentosDoCaso.map(d => `• [${d.nomeArquivo}](${d.url}) — ${d.tipo}`);
    let bloco = '📎 **Autos do processo (documentos já juntados):**';
    for (const linha of linhas) {
      if ((bloco + '\n' + linha).length > 1900) {
        await canalRevisao.send({ content: bloco });
        bloco = linha;
      } else {
        bloco += '\n' + linha;
      }
    }
    await canalRevisao.send({ content: bloco });
  }

  return interaction.reply({ content: `Pedido de revisão aberto em ${canalRevisao}.`, ephemeral: true });
}

// ---- Peticionamento genérico do Advogado (spec-andamentos-processuais_4.md, seção 8.8) ----
// `processo.peticoes` (array na própria ficha do processo) não tem relação nenhuma com a
// tabela `peticoes` do banco (porte de arma/troca de nome/limpeza de ficha, ver commands/
// peticao.js) — mesma palavra, coisas diferentes: aqui é uma petição avulsa dentro de um
// processo já aberto, não um protocolo administrativo próprio com numeração e ticket dedicado.
// Análogo ao ciclo de habilitação (pedido → decisão), só que sem aprovação prévia — o Advogado
// protocola a qualquer momento, o Juiz decide quando quiser.

function botaoPeticionar(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:peticionar:${numero}`).setLabel('📄 Peticionar').setStyle(ButtonStyle.Secondary);
}

function botoesDeferirIndeferirPeticao(numero, peticaoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:deferirpeticao:${numero}#${peticaoId}`).setLabel('Deferir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:processo:indeferirpeticao:${numero}#${peticaoId}`).setLabel('Indeferir').setStyle(ButtonStyle.Danger),
  );
}

async function peticionar(interaction, numero) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem peticionar.', ephemeral: true });
  }
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  const peticoesDoProcesso = processo.peticoes || [];
  const novoId = peticoesDoProcesso.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  const peticaoNova = { id: novoId, advogadoId: interaction.user.id, url: anexo.url, nomeArquivo: anexo.nomeArquivo, status: 'Pendente', criadaEm: new Date().toISOString() };
  db.atualizar('processos', numero, { peticoes: [...peticoesDoProcesso, peticaoNova] });

  anexos.criarDocumento({
    tipo: 'peticao_avulsa', url: anexo.url, nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: `${numero}#${novoId}`, protocoloVinculado: numero,
  });

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'peticao_protocolada', titulo: '📄 Petição protocolada', detalhe: `Petição avulsa protocolada por <@${interaction.user.id}>.`,
    executorId: interaction.user.id, anexoUrl: anexo.url, metadata: { peticaoId: novoId },
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal && processo.juiz) {
    await canal.send({
      content: `<@${processo.juiz}> — petição protocolada por <@${interaction.user.id}>.`,
      components: [botoesDeferirIndeferirPeticao(numero, novoId)],
      files: [{ attachment: anexo.url, name: anexo.nomeArquivo }],
    });
  }
  await repostarPainel(interaction.guild, numero);
  return interaction.followUp({ content: 'Petição protocolada e enviada ao Juiz.' });
}

async function decidirPeticao(interaction, chave, deferir) {
  const [numero, idTexto] = chave.split('#');
  const peticaoId = Number(idTexto);
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decidir petição — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const peticoesDoProcesso = processo.peticoes || [];
  const alvo = peticoesDoProcesso.find(p => p.id === peticaoId);
  if (!alvo || alvo.status !== 'Pendente') {
    return interaction.reply({ content: 'Essa petição não existe mais ou já foi decidida.', ephemeral: true });
  }
  const novoStatus = deferir ? 'Deferida' : 'Indeferida';
  db.atualizar('processos', numero, { peticoes: peticoesDoProcesso.map(p => p.id === peticaoId ? { ...p, status: novoStatus } : p) });

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'peticao_decidida', titulo: `📄 Petição ${novoStatus.toLowerCase()}`,
    detalhe: `Petição de <@${alvo.advogadoId}> foi ${novoStatus.toLowerCase()} pelo Juiz.`,
    executorId: interaction.user.id, anexoUrl: deferir ? alvo.url : null,
    metadata: { peticaoId, resultado: novoStatus },
  });
  await repostarPainel(interaction.guild, numero);

  return interaction.update({ content: `Petição **${novoStatus.toLowerCase()}** pelo Juiz.`, components: [] });
}

// ---- Recurso/Apelação (só quem perdeu, conforme o resultado estruturado da sentença) ----

// Sem bypass de admin de propósito — recorrer é ato de parte (só quem de fato perdeu a causa),
// não uma função de suporte administrativo. Staff que precisar agir nesse papel usa as trocas
// de Juiz/Promotor/Desembargador (utils/supervisao.js) pra assumir o papel de verdade primeiro.
function podeRecorrer(interaction, processo) {
  if (isSuperStaff(interaction)) return true;
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

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'apelacao', titulo: `⚖️ Apelação ${numeroApelacao} interposta`,
    detalhe: razoes, executorId: recorrenteId, metadata: { apelacaoNumero: numeroApelacao },
  });
  // Sem repostarPainel aqui: a narrativa desta seção nasce no canal NOVO da apelação, não no
  // canal do processo original (que a essa altura já costuma estar arquivado pela sentença).

  await auditoria.registrar(interaction.guild, { acao: 'Recurso interposto', executorId: recorrenteId, referencia: `Processo ${numero} → Apelação ${numeroApelacao}` });
  return interaction.reply({ content: `Recurso ${numeroApelacao} aberto em ${canal}.`, ephemeral: true });
}

async function validarDecisaoApelacao(interaction, numeroApelacao) {
  const apelacao = db.buscarPorNumero('apelacoes', numeroApelacao);
  if (!apelacao) {
    await interaction.reply({ content: 'Apelação não encontrada.', ephemeral: true });
    return null;
  }
  if (interaction.user.id !== apelacao.desembargadorId && !isSuperStaff(interaction)) {
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
    const novoJuizId = rh.sortearJuiz({ excluirIds: [processoOriginal.delegado, processoOriginal.promotor, processoOriginal.juiz, processoOriginal.autor, ...(processoOriginal.reus || [])].filter(Boolean) });
    // Com Juiz sorteado, o caso já nasce "Concluso para julgamento" (dossie-conclusao-reabertura.md,
    // seção 3.2) — o novo Juiz decide na hora se julga com o que já tem ou pede mais prova
    // ("Requerer novas provas", ver postarDossie/requererNovasProvas). Sem Juiz disponível,
    // mantém o comportamento anterior (Instrução) — não tem pra quem mandar o dossiê ainda.
    db.atualizar('processos', processoOriginal.numero, {
      status: novoJuizId ? 'Concluso para julgamento' : 'Instrução',
      juiz: novoJuizId, juizDesde: new Date().toISOString(), sentenca: null, resultado: null, apelacaoNumero: null,
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
        components: novoJuizId ? botoesJuiz(processoOriginal.numero) : [],
      });
      if (novoJuizId) {
        const processoReaberto = db.buscarPorNumero('processos', processoOriginal.numero);
        await dossieJulgamento.postarDossie(canalOriginalParaJuiz, processoReaberto, anexos.listarPorProtocolo(processoOriginal.numero), {
          motivo: extras.fundamentacao, desembargador: `<@${interaction.user.id}>`, dataAnulacao: new Date(),
        });
      }
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
      .addStringOption(o => o.setName('nome_acao').setDescription('Nome da ação (ex: Ação indenizatória de perdas e danos por acidente de trânsito)').setRequired(true))
      .addStringOption(o => o.setName('autor_nome').setDescription('Nome completo do autor').setRequired(true))
      .addUserOption(o => o.setName('autor_discord').setDescription('Usuário Discord do autor').setRequired(true))
      .addStringOption(o => o.setName('reu_nome').setDescription('Nome completo do réu').setRequired(true))
      .addUserOption(o => o.setName('reu_discord').setDescription('Usuário Discord do réu').setRequired(true)))
    .addSubcommand(sub => sub.setName('listar').setDescription('Lista processos')
      .addStringOption(o => o.setName('status').setDescription('Filtrar por status')))
    .addSubcommand(sub => sub.setName('ver').setDescription('Ver detalhes de um processo')
      .addStringOption(o => o.setName('numero').setDescription('Número do processo').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub.setName('historico').setDescription('Autos do processo — histórico completo (medida de origem, mandados, ofícios, apelação)')
      .addStringOption(o => o.setName('numero').setDescription('Número do processo').setRequired(true).setAutocomplete(true))),

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
        nomeAcao: interaction.options.getString('nome_acao'),
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

    if (sub === 'historico') {
      return verHistoricoProcesso(interaction, interaction.options.getString('numero'));
    }
  },

  // ---- Handlers de botão/modal ----

  // Ao decidir (oferecer ou arquivar), o Promotor agora escreve o parecer do MP num modal antes
  // (spec-atualizacoes-bot-juridico.md, seção 1, passos 4-6) — a decisão de mérito em si só se
  // consuma em confirmarParecerMp, na submissão do modal.
  async oferecer(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
    }
    return interaction.showModal(modalParecerMp(numero, 'oferecer'));
  },

  async arquivar(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
    }
    return interaction.showModal(modalParecerMp(numero, 'arquivar'));
  },

  async julgar(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processo.juiz}>.`, ephemeral: true });
    }
    if (processo.tipo === 'Civil' && processo.status !== 'Concluso para julgamento') {
      return interaction.reply({ content: `Este processo ainda não está concluso para julgamento (status atual: "${processo.status}"). Falta citar o réu, aguardar a contestação ou decretar revelia.`, ephemeral: true });
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
    // Segunda trava (defesa em profundidade) — o clique em "Julgar" já checa isso, mas a
    // sentença de verdade só se consuma aqui, na submissão do modal; sem checar de novo, o
    // commit final da decisão de mérito ficava sem nenhuma verificação própria.
    const processoAlvo = db.buscarPorNumero('processos', numero);
    if (!processoAlvo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
    if (interaction.user.id !== processoAlvo.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processoAlvo.juiz}>.`, ephemeral: true });
    }

    const texto = interaction.fields.getTextInputValue('texto');
    // Pena/regime só vêm no modal quando o resultado é Condenado (ver painel.js, select de
    // resultado) — getTextInputValue lançaria se o campo não existir nesse envio.
    const pena = resultado === 'Condenado' ? interaction.fields.getTextInputValue('pena') : null;
    const regime = resultado === 'Condenado' ? interaction.fields.getTextInputValue('regime') : null;
    db.atualizar('processos', numero, { status: 'Encerrado', sentenca: texto, resultado, pena, regime, sentencaEm: new Date().toISOString() });

    const processo = db.buscarPorNumero('processos', numero);
    const nomeJuiz = await documentoPng.nomeExibicao(interaction.guild, processo.juiz);
    // Civil sempre tem reuNome (texto livre, nome do personagem/empresa — o apelido do
    // jogador no Discord não representa a parte) — só resolve @menção quando não há esse
    // campo (caso do Penal, onde réu só existe como menção mesmo).
    const nomeReu = processo.reuNome || (
      (processo.reus || []).length
        ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(interaction.guild, id)))).join(' e ')
        : 'o(a) réu(ré)'
    );
    const nomeAutor = processo.autorNome || (processo.autor ? await documentoPng.nomeExibicao(interaction.guild, processo.autor) : 'a parte autora');
    const crimeDescricao = (processo.crimes || []).map(c => `${c.nome} (art. ${c.artigo})`).join(', ') || 'crime não especificado';

    const TIPO_DOCUMENTO_SENTENCA = {
      'Penal:Condenado': 'sentenca_penal_condenatoria',
      'Penal:Absolvido': 'sentenca_penal_absolutoria',
      'Civil:Procedente': 'sentenca_civel_procedente',
      'Civil:Improcedente': 'sentenca_civel_improcedente',
    };
    const tipoDocumento = TIPO_DOCUMENTO_SENTENCA[`${processo.tipo}:${resultado}`];

    const pngSentenca = await documentoPng.gerarDocumentoPNG({
      tipoDocumento,
      orgaoEmissor: 'judiciario',
      subunidade: processo.tipo === 'Penal' ? 'Comarca de São Paulo — Vara Criminal' : 'Comarca de São Paulo — Vara Cível',
      tituloDocumento: 'SENTENÇA',
      numeroProcesso: numero,
      dataEmissao: documentos.dataExtenso(),
      destinatario: processo.tipo === 'Penal' ? 'Réu(s)' : 'Autor e Réu(s)',
      corpoTexto: texto,
      nomeReu, nomeAutor, crimeDescricao, pena, regime,
      nomeAssinante: nomeJuiz,
      cargoAssinante: 'Juiz de Direito',
    }).catch(err => { console.error('Falha ao gerar PNG da sentença:', err.message); return null; });

    await interaction.reply({
      content: documentos.textoSentenca(processo), embeds: [embedProcesso(processo)], components: [botaoRecorrer(numero)],
      ...(pngSentenca ? { files: [{ attachment: pngSentenca, name: `Sentenca-${numero}.png` }] } : {}),
      fetchReply: true,
    });
    const msgSentenca = await interaction.fetchReply().catch(() => null);
    const anexoUrlSentenca = msgSentenca?.attachments?.first()?.url || null;

    // Se o processo nasceu de uma medida pedida pela Polícia Civil (codigoExterno), devolve o
    // desfecho pra eles também — fecha o ciclo mandado → instrução → sentença.
    if (processo.tipo === 'Penal') {
      await devolutivaPoliciaCivil.enviarSentencaPoliciaCivil({ processo, texto: documentos.textoSentenca(processo), pngBuffer: pngSentenca });
    }

    await andamentos.registrar(interaction.guild, numero, {
      tipo: 'sentenca', titulo: `⚖️ Sentença — ${resultado}`,
      detalhe: texto, executorId: interaction.user.id, anexoUrl: anexoUrlSentenca, metadata: { resultado, pena, regime },
    });
    // processo aqui já está com status 'Encerrado' (refetch acima) — painelAtual retorna null
    // e isso só limpa os componentes do painel antigo, sem postar um novo. Certo: processo
    // sentenciado não deveria mais oferecer "Julgar"/"Emitir intimação" clicáveis.
    await repostarPainel(interaction.guild, numero);

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
  verHistoricoProcesso,
  listarProcessos,
  postarOuAtualizarDiario,
  abrirSelectPapelParteTardia,
  processarSelecaoPapelParteTardia,
  confirmarParteTardia,
  abrirModalHabilitacao,
  criarHabilitacao,
  decidirHabilitacao,
  abrirGerenciarDefesa,
  removerHabilitacao,
  abrirSelectDestinatarioIntimacao,
  processarSelecaoDestinatarioIntimacao,
  confirmarDestinatarioForaIntimacao,
  processarSelecaoTeorIntimacao,
  confirmarIntimacaoGenerica,
  abrirModalReceberEIntimar,
  emitirIntimacao,
  arquivarCivil,
  anexarPeticaoInicial,
  anexarRelatorioInquerito,
  confirmarParecerMp,
  anexarContestacao,
  decretarRevelia,
  requererNovasProvas,
  concluirInstrucaoNovamente,
  abrirSelectTestemunha,
  processarSelecaoTestemunha,
  registrarDepoimentoHandler,
  botoesJuiz,
  montarPainelAcoes,
  peticionar,
  decidirPeticao,
  painelAtual,
  repostarPainel,
  pedirRevisaoArquivamento,
  abrirModalRecorrer,
  criarApelacao,
  abrirSelecaoResultadoReforma,
  abrirModalFundamentacaoReforma,
  abrirModalFundamentacaoDecisao,
  finalizarApelacao,
  extrairMencoes,

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = db.todos('processos', p => p.numero.toLowerCase().includes(foco))
      .slice(0, 25)
      .map(p => ({ name: `${p.numero} — ${p.tipo} — ${p.status}`.slice(0, 100), value: p.numero }));
    await interaction.respond(resultados);
  },
};
