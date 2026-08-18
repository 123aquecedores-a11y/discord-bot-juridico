// PEÇAS COM ENTREGA IN-GAME — módulo único para TODOS os ritos (SPEC §5).
//
// Glossário da spec, usado literalmente aqui: "peça" é o texto autorado no sistema e renderizado
// pelo bot (petição, contestação, denúncia, intimação, decisão, sentença) — tem selo e é gated.
// "Prova" é anexo das partes, não passa por aqui. "Ato" é qualquer evento lavrado nos autos.
//
// O nome do arquivo diverge da sugestão da spec (`documentos.js`) porque esse nome já existe no
// projeto com outra responsabilidade: utils/documentos.js monta o TEXTO dos documentos para a
// mensagem do Discord. Aqui é o ciclo de vida da peça — selo, janela, recebimento, visibilidade.
//
// Este módulo é lógica + persistência, sem nenhuma dependência de discord.js. É de propósito: a
// camada de visibilidade é o ponto de maior risco do projeto (SPEC §8) e precisa ser testável sem
// subir bot. Botões, modais e embeds ficam na camada de cima.
const crypto = require('crypto');
const db = require('../database/db');
const rh = require('./rh');
const { TABELAS_TICKET } = require('./responsaveis');

const HORA_MS = 60 * 60 * 1000;

// SPEC §7: passadas 24h sem recebimento, o cartório distribui automaticamente.
const VALVULA_MS = 24 * HORA_MS;

// SPEC §6.4: o contador separa falha técnica de tentativa indevida. Print ruim não pode punir
// como quem está forçando entrada.
const MAX_RECUSAS_TOKEN = 3;   // token inválido/reusado/fora da janela/papel errado → trava na 3ª
const MAX_ILEGIVEIS_AVISO = 5; // QR ilegível → avisa a staff na 5ª, mas NUNCA trava

// SPEC §11.2: os três modos carimbados no processo. Registro sem o campo é `legado` por definição —
// nenhuma migração, nenhuma linha escrita no dados.json para descobrir isso.
const MODOS = { LEGADO: 'legado', INGAME: 'ingame', ABERTO: 'aberto' };
const modoDoProcesso = (registro) => (registro && registro.modoEntrega) || MODOS.LEGADO;

// SPEC §6.2: janela configurável, faixa aceita 10–120, padrão 60. Fora da faixa cai no padrão em
// vez de valer — uma env com "0" ou "9999" não pode desligar nem eternizar a janela em silêncio.
function janelaMinutos() {
  const bruto = Number(process.env.JANELA_ENTREGA_MIN);
  if (!Number.isFinite(bruto) || bruto < 10 || bruto > 120) return 60;
  return Math.floor(bruto);
}

// ---------------------------------------------------------------------------
// Vínculo por papel, nunca por pessoa (SPEC §6.2 e §13)
// ---------------------------------------------------------------------------
// Toda a feature se amarra ao PAPEL ("o juiz do processo 001CV"), e quem ocupa o papel é resolvido
// no momento da validação. Trocou o juiz, o substituto assume a entrega pendente sem regenerar
// nada. Gravar o ID aqui seria o furo que a reconciliação do RH já teve que consertar.
//
// A resolução reusa o TABELAS_TICKET de utils/responsaveis.js — é o mesmo mapa que a troca
// universal de responsável já usa. Duplicar esse mapa aqui garantiria que um dia os dois divergem.
//
// DELIBERADAMENTE SEM CHECAGEM DE RH AQUI. `p.juiz` / `p.promotor` / `p.delegado` É a autoridade
// sobre quem age naquele processo, e ponto. Reconferir o cargo no RH neste momento:
//   1) duplicaria uma regra que já tem dono — a reconciliação, que roda no boot e periodicamente;
//   2) contradiria a política já vigente, em que "sem cargo" sem substituto MANTÉM a pessoa no
//      processo (só "ausente" esvazia) — o juiz que a reconciliação manteve de propósito seria
//      recusado justamente na hora de receber;
//   3) excluiria o Delegado por completo, já que ele entra por menção crua, sem registro no RH
//      (é a exceção declarada em EXIGE_CARGO_RH).
// Elegibilidade de cargo é assunto da reconciliação, que age antes e por fora.
function ocupanteDoSlot(processoTabela, registro, papel) {
  const cfg = TABELAS_TICKET[processoTabela];
  const pcfg = cfg && cfg.papeis[papel];
  return pcfg ? (registro[pcfg.campo] || null) : null;
}

