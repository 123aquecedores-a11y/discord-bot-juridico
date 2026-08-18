const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const db = require('../database/db');
const { proximoNumero } = require('../utils/numeracao');
const modoEntrega = require('../utils/modoEntrega');
const { temCargo, isAdmin, isSuperStaff } = require('../utils/permissoes');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const config = require('../config');
const { penaTexto, crimeLabel, resolverCrimesTexto, normalizarCrime } = require('../utils/crimesTexto');
const { ATENUANTES, labelsDe } = require('../utils/atenuantes');
const rascunhoSentenca = require('../utils/rascunhoSentenca');
const { truncar } = require('../utils/texto');
const auditoria = require('../utils/auditoria');
const documentos = require('../utils/documentos');
const { historicoDoProcesso } = require('../utils/historico');
const documentoPng = require('../services/gerarDocumentoPNG');
const diario = require('../utils/diarioOficial');
const diarioAtos = require('../utils/diarioAtos');
const devolutivaPoliciaCivil = require('../utils/devolutivaPoliciaCivil');
const dossie = require('../utils/dossie');
const { aguardarAnexoPDF, aguardarAnexos, coletarAnexoPdf } = require('../utils/anexoPdf');
const cartorio = require('../utils/cartorio');
const preferencias = require('../utils/preferencias');
const { RascunhoTTL } = require('../utils/rascunhoTtl');
const revisaoIA = require('../utils/revisaoIA');
const analiseDocumento = require('../utils/analiseDocumento');

// Rascunho da decisão entre o modal e a publicação — guarda o texto (sentença/parecer/acórdão/
// razões) enquanto o autor decide se revisa por IA. Com TTL: se o fluxo for abandonado após o
// "Revisar", a entrada expira sozinha (não vaza em memória) e a mensagem "a prévia expirou" passa
// a ser verdade. Se sumir (restart/expiração), é só refazer a ação.
const rascunhoDecisao = new RascunhoTTL();
const chaveDecisao = (uid, numero) => `${uid}:${numero}`;

// Veredicto por crime (lote 5, Função 2) — guarda os IDs dos crimes CONDENADOS entre o select de
// veredicto e a submissão do modal de sentença (passando pela tela de atenuantes). TTL igual ao
// rascunhoDecisao: se o fluxo for abandonado, expira sozinho.
const rascunhoVeredicto = new RascunhoTTL();
const anexos = require('../utils/anexos');
const mandadoCmd = require('./mandado');
const medidaCmd = require('./medida');
const dossieJulgamento = require('../utils/dossieJulgamento');
const partesProcesso = require('../utils/partesProcesso');
const andamentos = require('../utils/andamentos');
const responsaveis = require('../utils/responsaveis');

function extrairMencoes(texto) {
  if (!texto) return [];
  const matches = [...texto.matchAll(/<@!?(\d+)>/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// Delega pra fonte única em utils/crimesTexto — casa cada crime por id interno, por código de
// artigo OU por nome (ver resolverCrimesTexto). Antes só casava por id exato, o que fazia a
// abertura falhar quando o texto trazia os crimes por artigo/nome (ex.: encerramento de inquérito
// vindo da Polícia Civil, /processo penal digitado à mão).
function resolverCrimes(texto) {
  return resolverCrimesTexto(texto);
}

// Identidade do réu para exibição, unificada entre o painel do caso e a capa pública. Três casos:
// penal → lista de @Discord; cível com Discord → nome + RG + @; cível só nome/RG (Parte 2, sem
// Discord — identidade canônica no RP) → nome + RG. "A identificar" só quando não há nenhum dos dois.
function descreverReu(p) {
  if (p.reuNome) {
    const disc = (p.reus || [])[0];
    return `${p.reuNome}${p.reuRg ? ` — RG ${p.reuRg}` : ''}${disc ? ` (<@${disc}>)` : ''}`;
  }
  if ((p.reus || []).length) return p.reus.map(id => `<@${id}>`).join(', ');
  return '*A identificar*';
}

function embedProcesso(p) {
  const crimesTxt = truncar((p.crimes || []).map(c => `• ${crimeLabel(c)} — pena: ${penaTexto(c)}${c.fianca_sugerida ? ` | fiança ref.: ${c.fianca_sugerida}` : ''}`).join('\n') || '—');
  const reusTxt = descreverReu(p);
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

// Modal final da sentença do caminho direto: absolvição penal e cível (procedente/improcedente),
// sem tela de apoio. A condenação penal não passa por aqui — vai sempre pelo fluxo por-crime
// (veredicto por crime → modalSentencaPorCrime), que é quem coleta pena e regime.
function modalSentenca(numero, resultado) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:sentenca:${numero}#${resultado}`).setTitle('Sentença');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('texto').setLabel('Fundamentação e decisão').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return modal;
}

// Tela de apoio antes do modal de condenação (spec-atualizacao-codigo-penal-e-sentenca.md,
// seção 4) — por crime do processo, mostra faixa de pena e fiança sugerida (só referência,
// nunca preenche nada sozinho) e, se algum crime for elegivel_atenuante, um checklist opcional
// de atenuantes. Tudo aqui é apoio qualitativo: pena, regime e texto final continuam sendo
// digitados manualmente no modal seguinte. O aviso de teto de 45 meses é só informativo — não
// bloqueia o Juiz de sentenciar acima disso quando há decisão fundamentada.
function montarPainelSentencaPenal(processo, atenuantesSelecionadas, condenadosIds = null) {
  const todosCrimes = processo.crimes || [];
  // Função 2: quando vem a lista de condenados, a referência de pena/atenuantes é só desses crimes.
  const crimesDoProcesso = condenadosIds ? todosCrimes.filter(c => condenadosIds.includes(c.id)) : todosCrimes;
  const foraDoTeto = c => c.sem_custodia || c.apuracao === 'corregedoria';
  const somaTeto = crimesDoProcesso.filter(c => !foraDoTeto(c)).reduce((acc, c) => acc + (c.pena_max_meses || 0), 0);
  const ultrapassaTeto = somaTeto > 45;

  const embed = new EmbedBuilder()
    .setTitle(`⚖️ Sentença — Processo ${processo.numero} (Condenação)`)
    .setColor(ultrapassaTeto ? 0xe67e22 : 0x2ecc71)
    .setDescription('Faixa de pena e fiança de cada crime, só como referência. Marque atenuantes se cabível (opcional) e siga pra sentença — pena, regime e texto final continuam manuais.');

  for (const c of crimesDoProcesso) {
    embed.addFields({
      name: crimeLabel(c),
      value: `Pena: ${penaTexto(c)}\nFiança sugerida (referência): ${c.fianca_sugerida || 'não informada'}`,
    });
  }

  embed.addFields({
    name: 'Teto de custódia sem julgamento (45 meses)',
    value: ultrapassaTeto
      ? `⚠️ Soma das penas máximas: ${somaTeto} meses — ultrapassa o teto de 45. Havendo sentença fundamentada, a pena pode superar o teto normalmente; a fixação final é do Juízo.`
      : `Soma das penas máximas: ${somaTeto} meses (dentro do teto de 45).`,
  });

  const algumElegivel = crimesDoProcesso.some(c => c.elegivel_atenuante);
  const components = [];
  if (algumElegivel) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:processo:atenuantes:${processo.numero}`)
        .setPlaceholder('Atenuantes aplicáveis (opcional)')
        .setMinValues(0).setMaxValues(ATENUANTES.length)
        .addOptions(ATENUANTES.map(a => ({ label: a.label, value: a.value, default: atenuantesSelecionadas.includes(a.value) }))),
    ));
    if (atenuantesSelecionadas.length) {
      embed.addFields({ name: 'Atenuantes marcadas', value: labelsDe(atenuantesSelecionadas).join(', ') });
    }
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:continuarsentencapenal:${processo.numero}`).setLabel('✅ Continuar para sentença').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:processo:pularsentencapenal:${processo.numero}`).setLabel('⏭️ Pular sugestões e preencher direto').setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components };
}

// Modal de sentença POR CRIME (lote 5, Função 2) — fundamentação sempre; se houver condenação,
// um campo de penas (pré-preenchido com uma linha por crime condenado, pena texto-livre) + regime.
// Absolvição em tudo → só fundamentação.
function modalSentencaPorCrime(numero, processo, condenadosIds) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:sentencapocrime:${numero}`).setTitle('Sentença por crime');
  const condenados = (processo.crimes || []).filter(c => condenadosIds.includes(c.id));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('texto').setLabel('Fundamentação e decisão').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  if (condenados.length) {
    const template = condenados.map(c => `${crimeLabel(c)}: `).join('\n');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('penas').setLabel('Pena de cada crime condenado').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(template.slice(0, 4000))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('regime').setLabel('Regime inicial (ex: semiaberto)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)),
    );
  }
  return modal;
}

// Parecer do MP (spec-atualizacoes-bot-juridico.md, seção 1) — mesmo campo único serve pra
// Oferecer denúncia ou Arquivar, só muda o título e o que acontece depois da confirmação.
function modalParecerMp(numero, acao) {
  const titulo = acao === 'oferecer' ? 'Parecer do MP — Oferecer denúncia' : 'Parecer do MP — Arquivamento';
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:parecermp:${numero}#${acao}`).setTitle(titulo.slice(0, 45));
  modal.addComponents(new ActionRowBuilder().addComponents(
    // 4000 é o teto absoluto do Discord pra um campo de modal (Paragraph). Denúncia real tem
    // fundamentação longa (fatos + materialidade + capitulação + requerimentos), então usamos o
    // máximo. O texto do canal já é truncado em textoDespacho; o PNG (documento real) não tem limite.
    new TextInputBuilder().setCustomId('parecer').setLabel('Parecer do Ministério Público').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return modal;
}

// Chave de rascunho do parecer do MP — namespaced com "parecer:" pra nunca colidir com o
// rascunho da sentença (que usa `${uid}:${numero}` puro). Guarda também a `acao`
// (oferecer/arquivar), que no fluxo antigo vinha embutida no customId do modal.
const chaveParecer = (uid, numero) => `${uid}:parecer:${numero}`;

// Submissão do modal do parecer: em vez de publicar direto, guarda o rascunho e oferece a
// revisão por IA DENTRO do fluxo (mesmo padrão dos Fundamentos da sentença — Discord não
// deixa botão dentro do modal, então é o passo logo após).
async function confirmarParecerMp(interaction, chave) {
  const [numero, acao] = chave.split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true });
  }

  const parecer = interaction.fields.getTextInputValue('parecer');
  rascunhoDecisao.set(chaveParecer(interaction.user.id, numero), { texto: parecer, acao });
  // Revisão automática ligada: pula a tela de escolha e já envia o texto revisado pela IA.
  if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return executarParecerMp(interaction, numero, 'auto');
  const rotulo = acao === 'oferecer' ? 'oferecimento de denúncia' : 'arquivamento';
  return interaction.reply(revisaoIA.telaEscolha('parecermp', { extra: numero, titulo: 'Parecer do MP', rotulo, texto: parecer }));
}

// Gera a revisão por IA e mostra antes→depois; o Promotor escolhe qual enviar.
// R1 — esqueleto ÚNICO da revisão-IA in-flow (parecer/razões/acórdão/sentença): pega o rascunho,
// guarda contra expiração, revisa o texto pela IA e mostra a tela antes→depois (ou o fallback).
// Cada fluxo é um wrapper fino que só informa a chave, o campo do texto no rascunho, a tela e a
// mensagem de expiração — comportamento idêntico ao que era copiado 4×.
async function revisarRascunho(interaction, { chave, campo, telaId, extra, msgExpirou }) {
  const d = rascunhoDecisao.get(chave);
  if (!d) return interaction.update({ content: msgExpirou, components: [] }).catch(() => {});
  await interaction.deferUpdate();
  const revisado = await cartorio.revisarTexto(d[campo]).catch(() => null);
  if (!revisado) return interaction.editReply(revisaoIA.telaFallbackIA(telaId, extra));
  d.textoRevisado = revisado;
  return interaction.editReply(revisaoIA.telaAntesDepois(telaId, { extra, textoOriginal: d[campo], textoRevisado: revisado }));
}

// R1 — escolhe o texto a publicar (original ou o revisado pela IA) e, no modo 'auto', gera a
// revisão sob demanda (fallback pro original se a IA não responder). `campo` é a chave do texto no
// rascunho (texto/razoes/fundamentacao). Substitui o trio usarRevisado repetido em cada executar*.
async function resolverTextoFinal(d, modo, campo) {
  if (modo === 'auto' && !d.textoRevisado) d.textoRevisado = await cartorio.revisarTexto(d[campo]).catch(() => null);
  const usarRevisado = modo === 'auto' ? !!d.textoRevisado : modo;
  return usarRevisado && d.textoRevisado ? d.textoRevisado : d[campo];
}

async function revisarParecerTexto(interaction, numero) {
  return revisarRascunho(interaction, { chave: chaveParecer(interaction.user.id, numero), campo: 'texto', telaId: 'parecermp', extra: numero, msgExpirou: 'A prévia do parecer expirou. Refaça a ação.' });
}

// Commit do parecer (gera PNG, posta nos autos, sorteia juiz/arquiva). `usarRevisado` decide
// se publica o texto original ou o revisado pela IA — a `acao` vem do próprio rascunho.
async function executarParecerMp(interaction, numero, modo) {
  const chaveP = chaveParecer(interaction.user.id, numero);
  const d = rascunhoDecisao.get(chaveP);
  if (!d) return interaction.reply({ content: 'A prévia do parecer expirou. Refaça a ação.', ephemeral: true }).catch(() => {});
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true }).catch(() => {});
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor responsável por este processo pode decidir — no caso, <@${processo.promotor}>.`, ephemeral: true }).catch(() => {});
  }

  // Defer antes do PNG (Puppeteer) — mesma razão de salvarSentenca: sem isso a janela de 3s
  // do Discord estoura enquanto o Chromium sobe, e a interação "falha" mesmo com tudo certo.
  await interaction.deferReply({ ephemeral: true });
  rascunhoDecisao.delete(chaveP);
  const acao = d.acao;
  const parecer = await resolverTextoFinal(d, modo, 'texto');
  const nomeReu = processo.reuNome || (
    (processo.reus || []).length
      ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(interaction.guild, id)))).join(' e ')
      : 'o(a) indiciado(a)'
  );
  const crimeDescricao = (processo.crimes || []).map(c => crimeLabel(c)).join(', ') || 'crime não especificado';
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

  if (acao === 'oferecer') {
    // Exclui também o(s) réu(s) já identificado(s) — sem isso, nada impedia sortear como Juiz
    // a mesma conta que é ré no próprio processo que estaria julgando.
    const excluir = [processo.delegado, processo.promotor, ...(processo.reus || [])];
    const juizId = rh.sortearJuiz({ excluirIds: excluir });
    if (!juizId) {
      // Sem Juiz agora: marca estado próprio pra o job de retry penal distribuir depois
      // (verificarProcessosPenaisSemJuiz, prazos.js) — antes o processo ficava preso pra sempre.
      db.atualizar('processos', numero, { status: 'Denúncia oferecida - aguardando juiz' });
      return interaction.editReply({ content: `Parecer registrado e denúncia oferecida no processo ${numero}. Não há Juiz disponível agora, mas assim que houver um elegível o processo é **distribuído automaticamente** (o bot verifica a cada 10 min).` });
    }

    db.atualizar('processos', numero, { status: 'Instrução', juiz: juizId, juizDesde: new Date().toISOString() });
    if (canal) {
      await canais.adicionarMembro(canal, juizId);
      const reusTxt = (processo.reus || []).map(id => `<@${id}>`).join(', ') || 'réu(s) a identificar';
      const msgPainel = await canal.send({
        content: documentos.despachoRecebimentoDenuncia({ numero, tipo: processo.tipo, reusTxt, juizId, autorId: interaction.user.id }),
        components: montarPainelAcoes(db.buscarPorNumero('processos', numero)),
      });
      db.atualizar('processos', numero, { painelMsgId: msgPainel.id });
    }

    await auditoria.registrar(interaction.guild, { acao: 'Denúncia oferecida', executorId: interaction.user.id, referencia: `Processo ${numero} → Juiz <@${juizId}>` });
    await postarOuAtualizarCapaPublica(interaction.guild, numero);
    return interaction.editReply({ content: `Denúncia oferecida no processo ${numero}. Juiz sorteado: <@${juizId}>.` });
  }

  db.atualizar('processos', numero, { status: 'Arquivado' });
  if (canal) {
    await canais.arquivarCanal(canal);
    await canal.send({ content: `<@${processo.delegado}>`, components: [botaoPedirRevisao(numero)] });
  }
  await auditoria.registrar(interaction.guild, { acao: 'Processo arquivado (MP)', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  // NÍVEL 1 — arquivamento de inquérito publica no Diário na hora (efeito automático por natureza).
  await diarioAtos.publicarAto(interaction.guild, 'arquivamentoInquerito', db.buscarPorNumero('processos', numero));
  return interaction.editReply({ content: `Processo ${numero} arquivado.` });
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
  // Intimar réu (abre defesa) — só penal com Juiz e enquanto a intimação do réu não foi cumprida.
  // Some do painel assim que cumprida (habilitação por código, Parte A).
  {
    id: 'intimar_reu', grupo: 1, cargo: ['Juiz'],
    quando: (p) => p.tipo === 'Penal' && !!p.juiz && !p.intimacaoReuCumpridaEm,
    botao: (numero) => botaoIntimarReu(numero),
  },
  {
    // Citação do réu no civil (inicia o prazo de contestação) — a intimação genérica NÃO faz
    // isso; só o "Receber e intimar" dispara a transição pra "Aguardando contestação". Antes só
    // existia na mensagem de abertura (ficava enterrada); agora nasce no painel também.
    id: 'citar_reu_civil', grupo: 1, cargo: ['Juiz'],
    quando: (p) => p.tipo === 'Civil' && p.status === 'Aguardando defesa',
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:processo:recebereintimar:${numero}`).setLabel('📨 Receber e citar réu').setStyle(ButtonStyle.Success),
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

  // ---- Destravar caso preso sem julgador (Frente 1): só aparece quando o processo está parado
  // esperando Juiz (sorteio não achou cargo elegível). Clique gateado à Supervisão/Staff no handler
  // (supervisao.designarJulgador). Mesmo caminho oferecido pelo aviso automático de "sem Juiz". ----
  {
    id: 'designar_juiz', grupo: 1, cargo: ['Desembargador', 'Procurador'],
    quando: (p) => p.status === 'Aguardando sorteio de juiz' || p.status === 'Denúncia oferecida - aguardando juiz',
    botao: (numero) => new ButtonBuilder().setCustomId(`painel:acao:supervisao:designarjulgador:${numero}`).setLabel('⚖️ Designar Juiz').setStyle(ButtonStyle.Primary),
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
  // Anexar prova (lote 5, Função 5) — qualquer parte do processo, em qualquer fase não-terminal.
  // O gate real ("é parte do processo") acontece no clique (ehParteDoProcesso).
  {
    id: 'anexar_prova', grupo: 2, cargo: ['qualquer'],
    quando: () => true,
    botao: (numero) => botaoAnexarProva(numero),
  },
  // Rol de provas — só nasce quando já há ao menos uma prova, pra não poluir o painel.
  {
    id: 'rol_provas', grupo: 2, cargo: ['qualquer'],
    quando: (p) => (p.provas || []).length > 0,
    botao: (numero) => botaoRolProvas(numero),
  },
  // Gerenciar dados (lote 5, Função 1) — RG/nome/crime. Gate real por fase no clique
  // (podeGerenciarProcesso: inquérito=Delegado, com juiz=Juiz/Promotor, Staff sempre).
  {
    id: 'gerenciar', grupo: 2, cargo: ['Delegado', 'Juiz', 'Promotor'],
    quando: () => true,
    botao: (numero) => botaoGerenciar(numero),
  },
  // Voltar fase (lote 5, Função 3) — só nasce quando há uma volta direta possível (alvoVoltarFase).
  // Ato concluído (sentença/arquivamento de mérito) não aparece aqui: vai pelo caminho de anulação.
  {
    id: 'voltar_fase', grupo: 2, cargo: ['Juiz', 'Desembargador', 'Procurador'],
    quando: (p) => temVoltarFase(p),
    botao: (numero) => botaoVoltarFase(numero),
  },
  // Manifestação do MP (prompt_manifestacao_mp) — ponto único do MP no processo penal, qualquer
  // fase. Gate real (ehMembroDoMp) no clique. Roteia pros fluxos existentes + manifestação livre.
  {
    id: 'manifestacao_mp', grupo: 1, cargo: ['Promotor'],
    quando: (p) => p.tipo === 'Penal',
    botao: (numero) => botaoManifestacaoMp(numero),
  },
  // Supervisão do caso (Parte 2) — trocar Juiz/Promotor/Delegado sem sair do canal. Só nasce
  // enquanto houver responsável a trocar; gate real (Desembargador/Procurador/Staff) no clique.
  {
    id: 'supervisao_ticket', grupo: 2, cargo: ['Desembargador', 'Procurador'],
    quando: (p) => responsaveis.papeisTrocaveis('processos', p).length > 0,
    botao: (numero) => responsaveis.botaoSupervisaoTicket('processos', numero),
  },
];

