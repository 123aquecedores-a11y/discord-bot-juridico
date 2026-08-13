// Integração com o bot da Polícia Civil: requerimentos chegam via webhook nesse canal como
// embed, e viram medida cautelar de verdade automaticamente, reaproveitando o mesmo
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
const { extrairMencao } = require('./texto');
const { resolverCrimesTexto, extrairCrimesDeRelatorio } = require('./crimesTexto');

function campoDoEmbed(embed, nomeCampo) {
  const campo = (embed.fields || []).find(f => f.name.trim().toLowerCase() === nomeCampo.toLowerCase());
  return campo ? campo.value.trim() : null;
}

// Reconhece um encerramento de inquérito (relatório final do Delegado) entre as mensagens que a
// Polícia Civil manda no mesmo canal. Dois sinais, qualquer um serve:
//   1) campo "Evento" explícito (contrato ideal da spec de integração, seção 5.3); ou
//   2) presença de um "Relatório Final"/"Relatório" — assinatura que só o encerramento tem (o
//      pedido_medida traz Tipo/Alvo, a abertura_inquerito não tem relatório), então dá pra rotear
//      mesmo quando o payload real vem rotulado "Requerimento de Andamento Processual", sem o
//      campo "Evento". É parsing de embed (frágil por natureza — ver integracao-tribunal-policia-
//      civil.md seção 4), mas é o formato que chega hoje; o caminho manual via /painel continua.
function ehEncerramentoInquerito(embed) {
  // 1) Sinal EXPLÍCITO de tipo de evento — o mais confiável (contrato ideal da spec de integração,
  //    integracao-tribunal-policia-civil.md seção 5). O ideal é a Polícia Civil sempre mandar um
  //    "Evento"/"tipo_evento": encerrar inquérito ABRE PROCESSO; pedir medida abre CAUTELAR — sem
  //    esse campo, os dois podem chegar com o mesmo título ("Requerimento de Andamento Processual").
  const evento = (campoDoEmbed(embed, 'Evento') || campoDoEmbed(embed, 'tipo_evento') || '').toLowerCase();
  if (evento.includes('encerramento') && evento.includes('inqu')) return true;
  if (evento.includes('medida')) return false;

  // 2) Sem o campo de tipo, decide pelo CONTEÚDO (nunca pelo título, que é genérico demais e
  //    rotularia os dois): pedido de medida traz Alvo + RG do alvo — se tem isso, é medida, não
  //    encerramento. Encerramento traz relatório final / tipificação (campo "Crimes") / indiciamento.
  const pareceMedida = campoDoEmbed(embed, 'Alvo')
    && (campoDoEmbed(embed, 'RG do alvo') || campoDoEmbed(embed, 'CPF do alvo'));
  if (pareceMedida) return false;
  if (campoDoEmbed(embed, 'Relatório Final') || campoDoEmbed(embed, 'Relatório') || campoDoEmbed(embed, 'Crimes')) return true;
  // Relatório grande (>1024, o limite de um campo de embed) chega na descrição — reconhece pelo
  // conteúdo do indiciamento ali.
  return /incid[êe]ncia\s+penal|indiciad[oa]/i.test(embed.description || '');
}

// Junta o texto do relatório venha ele de um campo de embed (curto, ≤1024) ou da descrição
// (relatório grande) — os dois entram na extração de crimes/indiciado e viram o motivo do processo.
function textoDoRelatorio(embed) {
  const campo = campoDoEmbed(embed, 'Relatório Final') || campoDoEmbed(embed, 'Motivo/Relatório')
    || campoDoEmbed(embed, 'Relatório') || '';
  const descricao = (embed.description || '').trim();
  return [campo, descricao].filter(Boolean).join('\n\n').trim();
}

// Puxa o nome do indiciado da prosa do relatório ("INDICIADO: Fulano ..." / "INDICIADOS: ...")
// quando não veio num campo estruturado. Retorna só o nome (sem RG/Discord) — vira réu "por nome",
// vinculável ao Discord depois (spec seção 10: RG+nome é registro principal, Discord é opcional).
// Para de capturar ao encontrar o começo da tipificação/fatos, pra não engolir o relatório inteiro.
function extrairIndiciadoDoRelatorio(relatorio) {
  if (!relatorio) return null;
  const m = relatorio.match(/indiciad[oa]s?:?\s*(.+?)(?=\s+(?:incid[êe]ncia|tipifica|capitula|dos\s+fatos|art\.?\s)|[\n.]|$)/i);
  const nome = m && m[1] ? m[1].trim() : '';
  // Evita capturar lixo: nome plausível tem letra e não é enorme.
  return nome && nome.length >= 3 && nome.length <= 120 && /[a-zà-ú]/i.test(nome) ? nome : null;
}

