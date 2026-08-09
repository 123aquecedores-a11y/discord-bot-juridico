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

function textoMandado({ numero, medida, fundamentacaoPromotor, fundamentacaoJuiz }) {
  return [
    '**PODER JUDICIÁRIO**',
    `**Mandado nº ${numero}** (medida ${medida.numero})`,
    '',
    `**MANDADO DE ${medida.tipo.toUpperCase()}**`,
    '',
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

function textoDespacho({ numero, tipo, titulo, texto, autorId, cargoAutor }) {
  return [
    '**PODER JUDICIÁRIO**',
    `**Processo nº ${numero} (${tipo})**`,
    '',
    `**${titulo}**`,
    '',
    truncar(texto, 1200),
    '',
    `Comarca, ${dataExtenso()}.`,
    '',
    `<@${autorId}> — ${cargoAutor}`,
  ].join('\n');
}

module.exports = { dataExtenso, textoSentenca, textoAcordao, textoMandado, textoDespacho, textoSentencaPeticao };