// Fonte única do customId: pega o botão de uma ação pelo id do catálogo. A string do customId vive
// SÓ aqui no catálogo, então os hubs (Fase 4) e qualquer outra "view" derivam daqui sem divergir.
function botaoDoCatalogo(id, numero) {
  const acao = CATALOGO_ACOES.find(a => a.id === id);
  if (!acao) throw new Error(`botaoDoCatalogo: ação "${id}" não existe no CATALOGO_ACOES`);
  return acao.botao(numero);
}

function acaoDoCatalogo(id) {
  return CATALOGO_ACOES.find(a => a.id === id);
}

// Empacota uma lista de botões em ActionRows (máx. 5 por linha, limite do Discord).
function empacotarBotoes(botoes) {
  const linhas = [];
  for (let i = 0; i < botoes.length; i += 5) {
    linhas.push(new ActionRowBuilder().addComponents(botoes.slice(i, i + 5)));
  }
  return linhas;
}

// ---- Fase 4: HUD por cargo (hubs) ----
// O painel do processo agrupa as ações por CARGO. Cada hub é UM botão na mensagem compartilhada do
// canal; clicar abre um submenu EFÊMERO (só quem clicou vê) com as ações daquele cargo que se
// aplicam à FASE (quando) E ao CARGO de quem clicou. O gate real de cada ação continua no seu
// handler (esconder é só UX). Os hubs reusam o CATALOGO_ACOES (mesmos customIds e handlers) — são
// camada de apresentação, não um segundo sistema de permissão: a visibilidade por cargo sai do
// próprio campo `cargo` do catálogo. Ações compartilhadas (ex.: Anexar prova, Registrar depoimento)
// aparecem em mais de um hub chamando A MESMA função/botão do catálogo, sem duplicar código.
const HUBS_PROCESSO = [
  {
    id: 'hubjuiz', label: '⚖️ Juiz', estilo: ButtonStyle.Primary,
    visivel: (p) => !!p.juiz,
    acoes: ['julgar', 'intimar_reu', 'citar_reu_civil', 'emitir_intimacao', 'emitir_mandado', 'registrar_depoimento', 'parte_tardia', 'gerenciar_defesa', 'arquivar_manual', 'voltar_fase', 'gerenciar'],
  },
  {
    id: 'hubmp', label: '🏛️ Ministério Público', estilo: ButtonStyle.Primary,
    visivel: (p) => p.tipo === 'Penal',
    // O "peticionar" do MP é a Manifestação do MP (o gate de peticionar é advogado-parte; o MP
    // manifesta/requer por aqui — oferecer denúncia, arquivar, medida, requerimento livre).
    acoes: ['manifestacao_mp', 'solicitar_medida', 'registrar_depoimento', 'anexar_prova'],
  },
  {
    id: 'hubadvogado', label: '📎 Advogado / Defesa', estilo: ButtonStyle.Secondary,
    visivel: () => true,
    acoes: ['peticionar', 'anexar_prova', 'rol_provas'],
  },
  {
    id: 'hubdelegado', label: '🚓 Delegado', estilo: ButtonStyle.Secondary,
    visivel: (p) => p.tipo === 'Penal' && !p.juiz,
    acoes: ['identificar_reu', 'anexar_relatorio', 'gerenciar', 'registrar_depoimento'],
  },
];

// Ações universais que ficam como botão DIRETO no painel (fora de hub) — qualquer parte precisa
// delas em qualquer fase/tipo, então não faz sentido escondê-las atrás de um cargo. (Histórico e
// "Solicitar documento externo" são `cargo: qualquer`; "Designar Juiz" é ação de destravamento.)
const ACOES_UNIVERSAIS_PAINEL = ['historico', 'solicitar_documento_externo', 'designar_juiz', 'supervisao_ticket'];

function botaoHub(hub, numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:${hub.id}:${numero}`).setLabel(hub.label).setStyle(hub.estilo);
}

// Uma ação é visível para ESTE clicker? Reusa o metadado `cargo` do catálogo (não cria sistema
// novo): 'qualquer' → todos; senão precisa ter um dos cargos (temCargo) ou ser staff/admin. É só
// filtro de UX no submenu efêmero — o gate de verdade continua no handler de cada ação.
function acaoVisivelParaClicker(interaction, acao) {
  if ((acao.cargo || []).includes('qualquer')) return true;
  if (isSuperStaff(interaction) || isAdmin(interaction)) return true;
  return (acao.cargo || []).some(c => temCargo(interaction, c));
}

// Monta o painel de ações do processo (Fase 4): um botão por HUB de cargo cuja fase se aplica, mais
// os botões universais. O conteúdo de cada hub é resolvido no clique (abrirHubProcesso), por cargo
// de quem clicou. Em status terminal o painel some (sem ações).
function montarPainelAcoes(processo) {
  if (STATUS_TERMINAIS_PAINEL.includes(processo.status)) return [];
  const botoes = [];
  for (const hub of HUBS_PROCESSO) {
    if (!hub.visivel(processo)) continue;
    // Só cria o botão-hub se ao menos uma ação dele se aplica à fase atual (senão o submenu
    // nasceria vazio pra todo mundo).
    const temAlgo = hub.acoes.some(id => { const a = acaoDoCatalogo(id); return a && a.quando(processo); });
    if (temAlgo) botoes.push(botaoHub(hub, processo.numero));
  }
  for (const id of ACOES_UNIVERSAIS_PAINEL) {
    const a = acaoDoCatalogo(id);
    if (a && a.quando(processo)) botoes.push(a.botao(processo.numero));
  }
  return empacotarBotoes(botoes);
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

// Abre o submenu efêmero de um hub de cargo (Fase 4) — só quem clicou enxerga. Mostra as ações do
// hub aplicáveis à fase (quando) E visíveis pro cargo de quem clicou; cada ação reusa o botão do
// catálogo (mesmo customId/handler), então o gate real continua no handler da ação (esconder é UX).
async function abrirHubProcesso(interaction, hubId, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  const hub = HUBS_PROCESSO.find(h => h.id === hubId);
  if (!hub) return interaction.reply({ content: 'Menu indisponível.', ephemeral: true });

  const acoes = hub.acoes
    .map(acaoDoCatalogo)
    .filter(a => a && a.quando(processo) && acaoVisivelParaClicker(interaction, a));

  if (acoes.length === 0) {
    return interaction.reply({ content: `Você não tem ações disponíveis em **${hub.label}** neste processo.`, ephemeral: true });
  }
  return interaction.reply({
    content: `${hub.label} — escolha a ação:`,
    components: empacotarBotoes(acoes.map(a => a.botao(numero))),
    ephemeral: true,
  });
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
    new TextInputBuilder().setCustomId('texto').setLabel('Depoimento').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
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

async function criarProcessoPenal({ guild, delegadoId, promotorId, crimesTexto, motivo, reusTexto, reuNome = null, reuRg = null, medidaNumero, atoMpNumero }) {
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
    // Modo CARIMBADO na abertura e nunca mais alterado (SPEC §11.2): quem nasce num rito termina
    // nele. O interruptor da staff só decide o que carimbar aqui — nunca afeta processo em curso.
    modoEntrega: modoEntrega.modoParaNovoProcesso(guild.id),
    crimes: crimesEscolhidos, motivo,
    reus, reuNome, reuRg, advogados: [], delegado: delegadoId || null, promotor: promotorFinal, juiz: null,
    canalId: canal.id, medidaVinculada: medidaNumero || null, atoMpVinculado: atoMpNumero || null, sentenca: null,
    // Registro unificado de partes (spec-atualizacoes-bot-juridico.md, seção 0) — réu(s) já
    // identificado(s) na abertura nascem espelhados aqui (por @ e/ou por nome+RG — Frente 7).
    partes: partesProcesso.espelharPartesDaAbertura({ reus, reuNome, reuRg, adicionadoPor: delegadoId || promotorFinal }),
  });

  // Réu é parte do processo desde que identificado — nunca fica trancado pra fora do canal.
  for (const reuId of reus) await canais.adicionarMembro(canal, reuId);

  const processo = db.buscarPorNumero('processos', numero);
  const mencoes = [delegadoId, promotorFinal].filter(Boolean).map(id => `<@${id}>`).join(' ');
  const msgAbertura = await canal.send({ content: mencoes, embeds: [embedProcesso(processo)], components: montarPainelAcoes(processo) });
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
async function criarProcessoCivil({ guild, advogadoId, nomeAcao, autorNome, autorRg = null, autorDiscordId = null, reuNome, reuRg = null, reuDiscordId = null }) {
  const numero = proximoNumero(db, 'processos', 'CV', p => p.tipo === 'Civil');
  // Discord de autor/réu agora é OPCIONAL (Parte 2): a parte pode existir só com nome (RG+nome
  // é o registro principal). Filtra os nulos pra não tentar adicionar "null" como membro do
  // canal nem excluir null do sorteio.
  const reus = [reuDiscordId].filter(Boolean);

  const canal = await canais.criarCanalTicket(guild, {
    categoriaId: config.categoriaProcessosCiveisId, prefixo: 'processo', numero,
    membros: [...new Set([advogadoId, autorDiscordId, reuDiscordId].filter(Boolean))], bloquearConversa: true,
  });

  // Exclui não só o advogado que abriu, mas autor e réu de verdade — nada impede que a mesma
  // conta que joga de Juiz também seja autor/réu numa causa civil pessoal dela.
  const juizId = rh.sortearJuiz({ excluirIds: [advogadoId, autorDiscordId, reuDiscordId].filter(Boolean) });
  if (juizId) await canais.adicionarMembro(canal, juizId);

  db.inserir('processos', {
    numero, tipo: 'Civil', status: juizId ? 'Aguardando defesa' : 'Aguardando sorteio de juiz',
    // Ver o mesmo carimbo em criarProcessoPenal — SPEC §11.2.
    modoEntrega: modoEntrega.modoParaNovoProcesso(guild.id),
    crimes: [], motivo: nomeAcao,
    autorNome, autorRg, autorDiscordId, reuNome, reuRg,
    reus, advogados: [advogadoId], delegado: null, promotor: null, juiz: juizId,
    juizDesde: juizId ? new Date().toISOString() : null,
    canalId: canal.id, medidaVinculada: null, sentenca: null, autor: advogadoId,
    // Registro unificado de partes (spec-atualizacoes-bot-juridico.md, seção 0) — autor e réu já
    // nascem espelhados aqui também (com RG), sem substituir autorNome/reuNome/reus.
    partes: partesProcesso.espelharPartesDaAbertura({ reus, reuNome, reuRg, autorId: autorDiscordId, autorNome, autorRg, adicionadoPor: advogadoId }),
  });

  const processo = db.buscarPorNumero('processos', numero);
  const componentes = [botoesCivilAbertura(numero), botaoAnexarPeticaoInicial(numero)];
  if (juizId) componentes.push(...montarPainelAcoes(processo));
  const avisoSemJuiz = juizId ? '' : '\n\n⚠️ **Nenhum Juiz foi sorteado ainda.** Não há Juiz elegível — provavelmente porque o único Juiz cadastrado é parte/advogado deste processo (juiz não julga a própria causa), ou não há Juiz cadastrado. Assim que existir um Juiz elegível, o sorteio acontece **automaticamente** (o bot tenta de novo a cada 10 min). O painel completo (Julgar, etc.) aparece quando houver Juiz.';
  await canal.send({
    content: `<@${advogadoId}>${juizId ? ` <@${juizId}>` : ''}\n📎 Clique em **"Anexar petição inicial"** abaixo pra juntar o PDF aos autos.${avisoSemJuiz}`,
    embeds: [embedProcesso(processo)], components: componentes,
  });

  await andamentos.registrar(guild, numero, {
    tipo: 'processo_aberto', titulo: `📁 Processo Civil ${numero} aberto`,
    detalhe: `Autor: ${autorNome} — Réu: ${reuNome}`, executorId: advogadoId, metadata: {},
  });
  // Sem gravar painelMsgId aqui: a mensagem de abertura mistura o painel geral com botões de
  // uso único desta fase ("Anexar petição inicial") — se repostarPainel limpasse os componentes
  // dela mais tarde, apagaria também um botão que ainda pode ser necessário.

  await postarOuAtualizarCapaPublica(guild, numero);
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

  const coletado = await coletarAnexoPdf(interaction, { numero, tipo: 'peticao_inicial', protocolo: numero });
  if (!coletado) return; // coletarAnexoPdf já avisou o motivo (tempo esgotado ou não é PDF)
  const { anexo } = coletado;

  const componentesRestantes = (interaction.message?.components || []).filter(row =>
    !(row.components || []).some(c => c.customId === `painel:acao:processo:anexarpeticaoinicial:${numero}`),
  );
  if (interaction.message) await interaction.message.edit({ components: componentesRestantes }).catch(() => {});

  await interaction.followUp({ content: `📎 Petição inicial anexada por <@${interaction.user.id}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos.` });

  // IA "cartório" lê a petição inicial e resume pro Juiz (best-effort). Se off/falhar, segue sem.
  const canalPI = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canalPI) {
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'peticao_inicial', pdfUrl: anexo.url });
    if (processo.juiz || embedAnalise) {
      await canalPI.send({ content: `${processo.juiz ? `<@${processo.juiz}> — ` : ''}petição inicial juntada aos autos.`, embeds: embedAnalise ? [embedAnalise] : [] });
    }
  }
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

  const coletado = await coletarAnexoPdf(interaction, { numero, tipo: 'relatorio_inquerito', protocolo: numero });
  if (!coletado) return;
  const { anexo } = coletado;

  const linhasAtualizadas = (interaction.message?.components || []).map(row => {
    const mantidos = (row.components || []).filter(c => c.customId !== `painel:acao:processo:anexarrelatorio:${numero}`);
    return mantidos.length ? new ActionRowBuilder().addComponents(...mantidos) : null;
  }).filter(Boolean);
  if (interaction.message) await interaction.message.edit({ components: linhasAtualizadas }).catch(() => {});

  await interaction.followUp({ content: `📎 Relatório de inquérito anexado por <@${interaction.user.id}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos.` });

  // IA "cartório" faz a ANÁLISE ESTRUTURADA e fiel do relatório pro Promotor (spec_resumo_ia_
  // documentos.md) — extração em embed, não resumo raso. Best-effort: se falhar/estiver off, o
  // relatório já foi juntado; só avisa "resumo indisponível" quando a IA existe mas não respondeu.
  const canalRel = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canalRel) {
    const pingPromotor = processo.promotor ? `<@${processo.promotor}> — ` : '';
    // gerarAnaliseEmbed sempre devolve embed (análise ou aviso visível de indisponibilidade — Frente 5.3).
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'relatorio_inquerito', pdfUrl: anexo.url });
    await canalRel.send({ content: `${pingPromotor}relatório de inquérito juntado aos autos.`, embeds: embedAnalise ? [embedAnalise] : [] });
  }
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

  const coletado = await coletarAnexoPdf(interaction, { numero, tipo: 'contestacao', protocolo: numero });
  if (!coletado) return;
  const { anexo } = coletado;
  db.atualizar('processos', numero, { status: 'Concluso para julgamento', contestacaoEm: new Date().toISOString() });

  if (interaction.message) await interaction.message.edit({ components: [] }).catch(() => {});

  const processoAtualizado = db.buscarPorNumero('processos', numero);
  await interaction.followUp({
    content: `📎 Contestação anexada por <@${interaction.user.id}> em nome de <@${habilitacao.reuId}> — [${anexo.nomeArquivo}](${anexo.url}) juntado(a) aos autos. Processo concluso para julgamento.`,
    embeds: [embedProcesso(processoAtualizado)],
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    // IA "cartório" faz a análise estruturada da contestação pro Juiz (best-effort).
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'contestacao', pdfUrl: anexo.url });
    if (processo.juiz) await canal.send({ content: `<@${processo.juiz}> — contestação anexada, processo concluso para julgamento.`, embeds: embedAnalise ? [embedAnalise] : [] });
    else if (embedAnalise) await canal.send({ content: 'Contestação juntada aos autos.', embeds: [embedAnalise] });
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
    content: documentos.despachoDecretoRevelia({ numero, reusTxt, autorId: interaction.user.id }),
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
  // Penal (habilitação por código): o caso só aparece no canal de advogados DEPOIS que o Juiz
  // marca a intimação do réu como cumprida — antes disso a defesa fica fechada.
  return p.status !== 'Aguardando decisão do MP' && !!p.intimacaoReuCumpridaEm;
}

function temAcessoTotal(interaction, processo) {
  if (isAdmin(interaction) || isSuperStaff(interaction)) return true;
  const uid = interaction.user.id;
  if ([processo.delegado, processo.promotor, processo.juiz, processo.autor].includes(uid)) return true;
  return (processo.habilitacoes || []).some(h => h.advogadoId === uid && h.status === 'Aprovado');
}

// "Capa pública": o que aparece no canal "Advogar - Pegar Casos". No PENAL a capa é CEGA
// (habilitação por código): mostra só o número, nada de réu/autor/crimes — o advogado só descobre
// o caso ao se habilitar com o código que o réu recebeu na intimação. No cível segue detalhada.
function embedCapaPublica(p) {
  if (p.tipo === 'Penal') {
    return new EmbedBuilder()
      .setTitle(`📁 Processo ${p.numero}`)
      .setColor(0xe67e22)
      .setDescription('Caso disponível para **habilitação da defesa**. Clique em **Solicitar habilitação** e informe o nome do cliente, o RG e o **código de 4 dígitos** que consta na intimação do réu.')
      .setFooter({ text: 'Réu, autor e teor são sigilosos — habilite-se para acessar os autos.' });
  }
  const reusTxt = descreverReu(p);
  const embed = new EmbedBuilder()
    .setTitle(`📁 Processo ${p.numero} (${p.tipo})`)
    .setColor(0x3498db)
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

// Publica a capa no canal "Advogar - Pegar Casos" na primeira vez que o processo se torna público, e
// depois disso EDITA o mesmo post a cada mudança relevante (nunca duplica).
async function postarOuAtualizarCapaPublica(guild, numero) {
  if (!config.canalAdvogarPegarCasosId) return;
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo || !processoPublico(processo)) return;

  const canal = await guild.channels.fetch(config.canalAdvogarPegarCasosId).catch(() => null);
  if (!canal || !canal.isTextBased?.()) {
    console.error(`CANAL_ADVOGAR_PEGAR_CASOS_ID (${config.canalAdvogarPegarCasosId}) não é um canal de texto válido — capa do processo ${numero} não foi publicada.`);
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
    console.error(`Falha ao publicar/atualizar o canal "Advogar - Pegar Casos" do processo ${numero}: ${err.message}`);
  }
}

// ---- Intimação do réu com código de habilitação (habilitação por código, Parte A) ----
// Fluxo PENAL: o Juiz emite a intimação do réu (a via que vai pro jogo) com um código de 4 dígitos
// impresso SÓ nela; depois marca "cumprida" quando o réu recebe no jogo — só então o caso aparece
// CEGO no canal de advogados e começa o prazo de 48h para constituir advogado (Parte B).

function botaoIntimarReu(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:intimarreu:${numero}`).setLabel('📃 Intimar réu (abre defesa)').setStyle(ButtonStyle.Primary);
}
function botaoMarcarIntimacaoCumprida(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:intimarreucumprida:${numero}`).setLabel('✅ Marcar intimação cumprida').setStyle(ButtonStyle.Success);
}
function gerarCodigoHabilitacao() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 dígitos
}

async function intimarReu(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.tipo !== 'Penal') return interaction.reply({ content: 'A intimação do réu com código de habilitação é do fluxo penal.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode intimar o réu — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });

  const codigo = processo.codigoHabilitacao || gerarCodigoHabilitacao();
  if (!processo.codigoHabilitacao) db.atualizar('processos', numero, { codigoHabilitacao: codigo });

  const corpoComCodigo = documentos.corpoIntimacaoReu(codigo);

  // Assinatura = quem clicou (o Juiz do processo, ou superstaff no lugar dele).
  const nomeAssinante = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const png = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'intimacao', orgaoEmissor: 'judiciario',
    subunidade: 'Comarca de São Paulo — Vara Criminal',
    tituloDocumento: 'INTIMAÇÃO DO RÉU', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: processo.reuNome || 'Réu(s)', corpoTexto: corpoComCodigo, nomeAssinante, cargoAssinante: 'Juiz de Direito',
  }).catch(err => { console.error('Falha ao gerar PNG da intimação do réu:', err.message); return null; });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canal.send({
      content: '📃 **Intimação do réu emitida** — a via do réu (com o código de habilitação) está no anexo e é a que vai pro jogo. Marque **"intimação cumprida"** quando o réu receber; só então o caso abre para a defesa se habilitar.',
      files: png ? [{ attachment: png, name: `Intimacao-Reu-${numero}.png` }] : [],
      components: [new ActionRowBuilder().addComponents(botaoMarcarIntimacaoCumprida(numero))],
    }).catch(() => {});
  }
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_reu_emitida', titulo: '📃 Intimação do réu emitida',
    detalhe: 'Intimação do réu emitida com código de habilitação impresso na via do réu.', executorId: interaction.user.id,
  });
  return interaction.editReply({ content: `📃 Intimação do réu emitida. **Código de habilitação (via do réu): \`${codigo}\`** — já impresso na via do réu (anexo). Repasse ao réu no jogo. Quando ele receber, clique em **Marcar intimação cumprida**.` });
}

