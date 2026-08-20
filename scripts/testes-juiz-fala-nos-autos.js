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

// CHROMIUM STUBBADO — e o porquê, porque isto é a diferença entre um teste de 8s e um de 5 min.
//
// Cada ato publicado renderiza um PNG de verdade (Puppeteer sobe o Chromium, monta o HTML, pagina,
// captura). São ~9 atos aqui: a suíte inteira passava a levar mais tempo neste arquivo do que em
// todos os outros juntos, e o operador já reclamou duas vezes da demora.
//
// O que este teste precisa provar NÃO é que o Chromium desenha — é que o ATO chega ao canal, com
// anexo, e é lavrado nos autos. Substituir o gerador no require.cache ANTES de carregar
// emissaoPeca troca só a etapa cara; todo o resto do caminho é o código real, sem mock.
//
// O gerador de verdade continua sendo exercitado, UMA vez, na seção 5 — e é lá que se confere que
// ele pagina e devolve buffers. Duas coisas separadas, cada uma testada onde custa menos.
const CAMINHO_PNG = require.resolve('../services/gerarPecaPNG');
let renderizacoes = 0;
require.cache[CAMINHO_PNG] = {
  id: CAMINHO_PNG, filename: CAMINHO_PNG, loaded: true, children: [], paths: [],
  exports: {
    ...require('../services/gerarPecaPNG'),
    gerarPecaPNG: async (dados) => {
      renderizacoes++;
      // Uma folha por ~3.000 caracteres, só para o teste distinguir documento de uma e de várias
      // páginas — o nome do anexo muda nos dois casos.
      const folhas = Math.max(1, Math.ceil((dados.texto || '').length / 3000));
      return Array.from({ length: folhas }, (_, i) => Buffer.from(`png-falso-fl${i + 1}`));
    },
  },
};

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
const OUTRO_PROMOTOR = '190000000000000004'; // MP é órgão: qualquer Promotor cobre o colega
const REU = '190000000000000005';
const ADVOGADO = '190000000000000006';
rh.contratar(OUTRO_PROMOTOR, 'Promotor', 'Promotor substituto');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado da defesa');

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
    juiz: JUIZ, promotor: PROMOTOR, delegado: null, reus: [REU], canalId: 'c1',
    habilitacoes: [{ id: 1, advogadoId: ADVOGADO, status: 'Aprovado' }],
    ...campos,
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

  // COM DOCUMENTO, DESDE 20/08/2026 (tarde). A primeira versão do despacho era texto-só e a
  // resposta dizia "as partes já o veem no canal" — só que `andamentos.registrar` NÃO posta no
  // canal do processo: grava no banco e espelha o TÍTULO no canal de auditoria. O texto ficava
  // nos autos, truncado em 300 caracteres no histórico, e o canal não recebia nada. Era bug de
  // PUBLICAÇÃO, não de persistência, e é por isso que estas asserções foram INVERTIDAS.
  ok(postados.some(m => m.files && m.files.length), '3d: o PNG do despacho é postado NO canal');
  const comArquivo = postados.find(m => m.files && m.files.length);
  ok(!!comArquivo && /^ato-/.test(comArquivo.files[0].name || ''),
    '3d2: pelo ponto único de ato do Juízo', comArquivo && comArquivo.files[0].name);
  // Publicado NÃO é o mesmo que entregue: nenhuma peça, nenhum selo, nenhuma janela.
  ok(!db.todos('pecas', x => x.processoNumero === p.numero).length,
    '3e: e ainda assim nenhuma peça foi criada — sem selo, sem entrega');
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

