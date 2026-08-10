// Integração com o bot da Polícia Civil: requerimentos chegam via webhook nesse canal como
// embed, e viram medida provisória de verdade automaticamente, reaproveitando o mesmo
// solicitarMedida() que o /painel já usa — nasce com Delegado já vinculado (acesso ao canal +
// marcado) e Promotor sorteado, pronta pra decisão do MP. Não reage a mensagem comum, só a
// mensagens de fato enviadas por um webhook (message.webhookId), pra não confundir conversa
// solta no canal com requerimento de verdade.
const db = require('../database/db');
const config = require('../config');
const medidaCmd = require('../commands/medida');
const processoCmd = require('../commands/processo');
const auditoria = require('./auditoria');
const ficha = require('./ficha');
const dossie = require('./dossie');
const anexos = require('./anexos');

function extrairMencao(texto) {
  const m = texto && texto.match(/<@!?(\d+)>/);
  return m ? m[1] : null;
}

function campoDoEmbed(embed, nomeCampo) {
  const campo = (embed.fields || []).find(f => f.name.trim().toLowerCase() === nomeCampo.toLowerCase());
  return campo ? campo.value.trim() : null;
}

// Encerramento de inquérito (spec-atualizacoes-bot-juridico.md, seção 1) — evento diferente de
// pedido_medida, mesmo canal, distinguido pelo campo "Evento". O Delegado abre o processo penal
// direto do lado da Polícia Civil quando o inquérito termina; reaproveita criarProcessoPenal
// (o MESMO usado pela abertura manual via /painel), então se essa integração falhar ou nunca
// vier, o mesmo resultado continua alcançável na mão — dois caminhos, mesmo destino, sem
// depender um do outro.
async function processarEncerramentoInquerito(message, embed) {
  const delegadoId = extrairMencao(campoDoEmbed(embed, 'Delegado responsável') || campoDoEmbed(embed, 'Delegado') || '');
  const protocolo = campoDoEmbed(embed, 'Protocolo do Inquérito') || campoDoEmbed(embed, 'Protocolo');
  const reusTexto = campoDoEmbed(embed, 'Réu(s)') || campoDoEmbed(embed, 'Indiciados') || '';
  const crimesTexto = campoDoEmbed(embed, 'Crimes') || '';
  const motivo = campoDoEmbed(embed, 'Motivo/Relatório') || campoDoEmbed(embed, 'Relatório') || 'Denúncia decorrente de inquérito policial.';
  const relatorioPdfUrl = campoDoEmbed(embed, 'Relatório (PDF)') || campoDoEmbed(embed, 'Relatório PDF');

  const erros = [];
  if (!delegadoId) erros.push('campo "Delegado responsável" precisa ser uma @menção válida do Discord (não nome em texto)');
  if (!protocolo) erros.push('campo "Protocolo do Inquérito" ausente');
  if (!crimesTexto) erros.push('campo "Crimes" ausente (IDs de `/crime buscar`, separados por vírgula)');

  if (erros.length > 0) {
    await message.reply({
      content: `⚠️ **Comunicação do Tribunal** — não foi possível processar o encerramento de inquérito automaticamente:\n${erros.map(e => `• ${e}`).join('\n')}\n\nAbra o processo manualmente pelo \`/painel\` > Processo > Abrir Penal.`,
    }).catch(() => {});
    return;
  }

  const resultado = await processoCmd.criarProcessoPenal({
    guild: message.guild, delegadoId, promotorId: null,
    crimesTexto, motivo, reusTexto, medidaNumero: null, atoMpNumero: null,
  });

  if (resultado.erro) {
    await message.reply({ content: `⚠️ **Comunicação do Tribunal** — encerramento de inquérito recebido, mas não foi possível abrir o processo: ${resultado.erro}` }).catch(() => {});
    return;
  }

  // Dossiê do inquérito: puxa pro processo tudo que já foi acumulado sob esse protocolo
  // (pedidos de medida, mandados, indícios já anexados) — o relatório completa o quadro.
  dossie.vincularProcesso(protocolo, resultado.numero);
  db.atualizar('processos', resultado.numero, { codigoExterno: protocolo });

  if (relatorioPdfUrl) {
    anexos.criarDocumento({
      tipo: 'relatorio_inquerito', url: relatorioPdfUrl,
      nomeArquivo: relatorioPdfUrl.split('/').pop().split('?')[0] || 'relatorio.pdf',
      autorId: delegadoId, atoOrigemId: resultado.numero, protocoloVinculado: resultado.numero,
    });
  }

  await message.reply({ content: `✅ **Comunicação do Tribunal** — encerramento de inquérito recebido, processo ${resultado.numero} aberto e enviado à fila do Ministério Público em ${resultado.canal}.` }).catch(() => {});
  await auditoria.registrar(message.guild, {
    acao: 'Processo penal aberto via encerramento de inquérito', executorId: delegadoId,
    referencia: `${resultado.numero} (protocolo: ${protocolo})`,
  });
}