async function marcarIntimacaoReuCumprida(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode marcar a intimação como cumprida — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  if (processo.intimacaoReuCumpridaEm) {
    return interaction.reply({ content: 'A intimação do réu já estava marcada como cumprida.', ephemeral: true });
  }
  db.atualizar('processos', numero, { intimacaoReuCumpridaEm: new Date().toISOString(), avisoPrazoHabilitacaoEnviado: false });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_reu_cumprida', titulo: '✅ Intimação do réu cumprida',
    detalhe: 'O Juiz marcou a intimação do réu como cumprida. Abre a habilitação da defesa — 48h para constituir advogado, senão o Juízo nomeia defensor dativo.',
    executorId: interaction.user.id,
  });
  await auditoria.registrar(interaction.guild, { acao: 'Intimação do réu cumprida', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  await postarOuAtualizarCapaPublica(interaction.guild, numero); // revela a capa cega no canal de advogados
  await repostarPainel(interaction.guild, numero);
  return interaction.update({ content: '✅ Intimação do réu cumprida — habilitação da defesa aberta. O caso aparece (cego) no canal de advogados e o prazo de 48h para constituir advogado começou.', components: [] });
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

  await postarOuAtualizarCapaPublica(guild, numero);
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
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo da parte').setPlaceholder('Ex: Ricardo Fernandes').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG da parte').setPlaceholder('Ex: 12.345.678-9').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mencao').setLabel('Menção @ Discord (opcional)').setPlaceholder('Vazio se a pessoa não tem Discord').setStyle(TextInputStyle.Short).setRequired(false)),
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

  const nomeCompleto = (interaction.fields.getTextInputValue('nomeCompleto') || '').trim() || null;
  const rg = (interaction.fields.getTextInputValue('rg') || '').trim() || null;
  const discordId = extrairMencoes(interaction.fields.getTextInputValue('mencao') || '')[0] || null;
  // RG + nome é o registro principal (Parte 2); Discord é opcional. Só barra se não veio NADA.
  if (!discordId && !nomeCompleto && !rg) {
    return interaction.reply({ content: 'Informe pelo menos o **nome** ou o **RG** da parte (a menção do Discord é opcional).', ephemeral: true });
  }

  if (papel === 'reu') {
    // Com Discord: reaproveita vincularReu (libera acesso ao canal, embed, publicação em "Advogar - Pegar Casos", auditoria).
    if (discordId) {
      const resultado = await vincularReu({ guild: interaction.guild, numero, reusTexto: `<@${discordId}>`, executorId: interaction.user.id });
      if (resultado.erro) return interaction.reply({ content: resultado.erro, ephemeral: true });
      partesProcesso.adicionarParte(numero, { papel: 'reu', nome: nomeCompleto, rg, discordId, origem: 'parte_tardia', adicionadoPor: interaction.user.id });
      return interaction.reply({ content: `Réu adicionado ao processo ${numero}, com acesso liberado no canal.`, ephemeral: true });
    }
    // Sem Discord: réu registrado só por nome (sem acesso ao canal, que exige conta no Discord).
    partesProcesso.adicionarParte(numero, { papel: 'reu', nome: nomeCompleto, discordId: null, origem: 'parte_tardia', adicionadoPor: interaction.user.id });
    const canalReu = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canalReu) await canalReu.send({ content: `📋 <@${interaction.user.id}> identificou **${nomeCompleto}** como **réu** neste processo (registrado por nome — sem conta no Discord).` });
    await andamentos.registrar(interaction.guild, numero, {
      tipo: 'parte_tardia_reu', titulo: '⚖️ Réu identificado (por nome)',
      detalhe: `**${nomeCompleto}** registrado como réu por <@${interaction.user.id}> (sem Discord).`,
      executorId: interaction.user.id, metadata: { nome: nomeCompleto },
    });
    await repostarPainel(interaction.guild, numero);
    return interaction.reply({ content: `Réu **${nomeCompleto}** registrado no processo ${numero} (sem acesso ao canal — não tem Discord).`, ephemeral: true });
  }

  // Testemunha NÃO ganha acesso ao canal — só fica registrada, disponível pra depoimento
  // (seção 0) e, nas próximas fases, pra mandado/intimação escolherem ela como destinatário.
  partesProcesso.adicionarParte(numero, { papel, nome: nomeCompleto, rg, discordId, origem: 'parte_tardia', adicionadoPor: interaction.user.id });

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

// ---- Habilitação de advogado (nome + RG do cliente, réu específico, aprovação do Juiz) ----

// Normaliza nome/RG pra comparação tolerante (sem acento/caixa/pontuação) — usado na validação
// da habilitação por código (o advogado tem que acertar os dados do réu).
function normalizarDado(s) {
  return normalizarCrime(s).replace(/[.\-\s/]/g, '');
}
function dadosBatemComReu(processo, nome, rg) {
  const nomeIn = normalizarDado(nome);
  const rgIn = normalizarDado(rg);
  const alvos = [{ nome: processo.reuNome, rg: processo.reuRg }];
  for (const p of (processo.partes || [])) {
    if (/r[ée]u/i.test(p.papel || '')) alvos.push({ nome: p.nome, rg: p.rg });
  }
  return alvos.some(a => a.nome && a.rg && normalizarDado(a.nome) === nomeIn && normalizarDado(a.rg) === rgIn);
}
// Réu "identificado" = existe algum alvo (reuNome/reuRg do processo, ou parte com papel réu) com
// nome E RG preenchidos. Sem isso não há contra o que conferir os dados informados, e o inquérito
// pode ser intimado (gerando código) antes de o réu ter RG nos autos — então cobrar dadosBatemComReu
// nesse estado travaria toda habilitação mesmo com o código certo.
function reuIdentificado(processo) {
  const alvos = [{ nome: processo.reuNome, rg: processo.reuRg }];
  for (const p of (processo.partes || [])) {
    if (/r[ée]u/i.test(p.papel || '')) alvos.push({ nome: p.nome, rg: p.rg });
  }
  return alvos.some(a => a.nome && a.rg);
}
function habilitacaoBloqueada(processo, uid) {
  const t = (processo.tentativasHabilitacao || []).find(x => x.advogadoId === uid);
  return !!(t && t.erros >= 3);
}

async function abrirModalHabilitacao(interaction, numero) {
  if (!temCargo(interaction, 'Advogado')) {
    return interaction.reply({ content: 'Só Advogados podem solicitar habilitação.', ephemeral: true });
  }
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!processoPublico(processo)) {
    return interaction.reply({ content: 'Esse processo ainda não está aberto para habilitação da defesa.', ephemeral: true });
  }
  if (!processo.juiz) {
    return interaction.reply({ content: 'Esse processo ainda não tem Juiz sorteado — tente novamente em instantes.', ephemeral: true });
  }
  if ((processo.habilitacoes || []).some(h => h.advogadoId === interaction.user.id && (h.status === 'Pendente' || h.status === 'Aprovado'))) {
    return interaction.reply({ content: 'Você já tem um pedido de habilitação (pendente ou aprovado) neste processo.', ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`painel:modal:habilitacao:solicitar:${numero}`).setTitle('Solicitar habilitação');
  if (processo.tipo === 'Penal') {
    // Habilitação por CÓDIGO (Parte A). Bloqueia após 3 tentativas erradas.
    if (habilitacaoBloqueada(processo, interaction.user.id)) {
      return interaction.reply({ content: '🚫 Você atingiu 3 tentativas erradas e está bloqueado para habilitação neste processo. Fale com a Supervisão se for engano.', ephemeral: true });
    }
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente (réu)').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('codigo').setLabel('Código de 4 dígitos (da intimação do réu)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(4)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aviso').setLabel('Digite SIM (ciente do aviso)').setPlaceholder('Dados falsos ou adivinhar o código = infração sujeita a sanção').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)),
    );
  } else {
    // Cível — fluxo antigo, intocado (nome/RG + menção opcional do réu).
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome completo do cliente (réu)').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rg').setLabel('RG do cliente').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reu').setLabel('Menção @ do réu (opcional)').setPlaceholder('Vazio se o réu não tem Discord').setStyle(TextInputStyle.Short).setRequired(false)),
    );
  }
  return interaction.showModal(modal);
}

async function criarHabilitacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  return processo.tipo === 'Penal'
    ? criarHabilitacaoPenal(interaction, processo, numero)
    : criarHabilitacaoCivil(interaction, processo, numero);
}

// Penal: valida código (100%) + dados do réu; 3ª tentativa errada bloqueia + loga.
async function criarHabilitacaoPenal(interaction, processo, numero) {
  const uid = interaction.user.id;
  if (habilitacaoBloqueada(processo, uid)) {
    return interaction.reply({ content: '🚫 Você está bloqueado para habilitação neste processo (3 tentativas erradas).', ephemeral: true });
  }
  const nomeCliente = (interaction.fields.getTextInputValue('nome') || '').trim();
  const rgCliente = (interaction.fields.getTextInputValue('rg') || '').trim();
  const codigoInformado = (interaction.fields.getTextInputValue('codigo') || '').trim();

  const codigoOk = !!processo.codigoHabilitacao && codigoInformado === processo.codigoHabilitacao;
  // Se o réu ainda não foi identificado nos autos (sem nome+RG), não há como conferir os dados
  // informados — a habilitação se apoia só no código (entregue de forma privada na intimação).
  // Assim o código continua funcionando e o advogado não é bloqueado por um dado que ninguém tem.
  const reuJaIdentificado = reuIdentificado(processo);
  const dadosOk = !reuJaIdentificado || dadosBatemComReu(processo, nomeCliente, rgCliente);

  if (!codigoOk || !dadosOk) {
    const tentativas = processo.tentativasHabilitacao || [];
    const entrada = tentativas.find(t => t.advogadoId === uid);
    const erros = (entrada?.erros || 0) + 1;
    const nova = { advogadoId: uid, erros, bloqueadoEm: erros >= 3 ? new Date().toISOString() : null };
    const atualizadas = entrada ? tentativas.map(t => t.advogadoId === uid ? nova : t) : [...tentativas, nova];
    db.atualizar('processos', numero, { tentativasHabilitacao: atualizadas });
    await auditoria.registrar(interaction.guild, { acao: 'Tentativa de habilitação recusada', executorId: uid, referencia: `Processo ${numero} — tentativa ${erros}/3 (${!codigoOk ? 'código' : 'dados'} incorreto)` });
    if (erros >= 3) {
      await andamentos.registrar(interaction.guild, numero, { tipo: 'habilitacao_bloqueada', titulo: '🚫 Advogado bloqueado (habilitação)', detalhe: `<@${uid}> foi bloqueado após 3 tentativas erradas de habilitação.`, executorId: null, metadata: { advogadoId: uid, tentativas: erros } });
    }
    const msg = erros >= 3
      ? '🚫 Dados ou código incorretos. Você atingiu **3 tentativas** e está **bloqueado** para habilitação neste processo (registrado no log).'
      : `❌ Dados ou código incorretos. Restam **${3 - erros}** tentativa(s). Informar dados falsos ou tentar adivinhar o código é infração sujeita a sanção.`;
    return interaction.reply({ content: msg, ephemeral: true });
  }

  return registrarPedidoHabilitacao(interaction, processo, numero, { nomeCliente, rgCliente, reuId: (processo.reus || [])[0] || null, codigoValidado: true });
}

// Cível: fluxo antigo (nome/RG + menção opcional), sem código.
async function criarHabilitacaoCivil(interaction, processo, numero) {
  const nomeCliente = interaction.fields.getTextInputValue('nome');
  const rgCliente = interaction.fields.getTextInputValue('rg');
  const reuMencao = extrairMencoes(interaction.fields.getTextInputValue('reu') || '')[0] || null;
  const reuId = reuMencao && (processo.reus || []).includes(reuMencao) ? reuMencao : null;
  return registrarPedidoHabilitacao(interaction, processo, numero, { nomeCliente, rgCliente, reuId, codigoValidado: false });
}