// Encerramento de inquérito (spec-atualizacoes-bot-juridico.md, seção 1) — evento diferente de
// pedido_medida, mesmo canal. O Delegado encerra o inquérito com o relatório final e isso abre o
// processo penal, reaproveitando criarProcessoPenal (o MESMO usado pela abertura manual via
// /painel), então se essa integração falhar ou nunca vier, o mesmo resultado continua alcançável
// na mão — dois caminhos, mesmo destino, sem depender um do outro. Reconhecimento e extração dos
// crimes/indiciado toleram o formato real que a Polícia Civil manda (ver ehEncerramentoInquerito).
async function processarEncerramentoInquerito(message, embed) {
  const delegadoId = extrairMencao(
    campoDoEmbed(embed, 'Delegado responsável') || campoDoEmbed(embed, 'Delegado') || campoDoEmbed(embed, 'Delegado solicitante') || '',
  );
  const protocolo = campoDoEmbed(embed, 'Protocolo do Inquérito') || campoDoEmbed(embed, 'Protocolo')
    || campoDoEmbed(embed, 'Código/Protocolo') || campoDoEmbed(embed, 'Código');
  const reusTexto = campoDoEmbed(embed, 'Réu(s)') || campoDoEmbed(embed, 'Indiciados') || '';
  const crimesField = campoDoEmbed(embed, 'Crimes') || '';
  // "Relatório Final" é o texto principal do encerramento — vem de campo (curto) ou da descrição
  // do embed (relatório grande, >1024). Aceita os rótulos antigos também.
  const relatorio = textoDoRelatorio(embed);
  const motivo = relatorio || 'Denúncia decorrente de inquérito policial.';
  const relatorioPdfUrl = campoDoEmbed(embed, 'Relatório (PDF)') || campoDoEmbed(embed, 'Relatório PDF');

  // Crimes: se veio um campo estruturado "Crimes", usa ele (aceita ID/artigo/nome); senão, extrai
  // da PROSA do relatório final ("INCIDÊNCIA PENAL: Art. X (Nome); ..."), que é como a Polícia
  // Civil manda hoje. O que não for reconhecido é avisado pra inclusão manual, não some calado.
  let crimesResolvidos = [];
  let crimesNaoReconhecidos = [];
  if (crimesField) {
    crimesResolvidos = resolverCrimesTexto(crimesField);
  } else if (relatorio) {
    const ex = extrairCrimesDeRelatorio(relatorio);
    crimesResolvidos = ex.crimes;
    crimesNaoReconhecidos = ex.naoReconhecidos;
  }

  // Indiciado por nome, quando não veio campo estruturado de réu(s).
  const reuNomeProsa = reusTexto ? null : extrairIndiciadoDoRelatorio(relatorio);

  const erros = [];
  if (!delegadoId) erros.push('campo "Delegado responsável" precisa ser uma @menção válida do Discord (não nome em texto)');
  if (!protocolo) erros.push('campo "Protocolo do Inquérito"/"Código/Protocolo" ausente');
  if (crimesResolvidos.length === 0) {
    erros.push('nenhum crime reconhecido — informe a tipificação por nome/artigo no relatório (ex.: "Art. 121 (Homicídio)") ou num campo "Crimes"');
  }

  if (erros.length > 0) {
    await message.reply({
      content: `⚠️ **Comunicação do Tribunal** — não foi possível processar o encerramento de inquérito automaticamente:\n${erros.map(e => `• ${e}`).join('\n')}\n\nAbra o processo manualmente pelo \`/painel\` > Processo > Abrir Penal.`,
    }).catch(() => {});
    return;
  }

  const resultado = await processoCmd.criarProcessoPenal({
    guild: message.guild, delegadoId, promotorId: null,
    // Re-serializa só os IDs já reconhecidos — garante que entram exatamente os crimes casados.
    crimesTexto: crimesResolvidos.map(c => c.id).join(','),
    motivo, reusTexto, reuNome: reuNomeProsa, reuRg: null,
    medidaNumero: null, atoMpNumero: null,
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

  const qtd = crimesResolvidos.length;
  const linhaCrimes = `📌 ${qtd} crime${qtd > 1 ? 's' : ''} reconhecido${qtd > 1 ? 's' : ''} e incluído${qtd > 1 ? 's' : ''} automaticamente.`;
  // Crimes que a base não reconheceu não travam a abertura — mas o Delegado/Promotor precisa saber
  // pra completar à mão (via /painel > Processo), senão sumiriam sem ninguém perceber.
  const linhaFalta = crimesNaoReconhecidos.length
    ? `\n⚠️ Não reconheci na base (adicione manualmente se aplicável): ${crimesNaoReconhecidos.join('; ')}.`
    : '';
  await message.reply({
    content: `✅ **Comunicação do Tribunal** — encerramento de inquérito recebido, processo ${resultado.numero} aberto e enviado à fila do Ministério Público em ${resultado.canal}.\n${linhaCrimes}${linhaFalta}`,
  }).catch(() => {});
  await auditoria.registrar(message.guild, {
    acao: 'Processo penal aberto via encerramento de inquérito', executorId: delegadoId,
    referencia: `${resultado.numero} (protocolo: ${protocolo})`,
  });
}

let avisouWebhookNaoConfigurado = false;

async function processarRequerimento(message) {
  if (message.channelId !== config.canalRequerimentoPoliciaCivilId) return;
  if (!message.webhookId || message.embeds.length === 0) return;

  // Frente 2.1 — autenticidade além do "tem webhookId": se o id do webhook esperado da Polícia
  // Civil estiver configurado, exige que seja EXATAMENTE ele (rejeita e loga o resto — possível
  // forjação). Sem o id configurado, mantém o comportamento antigo, mas avisa (1x) que a validação
  // forte está desligada, pra não ficar uma brecha silenciosa.
  if (config.webhookRequerimentoPoliciaCivilId) {
    if (message.webhookId !== config.webhookRequerimentoPoliciaCivilId) {
      console.warn(`[integracaoPC] Requerimento REJEITADO — webhook ${message.webhookId} ≠ esperado (possível forjação de pedido da Polícia Civil).`);
      return;
    }
  } else if (!avisouWebhookNaoConfigurado) {
    avisouWebhookNaoConfigurado = true;
    console.warn('[integracaoPC] WEBHOOK_REQUERIMENTO_POLICIA_CIVIL_ID não configurado — validação forte de autenticidade DESLIGADA (qualquer webhook nesse canal é aceito). Defina o id do webhook da Polícia Civil no .env pra fechar a brecha (Frente 2.1).');
  }

  const embed = message.embeds[0];

  // "Evento" distingue encerramento_inquerito de pedido_medida — mesmo canal, payloads
  // diferentes. Sem esse campo, cai no fluxo de sempre (pedido_medida), pra não quebrar quem já
  // manda o payload antigo sem essa marcação.
  if (ehEncerramentoInquerito(embed)) {
    return processarEncerramentoInquerito(message, embed);
  }

  const tipoTexto = campoDoEmbed(embed, 'Tipo');
  const delegadoId = extrairMencao(campoDoEmbed(embed, 'Delegado solicitante'));
  const alvo = campoDoEmbed(embed, 'Alvo');
  const alvoDiscordId = extrairMencao(campoDoEmbed(embed, 'Discord do alvo'));
  // Aceita "RG do alvo" (novo padrão) e "CPF do alvo" (payload antigo do bot da PC) — enquanto
  // o time da Polícia Civil não migra o rótulo, os dois funcionam.
  const rgAlvo = campoDoEmbed(embed, 'RG do alvo') || campoDoEmbed(embed, 'CPF do alvo');
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

  // RG + Nome do alvo são o registro principal (Parte 2) — obrigatórios. Discord do alvo é
  // OPCIONAL: o réu/alvo pode existir só com RG+nome (nem todo alvo tem conta no servidor). O
  // resto do fluxo de medida já tolera alvoDiscordId nulo (|| null, .filter(Boolean), guards).
  // Delegado (exerce função) continua precisando de @menção válida.
  const erros = [];
  if (!delegadoId) erros.push('campo "Delegado solicitante" precisa ser uma @menção válida do Discord (não nome em texto)');
  if (!alvo) erros.push('campo "Alvo" ausente');
  if (!rgAlvo) erros.push('campo "RG do alvo" ausente');
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
  ficha.vincularDiscordId(rgAlvo, alvoDiscordId, origem);
  ficha.definirNomeSeVazio(rgAlvo, nomeAlvo, origem);
  // codigoExterno vira campo próprio (não só texto dentro do motivo) — é o que permite mandar
  // a devolutiva certa de volta pro protocolo certo quando o Juiz decidir (ver
  // utils/devolutivaPoliciaCivil.js).
  db.atualizar('medidas', resultado.numero, { rgAlvo, nomeAlvo, codigoExterno: codigoExterno || null });

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

module.exports = { processarRequerimento, ehEncerramentoInquerito, extrairIndiciadoDoRelatorio };
