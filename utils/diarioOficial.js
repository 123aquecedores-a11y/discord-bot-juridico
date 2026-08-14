// Diário Oficial Eletrônico — canal público SOMENTE-LEITURA onde os atos oficiais são
// publicados automaticamente. O ID do canal fica no storage `estado` (chave 'diarioOficialId'),
// NÃO em env (o Railway é read-only em runtime). NÃO reutiliza a env legada CANAL_DIARIO_OFICIAL_ID
// (essa é do canal "advogar-pegar-casos", que é outra coisa).
const estado = require('./estado');
const { EmbedBuilder } = require('discord.js');

const CHAVE = 'diarioOficialId';

function getCanalId() { return estado.obter(CHAVE); }
function setCanalId(id) { return estado.definir(CHAVE, id); }

function montarEmbed(tipo, d) {
  const e = new EmbedBuilder().setTimestamp().setFooter({ text: 'Diário Oficial Eletrônico' });
  switch (tipo) {
    case 'edital_aberto':
      return e.setColor(0x2c3e50).setTitle(`📜 Edital de Processo Seletivo nº ${d.numero}`)
        .setDescription('Publicação de **abertura** de processo seletivo para ingresso na magistratura e no Ministério Público.')
        .addFields(
          { name: 'Vagas', value: `Juiz: **${d.vagasJuiz}** · Promotor: **${d.vagasPromotor}**`, inline: true },
          { name: 'Inscrições', value: `${d.inicio} a ${d.fim}`, inline: true },
        );
    case 'edital_encerrado':
      return e.setColor(0x95a5a6).setTitle(`📜 Edital nº ${d.numero} — Encerrado`)
        .setDescription('Ficam **encerradas** as inscrições do processo seletivo em referência.');
    case 'sentenca':
      return e.setColor(0x8e44ad).setTitle(`⚖️ Sentença — Processo nº ${d.numero}`)
        .setDescription(`Foi proferida sentença nos autos ${d.tipoProcesso ? `(${d.tipoProcesso}) ` : ''}nº ${d.numero}.`)
        .addFields([
          d.resultado ? { name: 'Resultado', value: String(d.resultado), inline: true } : null,
          d.parte ? { name: 'Parte', value: String(d.parte), inline: true } : null,
          d.magistrado ? { name: 'Magistrado(a)', value: String(d.magistrado), inline: true } : null,
        ].filter(Boolean));
    case 'acordao':
      return e.setColor(0x8e44ad).setTitle(`⚖️ Acórdão — Processo nº ${d.numero}`)
        .setDescription('Foi proferido acórdão em grau de recurso.')
        .addFields([
          d.resultado ? { name: 'Decisão', value: String(d.resultado), inline: true } : null,
          d.relator ? { name: 'Relator(a)', value: String(d.relator), inline: true } : null,
        ].filter(Boolean));
    case 'nomeacao':
      return e.setColor(0x27ae60).setTitle('🪪 Nomeação / Atribuição de Cargo')
        .setDescription(`${d.nome ? `**${d.nome}** ` : ''}(<@${d.userId}>) foi nomeado(a) para o cargo de **${d.cargo}**.`)
        .addFields([
          { name: 'Cargo', value: String(d.cargo), inline: true },
          d.porQuemId ? { name: 'Ato de', value: `<@${d.porQuemId}>`, inline: true } : null,
        ].filter(Boolean));
    case 'mandado':
      return e.setColor(0xc0392b).setTitle(`📜 Mandado${d.tipoMandado ? ` de ${d.tipoMandado}` : ''}`)
        .setDescription(`Expedido mandado${d.processoNumero ? ` nos autos nº ${d.processoNumero}` : ''}.`)
        .addFields([
          d.numero ? { name: 'Mandado', value: String(d.numero), inline: true } : null,
          d.alvo ? { name: 'Alvo', value: String(d.alvo), inline: true } : null,
          d.porQuemId ? { name: 'Expedido por', value: `<@${d.porQuemId}>`, inline: true } : null,
        ].filter(Boolean));
    default:
      return e.setColor(0x2c3e50).setTitle('📜 Publicação Oficial').setDescription(String(d.texto || 'Ato publicado.'));
  }
}

/**
 * Publica um ato no Diário Oficial. BLINDADA: nunca lança — se não houver Diário configurado,
 * ou se o canal sumiu / o bot não tem permissão, apenas ignora (loga no console) e retorna false.
 * Assim, uma falha aqui NUNCA quebra o ato principal (sentença/edital/nomeação/mandado) que a chamou.
 * @param {import('discord.js').Guild} guild
 * @param {string} tipo
 * @param {Object} dados  campos do ato (+ opcional dados.files p/ anexar o PNG do documento)
 * @returns {Promise<boolean>} true se publicou
 */
async function publicarNoDiario(guild, tipo, dados = {}) {
  try {
    const canalId = getCanalId();
    if (!canalId || !guild) return false; // Diário não configurado → ignora em silêncio
    const canal = await guild.channels.fetch(canalId).catch(() => null);
    if (!canal || !canal.isTextBased?.()) return false;
    await canal.send({
      embeds: [montarEmbed(tipo, dados)],
      ...(Array.isArray(dados.files) && dados.files.length ? { files: dados.files } : {}),
    });
    return true;
  } catch (e) {
    console.error(`[diarioOficial] falha ao publicar ato "${tipo}" (ignorado, não quebra o ato):`, e.message);
    return false;
  }
}

module.exports = { publicarNoDiario, getCanalId, setCanalId, CHAVE };
