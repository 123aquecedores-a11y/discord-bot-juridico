// Textos formais dos atos do bot — mesma lógica de textoIntimacao (processo.js): bloco de
// texto puro (não imagem), pra manter as @menções pingáveis e dar pra copiar/colar como um
// documento de verdade, imitando a estrutura de um ato judicial real.
//
// Mensagem de texto do Discord tem limite de 2000 caracteres — campos de texto livre (sentença,
// razões de recurso, fundamentação) são truncados aqui pra nunca estourar isso mesmo somados.
const { truncar } = require('./texto');

const LIMITE_MENSAGEM = 2000;
// Margem pro que o chamador cola ANTES do documento — a menção do destinatário no mandado
// (`<@delegado>\n\n`, em commands/medida.js), prefixos de emoji etc. Sem reservar isso o documento
// cabe sozinho e estoura mesmo assim na hora do send.
const RESERVA_PREFIXO = 120;

// Cada campo de texto livre tinha um teto fixo (600/1200/1500) e ninguém conferia o SOMATÓRIO: o
// mandado da medida cautelar somava 2206 caracteres com os três campos no talo (representação do
// Delegado + manifestação do MP + fundamentação do Juízo) e a API recusava a mensagem inteira com
// `content[BASE_TYPE_MAX_LENGTH]` — a medida ficava gravada como deferida e o mandado nunca
// aparecia no canal.
//
// Aqui o teto é do documento montado, não de cada campo. A estrutura fixa (cabeçalho, dispositivo,
// data, assinatura) é intocável — cortar pelo fim comeria justamente a assinatura do ato — e o
// corte cai só nos textos livres. O teor íntegro continua no banco e no PNG; isto limita só a
// exibição em texto.
function montarDocumento(montar, livres, reserva = RESERVA_PREFIXO) {
  const textos = livres.map(t => t || '');
  const documento = montar(textos);
  const orcamento = LIMITE_MENSAGEM - reserva;
  if (documento.length <= orcamento) return documento;

  // `- textos.length` paga o "…" que o truncar acrescenta a cada campo cortado.
  const fixo = documento.length - textos.reduce((soma, t) => soma + t.length, 0);
  const cortado = montar(cotas(textos, orcamento - fixo - textos.length).map((cota, i) => truncar(textos[i], cota)));
  if (cortado.length <= LIMITE_MENSAGEM) return cortado;
  // Rede final: se nem assim coube, quem é grande demais é a estrutura fixa (ex.: sentença com
  // dezenas de réus mencionados). Mandar truncado é melhor que estourar a interação no meio de um
  // ato que já foi gravado no banco.
  console.warn(`[documentos] documento de ${cortado.length} caracteres truncado no limite do Discord`);
  return `${cortado.slice(0, LIMITE_MENSAGEM - 1)}…`;
}

// Divide `total` caracteres entre os textos livres: quem cabe na cota igualitária leva só o que
// precisa e devolve a sobra pra próxima rodada; quem não cabe divide o que restou. Sem isso um
// campo de duas linhas desperdiçaria a cota inteira enquanto a fundamentação do Juízo era cortada.
function cotas(textos, total) {
  const cota = new Array(textos.length).fill(0);
  let pendentes = textos.map((_, i) => i);
  // Piso de 80 por campo: nenhum campo do ato pode sumir por completo do documento.
  let restante = Math.max(total, 80 * textos.length);
  while (pendentes.length) {
    const parcela = Math.floor(restante / pendentes.length);
    const cabem = pendentes.filter(i => textos[i].length <= parcela);
    if (!cabem.length) { pendentes.forEach(i => { cota[i] = parcela; }); break; }
    cabem.forEach(i => { cota[i] = textos[i].length; restante -= textos[i].length; });
    pendentes = pendentes.filter(i => textos[i].length > parcela);
  }
  return cota;
}

