// Dossiê de conclusão/reabertura (dossie-conclusao-reabertura.md) — cartão único reaproveitado
// tanto quando o processo fica concluso pra julgamento pela primeira vez quanto quando reabre
// depois de anulação pelo Desembargador. NÃO confundir com utils/dossie.js (dossiê de INQUÉRITO
// policial — conceito diferente, chave é protocoloInquerito, não processo).
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { truncar } = require('./texto');

// Processo civil tem autorNome/reuNome (texto livre — nome do personagem, não o apelido do
// jogador no Discord). Penal não tem "autor" no sentido processual — quem acusa é o MP.
function nomeAutor(processo) {
  if (processo.autorNome) return processo.autorNome;
  return processo.promotor ? `<@${processo.promotor}> (Ministério Público)` : 'Ministério Público';
}

function nomesReus(processo) {
  if (processo.reuNome) return processo.reuNome;
  return (processo.reus || []).map(id => `<@${id}>`).join(', ') || 'a identificar';
}

/**
 * Monta e posta o cartão de dossiê no canal do processo.
 * @param {import('discord.js').TextChannel} canal
 * @param {Object} processo
 * @param {Array} documentos - `documento`s vinculados a esse processo (ver
 *   mecanicas-anexo-e-vinculo-processual.md / utils/anexos.js -> listarPorProtocolo)
 * @param {Object} [acordao] - presente só quando o dossiê nasce de uma anulação:
 *   { motivo: string, desembargador: string, dataAnulacao: Date }
 */
async function postarDossie(canal, processo, documentos, acordao = null) {
  const embed = new EmbedBuilder()
    .setTitle(`📁 Processo ${processo.numero} — Dossiê para Julgamento`)
    .setColor(acordao ? 0xc8102e : 0x2b2d31);

  if (acordao) {
    embed.addFields({
      name: '⚠️ Acórdão — Sentença anterior anulada',
      value: `Motivo: ${truncar(acordao.motivo, 500)}\nDesembargador: ${acordao.desembargador}\nData: ${acordao.dataAnulacao.toLocaleDateString('pt-BR')}`,
    });
  }

  const listaDocumentos = documentos.map(d => `[${d.tipo}](${d.url})`).join('\n') || 'Nenhum documento anexado.';
  embed.addFields(
    { name: 'Autor', value: truncar(nomeAutor(processo), 200), inline: true },
    { name: 'Réu(s)', value: truncar(nomesReus(processo), 200), inline: true },
    { name: 'Documentos', value: truncar(listaDocumentos, 1000) },
  );

  // "Julgar" reaproveita o botão/handler que já existe (processo:julgar:numero, mapa bare do
  // index.js) — não é um botão novo, só reexibido aqui pra não obrigar quem vai julgar a rolar
  // até a mensagem antiga que abriu o processo.
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`processo:julgar:${processo.numero}`).setLabel('Julgar').setStyle(ButtonStyle.Success),
  );
  // "Requerer novas provas" reabre a instrução — e "Concluso para julgamento" é sempre
  // reabrível, então o botão aparece SEMPRE (não só na anulação/acordão). Antes ele só surgia
  // com acordão, o que capava o ciclo requerer→concluir em 1 vez (ponta solta da auditoria).
  botoes.addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:processo:requererprovas:${processo.numero}`).setLabel('Requerer novas provas').setStyle(ButtonStyle.Secondary),
  );

  return canal.send({ embeds: [embed], components: [botoes] });
}

module.exports = { postarDossie };