// Cria o pedido pendente e encaminha ao Juiz (portão que já existia — aprovação continua do Juiz).
async function registrarPedidoHabilitacao(interaction, processo, numero, { nomeCliente, rgCliente, reuId, codigoValidado }) {
  const uid = interaction.user.id;
  const reuRotulo = reuId ? `<@${reuId}>` : `**${nomeCliente}** (RG ${rgCliente})`;
  const habilitacoes = processo.habilitacoes || [];
  const novoId = habilitacoes.reduce((max, h) => Math.max(max, h.id || 0), 0) + 1;
  const habilitacao = { id: novoId, reuId, reuNome: nomeCliente, advogadoId: uid, nomeCliente, rgCliente, status: 'Pendente', criadoEm: new Date().toISOString() };
  db.atualizar('processos', numero, { habilitacoes: [...habilitacoes, habilitacao] });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal && processo.juiz) {
    const embed = new EmbedBuilder()
      .setTitle(`⚖️ Pedido de habilitação — Processo ${numero}`)
      .setColor(0xf1c40f)
      .addFields(
        { name: 'Advogado', value: `<@${uid}>`, inline: true },
        { name: 'Réu representado', value: reuRotulo, inline: true },
        { name: 'Cliente', value: truncar(`${nomeCliente} — RG ${rgCliente}`) },
      );
    if (codigoValidado) embed.addFields({ name: 'Código', value: '✅ validado', inline: true });
    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`painel:acao:habilitacao:aprovar:${numero}#${novoId}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`painel:acao:habilitacao:negar:${numero}#${novoId}`).setLabel('Negar').setStyle(ButtonStyle.Danger),
    );
    await canal.send({ content: `<@${processo.juiz}>`, embeds: [embed], components: [botoes] });
  }

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'habilitacao_solicitada', titulo: '🖋️ Habilitação de advogado solicitada',
    detalhe: `<@${uid}> pediu habilitação para defender ${reuRotulo}${codigoValidado ? ' (código validado)' : ''}.`,
    executorId: uid, metadata: { habilitacaoId: novoId, advogadoId: uid, reuId, reuNome: nomeCliente },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.reply({ content: `✅ ${codigoValidado ? 'Código validado. ' : ''}Pedido de habilitação enviado ao Juiz do processo.`, ephemeral: true });
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
  // Réu pode ser só nome (sem Discord) — evita exibir "<@null>".
  const reuRef = alvo.reuId ? `<@${alvo.reuId}>` : `**${alvo.reuNome || 'o réu'}**`;

  const novoStatus = aprovar ? 'Aprovado' : 'Negado';
  // aprovadoEm marca o início do prazo de 24h para apresentar defesa (Parte B, penal).
  const atualizadas = habilitacoes.map(h => h.id === habId ? { ...h, status: novoStatus, aprovadoEm: aprovar ? new Date().toISOString() : (h.aprovadoEm || null) } : h);
  db.atualizar('processos', numero, { habilitacoes: atualizadas });

  if (aprovar) {
    const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canal) {
      await canais.adicionarMembro(canal, alvo.advogadoId);
      // Só faz sentido oferecer o botão de contestação se a citação já aconteceu — se ainda
      // não, o botão é postado depois, no momento da citação (ver emitirIntimacao).
      if (processo.tipo === 'Civil' && processo.status === 'Aguardando contestação') {
        await canal.send({ content: `<@${alvo.advogadoId}> — clique abaixo para anexar a contestação em nome de ${reuRef}.`, components: [botaoAnexarContestacao(numero, alvo.id)] });
      }
    }
  }

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'habilitacao_decidida', titulo: `🖋️ Habilitação ${novoStatus.toLowerCase()}`,
    detalhe: `Habilitação de <@${alvo.advogadoId}> para defender ${reuRef} foi ${novoStatus.toLowerCase()}.`,
    executorId: interaction.user.id, metadata: { habilitacaoId: habId, resultado: novoStatus },
  });
  await repostarPainel(interaction.guild, numero);

  const embed = new EmbedBuilder()
    .setColor(aprovar ? 0x2ecc71 : 0xe74c3c)
    .setDescription(`Habilitação de <@${alvo.advogadoId}> para defender ${reuRef} foi **${novoStatus.toLowerCase()}**.`);
  return interaction.update({ embeds: [embed], components: [] });
}

// ---- Gerenciar defesa: adicionar (habilitação direta pelo Juiz/Staff) e remover advogado ----
// "Adicionar advogado" (lote 5, Função 1) é override do fluxo normal (pedido do advogado →
// aprovação): o Juiz/Staff habilita direto por user-select, criando uma habilitação já Aprovada e
// dando acesso ao canal — mesmo efeito da aprovação comum (canais.adicionarMembro).

async function abrirGerenciarDefesa(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode gerenciar a defesa — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const temAprovadas = (processo.habilitacoes || []).some(h => h.status === 'Aprovado');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:addadvogado:${numero}`).setLabel('➕ Adicionar advogado').setStyle(ButtonStyle.Success),
  );
  if (temAprovadas) {
    row.addComponents(new ButtonBuilder().setCustomId(`painel:acao:processo:removeradvogado:${numero}`).setLabel('➖ Remover advogado').setStyle(ButtonStyle.Danger));
  }
  return interaction.reply({ content: '🛡️ **Gerenciar defesa** — o que deseja fazer?', components: [row], ephemeral: true });
}

// Botão "Adicionar advogado" → user-select do advogado.
async function abrirAdicionarAdvogado(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode habilitar advogados — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`painel:userselect:processo:addadvogado#${numero}`).setPlaceholder('Escolha o advogado a habilitar').setMaxValues(1),
  );
  return interaction.update({ content: 'Selecione o advogado a habilitar na defesa:', components: [row] });
}

// User-select do advogado → cria habilitação já Aprovada e concede acesso ao canal.
async function adicionarAdvogadoSelecionado(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.update({ content: 'Processo não encontrado.', components: [] });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.update({ content: `Só o Juiz deste processo pode habilitar advogados — no caso, <@${processo.juiz}>.`, components: [] });
  }
  const advId = interaction.values[0];
  if (!advId) return interaction.update({ content: 'Nenhum advogado selecionado.', components: [] });
  const habilitacoes = processo.habilitacoes || [];
  if (habilitacoes.some(h => h.status === 'Aprovado' && h.advogadoId === advId)) {
    return interaction.update({ content: 'Esse advogado já está habilitado neste processo.', components: [] });
  }
  // Vincula ao réu do processo: 1 réu com Discord → esse; senão, réu por nome/RG (reuId nulo).
  const reuId = (processo.reus || []).length === 1 ? processo.reus[0] : null;
  const novoId = habilitacoes.reduce((max, h) => Math.max(max, h.id || 0), 0) + 1;
  const hab = {
    id: novoId, reuId, reuNome: processo.reuNome || null, advogadoId: advId,
    nomeCliente: processo.reuNome || null, rgCliente: processo.reuRg || null,
    status: 'Aprovado', criadoEm: new Date().toISOString(), aprovadoEm: new Date().toISOString(), adicionadoPor: interaction.user.id,
  };
  db.atualizar('processos', numero, { habilitacoes: [...habilitacoes, hab] });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    await canais.adicionarMembro(canal, advId);
    await canal.send({ content: `<@${advId}> foi habilitado na defesa deste processo por <@${interaction.user.id}>.` }).catch(() => {});
  }
  await auditoria.registrar(interaction.guild, { acao: 'Advogado habilitado (Gerenciar defesa)', executorId: interaction.user.id, referencia: `Processo ${numero}: <@${advId}>` });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'habilitacao_decidida', titulo: '🖋️ Advogado habilitado',
    detalhe: `<@${advId}> habilitado na defesa por <@${interaction.user.id}> (via Gerenciar defesa).`,
    executorId: interaction.user.id, metadata: { habilitacaoId: novoId, resultado: 'Aprovado', advogadoId: advId },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.update({ content: `✅ <@${advId}> habilitado na defesa.`, components: [] });
}

// Botão "Remover advogado" → select das habilitações aprovadas.
async function abrirRemoverAdvogado(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode remover advogados — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const aprovadas = (processo.habilitacoes || []).filter(h => h.status === 'Aprovado');
  if (aprovadas.length === 0) return interaction.update({ content: 'Nenhum advogado habilitado neste processo ainda.', components: [] });

  const opcoes = await Promise.all(aprovadas.map(async h => {
    const adv = await interaction.guild.members.fetch(h.advogadoId).catch(() => null);
    const reu = h.reuId ? await interaction.guild.members.fetch(h.reuId).catch(() => null) : null;
    return {
      label: `${adv?.displayName || 'Advogado'} — defende ${reu?.displayName || h.reuNome || 'réu'}`.slice(0, 100),
      value: String(h.id),
    };
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`painel:select:habilitacao:remover:${numero}`).setPlaceholder('Selecione quem remover').addOptions(opcoes),
  );
  return interaction.update({ content: 'Quem remover da defesa?', components: [row] });
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

  // Réu pode ser só nome/RG (sem Discord): reuId null geraria `<@null>`. Mesma referência que
  // decidirHabilitacao usa — menção se tem Discord, senão o nome.
  const reuRef = alvo.reuId ? `<@${alvo.reuId}>` : `**${alvo.reuNome || 'o réu'}**`;

  const atualizadas = habilitacoes.map(h => h.id === alvo.id ? { ...h, status: 'Removido' } : h);
  db.atualizar('processos', numero, { habilitacoes: atualizadas });

  const aindaTemAcesso = atualizadas.some(h => h.advogadoId === alvo.advogadoId && h.status === 'Aprovado');
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    if (!aindaTemAcesso) await canal.permissionOverwrites.delete(alvo.advogadoId).catch(() => {});
    await canal.send({ content: `<@${alvo.advogadoId}> foi removido da defesa de ${reuRef} pelo Juiz. O réu mantém acesso ao canal.` });
  }

  await auditoria.registrar(interaction.guild, {
    acao: 'Advogado removido da defesa', executorId: interaction.user.id,
    referencia: `Processo ${numero}: <@${alvo.advogadoId}> (defendia ${reuRef})`,
  });

  return interaction.update({ content: `Removido. <@${alvo.advogadoId}> não representa mais ${reuRef} neste processo.`, components: [] });
}

// ---- Intimação (Juiz) ----
// Texto formal vem de utils/documentos.js (textoIntimacao) — compartilhado com a diligência
// de petição, que também precisa intimar alguém a fazer algo dentro de um prazo.

function modalIntimacao(numero, { destinatarioId, destinatarioNome, teorPadrao } = {}) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimar:${numero}`).setTitle('Emitir intimação');
  // O réu já é conhecido desde a abertura (nome+RG, e @ só se tiver Discord). Por isso a menção é
  // OPCIONAL (Frente 5.2): sem Discord, a citação sai identificada por nome+RG — nunca se pede @.
  const campoDest = new TextInputBuilder().setCustomId('destinatario').setLabel('Menção @ do destinatário (opcional)').setStyle(TextInputStyle.Short).setRequired(false);
  if (destinatarioId) campoDest.setValue(`<@${destinatarioId}>`);
  else if (destinatarioNome) campoDest.setPlaceholder(`${destinatarioNome} — sem Discord, deixe vazio`.slice(0, 100));
  const campoTeor = new TextInputBuilder().setCustomId('teor').setLabel('Teor da intimação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
  if (teorPadrao) campoTeor.setValue(teorPadrao);
  modal.addComponents(new ActionRowBuilder().addComponents(campoDest), new ActionRowBuilder().addComponents(campoTeor));
  return modal;
}

// Destinatário + teor pré-setado (spec-atualizacoes-bot-juridico.md, seção 4) — só pro botão
// GENÉRICO "Emitir intimação". O "Receber e intimar" da petição inicial civil (abaixo) continua
// exatamente como sempre foi, com preenchimento automático próprio — não usa nada disto.

function selectTeorIntimacao(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Qual o teor da intimação?')
      .addOptions(Object.entries(documentos.TEOR_PRESETS_INTIMACAO).map(([value, { label }]) => ({ label, value }))),
  );
}

// Reaproveitada tanto pelo fluxo genérico (abaixo) quanto por emitirIntimacao (citação/intimação
// clássica) — mesmo PNG, mesmo texto formal, só muda de onde vêm destinatário e teor.
async function postarIntimacaoNoCanal({ guild, processo, numero, destinatarioId, destinatarioNome, teor, assinanteId = null }) {
  const canal = await guild.channels.fetch(processo.canalId).catch(() => null);
  if (!canal) return null;

  // Assinatura = quem clicou/emitiu (assinanteId); em fluxo automático (sem clique) cai no Juiz do processo.
  const [nomeDestinatario, nomeAssinante] = await Promise.all([
    destinatarioId ? documentoPng.nomeExibicao(guild, destinatarioId) : Promise.resolve(destinatarioNome || 'Destinatário'),
    documentoPng.nomeExibicao(guild, assinanteId || processo.juiz),
  ]);
  const pngIntimacao = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'intimacao', orgaoEmissor: 'judiciario',
    subunidade: processo.tipo === 'Penal' ? 'Comarca de São Paulo — Vara Criminal' : 'Comarca de São Paulo — Vara Cível',
    tituloDocumento: 'INTIMAÇÃO', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: nomeDestinatario, corpoTexto: teor, nomeAssinante, cargoAssinante: 'Juiz de Direito',
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
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idTexto').setLabel('RG ou Discord ID').setStyle(TextInputStyle.Short).setRequired(true)),
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
  const { discordId, rg } = partesProcesso.classificarIdLivre(idTexto);
  const novaParte = partesProcesso.adicionarParte(numero, { papel: 'terceiro', nome: nomeCompleto, discordId, rg, origem: 'manual_mandado', adicionadoPor: interaction.user.id });
  return interaction.reply({
    content: 'Qual o teor da intimação?',
    components: [selectTeorIntimacao(`painel:select:processo:teorintimacao:${numero}#${novaParte.id}`)],
    ephemeral: true,
  });
}

async function processarSelecaoTeorIntimacao(interaction, chaveDestinatario) {
  const [numero, destinatarioRef] = chaveDestinatario.split('#');
  const preset = documentos.TEOR_PRESETS_INTIMACAO[interaction.values[0]];
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:intimargenerico:${numero}#${destinatarioRef}`).setTitle(`Intimação — ${preset.label}`.slice(0, 45));
  const campoTeor = new TextInputBuilder().setCustomId('teor').setLabel('Teor da intimação').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
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
  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a intimação sendo emitida com sucesso.
  await interaction.deferReply({ ephemeral: true });
  await postarIntimacaoNoCanal({ guild: interaction.guild, processo, numero, destinatarioId: parte?.discordId || null, destinatarioNome: parte?.nome || null, teor, assinanteId: interaction.user.id });

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_emitida', titulo: '✉️ Intimação emitida',
    detalhe: `Destinatário: ${parte?.discordId ? `<@${parte.discordId}>` : (parte?.nome || 'não identificado')}\nTeor: ${teor}`,
    executorId: interaction.user.id, metadata: { destinatarioId: parte?.discordId || null, destinatarioNome: parte?.nome || null, ehCitacao: false },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.editReply({ content: 'Intimação emitida e postada no canal do processo.' });
}

async function abrirModalReceberEIntimar(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode receber a petição inicial — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const reuId = (processo.reus || [])[0];
  // Sem Discord, o réu ainda é conhecido por nome+RG (gravados na abertura) — vira a dica do campo
  // e o destinatário do documento, sem forçar o Juiz a arranjar um @ (Frente 5.2).
  const reuNomeRg = processo.reuNome ? `${processo.reuNome}${processo.reuRg ? ` (RG ${processo.reuRg})` : ''}` : null;
  const teorPadrao = documentos.teorCitacao(config.prazoContestacaoDias);
  return interaction.showModal(modalIntimacao(numero, { destinatarioId: reuId, destinatarioNome: reuNomeRg, teorPadrao }));
}

