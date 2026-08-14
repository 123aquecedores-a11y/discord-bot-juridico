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

function selectTipoMedidaCoercitiva(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Qual o tipo?').addOptions(TIPOS_MEDIDA_COERCITIVA),
  );
}

function rotuloTipo(value, tipoLivre) {
  if (value === 'outro') return tipoLivre || 'Outro';
  return LABEL_POR_VALUE[value] || value;
}

// R8 — modal compartilhado do fluxo tipo→destinatário→modal (mandado direto e medida direta).
// Idêntico nos dois exceto pelo customId, título e pelo último campo (nome/rótulo do teor). Os
// campos condicionais (tipoLivre quando 'outro', nome+ID quando destinatário 'fora') são iguais.
function modalTipoDestinatario({ customId, titulo, tipoValue, destinatarioRef, campoTeor, labelTeor }) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(String(titulo).slice(0, 45));
  const linhas = [];
  if (tipoValue === 'outro') {
    linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipoLivre').setLabel('Descreva o tipo').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
  }
  if (destinatarioRef === 'fora') {
    linhas.push(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nomeCompleto').setLabel('Nome completo').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idTexto').setLabel('RG ou Discord ID').setStyle(TextInputStyle.Short).setRequired(true)),
    );
  }
  linhas.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(campoTeor).setLabel(labelTeor).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
  modal.addComponents(...linhas);
  return modal;
}

module.exports = { TIPOS_MEDIDA_COERCITIVA, selectTipoMedidaCoercitiva, rotuloTipo, modalTipoDestinatario };