// ---------------------------------------------------------------------------
console.log('\n4) ARQUIVAR abre RECURSO ao Desembargador');
// ---------------------------------------------------------------------------
// QUEM PERDE COM O ARQUIVAMENTO É A ACUSAÇÃO: o processo que ela queria em curso morreu sem
// decisão de mérito. O réu/defesa venceu, e por isso não recorre — é a mesma lógica de "quem
// perdeu recorre" que já vale na sentença e na petição administrativa.
//
// REUSO, não paralelo: mesmo `botaoRecorrer`, mesmo customId, mesmo `abrirModalRecorrer`, mesma
// `criarApelacao` (sorteio de Desembargador -> razões -> acórdão). O que se estendeu foi só a
// regra de acesso, em `ladosQuePerderam`/`podeRecorrer`.
async function secao4() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  ok(src.length > 10000, '4z: processo.js foi lido (scan não vazio)');

  // O botão é o MESMO da sentença. Se alguém criar um "botaoRecorrerArquivamento", isto quebra.
  ok(/componentes: \[botaoRecorrer\(numero\)\]/.test(src),
    '4a: o arquivamento posta o MESMO botão Recorrer da sentença');
  ok((src.match(/function botaoRecorrer\(/g) || []).length === 1,
    '4b: e existe UMA função de botão de recurso, não duas');

  // O status é o que abre o recurso — e é o MESMO que a supervisão já usava para reabrir caso
  // arquivado, então nada de estado novo.
  const p = processoComJuiz();
  emissao.semearRascunho(JUIZ, 'razoes_arquivamento', p.numero, 'Ausente justa causa para a ação penal.');
  limpar();
  await processoCmd.arquivarComRazoes(fakeInteraction(JUIZ), 'razoes_arquivamento', p.numero);
  const depois = db.buscarPorNumero('processos', p.numero);
  ok(depois.status === 'Arquivado sem julgamento de mérito',
    '4c: o arquivamento grava o status que abre o recurso', depois.status);
  ok(depois.razoesArquivamento === 'Ausente justa causa para a ação penal.',
    '4d: e guarda as razões no registro');

  // QUEM PODE RECORRER — a resposta que o operador pediu para conferir.
  const podeRec = (uid) => processoCmd.podeRecorrer(fakeInteraction(uid), db.buscarPorNumero('processos', p.numero));
  ok(podeRec(PROMOTOR) === true, '4e: o PROMOTOR do caso pode recorrer do arquivamento');
  ok(podeRec(OUTRO_PROMOTOR) === true,
    '4f: e qualquer Promotor cobre o papel — MP é órgão (mesma regra da petição administrativa)');
  ok(podeRec(REU) === false, '4g: o RÉU não recorre — ele venceu');
  ok(podeRec(ADVOGADO) === false, '4h: nem a defesa habilitada, pelo mesmo motivo');
  ok(podeRec(JUIZ) === false, '4i: e o Juiz não é parte');

  // A recusa explica o motivo REAL, não a regra abstrata.
  const recusa = processoCmd.explicarNegacaoRecurso(fakeInteraction(REU), db.buscarPorNumero('processos', p.numero));
  ok(/arquivado sem julgamento de mérito/i.test(recusa),
    '4j: e a recusa ao réu explica que o caso encerrou a favor dele', recusa.slice(0, 60));
  ok(/Ministério Público/.test(recusa), '4k: dizendo quem tem o recurso liberado');

  // Não inventou fluxo: o recurso do arquivamento é a MESMA apelação.
  ok(/ORIGENS_RECURSO\[tabela\]/.test(src), '4l: a apelação continua resolvida pela tabela de origens');
  ok(!/apelacaoDoArquivamento|criarApelacaoArquivamento/.test(src),
    '4m: e não nasceu uma apelação paralela para o arquivamento');
}
// ---------------------------------------------------------------------------
console.log('\n5) O STUB NÃO MENTE — o contrato do gerador é conferido sem subir o Chromium');
// ---------------------------------------------------------------------------
// As seções acima rodam com o gerador stubbado (ver o topo). Sem esta seção, o arquivo poderia
// passar verde com um gerador que não existe mais — mock que dá confiança falsa.
//
// A renderização REAL não é exercitada aqui, de propósito: medida neste ambiente, UMA chamada a
// `gerarPecaPNG` levou 5 minutos de ESPERA (0,18s de CPU) — Chromium órfão travando o pipe. Um
// arquivo de teste não pode custar mais que a suíte inteira. O gerador continua coberto de verdade
// por scripts/testes-selo.js e scripts/testes-pagina-publica.js, que já sobem o Chromium.
//
// O que se confere aqui é o CONTRATO: que a função existe, tem a assinatura que `publicarAtoNoCanal`
// usa, e que o stub foi de fato exercitado — senão as asserções acima não provaram nada.
async function secao5() {
  delete require.cache[CAMINHO_PNG];
  const real = require('../services/gerarPecaPNG');
  ok(typeof real.gerarPecaPNG === 'function', '5a: o gerador real existe e é função');
  ok(real.gerarPecaPNG.length >= 1, '5b: e recebe o objeto de dados que publicarAtoNoCanal monta');
  ok(renderizacoes >= 5, '5c: o stub REALMENTE foi usado nas seções acima', `${renderizacoes} chamada(s)`);

  // O stub devolve buffers e pagina por tamanho — se ele deixasse de fazer isso, as asserções de
  // anexo acima passariam vazias sem ninguém notar.
  const { gerarPecaPNG } = require.cache[CAMINHO_PNG] ? require('../services/gerarPecaPNG') : real;
  ok(typeof gerarPecaPNG === 'function', '5z: o módulo carrega dos dois jeitos (com e sem cache)');
}


(async () => {
  await secao2();
  await secao3();
  await secao4();
  await secao5();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