// Advogado NÃO é um slot: `advogados[]` é coleção e "o advogado do processo" é ambíguo exatamente
// nos casos que importam — intimação dirigida ao advogado de uma parte específica, litisconsórcio,
// defensor dativo somado ao constituído. Por isso o destinatário advogado aponta para uma
// HABILITAÇÃO específica (`habilitacaoId`), nunca para a lista.
//
// Habilitação revogada (status ≠ Aprovado) devolve null: ninguém ocupa, o ato fica pendente e a
// válvula de 24h resolve. É o comportamento certo — não há fallback a inventar.
function ocupanteDaHabilitacao(registro, habilitacaoId) {
  const hab = (registro.habilitacoes || []).find(h => h.id === habilitacaoId);
  return hab && hab.status === 'Aprovado' ? (hab.advogadoId || null) : null;
}

// Quem ocupa ESTE destinatário agora. `null` = slot vago (juiz saiu e ainda não houve sorteio,
// habilitação revogada). Nunca inventa substituto.
function ocupanteAtual(processoTabela, registro, destinatario) {
  if (!destinatario) return null;
  return destinatario.papel === 'Advogado'
    ? ocupanteDaHabilitacao(registro, destinatario.habilitacaoId)
    : ocupanteDoSlot(processoTabela, registro, destinatario.papel);
}

const ocupaDestinatario = (processoTabela, registro, destinatario, usuarioId) =>
  !!usuarioId && ocupanteAtual(processoTabela, registro, destinatario) === usuarioId;

// Supervisão. Isto é cargo GLOBAL, não ocupação de papel no processo — por isso resolve pelo RH
// (fonte da verdade de cargo no projeto, nunca a role do Discord). Não é a checagem vetada acima:
// aquela era reconferir o ocupante do papel; esta é "esta pessoa é da supervisão?".
//
// Usa temCargo, e não getCargo: getCargo devolve o REGISTRO do RH, não a string do cargo —
// compará-lo com 'Desembargador' seria sempre falso, e a supervisão perderia acesso em silêncio.
function isSupervisao(usuarioId) {
  return rh.temCargo(usuarioId, 'Desembargador') || rh.temCargo(usuarioId, 'Procurador');
}

// ---------------------------------------------------------------------------
// Selo de autenticação (SPEC §5.3)
// ---------------------------------------------------------------------------
// O QR carrega um token de servidor de uso único — NUNCA o número do documento, senão qualquer um
// que veja um documento antigo consegue forjar a leitura. Um token por destinatário (SPEC §11.3).
const novoToken = () => `tk_${crypto.randomBytes(16).toString('hex')}`;

// Os 6 dígitos existem para leitura HUMANA: a staff confere de olho se o selo da captura bate com o
// do documento. Ninguém digita isso em lugar nenhum do fluxo (SPEC §3.5, §13).
const novosDigitos = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