async function emitirIntimacao(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });

  const teor = interaction.fields.getTextInputValue('teor');
  // Destinatário: @ digitado tem prioridade; sem @, cai no réu já guardado (Discord, se houver;
  // senão nome+RG). Citação do réu não exige Discord (Frente 5.2) — só barra se não houver NENHUMA
  // identidade (nem @ digitado, nem réu na abertura).
  const destId = extrairMencoes(interaction.fields.getTextInputValue('destinatario'))[0] || (processo.reus || [])[0] || null;
  const destinatarioNome = !destId && processo.reuNome
    ? `${processo.reuNome}${processo.reuRg ? ` (RG ${processo.reuRg})` : ''}`
    : null;
  if (!destId && !destinatarioNome) {
    return interaction.reply({ content: 'Não há destinatário identificado. Marque o destinatário com @menção, ou informe o réu (nome/RG) na abertura do processo.', ephemeral: true });
  }

  // "Receber e intimar" (abertura do civil) usa o MESMO modal/customId que "Emitir intimação"
  // genérico — não dá pra distinguir pelo customId. O que diferencia é o momento: só é uma
  // CITAÇÃO (com prazo automático de contestação) quando o civil ainda está na fase pré-citação.
  const ehCitacaoCivil = processo.tipo === 'Civil' && processo.status === 'Aguardando defesa';

  // Defer antes do PNG (Puppeteer) — sem isso a janela de 3s do Discord estoura enquanto o
  // Chromium sobe e a interação "falha" mesmo com a intimação/citação sendo emitida com sucesso.
  await interaction.deferReply({ ephemeral: true });
  const canal = await postarIntimacaoNoCanal({ guild: interaction.guild, processo, numero, destinatarioId: destId, destinatarioNome, teor, assinanteId: interaction.user.id });

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

  const destinatarioLabel = destId ? `<@${destId}>` : (destinatarioNome || 'não identificado');
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'intimacao_emitida', titulo: ehCitacaoCivil ? '✉️ Citação emitida' : '✉️ Intimação emitida',
    detalhe: `Destinatário: ${destinatarioLabel}\nTeor: ${teor}`,
    executorId: interaction.user.id, metadata: { destinatarioId: destId, destinatarioNome, ehCitacao: ehCitacaoCivil, prazoContestacaoAte },
  });
  await repostarPainel(interaction.guild, numero);

  return interaction.editReply({ content: 'Intimação emitida e postada no canal do processo.' });
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
      content: documentos.despachoIndeferimentoInicial({ numero, autorId: interaction.user.id }),
    });
    await canais.arquivarCanal(canal);
  }

  await auditoria.registrar(interaction.guild, { acao: 'Petição inicial arquivada (civil)', executorId: interaction.user.id, referencia: `Processo ${numero}` });
  // NÍVEL 1 — indeferimento da petição inicial cível publica no Diário na hora.
  await diarioAtos.publicarAto(interaction.guild, 'indeferimentoInicial', db.buscarPorNumero('processos', numero));
  await postarOuAtualizarCapaPublica(interaction.guild, numero);
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

  // Frente 2.3 — só advogado PARTE do processo peticiona (antes: qualquer Advogado em qualquer
  // processo). É parte: o advogado do autor no cível (processo.autor) OU um advogado com habilitação
  // APROVADA (defesa) — mesmo critério de anexarContestacao. Staff Salve como reserva.
  const ehAutor = !!processo.autor && processo.autor === interaction.user.id;
  const ehHabilitado = (processo.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === interaction.user.id);
  if (!ehAutor && !ehHabilitado && !isSuperStaff(interaction)) {
    return interaction.reply({ content: 'Você não é advogado habilitado neste processo. Para peticionar aqui, seja o advogado do autor (cível) ou solicite e obtenha a **habilitação da defesa** antes.', ephemeral: true });
  }

  // BIFURCAÇÃO POR MODO — mesmo botão, dois ritos. O advogado continua clicando em "Peticionar",
  // que é onde ele já procura; o que muda é o que acontece depois.
  //
  // Processo LEGADO segue no anexo de PDF, daqui até o fim: quem abriu o caso de um jeito não pode
  // ser surpreendido no meio (SPEC §11.2). Processo novo vai para o formulário, que gera a peça.
  //
  // Ligar aqui, e não criar um botão novo, também é o que impede o pior caso: um processo legado
  // exibindo um botão que só recusa. Botão que não deveria estar ali é pior que botão ausente.
  if (require('../utils/pecas').modoDoProcesso(processo) !== 'legado') {
    return require('../utils/emissaoPeca').abrirEmissao(interaction, 'peticao_incidental', numero);
  }

  const anexo = await aguardarAnexoPDF(interaction);
  if (!anexo) return;

  const peticoesDoProcesso = processo.peticoes || [];
  const novoId = peticoesDoProcesso.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  const peticaoNova = { id: novoId, advogadoId: interaction.user.id, url: anexo.url, nomeArquivo: anexo.nomeArquivo, status: 'Pendente', criadaEm: new Date().toISOString() };
  const patchPeticao = { peticoes: [...peticoesDoProcesso, peticaoNova] };
  // Penal: a 1ª petição de um advogado habilitado (constituído ou dativo) conta como DEFESA
  // apresentada — cumpre o prazo de 24h e para o re-sorteio de defensor dativo (Parte B).
  const ehDefensor = (processo.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === interaction.user.id);
  if (processo.tipo === 'Penal' && ehDefensor && !processo.defesaApresentadaEm) {
    patchPeticao.defesaApresentadaEm = new Date().toISOString();
  }
  db.atualizar('processos', numero, patchPeticao);

  anexos.criarDocumento({
    tipo: 'peticao_avulsa', url: anexo.url, canalId: anexo.canalId, mensagemId: anexo.mensagemId,
    nomeArquivo: anexo.nomeArquivo, autorId: anexo.autorId,
    atoOrigemId: `${numero}#${novoId}`, protocoloVinculado: numero,
  });

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'peticao_protocolada', titulo: '📄 Petição protocolada', detalhe: `Petição avulsa protocolada por <@${interaction.user.id}>.`,
    executorId: interaction.user.id, anexoUrl: anexo.url, metadata: { peticaoId: novoId },
  });

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal && processo.juiz) {
    // IA "cartório" faz a análise estruturada do PDF pro Juiz (best-effort). Se off/falhar, segue sem.
    const embedAnalise = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'peticao_avulsa', pdfUrl: anexo.url });
    await canal.send({
      content: `<@${processo.juiz}> — petição protocolada por <@${interaction.user.id}>.`,
      embeds: embedAnalise ? [embedAnalise] : [],
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

// ---- Anexar prova (lote 5, Função 5) ----
// Rol de provas do processo (`processo.provas[]`), no mesmo estilo de `processo.peticoes[]`. Cada
// prova agrupa N arquivos sob uma descrição. Prova NUNCA some: a mensagem de upload do autor não é
// apagada e cada arquivo também vira documento dos autos (`anexos.criarDocumento`), aparecendo no
// dossiê/histórico. Aberto às PARTES do processo (quem tem acesso ao canal) + Staff.

function ehParteDoProcesso(interaction, processo) {
  if (isSuperStaff(interaction) || isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  if ([processo.delegado, processo.promotor, processo.juiz, processo.autor].filter(Boolean).includes(uid)) return true;
  if ((processo.reus || []).includes(uid)) return true;
  return (processo.habilitacoes || []).some(h => h.status === 'Aprovado' && h.advogadoId === uid);
}

function botaoAnexarProva(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:anexarprova:${numero}`).setLabel('🧾 Anexar prova').setStyle(ButtonStyle.Secondary);
}
function botaoRolProvas(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:rolprovas:${numero}`).setLabel('🗂️ Rol de provas').setStyle(ButtonStyle.Secondary);
}

function modalAnexarProva(numero) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:anexarprova:${numero}`).setTitle('Anexar prova');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipo').setLabel('Tipo (foto / vídeo / link / PDF / doc)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('descricao').setLabel('O que é a prova (descrição)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link').setLabel('Link (só se a prova for um link)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return modal;
}

async function abrirModalAnexarProva(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!ehParteDoProcesso(interaction, processo)) {
    return interaction.reply({ content: 'Só as partes do processo (Delegado, MP, Juiz, réu ou advogado habilitado) podem anexar provas aqui.', ephemeral: true });
  }
  return interaction.showModal(modalAnexarProva(numero));
}

// Grava a prova no rol + no dossiê, posta o card no canal e registra o andamento. Compartilhado
// pelos dois caminhos (link resolvido no modal, ou arquivos vindos da janela de upload).
async function registrarProvaNoProcesso(interaction, processo, { tipo, descricao, arquivos }) {
  const numero = processo.numero;
  const provas = processo.provas || [];
  const novoId = provas.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  const provaNova = {
    id: novoId, autorId: interaction.user.id, tipo, descricao,
    arquivos: arquivos.map(a => a.url), criadaEm: new Date().toISOString(),
  };
  db.atualizar('processos', numero, { provas: [...provas, provaNova] });

  // Cada arquivo também entra como documento dos autos (aparece no dossiê/histórico por protocolo).
  for (const a of arquivos) {
    anexos.criarDocumento({
      tipo: 'prova', url: a.url, nomeArquivo: a.nomeArquivo || 'prova', autorId: interaction.user.id,
      atoOrigemId: `${numero}#prova${novoId}`, protocoloVinculado: numero,
    });
  }

  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    const lista = arquivos.map((a, i) => `• [${a.nomeArquivo || `arquivo ${i + 1}`}](${a.url})`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle(`🧾 Prova juntada aos autos (#${novoId})`).setColor(0x8e44ad)
      .addFields(
        { name: 'Tipo', value: tipo || '—', inline: true },
        { name: 'Juntada por', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Descrição', value: truncar(descricao) },
        { name: `Arquivo(s) — ${arquivos.length}`, value: truncar(lista) || '—' },
      );
    await canal.send({ embeds: [embed] }).catch(() => {});
  }

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'prova_juntada', titulo: '🧾 Prova juntada',
    detalhe: `Prova juntada por <@${interaction.user.id}>: "${descricao}" — ${arquivos.length} arquivo(s).`,
    executorId: interaction.user.id, anexoUrl: arquivos[0]?.url || null,
    metadata: { provaId: novoId, tipo, quantidade: arquivos.length },
  });
  await repostarPainel(interaction.guild, numero);
  return novoId;
}

// Submit do modal de "Anexar prova".
async function salvarProva(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!ehParteDoProcesso(interaction, processo)) {
    return interaction.reply({ content: 'Só as partes do processo podem anexar provas.', ephemeral: true });
  }
  const tipo = (interaction.fields.getTextInputValue('tipo') || '').trim() || 'Documento';
  const descricao = (interaction.fields.getTextInputValue('descricao') || '').trim();
  const link = (interaction.fields.getTextInputValue('link') || '').trim();
  if (!descricao) return interaction.reply({ content: 'A descrição da prova é obrigatória.', ephemeral: true });

  // Caminho A: prova por LINK — resolve na hora, sem abrir janela de upload.
  if (link) {
    await interaction.deferReply({ ephemeral: true });
    const nid = await registrarProvaNoProcesso(interaction, processo, {
      tipo, descricao, arquivos: [{ url: link, nomeArquivo: link.split('/').pop()?.split('?')[0] || 'link' }],
    });
    return interaction.editReply({ content: `🧾 Prova #${nid} registrada (link).` });
  }

  // Caminho B: prova por ARQUIVO(S) — abre a janela temporária e coleta N arquivos.
  const resultado = await aguardarAnexos(interaction, { timeoutMs: 90 * 1000, idleMs: 25 * 1000 });
  if (!resultado) return; // já avisou tempo esgotado
  const nid = await registrarProvaNoProcesso(interaction, processo, { tipo, descricao, arquivos: resultado.arquivos });
  return interaction.followUp({ content: `🧾 Prova #${nid} registrada (${resultado.arquivos.length} arquivo(s)).`, ephemeral: true });
}

// Rol de provas consolidado (lista nos autos), acessível às partes.
async function verRolProvas(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!ehParteDoProcesso(interaction, processo)) {
    return interaction.reply({ content: 'Só as partes do processo podem consultar o rol de provas.', ephemeral: true });
  }
  const provas = processo.provas || [];
  if (provas.length === 0) return interaction.reply({ content: 'Nenhuma prova juntada a este processo ainda.', ephemeral: true });
  const linhas = provas.map(p => {
    const arqs = (p.arquivos || []).map((u, i) => `[arquivo ${i + 1}](${u})`).join(', ') || '—';
    return `**#${p.id}** — ${p.tipo || 'prova'} — por <@${p.autorId}>\n${p.descricao}\n${arqs}`;
  }).join('\n\n');
  const embed = new EmbedBuilder().setTitle(`🗂️ Rol de provas — Processo ${numero}`).setColor(0x8e44ad).setDescription(truncar(linhas, 4000));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- Gerenciar dados do processo (lote 5, Função 1) ----
// Editar RG/nome do réu e adicionar/remover crime, tudo por modal/select (sem digitar solto no
// canal). Permissão POR FASE: no inquérito (Penal sem juiz) quem edita é o Delegado dono do caso;
// após a denúncia (com juiz) é o Juiz ou o Promotor do processo; Staff/dono sempre. Toda edição
// loga em auditoria (valor antigo → novo) E gera andamento nos autos — nada de edição silenciosa.
// Acrescentar crime DEPOIS de a defesa já ter sido apresentada dispara intimação à defesa
// (devido processo, reaproveitando postarIntimacaoNoCanal).

function podeGerenciarProcesso(interaction, processo) {
  if (isSuperStaff(interaction) || isAdmin(interaction)) return true;
  const uid = interaction.user.id;
  if (!processo.juiz) return processo.delegado === uid;          // fase de inquérito → Delegado dono
  return processo.juiz === uid || processo.promotor === uid;      // após a denúncia → Juiz ou Promotor
}

const RECUSA_GERENCIAR = 'Você não pode gerenciar este processo nesta fase (inquérito: Delegado do caso; após a denúncia: Juiz ou Promotor do processo; Staff sempre).';

function botaoGerenciar(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:gerenciar:${numero}`).setLabel('⚙️ Gerenciar').setStyle(ButtonStyle.Secondary);
}

async function abrirGerenciar(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeGerenciarProcesso(interaction, processo)) return interaction.reply({ content: RECUSA_GERENCIAR, ephemeral: true });
  const select = new StringSelectMenuBuilder().setCustomId(`painel:select:processo:gerenciar:${numero}`).setPlaceholder('O que deseja editar?')
    .addOptions(
      { label: 'Alterar/adicionar RG do réu', value: 'rg', emoji: '🪪' },
      { label: 'Mudar nome do réu', value: 'nome', emoji: '✏️' },
      { label: 'Adicionar crime', value: 'addcrime', emoji: '➕' },
      { label: 'Remover crime', value: 'removecrime', emoji: '➖' },
    );
  return interaction.reply({ content: '⚙️ **Gerenciar processo** — escolha o que editar:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
}

function modalGerenciarCampo(numero, campo, label, valorAtual) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:gerenciar${campo}:${numero}`).setTitle(`Editar ${label}`.slice(0, 45));
  const input = new TextInputBuilder().setCustomId('valor').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
  if (valorAtual) input.setValue(String(valorAtual).slice(0, 100));
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function modalAddCrime(numero) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:gerenciaraddcrime:${numero}`).setTitle('Adicionar crime');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('crime').setLabel('Crime — nome, artigo ou ID (vírgula p/ vários)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200),
  ));
  return modal;
}

// Submit do select do menu Gerenciar → abre o modal/select certo.
async function tratarGerenciar(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeGerenciarProcesso(interaction, processo)) return interaction.reply({ content: RECUSA_GERENCIAR, ephemeral: true });
  const escolha = interaction.values[0];
  if (escolha === 'rg') return interaction.showModal(modalGerenciarCampo(numero, 'rg', 'RG do réu', processo.reuRg));
  if (escolha === 'nome') return interaction.showModal(modalGerenciarCampo(numero, 'nome', 'Nome do réu', processo.reuNome));
  if (escolha === 'addcrime') return interaction.showModal(modalAddCrime(numero));
  if (escolha === 'removecrime') return abrirSelectRemoverCrime(interaction, numero, processo);
  return interaction.reply({ content: 'Opção inválida.', ephemeral: true });
}

// Salva RG ou nome do réu (campo = 'rg' | 'nome').
async function salvarGerenciarCampo(interaction, numero, campo) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeGerenciarProcesso(interaction, processo)) return interaction.reply({ content: RECUSA_GERENCIAR, ephemeral: true });
  const valor = (interaction.fields.getTextInputValue('valor') || '').trim();
  if (!valor) return interaction.reply({ content: 'Valor vazio.', ephemeral: true });

  const dbCampo = campo === 'rg' ? 'reuRg' : 'reuNome';
  const rotulo = campo === 'rg' ? 'RG do réu' : 'Nome do réu';
  const antigo = processo[dbCampo] || '—';
  if (antigo === valor) return interaction.reply({ content: `O ${rotulo} já é "${valor}".`, ephemeral: true });
  db.atualizar('processos', numero, { [dbCampo]: valor });

  await auditoria.registrar(interaction.guild, { acao: `Edição — ${rotulo}`, executorId: interaction.user.id, referencia: `Processo ${numero}: "${antigo}" → "${valor}"` });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'dados_editados', titulo: `✏️ ${rotulo} editado`,
    detalhe: `${rotulo} alterado de "${antigo}" para "${valor}" por <@${interaction.user.id}>.`,
    executorId: interaction.user.id, metadata: { campo: dbCampo, antigo, novo: valor },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.reply({ content: `${rotulo} atualizado para **${valor}**.`, ephemeral: true });
}

// Submit do modal "Adicionar crime".
async function salvarAddCrime(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeGerenciarProcesso(interaction, processo)) return interaction.reply({ content: RECUSA_GERENCIAR, ephemeral: true });
  if (processo.tipo !== 'Penal') return interaction.reply({ content: 'Só processos penais têm crimes.', ephemeral: true });

  const resolvidos = resolverCrimesTexto(interaction.fields.getTextInputValue('crime'));
  if (resolvidos.length === 0) return interaction.reply({ content: 'Nenhum crime reconhecido. Use nome, artigo (ex.: Art. 121) ou ID de `/crime buscar`.', ephemeral: true });

  const atuais = processo.crimes || [];
  const jaTem = new Set(atuais.map(c => c.id));
  const novos = resolvidos.filter(c => !jaTem.has(c.id));
  if (novos.length === 0) return interaction.reply({ content: 'Esse(s) crime(s) já constam no processo.', ephemeral: true });

  db.atualizar('processos', numero, { crimes: [...atuais, ...novos] });
  const nomes = novos.map(c => crimeLabel(c)).join('; ');
  await auditoria.registrar(interaction.guild, { acao: 'Crime acrescentado', executorId: interaction.user.id, referencia: `Processo ${numero}: + ${nomes}` });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'crime_adicionado', titulo: '➕ Crime acrescentado',
    detalhe: `Crime(s) acrescentado(s) por <@${interaction.user.id}>: ${nomes}.`,
    executorId: interaction.user.id, metadata: { crimes: novos.map(c => c.id) },
  });

  // Devido processo: se a defesa já foi apresentada (há advogado habilitado), o crime novo não
  // entra em silêncio — intima a defesa pra se manifestar antes de qualquer julgamento por ele.
  const defesaApresentada = (processo.habilitacoes || []).some(h => h.status === 'Aprovado');
  let aviso = '';
  if (defesaApresentada) {
    await intimarDefesaSobreCrimeNovo(interaction.guild, db.buscarPorNumero('processos', numero), novos, interaction.user.id);
    aviso = ' ⚖️ A defesa foi **intimada** a se manifestar sobre o(s) crime(s) novo(s).';
  }
  await repostarPainel(interaction.guild, numero);
  return interaction.reply({ content: `Crime(s) adicionado(s): ${nomes}.${aviso}`, ephemeral: true });
}

// Dispara intimação a cada advogado habilitado sobre o(s) crime(s) acrescentado(s) tarde.
async function intimarDefesaSobreCrimeNovo(guild, processo, crimesNovos, executorId) {
  const numero = processo.numero;
  const nomes = crimesNovos.map(c => crimeLabel(c)).join('; ');
  const teor = documentos.teorIntimacaoCrimeTardio(nomes);
  const habilitados = (processo.habilitacoes || []).filter(h => h.status === 'Aprovado');
  for (const h of habilitados) {
    await postarIntimacaoNoCanal({ guild, processo, numero, destinatarioId: h.advogadoId, destinatarioNome: null, teor, assinanteId: executorId });
  }
  await andamentos.registrar(guild, numero, {
    tipo: 'intimacao_emitida', titulo: '✉️ Defesa intimada (crime acrescentado)',
    detalhe: `Defesa intimada a se manifestar sobre crime(s) acrescentado(s): ${nomes}.`,
    executorId, metadata: { motivo: 'crime_tardio', crimes: crimesNovos.map(c => c.id) },
  });
}

async function abrirSelectRemoverCrime(interaction, numero, processo) {
  const crimes = processo.crimes || [];
  if (crimes.length === 0) return interaction.reply({ content: 'Este processo não tem crimes cadastrados.', ephemeral: true });
  const select = new StringSelectMenuBuilder().setCustomId(`painel:select:processo:gerenciarremovecrime:${numero}`).setPlaceholder('Qual crime remover?')
    .setMinValues(1).setMaxValues(crimes.length)
    .addOptions(crimes.map(c => ({ label: crimeLabel(c).slice(0, 100), value: c.id })));
  return interaction.reply({ content: 'Selecione o(s) crime(s) a remover:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
}

async function removerCrime(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeGerenciarProcesso(interaction, processo)) return interaction.reply({ content: RECUSA_GERENCIAR, ephemeral: true });
  const remover = new Set(interaction.values);
  const atuais = processo.crimes || [];
  const removidos = atuais.filter(c => remover.has(c.id));
  const restantes = atuais.filter(c => !remover.has(c.id));
  if (removidos.length === 0) return interaction.update({ content: 'Nada foi removido.', components: [] });
  // Processo penal não pode ficar sem nenhum crime.
  if (processo.tipo === 'Penal' && restantes.length === 0) {
    return interaction.update({ content: '⚠️ Não dá pra remover todos os crimes de um processo penal — ele precisa de ao menos um. Adicione outro antes, ou arquive o processo.', components: [] });
  }
  db.atualizar('processos', numero, { crimes: restantes });
  const nomes = removidos.map(c => crimeLabel(c)).join('; ');
  await auditoria.registrar(interaction.guild, { acao: 'Crime removido', executorId: interaction.user.id, referencia: `Processo ${numero}: − ${nomes}` });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'crime_removido', titulo: '➖ Crime removido',
    detalhe: `Crime(s) removido(s) por <@${interaction.user.id}>: ${nomes}.`,
    executorId: interaction.user.id, metadata: { crimes: removidos.map(c => c.id) },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.update({ content: `Crime(s) removido(s): ${nomes}.`, components: [] });
}

// ---- Voltar fase (lote 5, Função 3) ----
// ESTENDE o mecanismo de reabertura que já existe (requererNovasProvas/concluirInstrução +
// canais.reabrirCanal + reinício de prazo via juizDesde). NÃO desfaz ato concluído: sentença e
// arquivamento de mérito só se revertem pelo caminho de anulação (Desembargador) / revisão de
// arquivamento (Procurador) — o botão redireciona pra lá em vez de fazer um "voltar" solto. Motivo
// obrigatório, documentos já juntados permanecem nos autos (referentes à fase reaberta), andamento
// + auditoria.

// Fase-alvo do "voltar" a partir do status atual, ou null se não há volta direta (ato concluído).
function alvoVoltarFase(processo) {
  const penal = processo.tipo === 'Penal';
  switch (processo.status) {
    case 'Concluso para julgamento': return { para: penal ? 'Em instrução' : 'Aguardando defesa', reabrirCanal: false };
    case 'Em instrução': return { para: 'Instrução', reabrirCanal: false };
    case 'Arquivado sem julgamento de mérito': return { para: penal ? 'Instrução' : 'Aguardando defesa', reabrirCanal: true };
    default: return null;
  }
}

// O processo PENAL comum vai de 'Instrução' direto pra sentença (não passa por 'Concluso'), então
// nessa fase o "Voltar fase" abre um MENU com duas opções (decisão do dono): devolver ao MP
// (reabre a decisão de denúncia/arquivamento, tira o Juiz) ou reabrir a instrução (volta a colher
// provas, mantém o Juiz).
const ESCOLHAS_VOLTAR_INSTRUCAO = {
  devolvermp: { para: 'Aguardando decisão do MP', limparJuiz: true, reabrirCanal: false },
  reabririnstrucao: { para: 'Em instrução', limparJuiz: false, reabrirCanal: false },
};

function penalEmInstrucao(processo) {
  return processo.tipo === 'Penal' && processo.status === 'Instrução';
}

function temVoltarFase(processo) {
  return !!alvoVoltarFase(processo) || penalEmInstrucao(processo);
}

// Destino do "voltar": se veio uma escolha do menu (penal em Instrução), usa ela; senão, o alvo
// único por status (alvoVoltarFase).
function resolverAlvoVoltar(processo, escolha) {
  if (escolha && ESCOLHAS_VOLTAR_INSTRUCAO[escolha]) return ESCOLHAS_VOLTAR_INSTRUCAO[escolha];
  const a = alvoVoltarFase(processo);
  return a ? { ...a, limparJuiz: false } : null;
}

function podeVoltarFase(interaction, processo) {
  if (isSuperStaff(interaction) || isAdmin(interaction)) return true;
  if (temCargo(interaction, 'Desembargador') || temCargo(interaction, 'Procurador')) return true;
  return processo.juiz === interaction.user.id;
}

function botaoVoltarFase(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:voltarfase:${numero}`).setLabel('↩️ Voltar fase').setStyle(ButtonStyle.Secondary);
}

