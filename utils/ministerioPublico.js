// Instrumentos de atuação extrajudicial do Ministério Público — restrito a Promotor/Procurador
// de propósito: são atribuições EXCLUSIVAS do MP (art. 129 da Constituição Federal), uma
// instituição distinta do Judiciário. Juiz e Desembargador não têm essas atribuições, por isso
// não usam a lógica de isAdmin/isSuperStaff genérica daqui, é cargo-específico mesmo.
//
// Requisição (art. 129, VI e VIII, CF) — COERCITIVA: o destinatário é obrigado a atender.
// Recomendação — PERSUASIVA: expõe razões fáticas/jurídicas, sem força coercitiva.
// Inquérito Civil (art. 129, III, CF + Lei 7.347/1985) — investigação administrativa PRIVATIVA
// do MP, sobre patrimônio público/meio ambiente/interesses difusos — nada a ver com inquérito
// policial (que é do Delegado, sobre crime).
//
// Cada ato abre, além do documento indo pro canal fixo do MP (feed oficial/externo), um canal-
// ticket individual — é ali que o Promotor "recebe e toma as medidas": acompanhar, e se a
// apuração indicar crime, abrir a denúncia direto dali (mesmo fluxo de seleção de crimes usado
// em qualquer outro processo penal, só que sem inquérito policial por trás — o próprio ato do
// MP é a origem).
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const documentos = require('./documentos');
const auditoria = require('./auditoria');
const canais = require('./canais');
const rascunhoCrimes = require('./rascunhoCrimes');
const crimePicker = require('./crimePicker');
const { proximoNumeroClassico } = require('./numeracao');
const { temCargo, isAdmin, isSuperStaff } = require('./permissoes');

const CATEGORIA_MP_CHAVE = 'categoriaMpId';
const CATEGORIA_MP_NOME = '⚖️ Ministério Público — Procedimentos';

function ehMembroDoMP(interaction) {
  return isAdmin(interaction) || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador');
}

async function postarNoCanalMP(texto) {
  if (!config.webhookMinisterioPublicoUrl) return;
  await fetch(config.webhookMinisterioPublicoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Ministério Público — Sistema Integrado', content: texto }),
  }).catch(err => console.error('Falha ao postar no canal do Ministério Público:', err.message));
}