function novoDestinatario({ papel, habilitacaoId = null }, { gated, agora }) {
  return {
    papel,
    // Obrigatório quando papel === 'Advogado'. Para os demais fica null: eles são slot.
    habilitacaoId,
    token: gated ? novoToken() : null,
    tokenUsado: false,
    recebidoEm: gated ? null : new Date(agora).toISOString(),
    // Em modo `aberto` não há cena: o ato nasce recebido, e o "como" fica registrado para os autos
    // não mentirem dizendo que houve entrega pessoal.
    recebidoComo: gated ? null : 'sem gate (modo aberto)',
    recebidoPorId: null,
    automatico: false,
    capturaUrl: null,
    capturaMensagemId: null,
    recusasToken: 0,
    ilegiveisSeguidas: 0,
    avisoIlegivelEnviado: false,
    travado: false,
    travadoEm: null,
    destravadoPorId: null,
    destravadoMotivo: null,
    // Horário-limite PERSISTIDO, conferido na varredura periódica. Nunca setTimeout: o bot
    // reinicia a cada deploy e todo temporizador em memória morre (SPEC §12, §13).
    valvulaEm: gated ? new Date(agora + VALVULA_MS).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------
// `destinatarios` são PAPÉIS — `{ papel: 'Juiz' }` ou `{ papel: 'Advogado', habilitacaoId: 3 }` —
// nunca IDs. Cada um ganha o próprio token, e o ato só se cumpre por inteiro quando todos
// receberam ou a válvula estourar (SPEC §11.3).
function gerar({ processoTabela, processoNumero, tipo, autorId, autorPapel, texto, destinatarios = [], agora = Date.now() }) {
  const processo = db.buscarPorNumero(processoTabela, processoNumero);
  if (!processo) return { ok: false, razao: 'processo não encontrado' };

  const invalido = destinatarios.find(d => d.papel === 'Advogado' && !d.habilitacaoId);
  if (invalido) return { ok: false, razao: 'destinatário Advogado exige habilitacaoId — `advogados[]` é coleção e não identifica quem recebe' };

  const modo = modoDoProcesso(processo);
  // `aberto` gera formulário e PNG iguais ao `ingame`, mas sem selo, sem janela e sem gate: o
  // documento nasce visível às partes (SPEC §11.2). `legado` não deveria chegar aqui — processo
  // antigo segue no fluxo de PDF anexado.
  const gated = modo === MODOS.INGAME;

  const nSeq = db.todos('pecas', p => p.processoNumero === processoNumero).length + 1;
  const peca = db.inserir('pecas', {
    numero: `${processoNumero}-P${nSeq}`,
    processoTabela,
    processoNumero,
    tipo,
    autorId,
    autorPapel,
    texto, // fonte da verdade; o PNG é renderizado a partir daqui (SPEC §5.1)
    modoEntrega: modo,
    gated,
    digitos: gated ? novosDigitos() : null,
    criadoEm: new Date(agora).toISOString(),
    janela: null,
    destinatarios: destinatarios.map(d => novoDestinatario(d, { gated, agora })),
  });
  return { ok: true, peca };
}

// ---------------------------------------------------------------------------
// Janela de entrega
// ---------------------------------------------------------------------------
// Quem abre é quem ocupa o papel do EMISSOR agora — não necessariamente quem escreveu. Se o
// emissor foi trocado, o substituto pode abrir a janela: vale nos dois sentidos (SPEC §6.2).
function podeOperarComoEmissor(peca, processo, usuarioId) {
  if (peca.autorId === usuarioId) return true;
  if (isSupervisao(usuarioId)) return true;
  if (!processo) return false;
  return ocupaDestinatario(peca.processoTabela, processo, { papel: peca.autorPapel }, usuarioId);
}

function abrirEntrega(pecaNumero, quemAbriuId, { agora = Date.now() } = {}) {
  const peca = db.buscarPorNumero('pecas', pecaNumero);
  if (!peca) return { ok: false, razao: 'peça não encontrada' };
  if (!peca.gated) return { ok: false, razao: 'peça não é gated — não há entrega a abrir' };

  const processo = db.buscarPorNumero(peca.processoTabela, peca.processoNumero);
  if (!processo) return { ok: false, razao: 'processo não encontrado' };
  if (!podeOperarComoEmissor(peca, processo, quemAbriuId)) {
    return { ok: false, razao: 'só quem ocupa o papel do emissor pode abrir a entrega' };
  }

  const minutos = janelaMinutos();
  const janela = {
    abertaEm: new Date(agora).toISOString(),
    expiraEm: new Date(agora + minutos * 60 * 1000).toISOString(),
    encerradaEm: null,
    abertaPorId: quemAbriuId,
    // Cada abertura é logada: janela expirada pode ser reaberta quantas vezes o emissor quiser, e o
    // número de reaberturas é sinal de que a cena não está acontecendo (SPEC §6.7).
    aberturas: ((peca.janela && peca.janela.aberturas) || 0) + 1,
  };
  db.atualizar('pecas', pecaNumero, { janela });

  // Slot vago não impede abrir a janela, mas a staff precisa enxergar: ninguém pode clicar
  // `Receber` e o ato vai cair na válvula. Sem fallback — é o comportamento correto (SPEC §7).
  const semOcupante = peca.destinatarios
    .filter(d => !d.recebidoEm && !ocupanteAtual(peca.processoTabela, processo, d))
    .map(d => d.papel);
  if (semOcupante.length) {
    console.warn(`[pecas] ${peca.numero}: janela aberta, mas sem ocupante para ${semOcupante.join(', ')} — o ato ficará pendente até a válvula de 24h.`);
  }
  return { ok: true, janela, minutos, semOcupante };
}

function encerrarEntrega(pecaNumero, quemEncerrouId, { agora = Date.now() } = {}) {
  const peca = db.buscarPorNumero('pecas', pecaNumero);
  if (!peca) return { ok: false, razao: 'peça não encontrada' };
  if (!peca.janela || peca.janela.encerradaEm) return { ok: false, razao: 'não há janela aberta' };

  const processo = db.buscarPorNumero(peca.processoTabela, peca.processoNumero);
  if (!podeOperarComoEmissor(peca, processo, quemEncerrouId)) {
    return { ok: false, razao: 'só quem ocupa o papel do emissor pode encerrar a entrega' };
  }
  db.atualizar('pecas', pecaNumero, { janela: { ...peca.janela, encerradaEm: new Date(agora).toISOString() } });
  return { ok: true };
}

const janelaAberta = (peca, agora = Date.now()) =>
  !!(peca.janela && !peca.janela.encerradaEm && new Date(peca.janela.expiraEm).getTime() > agora);

// ---------------------------------------------------------------------------
// Recebimento
// ---------------------------------------------------------------------------
// `tokenLido` vem da decodificação do QR na captura. O destinatário NÃO digita nada em momento
// algum (SPEC §3.5, §13) — quando a leitura falha, o chamador passa tokenLido = null e o
// destinatário simplesmente tenta outra captura.
function receber(pecaNumero, quemRecebeuId, { tokenLido = null, capturaUrl = null, capturaMensagemId = null, agora = Date.now() } = {}) {
  const peca = db.buscarPorNumero('pecas', pecaNumero);
  if (!peca) return { ok: false, razao: 'peça não encontrada' };
  if (!peca.gated) return { ok: false, razao: 'peça não é gated' };

  const processo = db.buscarPorNumero(peca.processoTabela, peca.processoNumero);
  if (!processo) return { ok: false, razao: 'processo não encontrado' };

  // O destinatário é resolvido pelo que a pessoa ocupa AGORA — slot do papel, ou a habilitação
  // específica quando é advogado. Juiz substituto recebe a entrega pendente do antecessor sem nada
  // ser regenerado; advogado de outra parte não recebe a intimação que não é dele.
  const idx = peca.destinatarios.findIndex(d => ocupaDestinatario(peca.processoTabela, processo, d, quemRecebeuId));
  if (idx === -1) {
    return { ok: false, motivo: 'papel', razao: 'quem clicou não ocupa o papel de destinatário desta peça' };
  }
  const dest = peca.destinatarios[idx];

  if (dest.recebidoEm) return { ok: false, motivo: 'ja_recebido', razao: 'esta peça já foi recebida' };
  if (dest.travado) return { ok: false, motivo: 'travado', razao: 'selo travado — só desembargador ou staff destrava' };

  const salvar = (novoDest) => {
    const destinatarios = peca.destinatarios.map((d, i) => (i === idx ? novoDest : d));
    db.atualizar('pecas', pecaNumero, { destinatarios });
    return destinatarios[idx];
  };

  // QR ILEGÍVEL — imagem ruim, corte, compressão. NÃO conta para a trava: quem tirou print ruim
  // não pode ser punido como quem está tentando forçar entrada (SPEC §6.4).
  if (!tokenLido) {
    const ilegiveis = dest.ilegiveisSeguidas + 1;
    const avisar = ilegiveis >= MAX_ILEGIVEIS_AVISO && !dest.avisoIlegivelEnviado;
    salvar({ ...dest, ilegiveisSeguidas: ilegiveis, avisoIlegivelEnviado: dest.avisoIlegivelEnviado || avisar });
    return {
      ok: false,
      motivo: 'ilegivel',
      ilegiveisSeguidas: ilegiveis,
      avisarStaff: avisar, // avisa, mas NÃO trava — o destinatário continua podendo tentar
      razao: 'não consegui ler o selo na captura. Tire outra, com o rodapé do documento visível e sem corte.',
    };
  }

  // A partir daqui houve token apresentado. Toda recusa abaixo CONTA para a trava.
  const recusar = (motivo, razao) => {
    const recusas = dest.recusasToken + 1;
    const travado = recusas >= MAX_RECUSAS_TOKEN;
    const atualizado = salvar({
      ...dest,
      recusasToken: recusas,
      travado,
      travadoEm: travado ? new Date(agora).toISOString() : null,
    });
    return { ok: false, motivo, razao, recusasToken: recusas, travou: travado, destinatario: atualizado };
  };

  if (!janelaAberta(peca, agora)) {
    return recusar('janela', peca.janela && peca.janela.encerradaEm
      ? 'a janela de entrega foi encerrada pelo emissor'
      : 'não há janela de entrega aberta neste momento');
  }
  if (dest.tokenUsado) return recusar('token_usado', 'este selo já foi usado');
  if (tokenLido !== dest.token) return recusar('token_invalido', 'o selo lido não corresponde a esta peça');

  // Destravado. O token queima ao usar. A autoria da peça continua do emissor, com o horário
  // original de protocolo — o recebimento é ato próprio, não move a autoria (SPEC §6.5).
  const atualizado = salvar({
    ...dest,
    tokenUsado: true,
    recebidoEm: new Date(agora).toISOString(),
    recebidoComo: 'entrega pessoal',
    recebidoPorId: quemRecebeuId, // registrado APÓS o fato, para os autos — não é o que autoriza
    capturaUrl,
    capturaMensagemId,
    ilegiveisSeguidas: 0,
  });
  return { ok: true, destinatario: atualizado, peca: db.buscarPorNumero('pecas', pecaNumero) };
}

// SPEC §6.4: sem este caminho o processo morre no selo travado.
function destravarSelo(pecaNumero, papelDestinatario, quemDestravouId, motivo, { habilitacaoId = null } = {}) {
  if (!motivo || !String(motivo).trim()) return { ok: false, razao: 'motivo é obrigatório' };
  const peca = db.buscarPorNumero('pecas', pecaNumero);
  if (!peca) return { ok: false, razao: 'peça não encontrada' };

  const idx = peca.destinatarios.findIndex(d => d.papel === papelDestinatario
    && (papelDestinatario !== 'Advogado' || d.habilitacaoId === habilitacaoId));
  if (idx === -1) return { ok: false, razao: 'destinatário não encontrado nesta peça' };

  const destinatarios = peca.destinatarios.map((d, i) => (i === idx ? {
    ...d,
    travado: false,
    recusasToken: 0,
    ilegiveisSeguidas: 0,
    // Token novo: o anterior pode ter vazado, e é o que motivou as tentativas recusadas.
    token: novoToken(),
    tokenUsado: false,
    destravadoPorId: quemDestravouId,
    destravadoMotivo: String(motivo).trim(),
  } : d));
  db.atualizar('pecas', pecaNumero, { destinatarios });
  return { ok: true, destinatario: destinatarios[idx] };
}

// ---------------------------------------------------------------------------
// Camada de visibilidade — PONTO ÚNICO (SPEC §8)
// ---------------------------------------------------------------------------
// TODO ponto de saída passa por aqui, sem exceção: handlers, embeds, autocomplete, listagens, rol
// de provas, busca, exportação, índice dos autos. Espalhar essa regra por handler é o que já
// produziu vazamento de teor em auditoria anterior.
//
// Resolve por PAPEL, nunca por lista de IDs gravada: se o registro dissesse `podem ver: [id123]`,
// o juiz substituto entraria cego no processo.
// `ehStaff` vem de fora porque Staff é ROLE do Discord (CARGO_STAFF_ID), não cargo do RH, e este
// módulo não importa discord.js de propósito. Quem chama resolve com utils/permissoes e passa. Se
// alguém esquecer, o efeito é a staff ver de menos — nunca alguém ver de mais: falha fechada.
function podeVerTeor(usuarioId, pecaRef, processoOpcional = null, { ehStaff = false } = {}) {
  if (!usuarioId) return false;
  const peca = typeof pecaRef === 'object' && pecaRef !== null ? pecaRef : db.buscarPorNumero('pecas', pecaRef);
  if (!peca) return false;

  // Peça não gated (modo `aberto`) é visível às partes desde a criação.
  if (!peca.gated) return true;
  // Supervisão vê sempre — é o que permite auditar a captura e destravar selo.
  if (ehStaff || isSupervisao(usuarioId)) return true;
  // O autor vê o que escreveu.
  if (peca.autorId === usuarioId) return true;

  const processo = processoOpcional || db.buscarPorNumero(peca.processoTabela, peca.processoNumero);
  if (!processo) return false;

  // Quem ocupa o papel do emissor AGORA vê o teor mesmo sem ter escrito: emissor substituído
  // precisa enxergar a peça que herdou para poder entregá-la.
  if (ocupaDestinatario(peca.processoTabela, processo, { papel: peca.autorPapel }, usuarioId)) return true;

  // Após a sentença tudo abre no fluxo normal — o sigilo aqui é temporal, não permanente (SPEC §1).
  if (processoSentenciado(processo)) return habilitadoNoProcesso(peca.processoTabela, processo, usuarioId);

  // Quem já registrou recebimento vê — resolvido por PAPEL, não pelo ID que clicou. É isso que faz
  // o juiz substituto enxergar o teor de uma peça recebida pelo antecessor (SPEC §8, teste 16).
  // E é irreversível: voltar fase não re-trava o que já foi recebido.
  return peca.destinatarios.some(d => d.recebidoEm && ocupaDestinatario(peca.processoTabela, processo, d, usuarioId));
}

// "Após a sentença" — o gate cai quando o processo chega a desfecho de mérito.
const STATUS_SENTENCIADOS = ['Sentenciado', 'Encerrado', 'Julgado', 'Deferido', 'Indeferido'];
const processoSentenciado = (processo) => !!processo.sentenca || STATUS_SENTENCIADOS.includes(processo.status);

// Habilitado = qualquer um que opere o processo: responsáveis nos slots + advogados com habilitação
// aprovada. `advogados[]` entra como fallback dos ritos que não usam habilitação (cível).
function habilitadoNoProcesso(processoTabela, processo, usuarioId) {
  const cfg = TABELAS_TICKET[processoTabela];
  const slots = cfg ? Object.values(cfg.papeis).map(p => processo[p.campo]) : [];
  const advogados = (processo.habilitacoes || []).filter(h => h.status === 'Aprovado').map(h => h.advogadoId);
  const listados = (processo.advogados || []).map(a => (typeof a === 'string' ? a : a && a.id));
  return [...slots, ...advogados, ...listados].filter(Boolean).includes(usuarioId);
}

// Metadados são SEMPRE visíveis aos operadores do processo — só o teor é gated (SPEC §8). Esta é a
// projeção segura da peça: use-a em toda listagem, e o teor só entra se podeVerTeor autorizar.
// Título genérico por tipo, nunca descritivo: "Intimação — fls. 12" e não "Intimação sobre quebra
// de sigilo de Fulano", que entregaria o teor sem abrir o documento (SPEC §10).
function projetarParaUsuario(usuarioId, peca, processoOpcional = null, opcoes = {}) {
  const base = {
    numero: peca.numero,
    tipo: peca.tipo,
    processoNumero: peca.processoNumero,
    autorPapel: peca.autorPapel,
    criadoEm: peca.criadoEm,
    gated: peca.gated,
    recebido: peca.destinatarios.every(d => !!d.recebidoEm),
  };
  return podeVerTeor(usuarioId, peca, processoOpcional, opcoes) ? { ...base, texto: peca.texto } : base;
}

// ---------------------------------------------------------------------------
// Válvula de escape — 24h (SPEC §7)
// ---------------------------------------------------------------------------
// Roda na varredura periódica, comparando o horário-limite persistido. Nunca setTimeout.
// Devolve o que destravou para o chamador lavrar nos autos e medir a métrica obrigatória: se a
// maioria dos atos cai aqui, a entrega in-game não está acontecendo e o problema não é de software.
function varrerValvula({ agora = Date.now() } = {}) {
  const destravadas = [];
  for (const peca of db.todos('pecas', p => p.gated)) {
    let mudou = false;
    const destinatarios = peca.destinatarios.map(d => {
      if (d.recebidoEm || !d.valvulaEm || new Date(d.valvulaEm).getTime() > agora) return d;
      mudou = true;
      return {
        ...d,
        recebidoEm: new Date(agora).toISOString(),
        recebidoComo: 'distribuição automática pelo cartório — não houve entrega pessoal registrada',
        automatico: true,
      };
    });
    if (!mudou) continue;
    db.atualizar('pecas', peca.numero, { destinatarios });
    destravadas.push({ peca: peca.numero, processoNumero: peca.processoNumero, processoTabela: peca.processoTabela });
  }
  return destravadas;
}

// SPEC §7: a contagem reinicia na troca de responsável. Sem isso o substituto herda um caso que
// destrava sozinho em minutos e a cena nunca acontece. Chamado pelo fluxo de troca.
function reiniciarValvulaPorTroca(processoTabela, processoNumero, papel, { agora = Date.now() } = {}) {
  const reiniciadas = [];
  for (const peca of db.todos('pecas', p => p.gated && p.processoTabela === processoTabela && p.processoNumero === processoNumero)) {
    let mudou = false;
    const destinatarios = peca.destinatarios.map(d => {
      if (d.papel !== papel || d.recebidoEm) return d; // recebimento é irreversível
      mudou = true;
      return { ...d, valvulaEm: new Date(agora + VALVULA_MS).toISOString() };
    });
    if (!mudou) continue;
    db.atualizar('pecas', peca.numero, { destinatarios });
    reiniciadas.push(peca.numero);
  }
  return reiniciadas;
}

// "2 entregas pendentes aguardando recebimento" — o que o substituto herdou (SPEC §6.2).
function pendentesDoPapel(processoTabela, processoNumero, papel) {
  return db.todos('pecas', p => p.gated
    && p.processoTabela === processoTabela
    && p.processoNumero === processoNumero
    && p.destinatarios.some(d => d.papel === papel && !d.recebidoEm));
}

// SPEC §11.2.2b: DESTRAVAR EM EMERGÊNCIA — ação separada e explícita, nunca efeito colateral do
// interruptor. Se a mecânica travar o servidor e for preciso liberar os processos em curso, a staff
// usa este caminho de propósito, e cada processo afetado recebe o registro nos autos.
//
// Mora aqui, e não em utils/modoEntrega.js, exatamente para não poder ser chamada por engano junto
// com o desligamento do modo: quem desliga o interruptor não destrava nada.
function destravarTodasPendencias({ quemId, motivo, agora = Date.now() } = {}) {
  if (!motivo || !String(motivo).trim()) return { ok: false, razao: 'motivo é obrigatório' };
  const afetadas = [];
  for (const peca of db.todos('pecas', p => p.gated)) {
    let mudou = false;
    const destinatarios = peca.destinatarios.map(d => {
      if (d.recebidoEm) return d; // recebimento é irreversível
      mudou = true;
      return {
        ...d,
        recebidoEm: new Date(agora).toISOString(),
        recebidoComo: 'entregas destravadas pela staff',
        automatico: true,
        travado: false,
        destravadoPorId: quemId,
        destravadoMotivo: String(motivo).trim(),
      };
    });
    if (!mudou) continue;
    db.atualizar('pecas', peca.numero, { destinatarios });
    afetadas.push({ peca: peca.numero, processoTabela: peca.processoTabela, processoNumero: peca.processoNumero });
  }
  return { ok: true, afetadas };
}

// SPEC §11.2.1: relatório de aposentadoria do caminho antigo — quantos processos legados ainda
// estão abertos. Quando chegar a zero, o fluxo de PDF anexado pode ser removido.
function relatorioLegado(processoTabela = 'processos') {
  const cfg = TABELAS_TICKET[processoTabela];
  const todos = db.todos(processoTabela);
  const abertos = cfg ? todos.filter(r => cfg.aberto(r)) : todos;
  const porModo = { legado: 0, ingame: 0, aberto: 0 };
  for (const r of abertos) porModo[modoDoProcesso(r)] = (porModo[modoDoProcesso(r)] || 0) + 1;
  return { abertos: abertos.length, porModo, podeAposentarLegado: porModo.legado === 0 };
}

// SPEC §11.4: processo arquivado ou anulado fecha as janelas pendentes, para não sobrar estado
// órfão. Não marca nada como recebido — só encerra a janela.
function fecharJanelasDoProcesso(processoTabela, processoNumero, { agora = Date.now() } = {}) {
  const fechadas = [];
  for (const peca of db.todos('pecas', p => p.processoTabela === processoTabela && p.processoNumero === processoNumero)) {
    if (!peca.janela || peca.janela.encerradaEm) continue;
    db.atualizar('pecas', peca.numero, { janela: { ...peca.janela, encerradaEm: new Date(agora).toISOString() } });
    fechadas.push(peca.numero);
  }
  return fechadas;
}

module.exports = {
  MODOS, VALVULA_MS, MAX_RECUSAS_TOKEN, MAX_ILEGIVEIS_AVISO,
  modoDoProcesso, janelaMinutos,
  ocupanteAtual, ocupaDestinatario, isSupervisao,
  gerar, abrirEntrega, encerrarEntrega, janelaAberta, receber, destravarSelo,
  podeVerTeor, projetarParaUsuario, processoSentenciado, habilitadoNoProcesso,
  varrerValvula, reiniciarValvulaPorTroca, pendentesDoPapel, fecharJanelasDoProcesso,
  destravarTodasPendencias, relatorioLegado,
};