function modalVoltarFase(numero, escolha, paraLabel) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:voltarfase:${numero}${escolha ? `#${escolha}` : ''}`).setTitle('Voltar fase');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('motivo').setLabel(`Motivo (volta p/ "${paraLabel}")`.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return modal;
}

async function abrirModalVoltarFase(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeVoltarFase(interaction, processo)) {
    return interaction.reply({ content: 'Só o Juiz do processo (ou Desembargador/Procurador/Staff) pode voltar a fase.', ephemeral: true });
  }
  // Penal em Instrução → menu (devolver ao MP OU reabrir instrução).
  if (penalEmInstrucao(processo)) {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:processo:voltarfase:${numero}`).setPlaceholder('Voltar para qual fase?')
        .addOptions(
          { label: 'Devolver ao Ministério Público', value: 'devolvermp', description: 'O MP reavalia: denunciar de novo ou arquivar' },
          { label: 'Reabrir instrução (novas provas)', value: 'reabririnstrucao', description: 'Volta a colher provas/diligências' },
        ),
    );
    return interaction.reply({ content: '↩️ **Voltar fase** — para qual fase deseja voltar?', components: [row], ephemeral: true });
  }
  const alvo = alvoVoltarFase(processo);
  if (!alvo) {
    const dica = processo.status === 'Encerrado'
      ? 'Este processo já tem **sentença** — para desfazê-la o caminho é a **anulação em grau de recurso** (Desembargador), não "voltar fase".'
      : processo.status === 'Arquivado'
        ? 'Arquivamento de mérito se reverte pela **revisão de arquivamento** (Procurador), não por "voltar fase".'
        : 'Não há fase anterior para voltar a partir do status atual.';
    return interaction.reply({ content: `⚠️ ${dica}`, ephemeral: true });
  }
  return interaction.showModal(modalVoltarFase(numero, '', alvo.para));
}

// Escolha do menu (penal em Instrução) → abre o modal de motivo com a escolha embutida.
async function processarVoltarFaseEscolha(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeVoltarFase(interaction, processo)) return interaction.reply({ content: 'Sem permissão pra voltar a fase.', ephemeral: true });
  const escolha = interaction.values[0];
  const alvo = ESCOLHAS_VOLTAR_INSTRUCAO[escolha];
  if (!alvo) return interaction.reply({ content: 'Opção inválida.', ephemeral: true });
  return interaction.showModal(modalVoltarFase(numero, escolha, alvo.para));
}

async function voltarFase(interaction, chave) {
  const [numero, escolha] = String(chave).split('#');
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (!podeVoltarFase(interaction, processo)) return interaction.reply({ content: 'Sem permissão pra voltar a fase.', ephemeral: true });
  const alvo = resolverAlvoVoltar(processo, escolha);
  if (!alvo) return interaction.reply({ content: 'Não há fase anterior para voltar a partir do status atual.', ephemeral: true });
  const motivo = (interaction.fields.getTextInputValue('motivo') || '').trim();
  if (!motivo) return interaction.reply({ content: 'O motivo é obrigatório.', ephemeral: true });

  const statusAntigo = processo.status;
  await interaction.deferReply({ ephemeral: true });

  // Reabre o canal se o processo estava arquivado (partes voltam a ter acesso).
  if (alvo.reabrirCanal) {
    const canalArq = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
    if (canalArq) {
      const partes = [
        processo.delegado, processo.promotor, processo.juiz, processo.autor,
        ...(processo.reus || []),
        ...((processo.habilitacoes || []).filter(h => h.status === 'Aprovado').map(h => h.advogadoId)),
      ].filter(Boolean);
      await canais.reabrirCanal(canalArq, partes).catch(() => {});
    }
  }

  // Aplica a volta: status + reinício do relógio de julgamento (juizDesde) e rearme do aviso de
  // "sem juiz". Ao voltar pra antes da contestação (cível), zera o estado do prazo de contestação.
  const patch = { status: alvo.para };
  if (alvo.limparJuiz) {
    // Devolver ao MP: tira o Juiz — o processo volta pra fila de decisão do MP (faseDenunciaMp),
    // que reexibe Oferecer denúncia / Arquivar. Quando o MP redenunciar, sorteia Juiz de novo.
    patch.juiz = null; patch.juizDesde = null; patch.avisoSemJuizEnviado = false;
  } else if (processo.juiz) {
    patch.juizDesde = new Date().toISOString(); patch.avisoSemJuizEnviado = false;
  }
  if (alvo.para === 'Aguardando defesa') {
    patch.prazoContestacaoAte = null; patch.citacaoEm = null; patch.avisoPrazoContestacaoEnviado = false;
  }
  db.atualizar('processos', numero, patch);

  // Nota da reabertura no canal (+ botão de reconcluir instrução quando aplicável).
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) {
    const componentes = alvo.para === 'Em instrução' ? [new ActionRowBuilder().addComponents(botaoConcluirInstrucao(numero))] : [];
    await canal.send({
      content: `↩️ **Fase revertida** por <@${interaction.user.id}>: de "${statusAntigo}" para "${alvo.para}".\n**Motivo:** ${motivo}\nOs documentos já juntados permanecem nos autos, referentes à fase reaberta.`,
      components: componentes,
    }).catch(() => {});
  }

  await auditoria.registrar(interaction.guild, { acao: 'Volta de fase', executorId: interaction.user.id, referencia: `Processo ${numero}: "${statusAntigo}" → "${alvo.para}"`, motivo });
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'fase_revertida', titulo: '↩️ Fase revertida',
    detalhe: `Processo voltou de "${statusAntigo}" para "${alvo.para}" por <@${interaction.user.id}>. Motivo: ${motivo}`,
    executorId: interaction.user.id, metadata: { de: statusAntigo, para: alvo.para },
  });
  await repostarPainel(interaction.guild, numero);
  return interaction.editReply({ content: `Fase revertida para **${alvo.para}**.` });
}

// ---- Manifestação do Ministério Público (prompt_manifestacao_mp) ----
// Ponto ÚNICO de atuação do MP dentro do processo penal. NÃO duplica os fluxos: roteia pros
// handlers que já existem (oferecer/arquivar via modalParecerMp; medida cautelar via
// medida.abrirSolicitarMedidaDireta) e acrescenta a "Manifestação/Requerimento livre" (documento
// pela janela de upload da F5): manifestação junta direto aos autos; requerimento vira pendência
// na fila do Juiz. Gate de entrada: membro do MP; cada handler roteado MANTÉM sua trava de "dono
// do caso" (promotor do processo). Ciente de contexto: o botão vive no painel e carrega o número.

function ehMembroDoMp(interaction) {
  return isAdmin(interaction) || isSuperStaff(interaction) || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador');
}

function botaoManifestacaoMp(numero) {
  return new ButtonBuilder().setCustomId(`painel:acao:processo:manifestacaomp:${numero}`).setLabel('🏛️ Manifestação do MP').setStyle(ButtonStyle.Primary);
}

async function abrirManifestacaoMp(interaction, numero) {
  if (!ehMembroDoMp(interaction)) return interaction.reply({ content: 'Só Promotor/Procurador podem manifestar-se pelo Ministério Público.', ephemeral: true });
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.tipo !== 'Penal') return interaction.reply({ content: 'A manifestação do MP é para processos penais.', ephemeral: true });

  const opcoes = [];
  if (!processo.juiz) {
    opcoes.push({ label: 'Oferecer denúncia', value: 'oferecer', emoji: '⚖️' });
    opcoes.push({ label: 'Promover arquivamento', value: 'arquivar', emoji: '📦' });
  } else {
    opcoes.push({ label: 'Requerer medida cautelar', value: 'medida', emoji: '🔒' });
  }
  opcoes.push({ label: 'Manifestação / Requerimento livre (c/ documento)', value: 'livre', emoji: '📝' });

  const select = new StringSelectMenuBuilder().setCustomId(`painel:select:processo:manifestacaomp:${numero}`).setPlaceholder('Ato do MP nesta fase').addOptions(opcoes);
  return interaction.reply({ content: '🏛️ **Manifestação do Ministério Público** — escolha o ato desta fase:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
}

async function tratarManifestacaoMp(interaction, numero) {
  if (!ehMembroDoMp(interaction)) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  const escolha = interaction.values[0];

  if (escolha === 'oferecer' || escolha === 'arquivar') {
    // Reusa o modal/parecer existente (modalParecerMp → confirmarParecerMp → executarParecerMp),
    // mantendo a trava de dono do caso (promotor do processo) — a decisão real segue no fluxo antigo.
    if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Promotor responsável por este processo pode oferecer/arquivar — no caso, <@${processo.promotor}>.`, ephemeral: true });
    }
    return interaction.showModal(modalParecerMp(numero, escolha));
  }
  if (escolha === 'medida') return medidaCmd.abrirSolicitarMedidaDireta(interaction, numero);
  if (escolha === 'livre') return interaction.showModal(modalManifestacaoLivre(numero));
  return interaction.reply({ content: 'Opção inválida.', ephemeral: true });
}

function modalManifestacaoLivre(numero) {
  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:manifestacaomplivre:${numero}`).setTitle('Manifestação / Requerimento do MP');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('descricao').setLabel('Teor do ato').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipo').setLabel('"manifestacao" ou "requerimento"').setPlaceholder('manifestacao = junta direto | requerimento = decide o Juiz').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
  );
  return modal;
}

function botoesDeferirIndeferirReqMp(numero, reqId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:deferirreqmp:${numero}#${reqId}`).setLabel('Deferir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`painel:acao:processo:indeferirreqmp:${numero}#${reqId}`).setLabel('Indeferir').setStyle(ButtonStyle.Danger),
  );
}