function botoesAtoMp(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:mp:abrirprocesso:${numero}`).setLabel('📁 Abrir processo penal (denúncia)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`painel:acao:mp:arquivarmanual:${numero}`).setLabel('📦 Arquivar procedimento').setStyle(ButtonStyle.Secondary),
  );
}

// Canal privado do ato — só quem expediu (+ Staff, automaticamente via criarCanalTicket).
// Recebe o próprio documento formal como conteúdo (mesmo texto que vai pro canal fixo do MP),
// pra quem está de plantão no ticket ver exatamente o que foi expedido, sem ir atrás em outro canal.
async function criarTicketAto(guild, { numero, prefixo, executorId, texto }) {
  const categoriaId = await canais.obterOuCriarCategoria(guild, CATEGORIA_MP_CHAVE, CATEGORIA_MP_NOME);
  const canal = await canais.criarCanalTicket(guild, { categoriaId, prefixo, numero, membros: [executorId] });
  await canal.send({ content: `<@${executorId}>\n\n${texto}`, components: [botoesAtoMp(numero)] });
  return canal;
}

async function abrirRequisicao({ guild, destinatario, fundamentacao, prazo, executorId }) {
  const numero = proximoNumeroClassico(db, 'atosMp', 'REQ');
  const texto = documentos.textoRequisicaoMP({ numero, destinatario, fundamentacao, prazo, autorId: executorId });
  const canal = await criarTicketAto(guild, { numero, prefixo: 'requisicao', executorId, texto });

  db.inserir('atosMp', {
    numero, tipo: 'Requisição', destinatario, fundamentacao, prazo: prazo || null, executorId,
    canalId: canal.id, processoVinculado: null,
  });

  await postarNoCanalMP(texto);
  await auditoria.registrar(guild, { acao: 'Requisição do MP expedida', executorId, referencia: `${numero}: ${destinatario}` });
  return { numero, texto, canal };
}

async function abrirRecomendacao({ guild, destinatario, fundamentacao, executorId }) {
  const numero = proximoNumeroClassico(db, 'atosMp', 'REC');
  const texto = documentos.textoRecomendacaoMP({ numero, destinatario, fundamentacao, autorId: executorId });
  const canal = await criarTicketAto(guild, { numero, prefixo: 'recomendacao', executorId, texto });

  db.inserir('atosMp', {
    numero, tipo: 'Recomendação', destinatario, fundamentacao, executorId,
    canalId: canal.id, processoVinculado: null,
  });

  await postarNoCanalMP(texto);
  await auditoria.registrar(guild, { acao: 'Recomendação do MP expedida', executorId, referencia: `${numero}: ${destinatario}` });
  return { numero, texto, canal };
}

async function abrirInqueritoCivil({ guild, objeto, fundamentacao, executorId }) {
  const numero = proximoNumeroClassico(db, 'atosMp', 'IC');
  const texto = documentos.textoPortariaInqueritoCivil({ numero, objeto, fundamentacao, autorId: executorId });
  const canal = await criarTicketAto(guild, { numero, prefixo: 'inqueritocivil', executorId, texto });

  db.inserir('atosMp', {
    numero, tipo: 'Inquérito Civil', objeto, fundamentacao, executorId, status: 'Instaurado',
    canalId: canal.id, processoVinculado: null,
  });

  await postarNoCanalMP(texto);
  await auditoria.registrar(guild, { acao: 'Inquérito Civil instaurado', executorId, referencia: `${numero}: ${objeto.slice(0, 100)}` });
  return { numero, texto, canal };
}

// Abre o modal de denúncia a partir de um ato do MP — só quem expediu o ato (ou Staff Salve)
// decide se aquilo virou crime; mesma trava de "dono do caso" usada em toda decisão específica
// deste bot (nunca isAdmin genérico, ver medida.js/processo.js).
async function abrirProcessoDeAto(interaction, numero) {
  const ato = db.buscarPorNumero('atosMp', numero);
  if (!ato) return interaction.reply({ content: 'Ato não encontrado.', ephemeral: true });
  if (interaction.user.id !== ato.executorId && !isSuperStaff(interaction)) {
    return interaction.reply({ content: `Só quem expediu este ato pode abrir o processo a partir dele — no caso, <@${ato.executorId}>.`, ephemeral: true });
  }
  if (ato.processoVinculado) {
    return interaction.reply({ content: `Este ato já gerou o processo ${ato.processoVinculado}.`, ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`painel:modal:mp:denunciamodal:${numero}`).setTitle(`Abrir processo — ${numero}`.slice(0, 45));

  const campoMotivo = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo/fatos (edite se quiser)')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue((ato.fundamentacao || '').slice(0, 4000));
  const campoReus = new TextInputBuilder().setCustomId('reus').setLabel('Menções @ dos réus, se já identificados')
    .setStyle(TextInputStyle.Short).setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(campoMotivo),
    new ActionRowBuilder().addComponents(campoReus),
  );
  return interaction.showModal(modal);
}

// Submit do modal acima — inicia o mesmo rascunho/seleção de crimes usado em qualquer abertura
// de processo penal (ver medida.js `criarProcessoModal`); a finalização fica centralizada em
// painel.js (`finalizarProcessoPenal`), que trata `tipo: 'penal-mp'` pra linkar de volta ao ato.
function criarProcessoModal(interaction, numero) {
  const ato = db.buscarPorNumero('atosMp', numero);
  if (!ato) return interaction.reply({ content: 'Ato não encontrado.', ephemeral: true });

  rascunhoCrimes.iniciar(interaction.user.id, {
    tipo: 'penal-mp',
    dados: {
      delegadoId: null,
      promotorId: ato.executorId,
      motivo: interaction.fields.getTextInputValue('motivo'),
      reusTexto: interaction.fields.getTextInputValue('reus'),
      atoMpNumero: numero,
    },
  });

  return crimePicker.mostrarPainel(interaction, { novaMensagem: true });
}

module.exports = {
  ehMembroDoMP, abrirRequisicao, abrirRecomendacao, abrirInqueritoCivil,
  abrirProcessoDeAto, criarProcessoModal,
  // FALTAVA NO EXPORT desde que commands/peticao.js:377 passou a chamá-la (commit 9180eae,
  // "manifestação do MP em petições"). A função sempre existiu aqui e era usada internamente, mas
  // nunca saiu do módulo — então toda petição administrativa estourava
  // "ministerioPublico.postarNoCanalMP is not a function" no momento de avisar o MP designado.
  // Não é regressão recente: está assim desde aquele commit.
  postarNoCanalMP,
};
