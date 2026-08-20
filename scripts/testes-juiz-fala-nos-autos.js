/* eslint-disable */
// O JUIZ GANHOU VOZ NOS AUTOS (20/08/2026). Rode com:
//   node scripts/testes-juiz-fala-nos-autos.js
//
// O DIAGNÓSTICO: todas as ferramentas do Juiz eram de PRODUZIR documento — sentença, mandado,
// intimação, acórdão. Para NEGAR alguma coisa ele não tinha ferramenta nenhuma: simplesmente não
// emitia o mandado, e o pedido do MP ficava pendurado sem resposta. E arquivar era um clique só,
// sem razões e sem andamento — quem lia os autos não descobria por que o caso fechou.
//
// DUAS FUNÇÕES, UM COMPONENTE. Nenhuma das duas cria caminho paralelo: as duas reusam o rascunho
// por trechos de utils/emissaoPeca.js, com FINALIZADOR próprio (o mesmo padrão de
// fundamentacao_mandado e fundamentacao_sentenca). Nenhuma vira peça.
//
//   (a) ARQUIVAR COM RAZÕES — `arquivarManual` (painel.js) continua sendo quem fecha o canal. O que
//       se acrescentou foi a exigência de dizer por quê, e a lavratura nos autos ANTES do fecho.
//   (b) DESPACHO — sem PNG, sem selo, sem entrega, de propósito: gatear um despacho exigiria cena
//       para cada "indefiro", e o custo de encenação existe para o documento que a parte precisa
//       TER em mãos, não para o Juiz responder um pedido.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-juizfala-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const emissao = require('../utils/emissaoPeca');
const processoCmd = require('../commands/processo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ = '190000000000000001';
const OUTRO_JUIZ = '190000000000000002';
const PROMOTOR = '190000000000000003';
rh.contratar(JUIZ, 'Juiz', 'Juiz do caso');
rh.contratar(OUTRO_JUIZ, 'Juiz', 'Juiz de outro caso');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');

// O que foi postado no canal, e o que foi lavrado nos autos — as duas coisas que estes atos
// produzem, e as únicas que importam aqui.
const postados = [];
const canal = {
  id: 'c1', isTextBased: () => true,
  send: async (p) => { postados.push(p); return { id: `m${postados.length}` }; },
  // `values` e `setTopic` existem porque `canais.arquivarCanal` precisa dos dois: ele tira um
  // snapshot dos overwrites (array, não a Collection viva) e grava a categoria de origem no topic.
  permissionOverwrites: { cache: { some: () => false, values: () => [] }, delete: async () => {}, edit: async () => {} },
  setTopic: async () => {}, parentId: null,
  setParent: async () => {}, edit: async () => {}, messages: { fetch: async () => null },
  permissionsFor: () => ({ has: () => true }),
};
const guild = {
  id: 'guild1', roles: { everyone: 'role-everyone' },
  members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} } }) },
  channels: { fetch: async () => canal, create: async () => canal },
};