async function salvarManifestacaoLivre(interaction, numero) {
  if (!ehMembroDoMp(interaction)) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  // Só o Promotor responsável por ESTE processo (ou SuperStaff) manifesta/requer em nome do MP —
  // não qualquer membro do MP. Mesmo padrão de oferecer/arquivar em tratarManifestacaoMp.
  if (interaction.user.id !== processo.promotor && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Promotor responsável por este processo pode manifestar/requerer pelo MP — no caso, <@${processo.promotor}>.`, ephemeral: true });
  }
  const descricao = (interaction.fields.getTextInputValue('descricao') || '').trim();
  const ehRequerimento = (interaction.fields.getTextInputValue('tipo') || '').trim().toLowerCase().startsWith('req');
  if (!descricao) return interaction.reply({ content: 'O teor do ato é obrigatório.', ephemeral: true });

  // Documento é OPCIONAL: abre a janela de upload (F5); se nada vier, o ato é só-texto.
  const resultado = await aguardarAnexos(interaction, {
    timeoutMs: 60 * 1000, idleMs: 15 * 1000, silenciarVazio: true,
    mensagem: '📎 Se este ato tiver documento, envie-o agora como anexo (~60s). Se for só texto, é só aguardar a janela fechar.',
  });
  const arquivos = resultado ? resultado.arquivos : [];
  const lista = arquivos.map((a, i) => `[${a.nomeArquivo || `doc ${i + 1}`}](${a.url})`).join(', ') || '—';
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);

  for (const a of arquivos) {
    anexos.criarDocumento({ tipo: ehRequerimento ? 'requerimento_mp' : 'manifestacao_mp', url: a.url, nomeArquivo: a.nomeArquivo, autorId: interaction.user.id, atoOrigemId: `${numero}#mp`, protocoloVinculado: numero });
  }

  if (ehRequerimento) {
    // Requerimento → pendência na fila do Juiz (mesmo padrão pedido→decisão de habilitação/petição).
    const reqs = processo.requerimentosMp || [];
    const novoId = reqs.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    const req = { id: novoId, promotorId: interaction.user.id, descricao, arquivos: arquivos.map(a => a.url), status: 'Pendente', criadoEm: new Date().toISOString() };
    db.atualizar('processos', numero, { requerimentosMp: [...reqs, req] });
    if (canal && processo.juiz) {
      const embed = new EmbedBuilder().setTitle('📝 Requerimento do MP — decisão do Juiz').setColor(0x2980b9)
        .addFields({ name: 'Promotor', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Requerimento', value: truncar(descricao) }, { name: 'Documento(s)', value: truncar(lista) });
      await canal.send({ content: `<@${processo.juiz}> — requerimento do MP para apreciação.`, embeds: [embed], components: [botoesDeferirIndeferirReqMp(numero, novoId)] }).catch(() => {});
    }
    await andamentos.registrar(interaction.guild, numero, { tipo: 'requerimento_mp', titulo: '📝 Requerimento do MP protocolado', detalhe: `Requerimento do MP por <@${interaction.user.id}>: "${descricao}" — aguardando decisão do Juiz.`, executorId: interaction.user.id, anexoUrl: arquivos[0]?.url || null, metadata: { requerimentoId: novoId } });
    await repostarPainel(interaction.guild, numero);
    return interaction.followUp({ content: '📝 Requerimento protocolado e enviado ao Juiz.', ephemeral: true });
  }

  // Manifestação → juntada direta aos autos, sem decisão.
  if (canal) {
    const embed = new EmbedBuilder().setTitle('📝 Manifestação do Ministério Público').setColor(0x2980b9)
      .addFields({ name: 'Promotor', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Manifestação', value: truncar(descricao) }, { name: 'Documento(s)', value: truncar(lista) });
    await canal.send({ embeds: [embed] }).catch(() => {});
  }
  await andamentos.registrar(interaction.guild, numero, { tipo: 'manifestacao_mp', titulo: '📝 Manifestação do MP', detalhe: `Manifestação do MP por <@${interaction.user.id}>: "${descricao}" — juntada aos autos.`, executorId: interaction.user.id, anexoUrl: arquivos[0]?.url || null, metadata: {} });
  await repostarPainel(interaction.guild, numero);
  return interaction.followUp({ content: '📝 Manifestação juntada aos autos.', ephemeral: true });
}

async function decidirRequerimentoMp(interaction, chave, deferir) {
  const [numero, idTexto] = chave.split('#');
  const reqId = Number(idTexto);
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz deste processo pode decidir o requerimento — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const reqs = processo.requerimentosMp || [];
  const alvo = reqs.find(r => r.id === reqId);
  if (!alvo || alvo.status !== 'Pendente') return interaction.reply({ content: 'Esse requerimento não existe mais ou já foi decidido.', ephemeral: true });
  const novoStatus = deferir ? 'Deferido' : 'Indeferido';
  db.atualizar('processos', numero, { requerimentosMp: reqs.map(r => r.id === reqId ? { ...r, status: novoStatus } : r) });
  await andamentos.registrar(interaction.guild, numero, { tipo: 'requerimento_mp_decidido', titulo: `📝 Requerimento do MP ${novoStatus.toLowerCase()}`, detalhe: `Requerimento do MP foi ${novoStatus.toLowerCase()} pelo Juiz.`, executorId: interaction.user.id, metadata: { requerimentoId: reqId, resultado: novoStatus } });
  await repostarPainel(interaction.guild, numero);
  return interaction.update({ content: `Requerimento do MP **${novoStatus.toLowerCase()}** pelo Juiz.`, components: [] });
}

// ---- Recurso/Apelação (só quem perdeu, conforme o resultado estruturado da sentença) ----

// Sem bypass de admin de propósito — recorrer é ato de parte (só quem de fato perdeu a causa),
// não uma função de suporte administrativo. Staff que precisar agir nesse papel usa as trocas
// de Juiz/Promotor/Desembargador (utils/supervisao.js) pra assumir o papel de verdade primeiro.
// Quais lados "perderam" — base da regra de quem pode recorrer. Na sentença POR CRIME (Função 2),
// o réu perde se foi condenado em ALGUM crime e a acusação perde se houve absolvição em ALGUM —
// os dois lados podem ter interesse recursal simultâneo (antes era mutuamente exclusivo).
function ladosQuePerderam(processo) {
  const spc = processo.sentencaPorCrime;
  if (processo.tipo === 'Penal' && Array.isArray(spc) && spc.length) {
    return { perdeuReu: spc.some(s => s.resultado === 'Condenado'), perdeuAcusacao: spc.some(s => s.resultado === 'Absolvido') };
  }
  return {
    perdeuReu: (processo.tipo === 'Penal' && processo.resultado === 'Condenado') || (processo.tipo === 'Civil' && processo.resultado === 'Procedente'),
    perdeuAcusacao: (processo.tipo === 'Penal' && processo.resultado === 'Absolvido') || (processo.tipo === 'Civil' && processo.resultado === 'Improcedente'),
  };
}

function podeRecorrer(interaction, processo) {
  if (isSuperStaff(interaction)) return true;
  const uid = interaction.user.id;
  const { perdeuReu, perdeuAcusacao } = ladosQuePerderam(processo);

  // Réu/defesa pode recorrer se o réu perdeu (condenado em ao menos um crime); acusação pode se
  // perdeu (absolvição em ao menos um). Como agora não são exclusivos, testa o lado de quem clica.
  const ehReuOuDefesa = (processo.reus || []).includes(uid) || (processo.habilitacoes || []).some(h => h.advogadoId === uid && h.status === 'Aprovado');
  if (perdeuReu && ehReuOuDefesa) return true;
  if (perdeuAcusacao && (processo.tipo === 'Penal' ? uid === processo.promotor : uid === processo.autor)) return true;
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

// A parte contrária depende de QUEM recorre — no resultado por crime os dois lados podem recorrer,
// então não dá pra deduzir só pelo resultado. Se o recorrente é réu/defesa, a contrária é a
// acusação; senão, é o réu.
function parteContrariaDoRecurso(processo, recorrenteId) {
  const recorrenteEhReuOuDefesa = (processo.reus || []).includes(recorrenteId)
    || (processo.habilitacoes || []).some(h => h.advogadoId === recorrenteId && h.status === 'Aprovado');
  if (recorrenteEhReuOuDefesa) return processo.tipo === 'Penal' ? processo.promotor : processo.autor;
  return (processo.reus || [])[0] || null;
}

async function abrirModalRecorrer(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.apelacaoNumero) return interaction.reply({ content: `Esse processo já tem recurso aberto: ${processo.apelacaoNumero}.`, ephemeral: true });
  if (!podeRecorrer(interaction, processo)) return interaction.reply({ content: explicarNegacaoRecurso(interaction, processo), ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`painel:modal:processo:recorrer:${numero}`).setTitle('Recorrer da sentença');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('razoes').setLabel('Razões do recurso').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return interaction.showModal(modal);
}

// Razões do recurso (Advogado) — mesmo padrão revisão-in-flow. O modal guarda as razões e
// oferece a revisão por IA antes de protocolar a apelação (que cria canal e sorteia relator).
const chaveRazoes = (uid, numero) => `${uid}:razoes:${numero}`;

async function confirmarRazoes(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (processo.apelacaoNumero) return interaction.reply({ content: `Esse processo já tem recurso aberto: ${processo.apelacaoNumero}.`, ephemeral: true });
  if (!podeRecorrer(interaction, processo)) return interaction.reply({ content: explicarNegacaoRecurso(interaction, processo), ephemeral: true });

  const razoes = interaction.fields.getTextInputValue('razoes');
  rascunhoDecisao.set(chaveRazoes(interaction.user.id, numero), { razoes });
  // Revisão automática ligada: pula a tela de escolha e já protocola o texto revisado pela IA.
  if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return criarApelacao(interaction, numero, 'auto');
  return interaction.reply(revisaoIA.telaEscolha('razoes', { extra: numero, titulo: 'Razões do recurso', texto: razoes }));
}

async function revisarRazoesTexto(interaction, numero) {
  return revisarRascunho(interaction, { chave: chaveRazoes(interaction.user.id, numero), campo: 'razoes', telaId: 'razoes', extra: numero, msgExpirou: 'A prévia do recurso expirou. Refaça a ação.' });
}

async function criarApelacao(interaction, numero, modo) {
  const chaveR = chaveRazoes(interaction.user.id, numero);
  const d = rascunhoDecisao.get(chaveR);
  if (!d) return interaction.reply({ content: 'A prévia do recurso expirou. Refaça a ação.', ephemeral: true }).catch(() => {});
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) { rascunhoDecisao.delete(chaveR); return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true }).catch(() => {}); }
  if (processo.apelacaoNumero) { rascunhoDecisao.delete(chaveR); return interaction.reply({ content: `Esse processo já tem recurso aberto: ${processo.apelacaoNumero}.`, ephemeral: true }).catch(() => {}); }
  if (!podeRecorrer(interaction, processo)) { rascunhoDecisao.delete(chaveR); return interaction.reply({ content: explicarNegacaoRecurso(interaction, processo), ephemeral: true }).catch(() => {}); }

  // Defer antes de criar canal (operação lenta) — evita o estouro da janela de 3s do Discord.
  await interaction.deferReply({ ephemeral: true });
  rascunhoDecisao.delete(chaveR);
  const razoes = await resolverTextoFinal(d, modo, 'razoes');
  const recorrenteId = interaction.user.id;
  const parteContrariaId = parteContrariaDoRecurso(processo, recorrenteId);

  const desembargadorId = rh.sortearPorCargo('Desembargador');
  if (!desembargadorId) return interaction.editReply({ content: 'Não há Desembargador ativo cadastrado. As razões não foram protocoladas — tente de novo quando houver um Desembargador.' });

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
    // Troca de relator sem sair do ticket (Parte 2) — gate no clique.
    responsaveis.botaoSupervisaoTicket('apelacoes', numeroApelacao),
  );
  await canal.send({ content: `<@${desembargadorId}>`, embeds: [embed], components: [botoes] });

  // Resumo do caso pela IA "cartório" pro Desembargador relator (best-effort) — explica os autos,
  // a sentença recorrida e as razões, pra ele se situar rápido. Fallback gracioso se a IA off.
  const crimesTxt = (processo.crimes || []).map(c => crimeLabel(c)).join(', ') || (processo.motivo || '—');
  const resumoFatos = [
    `Processo ${processo.tipo} ${numero}.`,
    processo.tipo === 'Penal' ? `Crime(s): ${crimesTxt}.` : `Ação: ${processo.motivo || '—'}.`,
    processo.resultado ? `Sentença recorrida: ${processo.resultado}${processo.pena ? `, pena ${processo.pena}${processo.regime ? `, regime ${processo.regime}` : ''}` : ''}.` : 'Sem resultado registrado.',
    processo.sentenca ? `Fundamentação da sentença: ${truncar(processo.sentenca, 500)}` : null,
  ].filter(Boolean).join(' ');
  const despachoRelator = await cartorio.despachoParaCanal({ tipoAto: 'apelação (resumo para o relator)', textoLivre: razoes, resumoFatos }).catch(() => null);
  if (despachoRelator) await canal.send({ content: despachoRelator }).catch(() => {});

  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'apelacao', titulo: `⚖️ Apelação ${numeroApelacao} interposta`,
    detalhe: razoes, executorId: recorrenteId, metadata: { apelacaoNumero: numeroApelacao },
  });
  // Sem repostarPainel aqui: a narrativa desta seção nasce no canal NOVO da apelação, não no
  // canal do processo original (que a essa altura já costuma estar arquivado pela sentença).

  await auditoria.registrar(interaction.guild, { acao: 'Recurso interposto', executorId: recorrenteId, referencia: `Processo ${numero} → Apelação ${numeroApelacao}` });
  return interaction.editReply({ content: `Recurso ${numeroApelacao} aberto em ${canal}.` });
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
    new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do relator').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
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
    new TextInputBuilder().setCustomId('fundamentacao').setLabel('Fundamentação do relator').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
  ));
  return interaction.showModal(modal);
}

async function finalizarApelacao(interaction, numeroApelacao, decisao, extras = {}) {
  const apelacao = await validarDecisaoApelacao(interaction, numeroApelacao);
  if (!apelacao) return;

  // Guard de defer idempotente: no modo "revisão automática" o executarAcordao já deu deferReply
  // antes de revisar — sem esse guard, deferir de novo aqui lançaria (interação já reconhecida).
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isModalSubmit()) await interaction.deferReply({ ephemeral: true });
    else await interaction.deferUpdate();
  }

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
      // sentencaPorCrime[] acompanha sentenca/resultado (penal por-crime); anular sem limpá-lo deixa
      // o veredicto por crime antigo órfão até o re-julgamento (lido em displays e no PNG).
      juiz: novoJuizId, juizDesde: new Date().toISOString(), sentenca: null, resultado: null, sentencaPorCrime: null, apelacaoNumero: null,
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
        components: novoJuizId ? montarPainelAcoes(db.buscarPorNumero('processos', processoOriginal.numero)) : [],
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

  // PNG do acórdão — todo ato decisório final gera documento em imagem (igual à sentença). O
  // acórdão do Desembargador era o único que saía só em texto.
  const nomeDes = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const corpoAcordao = [
    `A Câmara, apreciando o recurso ${numeroApelacao} (processo ${apelacao.processoOriginalNumero}), decide: sentença ${statusFinal.toUpperCase()}.`,
    extras.novoResultado ? `Novo resultado: ${extras.novoResultado}.` : null,
    extras.fundamentacao ? `\nFundamentação do relator:\n${extras.fundamentacao}` : null,
  ].filter(Boolean).join('\n');
  const pngAcordao = await documentoPng.gerarDocumentoPNG({
    tipoDocumento: 'acordao', orgaoEmissor: 'judiciario', subunidade: 'Tribunal de Justiça — Câmara de Apelação',
    tituloDocumento: 'ACÓRDÃO', numeroProcesso: apelacao.processoOriginalNumero, dataEmissao: documentos.dataExtenso(),
    destinatario: 'Autos', corpoTexto: corpoAcordao, nomeAssinante: nomeDes, cargoAssinante: 'Desembargador(a) Relator(a)',
  }).catch(err => { console.error('Falha ao gerar PNG do acórdão:', err.message); return null; });
  const anexoAcordao = pngAcordao ? { files: [{ attachment: pngAcordao, name: `Acordao-${numeroApelacao}.png` }] } : {};

  if (interaction.channel) {
    await interaction.channel.send({ content: textoDoc, ...anexoAcordao });
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
        ...anexoAcordao,
      });
    }
    await postarOuAtualizarCapaPublica(interaction.guild, processoOriginal.numero);
  }

  await auditoria.registrar(interaction.guild, {
    acao: `Apelação decidida: ${statusFinal}`, executorId: interaction.user.id, referencia: `${numeroApelacao} (processo ${apelacao.processoOriginalNumero})`,
  });
  // Publica o acórdão no Diário Oficial (try/catch — falha aqui não pode quebrar a decisão).
  try {
    await diario.publicarNoDiario(interaction.guild, 'acordao', {
      numero: apelacao.processoOriginalNumero,
      resultado: `${statusFinal}${extras.novoResultado ? ` — ${extras.novoResultado}` : ''}`,
      relator: nomeDes,
      files: pngAcordao ? [{ attachment: pngAcordao, name: `Acordao-${numeroApelacao}.png` }] : undefined,
    });
  } catch (e) { console.error('[processo] publicação de acórdão no Diário falhou (ignorado):', e.message); }

  const embedResultado = new EmbedBuilder().setColor(0x8e44ad).setDescription(`Apelação ${numeroApelacao}: sentença **${statusFinal}**. Acórdão publicado no canal.`);
  return interaction.editReply({ embeds: [embedResultado], components: [] });
}

// Acórdão do Desembargador — mesmo padrão revisão-in-flow da sentença/parecer. O relator digita
// a fundamentação no modal (manter/anular/reformar); em vez de finalizar direto, guardamos o
// rascunho e oferecemos a revisão por IA antes de publicar o acórdão.
const chaveAcordao = (uid, numApelacao) => `${uid}:acordao:${numApelacao}`;
const ROTULO_DECISAO_ACORDAO = { manter: 'manter a sentença', anular: 'anular a sentença', reformar: 'reformar a sentença' };

async function confirmarAcordao(interaction, numeroApelacao, decisao, extras = {}) {
  const apelacao = await validarDecisaoApelacao(interaction, numeroApelacao);
  if (!apelacao) return;
  const fundamentacao = interaction.fields.getTextInputValue('fundamentacao');
  rascunhoDecisao.set(chaveAcordao(interaction.user.id, numeroApelacao), { decisao, fundamentacao, novoResultado: extras.novoResultado || null });
  // Revisão automática ligada: pula a tela de escolha e já publica o texto revisado pela IA.
  if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return executarAcordao(interaction, numeroApelacao, 'auto');
  const rotulo = ROTULO_DECISAO_ACORDAO[decisao] || decisao;
  return interaction.reply(revisaoIA.telaEscolha('acordao', { extra: numeroApelacao, titulo: 'Fundamentação do relator', rotulo, texto: fundamentacao }));
}

async function revisarAcordaoTexto(interaction, numeroApelacao) {
  return revisarRascunho(interaction, { chave: chaveAcordao(interaction.user.id, numeroApelacao), campo: 'fundamentacao', telaId: 'acordao', extra: numeroApelacao, msgExpirou: 'A prévia do acórdão expirou. Refaça a decisão.' });
}

async function executarAcordao(interaction, numeroApelacao, modo) {
  const chaveA = chaveAcordao(interaction.user.id, numeroApelacao);
  const d = rascunhoDecisao.get(chaveA);
  if (!d) return interaction.reply({ content: 'A prévia do acórdão expirou. Refaça a decisão.', ephemeral: true }).catch(() => {});
  rascunhoDecisao.delete(chaveA);
  // Modo automático: acusa o recebimento (defer) e revisa aqui, já que finalizarApelacao usa o
  // texto logo em seguida. Fallback pro original se a IA não responder.
  if (modo === 'auto') await interaction.deferReply({ ephemeral: true });
  const fundamentacao = await resolverTextoFinal(d, modo, 'fundamentacao');
  return finalizarApelacao(interaction, numeroApelacao, d.decisao, { fundamentacao, novoResultado: d.novoResultado });
}

