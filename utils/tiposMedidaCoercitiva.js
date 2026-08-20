// Seleção estruturada de tipo (seção 2 de painel-contexto-e-tipo-mandado.md) — compartilhada
// entre "Juiz emite mandado" (3.1) e "Promotor solicita medida" (3.2), os dois caminhos que
// coexistem dentro de um processo penal já aberto. Não inclui Citação/Intimação — esses
// continuam como fluxos independentes já existentes (ver commands/processo.js).
const { ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const TIPOS_MEDIDA_COERCITIVA = [
  { label: 'Prisão Preventiva', value: 'prisao_preventiva' },
  { label: 'Prisão Temporária', value: 'prisao_temporaria' },
  { label: 'Busca e Apreensão', value: 'busca_apreensao' },
  { label: 'Quebra de Sigilo', value: 'quebra_sigilo' },
  { label: 'Condução Coercitiva', value: 'conducao_coercitiva' },
  { label: 'Outro', value: 'outro' },
];

const LABEL_POR_VALUE = Object.fromEntries(TIPOS_MEDIDA_COERCITIVA.map(t => [t.value, t.label]));

// `multi` permite marcar VÁRIOS tipos de uma vez — o Juiz costuma expedir busca, prisão e condução
// contra o mesmo alvo no mesmo despacho, e obrigá-lo a percorrer o fluxo três vezes é atrito puro.
// Mesmo padrão da seleção de crimes, que já era múltipla.
function selectTipoMedidaCoercitiva(customId, { multi = false } = {}) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(multi ? 'Quais tipos? (pode marcar mais de um)' : 'Qual o tipo?')
    .addOptions(TIPOS_MEDIDA_COERCITIVA);
  if (multi) select.setMinValues(1).setMaxValues(TIPOS_MEDIDA_COERCITIVA.length);
  return new ActionRowBuilder().addComponents(select);
}

function rotuloTipo(value, tipoLivre) {
  if (value === 'outro') return tipoLivre || 'Outro';
  return LABEL_POR_VALUE[value] || value;
}

// ÍNDICES, e não os valores, viajam no customId. O teto do customId é 100 caracteres, e três
// valores ("prisao_preventiva,busca_apreensao,conducao_coercitiva") já passam de 55 sozinhos —
// somados ao número do processo e à referência do destinatário estourariam o limite, e o Discord
// simplesmente pararia de entregar o clique, sem erro visível.
function indicesDeValores(valores) {
  return (valores || [])
    .map(v => TIPOS_MEDIDA_COERCITIVA.findIndex(t => t.value === v))
    .filter(i => i >= 0)
    .join(',');
}

function valoresDeIndices(texto) {
  return String(texto || '')
    .split(',')
    // `Number('')` é 0, e sem este filtro uma entrada VAZIA devolveria o primeiro tipo da lista —
    // o Juiz emitiria uma prisão preventiva que ninguém marcou. Índice tem que ser dígito.
    .filter(i => /^\d+$/.test(i.trim()))
    .map(i => TIPOS_MEDIDA_COERCITIVA[Number(i)])
    .filter(Boolean)
    .map(t => t.value);
}

// R8 — modal compartilhado do fluxo tipo→destinatário→modal (mandado direto e medida direta).
// Idêntico nos dois exceto pelo customId, título e pelo último campo (nome/rótulo do teor). Os
// campos condicionais (tipoLivre quando 'outro', nome+ID quando destinatário 'fora') são iguais.
// `tipoValue` aceita uma string OU um array de valores (seleção múltipla). O campo livre nasce
// quando "Outro" está entre os escolhidos — em qualquer posição, não só quando é o único.
function modalTipoDestinatario({ customId, titulo, tipoValue, destinatarioRef, campoTeor, labelTeor }) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(String(titulo).slice(0, 45));
  const linhas = [];
  const escolhidos = Array.isArray(tipoValue) ? tipoValue : [tipoValue];
  if (escolhidos.includes('outro')) {
    linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipoLivre').setLabel('Nome do mandado ("Outro")').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
  }
  if (destinatarioRef === 'fora') {
    linhas.push(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idTexto').setLabel('RG ou Discord ID').setStyle(TextInputStyle.Short).setRequired(true)),
    );
  }
  linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(campoTeor).setLabel(labelTeor).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
  modal.addComponents(...linhas);
  return modal;
}

module.exports = { TIPOS_MEDIDA_COERCITIVA, selectTipoMedidaCoercitiva, rotuloTipo, modalTipoDestinatario, indicesDeValores, valoresDeIndices };
