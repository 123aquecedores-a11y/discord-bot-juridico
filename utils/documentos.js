// Textos formais dos atos do bot — mesma lógica de textoIntimacao (processo.js): bloco de
// texto puro (não imagem), pra manter as @menções pingáveis e dar pra copiar/colar como um
// documento de verdade, imitando a estrutura de um ato judicial real.
//
// Mensagem de texto do Discord tem limite de 2000 caracteres — campos de texto livre (sentença,
// razões de recurso, fundamentação) são truncados aqui pra nunca estourar isso mesmo somados.
const { truncar } = require('./texto');

function dataExtenso() {
  return new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function textoSentenca(processo) {
  const partes = processo.tipo === 'Penal'
    ? [`Delegado: <@${processo.delegado}>`, `Promotor: <@${processo.promotor}>`, `Réu(s): ${(processo.reus || []).map(id => `<@${id}>`).join(', ') || 'a identificar'}`]
    : [`Autor: <@${processo.autor}>`, `Réu(s): ${(processo.reus || []).map(id => `<@${id}>`).join(', ') || 'a identificar'}`];

  const dispositivo = {
    Condenado: 'Julgo **PROCEDENTE** a pretensão punitiva estatal para **CONDENAR** o(a) réu(ré).',
    Absolvido: 'Julgo **IMPROCEDENTE** a pretensão punitiva estatal para **ABSOLVER** o(a) réu(ré).',
    Procedente: 'Julgo **PROCEDENTE** o pedido.',
    Improcedente: 'Julgo **IMPROCEDENTE** o pedido.',
  }[processo.resultado] || 'Resultado não estruturado.';

  return [
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
    truncar(processo.sentenca, 1200),
    '',
    `**Dispositivo:** ${dispositivo}`,
    '',
    'Publique-se. Registre-se. Intimem-se as partes.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${processo.juiz}> — Juiz(a) de Direito`,
  ].join('\n');
}

function textoAcordao({ apelacao, decisaoTexto, statusFinal }) {
  const decisaoLinha = {
    Mantida: 'A Câmara, por decisão do Desembargador relator, **NEGA PROVIMENTO** ao recurso — a sentença de origem fica **MANTIDA** em seus exatos termos.',
    Reformada: 'A Câmara, por decisão do Desembargador relator, **DÁ PROVIMENTO** ao recurso — a sentença de origem fica **REFORMADA**.',
    Anulada: 'A Câmara, por decisão do Desembargador relator, **ANULA** a sentença de origem e determina a remessa dos autos a novo julgamento, com novo sorteio de Juiz.',
  }[statusFinal];

  return [
    '**TRIBUNAL DE JUSTIÇA**',
    `**Apelação nº ${apelacao.numero}** (processo originário ${apelacao.processoOriginalNumero})`,
    '',
    '**ACÓRDÃO**',
    '',
    `Vistos, relatados e discutidos os autos da apelação interposta por <@${apelacao.recorrenteId}> em face de <@${apelacao.parteContrariaId || 'parte contrária'}>.`,
    '',
    '**Razões do recurso:**',
    truncar(apelacao.razoes, 600),
    '',
    `**Decisão:** ${decisaoLinha}`,
    ...(decisaoTexto ? ['', '**Fundamentação do relator:**', truncar(decisaoTexto, 600)] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${apelacao.desembargadorId}> — Desembargador(a) Relator(a)`,
  ].join('\n');
}

const TIPO_PETICAO_TITULO = { PorteArma: 'PORTE DE ARMA', TrocaNome: 'TROCA DE NOME', LimpezaFicha: 'LIMPEZA DE FICHA CRIMINAL' };

function objetoPeticao(peticao) {
  if (peticao.tipo === 'TrocaNome') return `retificação de nome de "${peticao.nomeAtual}" para "${peticao.nomeNovo}"${peticao.cpfCliente ? ` (CPF ${peticao.cpfCliente})` : ''}`;
  if (peticao.tipo === 'LimpezaFicha') return 'exclusão de antecedentes da ficha criminal';
  return 'concessão de porte de arma de fogo';
}

// Texto padrão pra toda decisão (deferir/indeferir) de petição administrativa — mesmo formato
// pros três tipos, só troca o objeto do pedido e a fundamentação.
function textoSentencaPeticao({ peticao, status, motivo }) {
  const dispositivo = status === 'Deferido'
    ? `Ante o exposto, **DEFIRO** o pedido de ${objetoPeticao(peticao)}, nos termos requeridos.`
    : `Ante o exposto, **INDEFIRO** o pedido de ${objetoPeticao(peticao)}, por ausência dos requisitos legais para a espécie.`;

  const qualificacao = peticao.cpfCliente
    ? [
        `Requerente: ${peticao.nomeCliente || peticao.nomeNovo || '—'}, CPF ${peticao.cpfCliente}${peticao.enderecoCliente ? `, residente em ${peticao.enderecoCliente}` : ''}.`,
        `Advogado(a): <@${peticao.requerenteId}>.`,
      ].join('\n')
    : `Requerente: <@${peticao.requerenteId}>`;

  return [
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
    truncar(motivo, 800) || 'Presentes os requisitos legais exigidos para a espécie, conforme análise dos documentos e diligências constantes dos autos.',
    '',
    `**Dispositivo:** ${dispositivo}`,
    '',
    'Publique-se. Registre-se. Intimem-se os interessados.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${peticao.juiz}> — Juiz(a) de Direito`,
  ].join('\n');
}

function textoMandado({ numero, medida, fundamentacaoPromotor, fundamentacaoJuiz, codigoExterno }) {
  return [
    '**PODER JUDICIÁRIO**',
    `**Mandado nº ${numero}** (medida ${medida.numero})`,
    '',
    `**MANDADO DE ${medida.tipo.toUpperCase()}**`,
    '',
    ...(codigoExterno ? [`Pedido advindo do Inquérito Policial nº ${codigoExterno}.`, ''] : []),
    `Alvo: ${medida.alvo}`,
    '',
    '**Representação do Delegado:**',
    truncar(medida.motivo, 600),
    '',
    '**Manifestação do Ministério Público:**',
    truncar(fundamentacaoPromotor, 600),
    '',
    '**Fundamentação do Juízo:**',
    truncar(fundamentacaoJuiz, 600),
    '',
    `**Determino** o cumprimento do presente mandado de ${medida.tipo.toLowerCase()}, na forma da lei.`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${medida.juiz}> — Juiz(a) de Direito`,
  ].join('\n');
}

// Mandado emitido direto de dentro de um processo (painel-contexto-e-tipo-mandado.md, seção
// 3) — sem medida nem inquérito por trás, então não dá pra reaproveitar textoMandado (que exige
// o objeto `medida` inteiro). Mais enxuto: só o teor que o Juiz escreveu, sem a cadeia
// Delegado→MP→Juízo que só existe no fluxo antigo de medida provisória.
function textoMandadoDireto({ numero, processoNumero, tipoRotulo, alvo, teor, juizId }) {
  return [
    '**PODER JUDICIÁRIO**',
    `**Mandado nº ${numero}** (Processo ${processoNumero})`,
    '',
    `**MANDADO DE ${tipoRotulo.toUpperCase()}**`,
    '',
    `Alvo: ${alvo}`,
    '',
    truncar(teor, 1200),
    '',
    `**Determino** o cumprimento do presente mandado, na forma da lei.`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${juizId}> — Juiz(a) de Direito`,
  ].join('\n');
}

// Sentença sobre o pedido de medida provisória — mesmo formato de textoSentenca/
// textoSentencaPeticao (cabeçalho, vistos, fundamentação, dispositivo, publicação), usado na
// devolutiva pra Polícia Civil (utils/devolutivaPoliciaCivil.js) pra a decisão chegar como um
// ato judicial de verdade, não só um resumo em campos de embed.
function textoSentencaMandado({ medida, decisao, fundamentacao, numeroMandado, juizId, codigoExterno }) {
  const dispositivo = decisao === 'Deferido'
    ? `Ante o exposto, **DEFIRO** o pedido de ${medida.tipo.toLowerCase()}, e determino a expedição do respectivo mandado.`
    : `Ante o exposto, **INDEFIRO** o pedido de ${medida.tipo.toLowerCase()}, por ausência dos requisitos legais para a espécie.`;

  return [
    '**PODER JUDICIÁRIO**',
    `**Medida Provisória nº ${medida.numero}**`,
    '',
    '**SENTENÇA**',
    '',
    codigoExterno
      ? `Vistos, relatados e examinados os autos do pedido de medida provisória em epígrafe, advindo do Inquérito Policial nº ${codigoExterno}.`
      : 'Vistos, relatados e examinados os autos do pedido de medida provisória em epígrafe.',
    '',
    `**Tipo:** ${medida.tipo}`,
    `**Alvo:** ${truncar(medida.alvo, 300)}`,
    '',
    '**Fundamentação:**',
    truncar(fundamentacao, 1000) || 'Presentes os requisitos legais exigidos para a espécie, conforme análise dos indícios constantes dos autos.',
    '',
    `**Dispositivo:** ${dispositivo}`,
    ...(decisao === 'Deferido' && numeroMandado ? [`Expeça-se o Mandado nº ${numeroMandado}.`] : []),
    '',
    'Publique-se. Registre-se. Intimem-se os interessados.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${juizId}> — Juiz(a) de Direito`,
  ].join('\n');
}

function textoDespacho({ numero, tipo, titulo, texto, autorId, cargoAutor, referenciaExterna }) {
  return [
    '**PODER JUDICIÁRIO**',
    `**Processo nº ${numero} (${tipo})**`,
    '',
    `**${titulo}**`,
    '',
    ...(referenciaExterna ? [`Pedido advindo do Inquérito Policial nº ${referenciaExterna}.`, ''] : []),
    truncar(texto, 1200),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — ${cargoAutor}`,
  ].join('\n');
}

// Intimação genérica — usada tanto pelo Juiz num processo (emitir intimação/receber e intimar)
// quanto por qualquer outro ato que precise formalmente mandar alguém fazer algo, com prazo e
// consequência explícitos (ex: diligência de petição). `rotulo` deixa o cabeçalho certo pros
// dois contextos (processo tem número de processo, petição tem número de petição).
// destinatarioNome é o fallback pra "pessoa fora do processo" sem conta no Discord (spec-
// atualizacoes-bot-juridico.md, seção 3/4) — sem discordId não tem @menção possível.
function textoIntimacao({ numero, rotulo = 'Processo', destinatarioId, destinatarioNome, teor, prazo, consequencia }) {
  const destinatarioTexto = destinatarioId ? `<@${destinatarioId}>` : (destinatarioNome || 'a parte');
  return [
    '**PODER JUDICIÁRIO**',
    `**${rotulo} nº ${numero}**`,
    '',
    '**INTIMAÇÃO**',
    '',
    `Fica ${destinatarioTexto} intimado(a) nos autos em epígrafe.`,
    '',
    teor,
    ...(prazo ? ['', `**Prazo:** ${prazo}`] : []),
    ...(consequencia ? ['', `**Consequência do não cumprimento:** ${consequencia}`] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
  ].join('\n');
}

// Certidão de antecedentes/não constar como investigado — pode ser pedida por Juiz/
// Desembargador (Judiciário) OU Promotor/Procurador (Ministério Público), por isso o cabeçalho
// muda conforme quem pede — instituições diferentes, papel timbrado diferente.
function textoRequisicaoCertidao({ numero, cpf, nomeCliente, finalidade, autorId, instituicao }) {
  return [
    `**${instituicao}**`,
    `**Requisição de Certidão nº ${numero}**`,
    '',
    '**REQUISIÇÃO DE CERTIDÃO DE ANTECEDENTES**',
    '',
    `Requisita-se certidão de antecedentes criminais e de não constar como investigado(a) em inquérito policial em nome de:`,
    '',
    `**Nome:** ${nomeCliente}`,
    `**CPF:** ${cpf}`,
    `**Finalidade:** ${finalidade}`,
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}>`,
  ].join('\n');
}

// Requisição do MP — instrumento COERCITIVO (art. 129, VI, CF/88): o destinatário é obrigado a
// atender, diferente de uma recomendação. Precisa de fundamentação jurídica/fática, igual no
// mundo real (senão a requisição não tem lastro nenhum).
function textoRequisicaoMP({ numero, destinatario, fundamentacao, prazo, autorId }) {
  return [
    '**MINISTÉRIO PÚBLICO**',
    `**Requisição nº ${numero}**`,
    '',
    '**REQUISIÇÃO DE DOCUMENTOS/INFORMAÇÕES/DILIGÊNCIAS**',
    '',
    `Com fundamento no art. 129, incisos VI e VIII, da Constituição Federal, o Ministério Público REQUISITA de ${destinatario} o atendimento do quanto abaixo especificado, sob as penas da lei.`,
    '',
    '**Fundamentação:**',
    truncar(fundamentacao, 1000),
    ...(prazo ? ['', `**Prazo para atendimento:** ${prazo}`] : []),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n');
}

// Recomendação do MP — instrumento PERSUASIVO, sem força coercitiva (diferente da requisição):
// expõe razões fáticas e jurídicas pra convencer o destinatário a agir ou deixar de agir, mas
// não obriga. Instrumento de atuação extrajudicial consolidado nas resoluções do CNMP.
function textoRecomendacaoMP({ numero, destinatario, fundamentacao, autorId }) {
  return [
    '**MINISTÉRIO PÚBLICO**',
    `**Recomendação nº ${numero}**`,
    '',
    '**RECOMENDAÇÃO**',
    '',
    `O Ministério Público, no exercício de suas atribuições extrajudiciais, RECOMENDA a ${destinatario} a adoção (ou abstenção) das medidas a seguir expostas, sem caráter coercitivo, com base nas razões fáticas e jurídicas apontadas.`,
    '',
    '**Razões fáticas e jurídicas:**',
    truncar(fundamentacao, 1000),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n');
}

// Portaria de instauração de Inquérito Civil — procedimento investigatório administrativo,
// facultativo e PRIVATIVO do MP (art. 129, III, CF/88 + Lei 7.347/1985), pra apurar lesão a
// patrimônio público, meio ambiente ou outros interesses difusos/coletivos — nada a ver com
// inquérito policial (que é do Delegado, pra apuração de crime).
function textoPortariaInqueritoCivil({ numero, objeto, fundamentacao, autorId }) {
  return [
    '**MINISTÉRIO PÚBLICO**',
    `**Portaria nº ${numero} — Instauração de Inquérito Civil**`,
    '',
    'Com fundamento no art. 129, III, da Constituição Federal, e na Lei nº 7.347/1985, o Ministério Público RESOLVE instaurar o presente INQUÉRITO CIVIL, para apurar:',
    '',
    truncar(objeto, 600),
    '',
    '**Fundamentação:**',
    truncar(fundamentacao, 800),
    '',
    'Autue-se, registre-se e cientifique-se.',
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — Membro do Ministério Público`,
  ].join('\n');
}

// Ofício — correspondência formal expedida a um destinatário externo (órgão, instituição,
// pessoa), sempre vinculada a um processo em andamento. Quem expede varia (Delegado, Promotor,
// Procurador, Juiz), então o cabeçalho segue a instituição de quem assina, igual já acontece na
// certidão — a mesma peça pode sair como Polícia Civil, Ministério Público ou Poder Judiciário.
function textoOficio({ numero, processoNumero, destinatario, assunto, conteudo, autorId, instituicao }) {
  return [
    `**${instituicao}**`,
    `**Ofício nº ${numero}**`,
    `*Referente ao processo nº ${processoNumero}*`,
    '',
    `Ao(À) ${destinatario},`,
    '',
    `**Assunto:** ${assunto}`,
    '',
    truncar(conteudo, 1500),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}>`,
  ].join('\n');
}

module.exports = {
  dataExtenso, textoSentenca, textoAcordao, textoMandado, textoMandadoDireto, textoDespacho, textoSentencaPeticao,
  textoIntimacao, textoSentencaMandado, textoRequisicaoCertidao, textoRequisicaoMP,
  textoRecomendacaoMP, textoPortariaInqueritoCivil, textoOficio,
};
