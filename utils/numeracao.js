// NUMERAÇÃO DE PROCESSOS E ATOS — contador monotônico, nunca reusa número.
//
// Formato: sigla embutida sem hífen, contagem própria por tipo — 0001PN, 0002CV, 0001MD, 0001MO.
// `filtro` restringe a contagem a um subconjunto da tabela (ex: só Penais dentro de 'processos').
//
// POR QUE UM CONTADOR, E NÃO O MAIOR REGISTRO EXISTENTE
//
// Este arquivo já foi corrigido uma vez. A primeira versão contava registros sobreviventes, o que
// reemitia número assim que qualquer registro anterior era apagado — houve colisão real, dois
// processos "0007CV". A correção passou a usar o MAIOR número existente, o que resolveu o caso da
// contagem mas não o de apagar justamente o maior.
//
// Em 14/08/2026 uma limpeza de dados de teste apagou todos os processos, e a numeração voltou ao
// 0001. Enquanto o número só aparecia no Discord isso era feio; a partir da entrega in-game ele é
// IMPRESSO num documento que circula dentro do jogo. Um mandado antigo dizendo "0004PN" na mão de um
// jogador passaria a apontar para um caso diferente — e ninguém suspeitaria do número, suspeitariam
// do sistema.
//
// Agora o próximo número vem de um contador persistido, que só cresce. Mesmo padrão de
// `contadorOAB` e `contadorMatricula`, que já viviam em `estado`.
const estado = require('./estado');

// PISOS DE SEMENTE — o maior número JÁ EMITIDO por série, levantado em 18/08/2026 cruzando todos os
// backups do volume com a produção. Semear com o maior registro existente não bastaria: a limpeza
// de 14/08 apagou o histórico, e 5 séries reemitiriam 15 números já usados (PN chegou a 0008 com
// produção enxergando só 0002; AP chegou a 0005 com produção enxergando nenhum).
//
// LIMITAÇÃO CONHECIDA, e é o motivo de esta tabela existir em vez de um número mágico: os pisos vêm
// dos backups, e os backups têm começo. Um número emitido e apagado ANTES do backup mais antigo
// (11/08/2026) não está aqui e não há como saber. Se aparecer uma colisão com documento muito
// antigo, o lugar de procurar é este comentário — não o contador, que está fazendo o trabalho dele.
const PISOS = {
  AE: 1, AP: 5, CERT: 3, CV: 5, IC: 1, LF: 3, MD: 11,
  MO: 16, OFI: 10, PA: 4, PN: 8, REC: 1, REQ: 1, SB: 1,
};

// REFUNDAÇÃO — os pisos existem para preservar continuidade com o que já circulou no jogo. Num
// RESET deliberado do tribunal, em que todos os processos e documentos são apagados de propósito,
// não há continuidade a preservar: o primeiro processo do tribunal recém-fundado tem que ser
// 0001PN, não 0009PN.
//
// Por isso o descarte dos pisos é PASSO EXPLÍCITO, nunca efeito colateral do reset. Quem apaga o
// banco precisa dizer também que quer a numeração do zero — são duas decisões, e confundi-las
// faria a numeração voltar sozinha um dia em que alguém limpasse dados por outro motivo.
const CHAVE_REFUNDACAO = 'numeracaoRefundadaEm';
const refundada = () => !!estado.obter(CHAVE_REFUNDACAO);

/**
 * Descarta os pisos e zera todos os contadores. Chamar JUNTO do reset do banco, de propósito.
 * Depois disso, toda série recomeça em 0001.
 */
function refundarNumeracao({ motivo = 'reset do tribunal' } = {}) {
  const agora = new Date().toISOString();
  const zerados = [];
  for (const sigla of Object.keys(PISOS)) {
    if (estado.obter(chaveContador(sigla)) != null) zerados.push(sigla);
    estado.definir(chaveContador(sigla), '0');
  }
  estado.definir(CHAVE_REFUNDACAO, agora);
  console.warn(`[numeracao] REFUNDAÇÃO (${motivo}) em ${agora} — pisos históricos DESCARTADOS e contadores zerados. `
    + `A próxima emissão de cada série é 0001. Séries que tinham contador: ${zerados.join(', ') || '(nenhuma)'}.`);
  return { em: agora, zerados };
}

// Fica junto de contadorOAB/contadorMatricula, que já moram em `estado`. Vale notar a inconsistência
// para quem vier depois: `estado` foi descrito como o balde do derivado e regenerável (foi por isso
// que a flag do Modo Entrega In-Game foi para `configGuild`), mas contadores NÃO são regeneráveis —
// perdê-los reemite número. Manter todos os contadores no mesmo lugar vale mais que a pureza da
// separação; o que fecha o buraco é o teste que impede qualquer caminho de apagar `contador*`.
const chaveContador = (sigla) => `contador${sigla}`;

// Maior número já gravado nos registros que ainda existem. Só é consultado UMA VEZ por série, na
// semeadura — daí em diante o contador manda, e apagar registro não mexe mais em nada.
function maiorExistente(db, tabela, filtro, extrair) {
  const registros = filtro ? db.todos(tabela, filtro) : db.todos(tabela);
  return registros.reduce((max, r) => {
    const n = extrair(r);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

// Lê, incrementa e persiste. A semeadura usa o MAIOR entre o que existe hoje e o piso conhecido:
// os dois podem estar à frente um do outro (o piso cobre o que foi apagado; o existente cobre o que
// foi emitido depois de eu levantar a tabela).
function proximoValor(sigla, semear) {
  const chave = chaveContador(sigla);
  let atual = parseInt(estado.obter(chave), 10);
  if (!Number.isFinite(atual) || atual < 0) {
    // Depois de uma refundação os pisos não valem mais: o histórico foi apagado de propósito e não
    // há documento antigo circulando para colidir. `semear()` continua entrando porque o banco pode
    // ter ganho registros depois da refundação.
    atual = refundada() ? semear() : Math.max(semear(), PISOS[sigla] || 0);
  }
  const proximo = atual + 1;
  estado.definir(chave, String(proximo));
  return proximo;
}

function proximoNumero(db, tabela, sigla, filtro = null) {
  const n = proximoValor(sigla, () => maiorExistente(db, tabela, filtro, (r) => {
    if (typeof r.numero !== 'string' || !r.numero.endsWith(sigla)) return NaN;
    return parseInt(r.numero.slice(0, -sigla.length), 10);
  }));
  return `${String(n).padStart(4, '0')}${sigla}`;
}

// Formato antigo (OFI-0001), mantido por decisão explícita para ofício, certidão e atos do MP.
// Mesmo contador, mesma garantia.
function proximoNumeroClassico(db, tabela, prefixo) {
  const n = proximoValor(prefixo, () => maiorExistente(db, tabela, null, (r) => {
    if (typeof r.numero !== 'string') return NaN;
    const [pfx, seq] = r.numero.split('-');
    return pfx === prefixo ? parseInt(seq, 10) : NaN;
  }));
  return `${prefixo}-${String(n).padStart(4, '0')}`;
}

module.exports = { proximoNumero, proximoNumeroClassico, PISOS, chaveContador, refundarNumeracao, CHAVE_REFUNDACAO, refundada };