function dataExtenso() {
  return new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Dispositivo POR CRIME (lote 5, Função 2) — quando a sentença penal foi proferida crime a crime
// (processo.sentencaPorCrime), o dispositivo condena e absolve por tipificação. Senão, retorna null
// e o textoSentenca cai no dispositivo agregado antigo.
function dispositivoSentencaPenal(processo) {
  const spc = processo.sentencaPorCrime;
  if (!Array.isArray(spc) || spc.length === 0) return null;
  const nomeCrime = (s) => `${s.nome}${s.codigo_artigo ? ` (Art. ${s.codigo_artigo})` : ''}`;
  const cond = spc.filter(s => s.resultado === 'Condenado');
  const abs = spc.filter(s => s.resultado === 'Absolvido');
  const linhas = [];
  if (cond.length) {
    linhas.push(`Julgo **PARCIALMENTE PROCEDENTE** a pretensão punitiva para **CONDENAR** o(a) réu(ré) quanto a: ${cond.map(nomeCrime).join('; ')}${processo.pena ? `.\nPenas aplicadas: ${processo.pena}` : '.'}${processo.regime ? ` Regime inicial: ${processo.regime}.` : ''}`);
  }
  if (abs.length) {
    linhas.push(`**ABSOLVO** o(a) réu(ré) quanto a: ${abs.map(nomeCrime).join('; ')}.`);
  }
  return linhas.join('\n');
}

function textoSentenca(processo) {
  const partes = processo.tipo === 'Penal'
    ? [`Delegado: <@${processo.delegado}>`, `Promotor: <@${processo.promotor}>`, `Réu(s): ${(processo.reus || []).map(id => `<@${id}>`).join(', ') || 'a identificar'}`]
    : [`Autor: <@${processo.autor}>`, `Réu(s): ${(processo.reus || []).map(id => `<@${id}>`).join(', ') || 'a identificar'}`];

  const dispositivo = (processo.tipo === 'Penal' && dispositivoSentencaPenal(processo)) || {
    Condenado: 'Julgo **PROCEDENTE** a pretensão punitiva estatal para **CONDENAR** o(a) réu(ré).',
    Absolvido: 'Julgo **IMPROCEDENTE** a pretensão punitiva estatal para **ABSOLVER** o(a) réu(ré).',
    Procedente: 'Julgo **PROCEDENTE** o pedido.',
    Improcedente: 'Julgo **IMPROCEDENTE** o pedido.',
  }[processo.resultado] || 'Resultado não estruturado.';

  return montarDocumento(([fund]) => [
    '**PODER JUDICIÁRIO**',
    `**Processo nº ${processo.numero} (${processo.tipo})**`,
    '',
    '**SENTENÇA**',
    '',
    'Vistos, relatados e examinados os autos do processo em epígrafe.',
    '',
    '**Partes:**',
    partes.join('\n'),
    '',
    '**Fundamentação:**',
    fund,
    '',
    `**Dispositivo:** ${dispositivo}`,
    '',
    'Publique-se. Registre-se. Intimem-se as partes.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${processo.juiz}> — Juiz(a) de Direito`,
  ].join('\n'), [processo.sentenca]);
}

function textoAcordao({ apelacao, decisaoTexto, statusFinal }) {
  const decisaoLinha = {
    Mantida: 'A Câmara, por decisão do Desembargador relator, **NEGA PROVIMENTO** ao recurso — a sentença de origem fica **MANTIDA** em seus exatos termos.',
    Reformada: 'A Câmara, por decisão do Desembargador relator, **DÁ PROVIMENTO** ao recurso — a sentença de origem fica **REFORMADA**.',
    Anulada: 'A Câmara, por decisão do Desembargador relator, **ANULA** a sentença de origem e determina a remessa dos autos a novo julgamento, com novo sorteio de Juiz.',
  }[statusFinal];

  return montarDocumento(([razoes, doRelator]) => [
    '**TRIBUNAL DE JUSTIÇA**',
    `**Apelação nº ${apelacao.numero}** (processo originário ${apelacao.processoOriginalNumero})`,
    '',
    '**ACÓRDÃO**',
    '',
    `Vistos, relatados e discutidos os autos da apelação interposta por <@${apelacao.recorrenteId}> em face de <@${apelacao.parteContrariaId || 'parte contrária'}>.`,
    '',
    '**Razões do recurso:**',
    razoes,
    '',
    `**Decisão:** ${decisaoLinha}`,
    ...(decisaoTexto ? ['', '**Fundamentação do relator:**', doRelator] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${apelacao.desembargadorId}> — Desembargador(a) Relator(a)`,
  ].join('\n'), [apelacao.razoes, decisaoTexto]);
}

const TIPO_PETICAO_TITULO = { PorteArma: 'PORTE DE ARMA', TrocaNome: 'TROCA DE NOME', LimpezaFicha: 'LIMPEZA DE FICHA CRIMINAL' };

function objetoPeticao(peticao) {
  if (peticao.tipo === 'TrocaNome') return `retificação de nome de "${peticao.nomeAtual}" para "${peticao.nomeNovo}"${peticao.rgCliente ? ` (RG ${peticao.rgCliente})` : ''}`;
  if (peticao.tipo === 'LimpezaFicha') return 'exclusão de antecedentes da ficha criminal';
  return 'concessão de porte de arma de fogo';
}

// Texto padrão pra toda decisão (deferir/indeferir) de petição administrativa — mesmo formato
// pros três tipos, só troca o objeto do pedido e a fundamentação.
function textoSentencaPeticao({ peticao, status, motivo }) {
  const dispositivo = status === 'Deferido'
    ? `Ante o exposto, **DEFIRO** o pedido de ${objetoPeticao(peticao)}, nos termos requeridos.`
    : `Ante o exposto, **INDEFIRO** o pedido de ${objetoPeticao(peticao)}, por ausência dos requisitos legais para a espécie.`;

  const qualificacao = peticao.rgCliente
    ? [
        `Requerente: ${peticao.nomeCliente || peticao.nomeNovo || '—'}, RG ${peticao.rgCliente}${peticao.enderecoCliente ? `, residente em ${peticao.enderecoCliente}` : ''}.`,
        `Advogado(a): <@${peticao.requerenteId}>.`,
      ].join('\n')
    : `Requerente: <@${peticao.requerenteId}>`;

  return montarDocumento(([fund]) => [
    '**PODER JUDICIÁRIO**',
    `**Petição nº ${peticao.numero} (${TIPO_PETICAO_TITULO[peticao.tipo]})**`,
    '',
    '**SENTENÇA**',
    '',
    'Vistos, relatados e examinados os autos da presente petição administrativa.',
    '',
    qualificacao,
    '',
    '**Fundamentação:**',
    fund || 'Presentes os requisitos legais exigidos para a espécie, conforme análise dos documentos e diligências constantes dos autos.',
    '',
    `**Dispositivo:** ${dispositivo}`,
    '',
    'Publique-se. Registre-se. Intimem-se os interessados.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${peticao.juiz}> — Juiz(a) de Direito`,
  ].join('\n'), [motivo]);
}

function textoMandado({ numero, medida, fundamentacaoPromotor, fundamentacaoJuiz, codigoExterno }) {
  return montarDocumento(([alvo, motivo, doMinisterioPublico, doJuizo]) => [
    '**PODER JUDICIÁRIO**',
    `**Mandado nº ${numero}** (medida ${medida.numero})`,
    '',
    `**MANDADO DE ${medida.tipo.toUpperCase()}**`,
    '',
    ...(codigoExterno ? [`Pedido advindo do Inquérito Policial nº ${codigoExterno}.`, ''] : []),
    `Alvo: ${alvo}`,
    '',
    '**Representação do Delegado:**',
    motivo,
    '',
    '**Manifestação do Ministério Público:**',
    doMinisterioPublico,
    '',
    '**Fundamentação do Juízo:**',
    doJuizo,
    '',
    `**Determino** o cumprimento do presente mandado de ${medida.tipo.toLowerCase()}, na forma da lei.`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${medida.juiz}> — Juiz(a) de Direito`,
  ].join('\n'), [medida.alvo, medida.motivo, fundamentacaoPromotor, fundamentacaoJuiz]);
}

// Mandado emitido direto de dentro de um processo (painel-contexto-e-tipo-mandado.md, seção
// 3) — sem medida nem inquérito por trás, então não dá pra reaproveitar textoMandado (que exige
// o objeto `medida` inteiro). Mais enxuto: só o teor que o Juiz escreveu, sem a cadeia
// Delegado→MP→Juízo que só existe no fluxo antigo de medida cautelar.
function textoMandadoDireto({ numero, processoNumero, tipoRotulo, alvo, teor, juizId }) {
  return montarDocumento(([alvoTxt, teorTxt]) => [
    '**PODER JUDICIÁRIO**',
    `**Mandado nº ${numero}** (Processo ${processoNumero})`,
    '',
    `**MANDADO DE ${tipoRotulo.toUpperCase()}**`,
    '',
    `Alvo: ${alvoTxt}`,
    '',
    teorTxt,
    '',
    `**Determino** o cumprimento do presente mandado, na forma da lei.`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${juizId}> — Juiz(a) de Direito`,
  ].join('\n'), [alvo, teor]);
}

// Sentença sobre o pedido de medida cautelar — mesmo formato de textoSentenca/
// textoSentencaPeticao (cabeçalho, vistos, fundamentação, dispositivo, publicação), usado na
// devolutiva pra Polícia Civil (utils/devolutivaPoliciaCivil.js) pra a decisão chegar como um
// ato judicial de verdade, não só um resumo em campos de embed.
function textoSentencaMandado({ medida, decisao, fundamentacao, numeroMandado, juizId, codigoExterno }) {
  const dispositivo = decisao === 'Deferido'
    ? `Ante o exposto, **DEFIRO** o pedido de ${medida.tipo.toLowerCase()}, e determino a expedição do respectivo mandado.`
    : `Ante o exposto, **INDEFIRO** o pedido de ${medida.tipo.toLowerCase()}, por ausência dos requisitos legais para a espécie.`;

  return montarDocumento(([alvo, fund]) => [
    '**PODER JUDICIÁRIO**',
    `**Medida Cautelar nº ${medida.numero}**`,
    '',
    '**SENTENÇA**',
    '',
    codigoExterno
      ? `Vistos, relatados e examinados os autos do pedido de medida cautelar em epígrafe, advindo do Inquérito Policial nº ${codigoExterno}.`
      : 'Vistos, relatados e examinados os autos do pedido de medida cautelar em epígrafe.',
    '',
    `**Tipo:** ${medida.tipo}`,
    `**Alvo:** ${alvo}`,
    '',
    '**Fundamentação:**',
    fund || 'Presentes os requisitos legais exigidos para a espécie, conforme análise dos indícios constantes dos autos.',
    '',
    `**Dispositivo:** ${dispositivo}`,
    ...(decisao === 'Deferido' && numeroMandado ? [`Expeça-se o Mandado nº ${numeroMandado}.`] : []),
    '',
    'Publique-se. Registre-se. Intimem-se os interessados.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${juizId}> — Juiz(a) de Direito`,
  ].join('\n'), [medida.alvo, fundamentacao]);
}

function textoDespacho({ numero, tipo, titulo, texto, autorId, cargoAutor, referenciaExterna }) {
  return montarDocumento(([corpo]) => [
    '**PODER JUDICIÁRIO**',
    `**Processo nº ${numero} (${tipo})**`,
    '',
    `**${titulo}**`,
    '',
    ...(referenciaExterna ? [`Pedido advindo do Inquérito Policial nº ${referenciaExterna}.`, ''] : []),
    corpo,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — ${cargoAutor}`,
  ].join('\n'), [texto]);
}

// Intimação genérica — usada tanto pelo Juiz num processo (emitir intimação/receber e intimar)
// quanto por qualquer outro ato que precise formalmente mandar alguém fazer algo, com prazo e
// consequência explícitos (ex: diligência de petição). `rotulo` deixa o cabeçalho certo pros
// dois contextos (processo tem número de processo, petição tem número de petição).
// destinatarioNome é o fallback pra "pessoa fora do processo" sem conta no Discord (spec-
// atualizacoes-bot-juridico.md, seção 3/4) — sem discordId não tem @menção possível.
function textoIntimacao({ numero, rotulo = 'Processo', destinatarioId, destinatarioNome, teor, prazo, consequencia }) {
  const destinatarioTexto = destinatarioId ? `<@${destinatarioId}>` : (destinatarioNome || 'a parte');
  return montarDocumento(([teorTxt, prazoTxt, consequenciaTxt]) => [
    '**PODER JUDICIÁRIO**',
    `**${rotulo} nº ${numero}**`,
    '',
    '**INTIMAÇÃO**',
    '',
    `Fica ${destinatarioTexto} intimado(a) nos autos em epígrafe.`,
    '',
    teorTxt,
    ...(prazo ? ['', `**Prazo:** ${prazoTxt}`] : []),
    ...(consequencia ? ['', `**Consequência do não cumprimento:** ${consequenciaTxt}`] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
  ].join('\n'), [teor, prazo, consequencia]);
}

// Certidão de antecedentes/não constar como investigado — pode ser pedida por Juiz/
// Desembargador (Judiciário) OU Promotor/Procurador (Ministério Público), por isso o cabeçalho
// muda conforme quem pede — instituições diferentes, papel timbrado diferente.
function textoRequisicaoCertidao({ numero, rg, nomeCliente, finalidade, autorId, instituicao }) {
  return montarDocumento(([nome, finalidadeTxt]) => [
    `**${instituicao}**`,
    `**Requisição de Certidão nº ${numero}**`,
    '',
    '**REQUISIÇÃO DE CERTIDÃO DE ANTECEDENTES**',
    '',
    `Requisita-se certidão de antecedentes criminais e de não constar como investigado(a) em inquérito policial em nome de:`,
    '',
    `**Nome:** ${nome}`,
    `**RG:** ${rg}`,
    `**Finalidade:** ${finalidadeTxt}`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}>`,
  ].join('\n'), [nomeCliente, finalidade]);
}

// Requisição do MP — instrumento COERCITIVO (art. 129, VI, CF/88): o destinatário é obrigado a
// atender, diferente de uma recomendação. Precisa de fundamentação jurídica/fática, igual no
// mundo real (senão a requisição não tem lastro nenhum).
function textoRequisicaoMP({ numero, destinatario, fundamentacao, prazo, autorId }) {
  return montarDocumento(([destino, fund, prazoTxt]) => [
    '**MINISTÉRIO PÚBLICO**',
    `**Requisição nº ${numero}**`,
    '',
    '**REQUISIÇÃO DE DOCUMENTOS/INFORMAÇÕES/DILIGÊNCIAS**',
    '',
    `Com fundamento no art. 129, incisos VI e VIII, da Constituição Federal, o Ministério Público REQUISITA de ${destino} o atendimento do quanto abaixo especificado, sob as penas da lei.`,
    '',
    '**Fundamentação:**',
    fund,
    ...(prazo ? ['', `**Prazo para atendimento:** ${prazoTxt}`] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n'), [destinatario, fundamentacao, prazo]);
}

// Recomendação do MP — instrumento PERSUASIVO, sem força coercitiva (diferente da requisição):
// expõe razões fáticas e jurídicas pra convencer o destinatário a agir ou deixar de agir, mas
// não obriga. Instrumento de atuação extrajudicial consolidado nas resoluções do CNMP.
function textoRecomendacaoMP({ numero, destinatario, fundamentacao, autorId }) {
  return montarDocumento(([destino, fund]) => [
    '**MINISTÉRIO PÚBLICO**',
    `**Recomendação nº ${numero}**`,
    '',
    '**RECOMENDAÇÃO**',
    '',
    `O Ministério Público, no exercício de suas atribuições extrajudiciais, RECOMENDA a ${destino} a adoção (ou abstenção) das medidas a seguir expostas, sem caráter coercitivo, com base nas razões fáticas e jurídicas apontadas.`,
    '',
    '**Razões fáticas e jurídicas:**',
    fund,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n'), [destinatario, fundamentacao]);
}

// Portaria de instauração de Inquérito Civil — procedimento investigatório administrativo,
// facultativo e PRIVATIVO do MP (art. 129, III, CF/88 + Lei 7.347/1985), pra apurar lesão a
// patrimônio público, meio ambiente ou outros interesses difusos/coletivos — nada a ver com
// inquérito policial (que é do Delegado, pra apuração de crime).
function textoPortariaInqueritoCivil({ numero, objeto, fundamentacao, autorId }) {
  return montarDocumento(([objetoTxt, fund]) => [
    '**MINISTÉRIO PÚBLICO**',
    `**Portaria nº ${numero} — Instauração de Inquérito Civil**`,
    '',
    'Com fundamento no art. 129, III, da Constituição Federal, e na Lei nº 7.347/1985, o Ministério Público RESOLVE instaurar o presente INQUÉRITO CIVIL, para apurar:',
    '',
    objetoTxt,
    '',
    '**Fundamentação:**',
    fund,
    '',
    'Autue-se, registre-se e cientifique-se.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n'), [objeto, fundamentacao]);
}

// Ofício — correspondência formal expedida a um destinatário externo (órgão, instituição,
// pessoa), sempre vinculada a um processo em andamento. Quem expede varia (Delegado, Promotor,
// Procurador, Juiz), então o cabeçalho segue a instituição de quem assina, igual já acontece na
// certidão — a mesma peça pode sair como Polícia Civil, Ministério Público ou Poder Judiciário.
function textoOficio({ numero, processoNumero, destinatario, assunto, conteudo, autorId, instituicao }) {
  return montarDocumento(([destino, assuntoTxt, corpo]) => [
    `**${instituicao}**`,
    `**Ofício nº ${numero}**`,
    processoNumero ? `*Referente ao processo nº ${processoNumero}*` : '*Expediente avulso (não vinculado a processo)*',
    '',
    `Ao(À) ${destino},`,
    '',
    `**Assunto:** ${assuntoTxt}`,
    '',
    corpo,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}>`,
  ].join('\n'), [destinatario, assunto, conteudo]);
}

// ---- Atos do processo (textos formais antes inline em commands/processo.js, reunidos aqui) ----

// Despacho de recebimento da denúncia (penal) — o Juiz sorteado recebe a denúncia do MP.
function despachoRecebimentoDenuncia({ numero, tipo, reusTxt, juizId, autorId }) {
  return textoDespacho({
    numero, tipo, titulo: 'DESPACHO DE RECEBIMENTO DA DENÚNCIA',
    texto: `Recebo a denúncia oferecida pelo Ministério Público em desfavor de ${reusTxt}. Distribuído por sorteio a <@${juizId}>. Cite-se o(s) réu(s) para instrução e julgamento.`,
    autorId, cargoAutor: 'Promotor de Justiça',
  });
}

// Decreto de revelia (civil) — réu não contestou no prazo.
function despachoDecretoRevelia({ numero, reusTxt, autorId }) {
  return textoDespacho({
    numero, tipo: 'Civil', titulo: 'DECRETO DE REVELIA',
    texto: `Decorrido o prazo de contestação sem manifestação de ${reusTxt}, decreto a revelia, nos termos do art. 344 do Código de Processo Civil. Processo concluso para julgamento.`,
    autorId, cargoAutor: 'Juiz de Direito',
  });
}

// Indeferimento da petição inicial (civil) — arquivamento por ausência de requisitos.
function despachoIndeferimentoInicial({ numero, autorId }) {
  return textoDespacho({
    numero, tipo: 'Civil', titulo: 'DESPACHO DE INDEFERIMENTO DA PETIÇÃO INICIAL',
    texto: 'Analisados os requisitos de admissibilidade, INDEFIRO a petição inicial, ante a ausência de requisitos essenciais para o regular prosseguimento do feito, e determino o arquivamento.',
    autorId, cargoAutor: 'Juiz(a) de Direito',
  });
}

// Teor da citação do réu (civil) — prazo de contestação sob pena de revelia. `prazoDias` fica no
// chamador (config.prazoContestacaoDias) pra não acoplar documentos.js à config.
function teorCitacao(prazoDias) {
  return `Fica Vossa Senhoria citado(a) para, querendo, apresentar contestação no prazo de ${prazoDias} dias corridos, contados desta citação, sob pena de revelia.`;
}

// Intimação do réu (penal) — manda constituir advogado; a via do réu leva o código de
// habilitação da defesa impresso no rodapé.
const TEOR_INTIMACAO_REU = 'Fica o(a) réu(ré) INTIMADO(a) a constituir advogado para sua defesa nos autos deste processo, no prazo legal. Apresente esta via ao advogado que escolher — o código abaixo é necessário para a habilitação da defesa. Não havendo advogado constituído no prazo, o Juízo nomeará defensor dativo e o processo seguirá com defesa (ampla defesa assegurada).';

function corpoIntimacaoReu(codigo) {
  return `${TEOR_INTIMACAO_REU}\n\n=========================\nVIA DO RÉU — CÓDIGO DE HABILITAÇÃO DA DEFESA: ${codigo}\nEntregue este código ao seu advogado. Informar dados falsos ou tentar adivinhar o código é infração sujeita a sanção administrativa.`;
}

// Intimação da defesa sobre crime acrescentado tarde — assegura contraditório antes de julgar.
function teorIntimacaoCrimeTardio(nomesCrimes) {
  return `Fica a defesa INTIMADA a se manifestar, no prazo legal, sobre o(s) crime(s) acrescentado(s) à imputação: ${nomesCrimes}. Assegura-se o contraditório quanto a esta(s) imputação(ões) antes de qualquer julgamento a seu respeito.`;
}

// Presets do teor da intimação genérica (select "Qual o teor da intimação?").
const TEOR_PRESETS_INTIMACAO = {
  depoimento: { label: 'Prestar depoimento como testemunha', texto: 'Fica Vossa Senhoria intimado(a) a comparecer para prestar depoimento como testemunha nos autos deste processo, em data e local a serem informados.' },
  defesa: { label: 'Apresentar defesa', texto: 'Fica Vossa Senhoria intimado(a) a apresentar defesa nos autos deste processo, no prazo legal.' },
  audiencia: { label: 'Comparecer à audiência', texto: 'Fica Vossa Senhoria intimado(a) a comparecer à audiência designada nos autos deste processo.' },
  esclarecimentos: { label: 'Prestar esclarecimentos', texto: 'Fica Vossa Senhoria intimado(a) a comparecer para prestar esclarecimentos nos autos deste processo.' },
  determinacao: { label: 'Cumprir determinação judicial', texto: 'Fica Vossa Senhoria intimado(a) a cumprir a determinação judicial constante nos autos deste processo.' },
  outro: { label: 'Outro', texto: '' },
};

module.exports = {
  dataExtenso, textoSentenca, textoAcordao, textoMandado, textoMandadoDireto, textoDespacho, textoSentencaPeticao,
  textoIntimacao, textoSentencaMandado, textoRequisicaoCertidao, textoRequisicaoMP,
  textoRecomendacaoMP, textoPortariaInqueritoCivil, textoOficio,
  despachoRecebimentoDenuncia, despachoDecretoRevelia, despachoIndeferimentoInicial,
  teorCitacao, corpoIntimacaoReu, teorIntimacaoCrimeTardio, TEOR_PRESETS_INTIMACAO,
};