let seq = 0;
function processoComJuiz(campos = {}) {
  const numero = `07${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
    juiz: JUIZ, promotor: PROMOTOR, delegado: null, reus: [], canalId: 'c1', ...campos,
  });
  return db.buscarPorNumero('processos', numero);
}

const respostas = [];
function fakeInteraction(userId) {
  return {
    user: { id: userId },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    guild, channel: canal,
    reply: async (p) => { respostas.push({ tipo: 'reply', ...p }); return p; },
    deferReply: async () => { respostas.push({ tipo: 'defer' }); },
    editReply: async (p) => { respostas.push({ tipo: 'edit', ...p }); return p; },
    followUp: async (p) => { respostas.push({ tipo: 'followUp', ...p }); return p; },
    showModal: async (m) => { respostas.push({ tipo: 'modal', id: m?.data?.custom_id || 'modal' }); return m; },
    fields: { getTextInputValue: () => '' },
  };
}
const limpar = () => { respostas.length = 0; postados.length = 0; };
const andamentosDe = (numero) => db.todos('andamentos', a => a.protocolo === numero || a.numero === numero || a.processoNumero === numero);

console.log('\n=== O Juiz fala nos autos: arquivar com razões, e despachar ===\n');

// ---------------------------------------------------------------------------
console.log('1) REUSO — os dois atos usam o rascunho que já existia, e não viram peça');
// ---------------------------------------------------------------------------
{
  for (const tipo of ['razoes_arquivamento', 'despacho_juiz']) {
    const cfg = emissao.TIPOS[tipo];
    ok(!!cfg, `1a-${tipo}: o tipo existe no catálogo`);
    ok(cfg && cfg.ativo === true, `1b-${tipo}: e está ativo`);
    ok(cfg && cfg.semPeca === true, `1c-${tipo}: declarado semPeca — não gera documento entregue`);
    ok(cfg && cfg.emissor === 'Juiz', `1d-${tipo}: emitido pelo Juiz`);
    ok(cfg && Array.isArray(cfg.destinatarios) && cfg.destinatarios.length === 0,
      `1e-${tipo}: sem destinatário — não há entrega a fazer`);
  }
  // O despacho é nomeado pelo Juiz ("Indeferimento do pedido de prisão temporária"); as razões do
  // arquivamento não precisam de nome — o ato já diz o que é.
  ok(emissao.TIPOS.despacho_juiz.tituloLivre === true, '1f: o despacho é nomeado por quem o escreve');

  // O componente é o MESMO. Se um dia alguém escrever um modal próprio para estes atos, o rascunho
  // vira duas implementações que divergem — foi o motivo de FINALIZADORES existir.
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  ok(src.length > 10000, '1z: processo.js foi lido (scan não vazio)');
  ok(/registrarFinalizador\('razoes_arquivamento', arquivarComRazoes\)/.test(src),
    '1g: o arquivamento registra finalizador — não um fluxo próprio');
  ok(/registrarFinalizador\('despacho_juiz', publicarDespacho\)/.test(src),
    '1h: o despacho também');
  ok(/abrirModalTrecho\(interaction, 'razoes_arquivamento', numero\)/.test(src)
    && /abrirModalTrecho\(interaction, 'despacho_juiz', numero\)/.test(src),
    '1i: e as duas portas abrem o modal de trecho de sempre');
}

// ---------------------------------------------------------------------------
console.log('\n2) ARQUIVAR — nunca em silêncio');
// ---------------------------------------------------------------------------
async function secao2() {
  // -- 2.1 sem razões, não arquiva --
  const p1 = processoComJuiz();
  limpar();
  await processoCmd.arquivarComRazoes(fakeInteraction(JUIZ), 'razoes_arquivamento', p1.numero);
  ok(respostas.some(r => /Não há razões escritas/.test(r.content || '')),
    '2a: rascunho vazio (ou expirado) não arquiva — recusa dizendo por quê');
  ok(!db.buscarPorNumero('processos', p1.numero).arquivadoManual,
    '2b: e o processo continua aberto');

  // -- 2.2 com razões, arquiva E lavra --
  const p2 = processoComJuiz();
  const RAZOES = 'Extinta a punibilidade pela prescrição da pretensão punitiva.';
  emissao.semearRascunho(JUIZ, 'razoes_arquivamento', p2.numero, RAZOES);
  limpar();
  await processoCmd.arquivarComRazoes(fakeInteraction(JUIZ), 'razoes_arquivamento', p2.numero);

  const depois = db.buscarPorNumero('processos', p2.numero);
  ok(depois.arquivadoManual === true, '2c: com razões, o processo é arquivado');
  const lavrados = andamentosDe(p2.numero);
  const arq = lavrados.find(a => a.tipo === 'processo_arquivado');
  ok(!!arq, '2d: e o arquivamento é lavrado nos autos', `${lavrados.length} andamento(s)`);
  ok(!!arq && arq.detalhe.includes(RAZOES), '2e: com as RAZÕES por extenso — não só "arquivado"');
  ok(!!arq && arq.detalhe.includes(JUIZ), '2f: e quem determinou');

  // O rascunho foi consumido: sem isso, um segundo clique reaproveitaria o mesmo texto.
  ok(!emissao.lerRascunho(JUIZ, 'razoes_arquivamento', p2.numero).trechos.length,
    '2g: o rascunho é consumido pelo ato');

  // -- 2.3 guarda de colisão --
  emissao.semearRascunho(OUTRO_JUIZ, 'razoes_arquivamento', p2.numero, 'Outra razão qualquer.');
  const antes = andamentosDe(p2.numero).length;
  limpar();
  await processoCmd.arquivarComRazoes(fakeInteraction(OUTRO_JUIZ), 'razoes_arquivamento', p2.numero);
  ok(andamentosDe(p2.numero).length === antes,
    '2h: o segundo arquivamento não lavra um segundo andamento');

  // -- 2.4 quem não é o Juiz do caso não arquiva --
  const p3 = processoComJuiz();
  emissao.semearRascunho(PROMOTOR, 'razoes_arquivamento', p3.numero, 'Quero arquivar.');
  limpar();
  await processoCmd.arquivarComRazoes(fakeInteraction(PROMOTOR), 'razoes_arquivamento', p3.numero);
  ok(!db.buscarPorNumero('processos', p3.numero).arquivadoManual,
    '2i: o Promotor não arquiva o processo pelo fluxo do Juiz');
  ok(respostas.some(r => /Juiz/.test(r.content || '')), '2j: e recebe a razão da recusa');
}

// ---------------------------------------------------------------------------
console.log('\n3) DESPACHO — decisão em texto, visível às partes, sem documento');
// ---------------------------------------------------------------------------
async function secao3() {
  const p = processoComJuiz();
  const TEXTO = 'Indefiro o pedido de prisão temporária: os indícios apresentados não demonstram '
    + 'necessidade da medida para a instrução, e o alvo tem residência fixa.';
  emissao.semearRascunho(JUIZ, 'despacho_juiz', p.numero, TEXTO);
  // O título vem do modal do primeiro trecho; aqui é semeado direto no rascunho, que é onde ele vive.
  const rasc = emissao.lerRascunho(JUIZ, 'despacho_juiz', p.numero);
  rasc.tituloLivre = 'Indeferimento do pedido de prisão temporária';
  limpar();

  await processoCmd.publicarDespacho(fakeInteraction(JUIZ), 'despacho_juiz', p.numero);

  const lavrados = andamentosDe(p.numero);
  const desp = lavrados.find(a => a.tipo === 'despacho_juiz');
  ok(!!desp, '3a: o despacho é lavrado nos autos', `${lavrados.length} andamento(s)`);
  ok(!!desp && desp.detalhe.includes(TEXTO), '3b: com as razões do Juiz por extenso');
  ok(!!desp && /Indeferimento do pedido de prisão temporária/.test(desp.titulo || ''),
    '3c: e o título que ele escolheu', desp && desp.titulo);

  // SEM DOCUMENTO — é o ponto do ato. Nenhum anexo, nenhuma peça, nenhuma janela de entrega.
  ok(!postados.some(m => m.files && m.files.length), '3d: NENHUM arquivo foi anexado no canal');
  ok(!db.todos('pecas', x => x.processoNumero === p.numero).length,
    '3e: e nenhuma peça foi criada — sem selo, sem entrega');
  ok(!db.buscarPorNumero('processos', p.numero).arquivadoManual,
    '3f: despachar não arquiva o processo');

  // O processo NÃO muda de estado: despachar é falar, não decidir o rumo.
  ok(db.buscarPorNumero('processos', p.numero).status === 'Instrução',
    '3g: e o status não muda — o despacho não avança nem retrocede a fase');

  // Sem texto, não despacha.
  const p2 = processoComJuiz();
  limpar();
  await processoCmd.publicarDespacho(fakeInteraction(JUIZ), 'despacho_juiz', p2.numero);
  ok(respostas.some(r => /Não há texto/.test(r.content || '')), '3h: rascunho vazio não vira despacho');
  ok(!andamentosDe(p2.numero).some(a => a.tipo === 'despacho_juiz'), '3i: e nada é lavrado');

  // COBERTURA DE CARGO, não identidade estrita. `podeAtuarNoCaso` (utils/permissoes.js, 19/08/2026)
  // deixa um Juiz cobrir o outro — é assim em sentença, mandado e intimação, e o despacho segue a
  // MESMA regra em vez de inventar uma trava própria. Este teste primeiro afirmava o contrário e
  // reprovava o código: a asserção estava errada, não o comportamento.
  //
  // O que garante a rastreabilidade é o `executorId` do andamento: os autos registram quem de fato
  // despachou, não o titular do caso.
  emissao.semearRascunho(OUTRO_JUIZ, 'despacho_juiz', p2.numero, 'Despacho em substituição.');
  limpar();
  await processoCmd.publicarDespacho(fakeInteraction(OUTRO_JUIZ), 'despacho_juiz', p2.numero);
  const porSubstituto = andamentosDe(p2.numero).find(a => a.tipo === 'despacho_juiz');
  ok(!!porSubstituto, '3j: outro Juiz PODE despachar — a chefia/colegas cobrem o papel, como no resto do bot');
  ok(!!porSubstituto && porSubstituto.executorId === OUTRO_JUIZ,
    '3k: e os autos registram quem realmente despachou, não o titular', porSubstituto && porSubstituto.executorId);

  // O Promotor, não: `CARGO_DO_CAMPO.juiz` é 'Juiz', e ele não o cobre.
  const p2b = processoComJuiz();
  emissao.semearRascunho(PROMOTOR, 'despacho_juiz', p2b.numero, 'Despacho do promotor.');
  limpar();
  await processoCmd.publicarDespacho(fakeInteraction(PROMOTOR), 'despacho_juiz', p2b.numero);
  ok(!andamentosDe(p2b.numero).some(a => a.tipo === 'despacho_juiz'),
    '3k2: o Promotor não despacha nos autos');
  ok(respostas.some(r => /Juiz/.test(r.content || '')), '3k3: e recebe a razão da recusa');

  // Sem título, o despacho continua funcionando — o nome é conveniência, não requisito.
  const p3 = processoComJuiz();
  emissao.semearRascunho(JUIZ, 'despacho_juiz', p3.numero, 'Manifeste-se o MP em 48h.');
  limpar();
  await processoCmd.publicarDespacho(fakeInteraction(JUIZ), 'despacho_juiz', p3.numero);
  const semTitulo = andamentosDe(p3.numero).find(a => a.tipo === 'despacho_juiz');
  ok(!!semTitulo, '3l: sem título escolhido, o despacho sai assim mesmo');
  ok(!!semTitulo && /Despacho/.test(semTitulo.titulo || ''), '3m: com o rótulo genérico', semTitulo && semTitulo.titulo);
}

(async () => {
  await secao2();
  await secao3();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