async function processarRequerimento(message) {
  if (message.channelId !== config.canalRequerimentoPoliciaCivilId) return;
  if (!message.webhookId || message.embeds.length === 0) return;

  const embed = message.embeds[0];

  // "Evento" distingue encerramento_inquerito de pedido_medida — mesmo canal, payloads
  // diferentes. Sem esse campo, cai no fluxo de sempre (pedido_medida), pra não quebrar quem já
  // manda o payload antigo sem essa marcação.
  if ((campoDoEmbed(embed, 'Evento') || '').toLowerCase() === 'encerramento de inquérito') {
    return processarEncerramentoInquerito(message, embed);
  }

  const tipoTexto = campoDoEmbed(embed, 'Tipo');
  const delegadoId = extrairMencao(campoDoEmbed(embed, 'Delegado solicitante'));
  const alvo = campoDoEmbed(embed, 'Alvo');
  const alvoDiscordId = extrairMencao(campoDoEmbed(embed, 'Discord do alvo'));
  const cpfAlvo = campoDoEmbed(embed, 'CPF do alvo');
  const nomeAlvo = campoDoEmbed(embed, 'Nome do alvo');
  const motivo = campoDoEmbed(embed, 'Motivo/Indícios') || campoDoEmbed(embed, 'Motivo');
  const codigoExterno = campoDoEmbed(embed, 'Código/Protocolo') || campoDoEmbed(embed, 'Código');
  // protocolo_inquerito da especificação é o mesmo campo que este bot já chama de
  // codigoExterno — não precisa de campo novo no contrato, só de o time da Polícia Civil
  // mandar o MESMO valor em todo pedido do mesmo inquérito (não um código novo por pedido),
  // pra que o dossiê consiga agrupar direito.
  //
  // Indícios (seção 4.1, Camada 1): se o payload já vem com o PDF, não precisa de nenhuma
  // interação — vira documento direto. Sem isso, a medida nasce travada até o Delegado anexar
  // manualmente (Camada 2, ver medida.js `anexarIndicios`).
  const indiciosPdfUrl = campoDoEmbed(embed, 'Indícios (PDF)') || campoDoEmbed(embed, 'Indícios');

  // Discord/CPF/Nome do alvo agora são obrigatórios — sem isso não dá pra vincular o alvo à
  // ficha central (utils/ficha.js), e o cruzamento de antecedentes no SISBAJUS fica cego.
  const erros = [];
  if (!delegadoId) erros.push('campo "Delegado solicitante" precisa ser uma @menção válida do Discord (não nome em texto)');
  if (!alvo) erros.push('campo "Alvo" ausente');
  if (!alvoDiscordId) erros.push('campo "Discord do alvo" precisa ser uma @menção válida do Discord (não nome em texto)');
  if (!cpfAlvo) erros.push('campo "CPF do alvo" ausente');
  if (!nomeAlvo) erros.push('campo "Nome do alvo" ausente');
  if (!motivo) erros.push('campo "Motivo/Indícios" ausente');

  if (erros.length > 0) {
    await message.reply({
      content: `⚠️ **Comunicação do Tribunal** — não foi possível processar este requerimento automaticamente:\n${erros.map(e => `• ${e}`).join('\n')}\n\nRegistre manualmente pelo \`/painel\` > Medida > Solicitar.`,
    }).catch(() => {});
    return;
  }

  // Tipo fora dos 5 valores padrão não quebra a integração — só não fica pré-classificado,
  // vira "Outra" e o texto original entra no motivo pra não perder informação.
  const tipoValido = medidaCmd.TIPOS_MEDIDA.includes(tipoTexto);
  const tipoFinal = tipoValido ? tipoTexto : 'Outra';
  const motivoFinal = [
    motivo,
    !tipoValido && tipoTexto ? `Tipo original informado pela Polícia Civil: ${tipoTexto}` : null,
    codigoExterno ? `Protocolo de origem — Polícia Civil: ${codigoExterno}` : null,
  ].filter(Boolean).join('\n\n');

  const temIndicios = !!indiciosPdfUrl;
  const resultado = await medidaCmd.solicitarMedida({
    guild: message.guild, delegadoId, promotorId: null,
    tipo: tipoFinal, alvo, alvoDiscordId, motivo: motivoFinal,
    semIndicios: !temIndicios,
  });

  if (resultado.erro) {
    await message.reply({ content: `⚠️ **Comunicação do Tribunal** — requerimento recebido, mas não foi possível registrar: ${resultado.erro}` }).catch(() => {});
    return;
  }

  // Vincula o alvo à ficha central — é isso que faz o SISBAJUS achar essa pessoa depois e
  // cruzar antecedentes de verdade, igual já acontece com cliente de petição.
  const origem = `Integração Polícia Civil — Medida ${resultado.numero}`;
  ficha.vincularDiscordId(cpfAlvo, alvoDiscordId, origem);
  ficha.definirNomeSeVazio(cpfAlvo, nomeAlvo, origem);
  // codigoExterno vira campo próprio (não só texto dentro do motivo) — é o que permite mandar
  // a devolutiva certa de volta pro protocolo certo quando o Juiz decidir (ver
  // utils/devolutivaPoliciaCivil.js).
  db.atualizar('medidas', resultado.numero, { cpfAlvo, nomeAlvo, codigoExterno: codigoExterno || null });

  // Dossiê do inquérito: registra a medida sob o protocolo, e — Camada 1 — já cria o documento
  // de indícios direto se o payload trouxe o PDF, sem precisar de nenhuma interação humana
  // (o pedido chegou via webhook, não tem uma interaction viva nesse momento).
  if (codigoExterno) dossie.registrarMedida(codigoExterno, resultado.numero);
  if (temIndicios) {
    const documentoIndicios = anexos.criarDocumento({
      tipo: 'indicios_pedido_medida', url: indiciosPdfUrl,
      nomeArquivo: indiciosPdfUrl.split('/').pop().split('?')[0] || 'indicios.pdf',
      autorId: delegadoId, atoOrigemId: resultado.numero, protocoloVinculado: codigoExterno || resultado.numero,
    });
    if (codigoExterno) dossie.registrarDocumento(codigoExterno, documentoIndicios.id);
  }

  await message.reply({ content: `✅ **Comunicação do Tribunal** — requerimento recebido e registrado como medida ${resultado.numero}, em ${resultado.canal}.` }).catch(() => {});
  await auditoria.registrar(message.guild, {
    acao: 'Medida solicitada via integração (Polícia Civil)', executorId: delegadoId,
    referencia: `${resultado.numero}${codigoExterno ? ` (protocolo PC: ${codigoExterno})` : ''}`,
  });
}

module.exports = { processarRequerimento };
