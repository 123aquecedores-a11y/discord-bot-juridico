// Diário Oficial Eletrônico — canal público SOMENTE-LEITURA onde os atos oficiais são
// publicados automaticamente. O ID do canal fica no storage `estado` (chave 'diarioOficialId'),
// NÃO em env (o Railway é read-only em runtime). NÃO reutiliza a env legada CANAL_DIARIO_OFICIAL_ID
// (essa é do canal "advogar-pegar-casos", que é outra coisa).
const estado = require('./estado');
const guildGuard = require('./guildGuard');
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
    // ⚠️ Card legado, hoje sem nenhum chamador: mandado só entra no Diário pela engine
    // utils/diarioAtos.js, que aplica a política de sigilo por tipo (allow-list de prisão
    // preventiva/temporária no cumprimento). Não volte a chamar este tipo direto — passaria por
    // fora da política e publicaria tipo e alvo de diligência sigilosa.
    case 'mandado':
      return e.setColor(0xc0392b).setTitle(`📜 Mandado${d.tipoMandado ? ` de ${d.tipoMandado}` : ''}`)
        .setDescription(`Expedido mandado${d.processoNumero ? ` nos autos nº ${d.processoNumero}` : ''}.`)
        .addFields([
          d.numero ? { name: 'Mandado', value: String(d.numero), inline: true } : null,
          d.alvo ? { name: 'Alvo', value: String(d.alvo), inline: true } : null,
          d.porQuemId ? { name: 'Expedido por', value: `<@${d.porQuemId}>`, inline: true } : null,
        ].filter(Boolean));
    case 'comunicado': {
      // Título + corpo (markdown livre) + links (URLs cruas, uma por linha → o Discord linka na
      // description). Tudo na description (limite 4096) pra caber corpo longo.
      let desc = String(d.corpo || '');
      if (d.linksTexto) desc += `\n\n🔗 **Links**\n${d.linksTexto}`;
      return e.setColor(0x1f6feb).setTitle(`📢 ${String(d.titulo || 'Comunicado').slice(0, 256)}`).setDescription(desc.slice(0, 4096));
    }
    case 'peticao_administrativa':
      // Nível 1 — decisão de pedido administrativo (porte de arma, troca de nome, limpeza de ficha,
      // alvará), deferido ou indeferido. O corpo íntegro vai no PNG anexo (dados.files); o card é curto.
      return e.setColor(d.resultado === 'Deferido' ? 0x27ae60 : 0xc0392b)
        .setTitle(`⚖️ ${d.tipoPeticao || 'Pedido administrativo'} — ${d.resultado || ''}`.trim())
        .setDescription(`Decisão em pedido administrativo${d.parte ? ` de **${d.parte}**` : ''}.`)
        .addFields([
          d.tipoPeticao ? { name: 'Pedido', value: String(d.tipoPeticao), inline: true } : null,
          d.resultado ? { name: 'Resultado', value: String(d.resultado), inline: true } : null,
          d.numero ? { name: 'Protocolo', value: String(d.numero), inline: true } : null,
          d.validadeAte ? { name: 'Validade', value: `<t:${Math.floor(new Date(d.validadeAte).getTime() / 1000)}:D>`, inline: true } : null,
          d.magistradoId ? { name: 'Magistrado(a)', value: `<@${d.magistradoId}>`, inline: true } : null,
        ].filter(Boolean));
    case 'arquivamento_inquerito':
      return e.setColor(0x7f8c8d).setTitle(`📁 Inquérito arquivado — Processo nº ${d.numero}`)
        .setDescription('O Ministério Público promoveu o **arquivamento** do inquérito.')
        .addFields([d.promotorId ? { name: 'Promotor(a)', value: `<@${d.promotorId}>`, inline: true } : null].filter(Boolean));
    case 'indeferimento_inicial':
      return e.setColor(0xc0392b).setTitle(`📁 Petição inicial indeferida — Processo nº ${d.numero}`)
        .setDescription('O Juízo **indeferiu a petição inicial** e arquivou os autos.')
        .addFields([d.juizId ? { name: 'Magistrado(a)', value: `<@${d.juizId}>`, inline: true } : null].filter(Boolean));
    case 'desarquivamento':
      return e.setColor(0x27ae60).setTitle(`📂 Arquivamento revisto — Processo nº ${d.numero}`)
        .setDescription('Em revisão de arquivamento, a **denúncia foi forçada** e o processo **reaberto para instrução**.')
        .addFields([d.juizId ? { name: 'Juiz(a) sorteado(a)', value: `<@${d.juizId}>`, inline: true } : null].filter(Boolean));
    case 'mandado_cumprido':
      return e.setColor(0xc0392b).setTitle(`📜 Mandado cumprido${d.tipoMandado ? ` — ${d.tipoMandado}` : ''}`)
        .setDescription(`Mandado cumprido${d.processoNumero ? ` nos autos nº ${d.processoNumero}` : ''}.`)
        .addFields([
          d.numero ? { name: 'Mandado', value: String(d.numero), inline: true } : null,
          d.alvo ? { name: 'Alvo', value: String(d.alvo), inline: true } : null,
          d.cumpridoPorId ? { name: 'Cumprido por', value: `<@${d.cumpridoPorId}>`, inline: true } : null,
        ].filter(Boolean));
    case 'mandado_nao_cumprido':
      return e.setColor(0x7f8c8d).setTitle(`📜 Mandado não cumprido${d.tipoMandado ? ` — ${d.tipoMandado}` : ''}`)
        .setDescription(`Mandado expedido${d.processoNumero ? ` nos autos nº ${d.processoNumero}` : ''} e **não cumprido** até o encerramento do caso.`)
        .addFields([
          d.numero ? { name: 'Mandado', value: String(d.numero), inline: true } : null,
          d.alvo ? { name: 'Alvo', value: String(d.alvo), inline: true } : null,
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
    // Camada de profundidade do isolamento: o Diário é publicação PÚBLICA com @everyone —
    // publicar ato de um tribunal no servidor do outro é o pior vazamento possível aqui.
    if (!guildGuard.guardarEvento('diarioOficial.publicarNoDiario', guild, `ato "${tipo}"`)) return false;
    const canal = await guild.channels.fetch(canalId).catch(() => null);
    if (!canal || !canal.isTextBased?.()) return false;
    // Publicação em tempo real marca @everyone (decisão do operador). No modo SILENCIOSO
    // (varredura/backfill) NÃO marca — senão o backlog vira uma enxurrada de pings. Best-effort:
    // garante a permissão de mencionar @everyone só quando vai usá-la.
    const silencioso = !!dados.silencioso;
    const botId = guild.members?.me?.id || guild.client?.user?.id;
    if (botId && !silencioso) await canal.permissionOverwrites.edit(botId, { MentionEveryone: true }).catch(() => {});
    const enviada = await canal.send({
      content: silencioso ? '' : '@everyone',
      allowedMentions: silencioso ? { parse: [] } : { parse: ['everyone'] },
      embeds: [montarEmbed(tipo, dados)],
      ...(Array.isArray(dados.files) && dados.files.length ? { files: dados.files } : {}),
    });
    // Devolve a Message (não mais um booleano) pra quem precisa do id — a engine diarioAtos guarda
    // diarioMessageId p/ o card evoluir depois. Message é truthy, então os `if (publicou)` seguem OK.
    return enviada;
  } catch (e) {
    console.error(`[diarioOficial] falha ao publicar ato "${tipo}" (ignorado, não quebra o ato):`, e.message);
    return false;
  }
}

module.exports = { publicarNoDiario, getCanalId, setCanalId, CHAVE };