// Publicação da sentença (após o Juiz escolher revisar ou não) — lê o rascunho, gera o PNG e
// posta. `usarRevisado` decide entre o texto revisado pela IA e o original.
// Submit do modal de sentença por crime (Função 2) — monta o array sentencaPorCrime[] a partir do
// veredicto guardado (rascunhoVeredicto), deriva o resultado agregado (Condenado se houve ao menos
// uma condenação, senão Absolvido) e segue pro mesmo pipeline de revisão-IA/publicação.
async function salvarSentencaPorCrime(interaction, numero) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true });
  if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processo.juiz}>.`, ephemeral: true });
  }
  const condenadosIds = rascunhoVeredicto.get(chaveDecisao(interaction.user.id, numero)) || [];
  const crimes = processo.crimes || [];
  const temCondenacao = condenadosIds.length > 0;

  const textoDigitado = interaction.fields.getTextInputValue('texto');
  const penas = temCondenacao ? (interaction.fields.getTextInputValue('penas') || '').trim() : null;
  const regime = temCondenacao ? (interaction.fields.getTextInputValue('regime') || '').trim() : null;

  const atenuantesSelecionadas = temCondenacao ? rascunhoSentenca.obter(interaction.user.id, numero) : [];
  const rotulos = labelsDe(atenuantesSelecionadas);
  const texto = rotulos.length ? `${textoDigitado}\n\nAtenuada em razão de: ${rotulos.join(', ')}.` : textoDigitado;

  const sentencaPorCrime = crimes.map(c => ({
    crimeId: c.id, nome: c.nome, codigo_artigo: c.codigo_artigo,
    resultado: condenadosIds.includes(c.id) ? 'Condenado' : 'Absolvido',
  }));
  const resultado = temCondenacao ? 'Condenado' : 'Absolvido';

  rascunhoSentenca.limpar(interaction.user.id, numero);
  rascunhoVeredicto.delete(chaveDecisao(interaction.user.id, numero));

  rascunhoDecisao.set(chaveDecisao(interaction.user.id, numero), { texto, pena: penas, regime, resultado, sentencaPorCrime });
  if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return executarSentenca(interaction, numero, 'auto');
  return interaction.reply(revisaoIA.telaEscolha('sentenca', { extra: numero, titulo: 'Fundamentos da sentença', texto }));
}

async function executarSentenca(interaction, numero, modo) {
  const chave = chaveDecisao(interaction.user.id, numero);
  const d = rascunhoDecisao.get(chave);
  if (!d) return interaction.reply({ content: 'A prévia da sentença expirou. Refaça pelo botão "Julgar".', ephemeral: true }).catch(() => {});
  // Trava própria (defesa em profundidade, igual aos outros 4 executores) — o commit da sentença
  // se consuma AQUI, então revalida o Juiz antes de publicar, não só no salvarSentenca.
  const processoAlvo = db.buscarPorNumero('processos', numero);
  if (!processoAlvo) return interaction.reply({ content: 'Processo não encontrado.', ephemeral: true }).catch(() => {});
  if (interaction.user.id !== processoAlvo.juiz && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processoAlvo.juiz}>.`, ephemeral: true }).catch(() => {});
  }
  rascunhoDecisao.delete(chave);

  // Defer público ANTES do PNG (Puppeteer) — a sentença é pública no canal. No modo "revisão
  // automática" a revisão pela IA acontece depois do defer (é lenta), com fallback pro original.
  await interaction.deferReply();
  const texto = await resolverTextoFinal(d, modo, 'texto');
  const { pena, regime, resultado, sentencaPorCrime } = d;
  db.atualizar('processos', numero, { status: 'Encerrado', sentenca: texto, resultado, pena, regime, sentencaPorCrime: sentencaPorCrime || null, sentencaEm: new Date().toISOString() });

  const processo = db.buscarPorNumero('processos', numero);
  // Assinatura = quem clicou (o Juiz do processo, ou superstaff no lugar dele).
  const nomeAssinante = await documentoPng.nomeExibicao(interaction.guild, interaction.user.id);
  const nomeReu = processo.reuNome || (
    (processo.reus || []).length
      ? (await Promise.all(processo.reus.map(id => documentoPng.nomeExibicao(interaction.guild, id)))).join(' e ')
      : 'o(a) réu(ré)'
  );
  const nomeAutor = processo.autorNome || (processo.autor ? await documentoPng.nomeExibicao(interaction.guild, processo.autor) : 'a parte autora');
  const crimeDescricao = Array.isArray(processo.sentencaPorCrime) && processo.sentencaPorCrime.length
    ? processo.sentencaPorCrime.map(s => `${s.nome} (Art. ${s.codigo_artigo}) — ${s.resultado}`).join('; ')
    : ((processo.crimes || []).map(c => crimeLabel(c)).join(', ') || 'crime não especificado');

  const TIPO_DOCUMENTO_SENTENCA = {
    'Penal:Condenado': 'sentenca_penal_condenatoria', 'Penal:Absolvido': 'sentenca_penal_absolutoria',
    'Civil:Procedente': 'sentenca_civel_procedente', 'Civil:Improcedente': 'sentenca_civel_improcedente',
  };
  const tipoDocumento = TIPO_DOCUMENTO_SENTENCA[`${processo.tipo}:${resultado}`];

  const pngSentenca = await documentoPng.gerarDocumentoPNG({
    tipoDocumento, orgaoEmissor: 'judiciario',
    subunidade: processo.tipo === 'Penal' ? 'Comarca de São Paulo — Vara Criminal' : 'Comarca de São Paulo — Vara Cível',
    tituloDocumento: 'SENTENÇA', numeroProcesso: numero, dataEmissao: documentos.dataExtenso(),
    destinatario: processo.tipo === 'Penal' ? 'Réu(s)' : 'Autor e Réu(s)', corpoTexto: texto,
    nomeReu, nomeAutor, crimeDescricao, pena, regime, nomeAssinante, cargoAssinante: 'Juiz de Direito',
  }).catch(err => { console.error('Falha ao gerar PNG da sentença:', err.message); return null; });

  const msgSentenca = await interaction.editReply({
    content: documentos.textoSentenca(processo), embeds: [embedProcesso(processo)], components: [botaoRecorrer(numero)],
    ...(pngSentenca ? { files: [{ attachment: pngSentenca, name: `Sentenca-${numero}.png` }] } : {}),
  });
  const anexoUrlSentenca = msgSentenca?.attachments?.first()?.url || null;

  if (processo.tipo === 'Penal') {
    await devolutivaPoliciaCivil.enviarSentencaPoliciaCivil({ processo, texto: documentos.textoSentenca(processo), pngBuffer: pngSentenca });
  }
  await andamentos.registrar(interaction.guild, numero, {
    tipo: 'sentenca', titulo: `⚖️ Sentença — ${resultado}`,
    detalhe: texto, executorId: interaction.user.id, anexoUrl: anexoUrlSentenca, metadata: { resultado, pena, regime },
  });
  await repostarPainel(interaction.guild, numero);
  const canal = await interaction.guild.channels.fetch(processo.canalId).catch(() => null);
  if (canal) await canais.arquivarCanal(canal);
  await auditoria.registrar(interaction.guild, { acao: `Sentença: ${resultado}`, executorId: interaction.user.id, referencia: `Processo ${numero}` });
  // Publica a sentença no Diário Oficial (try/catch — falha aqui não pode quebrar o julgamento).
  try {
    await diario.publicarNoDiario(interaction.guild, 'sentenca', {
      numero, tipoProcesso: processo.tipo, resultado, parte: nomeReu, magistrado: nomeAssinante,
      files: pngSentenca ? [{ attachment: pngSentenca, name: `Sentenca-${numero}.png` }] : undefined,
    });
  } catch (e) { console.error('[processo] publicação de sentença no Diário falhou (ignorado):', e.message); }
  await postarOuAtualizarCapaPublica(interaction.guild, numero);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('processo')
    .setDescription('Gerencia processos penais e civis')
    .addSubcommand(sub => sub.setName('penal').setDescription('Abre um processo penal (inquérito) — Delegado')
      .addStringOption(o => o.setName('crimes').setDescription('Crimes separados por vírgula: ID, artigo ou nome (ver /crime buscar)').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Descrição objetiva dos fatos').setRequired(true))
      .addUserOption(o => o.setName('promotor').setDescription('Promotor responsável'))
      .addStringOption(o => o.setName('reus').setDescription('Menções @ dos réus, se já identificados'))
      .addStringOption(o => o.setName('medida').setDescription('Número da medida cautelar vinculada, se houver')))
    // Opções obrigatórias precisam vir ANTES das opcionais (regra do Discord), por isso os dois
    // nomes + réu_nome (obrigatórios) ficam agrupados antes dos @ do Discord (opcionais).
    .addSubcommand(sub => sub.setName('civil').setDescription('Abre um processo civil — Advogado (anexe a petição inicial depois, no canal)')
      .addStringOption(o => o.setName('nome_acao').setDescription('Nome da ação (ex: Ação indenizatória de perdas e danos por acidente de trânsito)').setRequired(true))
      .addStringOption(o => o.setName('autor_nome').setDescription('Nome completo do autor').setRequired(true))
      .addStringOption(o => o.setName('reu_nome').setDescription('Nome completo do réu').setRequired(true))
      .addUserOption(o => o.setName('autor_discord').setDescription('Usuário Discord do autor (opcional — deixe vazio se não estiver no Discord)'))
      .addUserOption(o => o.setName('reu_discord').setDescription('Usuário Discord do réu (opcional — deixe vazio se não estiver no Discord)')))
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
        autorDiscordId: interaction.options.getUser('autor_discord')?.id || null,
        reuNome: interaction.options.getString('reu_nome'),
        reuDiscordId: interaction.options.getUser('reu_discord')?.id || null,
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

    // Penal com crimes: veredicto POR CRIME (lote 5, Função 2) — multi-select onde os marcados =
    // Condenado e os não marcados = Absolvido. Fallback pro select agregado antigo se não houver
    // crimes ou se passar de 25 (limite de opções de um select do Discord).
    const crimesPenais = processo.tipo === 'Penal' ? (processo.crimes || []) : [];
    if (crimesPenais.length > 0 && crimesPenais.length <= 25) {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`painel:select:processo:veredictocrimes:${numero}`)
          .setPlaceholder('Marque os crimes CONDENADOS (não marcados = absolvidos)')
          .setMinValues(0).setMaxValues(crimesPenais.length)
          .addOptions(crimesPenais.map(c => ({ label: crimeLabel(c).slice(0, 100), value: c.id }))),
      );
      return interaction.reply({ content: '⚖️ **Veredicto por crime** — marque os crimes em que o réu foi **condenado**; os que ficarem em branco serão **absolvidos**. Em seguida você preenche a pena de cada um e a fundamentação.', components: [row], ephemeral: true });
    }

    const opcoes = processo.tipo === 'Penal'
      ? [{ label: 'Condenado', value: 'Condenado' }, { label: 'Absolvido', value: 'Absolvido' }]
      : [{ label: 'Procedente', value: 'Procedente' }, { label: 'Improcedente', value: 'Improcedente' }];

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`painel:select:processo:resultado:${numero}`).setPlaceholder('Qual o resultado?').addOptions(opcoes),
    );
    return interaction.reply({ content: 'Qual o resultado da sentença?', components: [row], ephemeral: true });
  },

  // Disparado pelo select de resultado quando é Penal + Condenado — mostra a tela de apoio
  // (faixa de pena, fiança de referência e checklist de atenuantes) antes do modal final.
  async mostrarResumoSentencaPenal(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.update({ content: 'Processo não encontrado.', embeds: [], components: [] });
    rascunhoSentenca.limpar(interaction.user.id, numero);
    // Este caminho é o fallback agregado (select único "Condenado", usado quando há >25 crimes e o
    // veredicto por crime não cabe num select): condena em TODOS os crimes — popula o veredicto pra
    // o modal por crime tratar todos como condenados, mantendo o mesmo pipeline.
    rascunhoVeredicto.set(chaveDecisao(interaction.user.id, numero), (processo.crimes || []).map(c => c.id));
    const { embeds, components } = montarPainelSentencaPenal(processo, []);
    return interaction.update({ content: null, embeds, components });
  },

  // Select de atenuantes da tela de apoio — só guarda o estado e redesenha o mesmo painel
  // (nada é gravado no processo ainda; isso só acontece na submissão do modal de sentença).
  async atualizarAtenuantesSentenca(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.update({ content: 'Processo não encontrado.', embeds: [], components: [] });
    rascunhoSentenca.definir(interaction.user.id, numero, interaction.values);
    const { embeds, components } = montarPainelSentencaPenal(processo, interaction.values);
    return interaction.update({ embeds, components });
  },

  // Select do veredicto por crime (Função 2) — guarda os condenados e segue pra tela de apoio
  // (atenuantes, só dos condenados) ou, se absolveu em tudo, direto pro modal de fundamentação.
  async processarVeredictoCrimes(interaction, numero) {
    const processo = db.buscarPorNumero('processos', numero);
    if (!processo) return interaction.update({ content: 'Processo não encontrado.', embeds: [], components: [] });
    if (interaction.user.id !== processo.juiz && !isSuperStaff(interaction)) {
      return interaction.reply({ content: `Só o Juiz sorteado para este processo pode julgá-lo — no caso, <@${processo.juiz}>.`, ephemeral: true });
    }
    const condenados = interaction.values || [];
    rascunhoVeredicto.set(chaveDecisao(interaction.user.id, numero), condenados);
    rascunhoSentenca.limpar(interaction.user.id, numero);
    if (condenados.length === 0) {
      return interaction.showModal(modalSentencaPorCrime(numero, processo, []));
    }
    const { embeds, components } = montarPainelSentencaPenal(processo, [], condenados);
    return interaction.update({ content: null, embeds, components });
  },

  // "Continuar para sentença" — mantém as atenuantes marcadas e abre o modal de sentença por crime.
  async continuarSentencaPenal(interaction, numero) {
    const condenados = rascunhoVeredicto.get(chaveDecisao(interaction.user.id, numero)) || [];
    return interaction.showModal(modalSentencaPorCrime(numero, db.buscarPorNumero('processos', numero), condenados));
  },

  // "Pular sugestões e preencher direto" — descarta as atenuantes e abre o mesmo modal.
  async pularSentencaPenal(interaction, numero) {
    rascunhoSentenca.limpar(interaction.user.id, numero);
    const condenados = rascunhoVeredicto.get(chaveDecisao(interaction.user.id, numero)) || [];
    return interaction.showModal(modalSentencaPorCrime(numero, db.buscarPorNumero('processos', numero), condenados));
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
    // Só chega aqui a absolvição penal e o cível (procedente/improcedente): sem pena, regime ou
    // atenuantes. A condenação penal vai sempre pelo fluxo por-crime (modalSentencaPorCrime →
    // salvarSentencaPorCrime), então `resultado` nunca é 'Condenado' neste handler.
    rascunhoSentenca.limpar(interaction.user.id, numero);

    // Em vez de publicar direto, guarda o rascunho e oferece a revisão por IA DENTRO do fluxo
    // dos Fundamentos (Discord não deixa botão dentro do modal, então é o passo logo após).
    rascunhoDecisao.set(chaveDecisao(interaction.user.id, numero), { texto, pena: null, regime: null, resultado });
    // Revisão automática ligada: pula a tela de escolha e já publica o texto revisado pela IA.
    if (preferencias.revisaoAutomaticaLigada(interaction.user.id)) return executarSentenca(interaction, numero, 'auto');
    return interaction.reply(revisaoIA.telaEscolha('sentenca', { extra: numero, titulo: 'Fundamentos da sentença', texto }));
  },

  // Gera a revisão por IA e mostra antes→depois; o Juiz escolhe qual publicar.
  async revisarSentencaTexto(interaction, numero) {
    return revisarRascunho(interaction, { chave: chaveDecisao(interaction.user.id, numero), campo: 'texto', telaId: 'sentenca', extra: numero, msgExpirou: 'A prévia da sentença expirou. Refaça pelo botão "Julgar".' });
  },

  async publicarSentenca(interaction, numero) { return executarSentenca(interaction, numero, false); },
  async usarRevisadoSentenca(interaction, numero) { return executarSentenca(interaction, numero, true); },

  // Parecer do MP — mesmo padrão revisão-in-flow da sentença.
  revisarParecerTexto,
  async publicarParecer(interaction, numero) { return executarParecerMp(interaction, numero, false); },
  async usarRevisadoParecer(interaction, numero) { return executarParecerMp(interaction, numero, true); },

  // Acórdão do Desembargador — mesmo padrão revisão-in-flow.
  confirmarAcordao,
  revisarAcordaoTexto,
  async publicarAcordao(interaction, numeroApelacao) { return executarAcordao(interaction, numeroApelacao, false); },
  async usarRevisadoAcordao(interaction, numeroApelacao) { return executarAcordao(interaction, numeroApelacao, true); },

  // Razões do recurso (Advogado) — mesmo padrão revisão-in-flow.
  confirmarRazoes,
  revisarRazoesTexto,
  async publicarRazoes(interaction, numero) { return criarApelacao(interaction, numero, false); },
  async usarRevisadoRazoes(interaction, numero) { return criarApelacao(interaction, numero, true); },

  criarProcessoPenal,
  criarProcessoCivil,
  modalSentenca,
  embedProcesso,
  processoPublico,
  temAcessoTotal,
  verProcesso,
  verHistoricoProcesso,
  listarProcessos,
  postarOuAtualizarCapaPublica,
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
  montarPainelAcoes,
  abrirHubProcesso,
  peticionar,
  decidirPeticao,
  abrirModalAnexarProva,
  salvarProva,
  verRolProvas,
  abrirGerenciar,
  tratarGerenciar,
  salvarGerenciarCampo,
  salvarAddCrime,
  removerCrime,
  abrirAdicionarAdvogado,
  adicionarAdvogadoSelecionado,
  abrirRemoverAdvogado,
  abrirModalVoltarFase,
  processarVoltarFaseEscolha,
  voltarFase,
  abrirManifestacaoMp,
  tratarManifestacaoMp,
  salvarManifestacaoLivre,
  decidirRequerimentoMp,
  salvarSentencaPorCrime,
  intimarReu,
  marcarIntimacaoReuCumprida,
  repostarPainel,
  pedirRevisaoArquivamento,
  abrirModalRecorrer,
  abrirSelecaoResultadoReforma,
  abrirModalFundamentacaoReforma,
  abrirModalFundamentacaoDecisao,
  finalizarApelacao,
  extrairMencoes,

  // Exportados só para scripts/testes-limite-componentes.js: garantir que o catálogo de ações por
  // hub (HUBS_PROCESSO/ACOES_UNIVERSAIS_PAINEL) nunca cresça a ponto de o empacotamento por 5
  // (empacotarBotoes) estourar o limite de 5 ActionRows por mensagem do Discord.
  HUBS_PROCESSO,
  ACOES_UNIVERSAIS_PAINEL,
  empacotarBotoes,

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const resultados = db.todos('processos', p => p.numero.toLowerCase().includes(foco))
      .slice(0, 25)
      .map(p => ({ name: `${p.numero} — ${p.tipo} — ${p.status}`.slice(0, 100), value: p.numero }));
    await interaction.respond(resultados);
  },
};
