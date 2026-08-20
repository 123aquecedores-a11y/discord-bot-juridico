/* eslint-disable */
// CICLO DEMISSÃO → CONTRATAÇÃO: o caso nunca fica sem dono (20/08/2026). Rode com:
//   node scripts/testes-ciclo-responsavel.js
//
// O QUE ACONTECEU EM PRODUÇÃO: um Promotor foi desligado e ficou responsável por 8 casos. A
// varredura periódica detectou os 8 — e ABORTOU, porque a trava de massa (5) existe justamente
// para não redistribuir tudo quando o sintoma parece RH zerado. Resultado: ninguém assumiu, e o
// aviso se repetia a cada boot esperando alguém agir na mão.
//
// A CORREÇÃO NÃO FOI AFROUXAR A TRAVA. A trava está certa — ela protege contra o caso em que o RH
// se corrompe. O que faltava era o mecanismo PRINCIPAL: redistribuir no ATO da demissão, um caso
// por vez, quando ainda se sabe exatamente quem saiu e por quê. A varredura fica como rede.
//
// E o ciclo fecha do outro lado: contratar alguém faz os casos que estavam "aguardando designação"
// irem para ele sozinhos.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-ciclo-rh-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const responsaveis = require('../utils/responsaveis');
const rhCmd = require('../commands/rh');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ_A = '160000000000000001';
const JUIZ_B = '160000000000000002';
const PROMOTOR_A = '160000000000000003';
const PROCURADOR = '160000000000000004';
const DESEMB = '160000000000000005';
const ADVOGADO = '160000000000000006';
const ADV_2 = '160000000000000007';
const REU = '160000000000000008';

// Guild de mentira: todo mundo é membro presente (o que se testa aqui é CARGO, não presença) e os
// canais aceitam send sem fazer nada.
const enviados = [];
function fakeGuild() {
  const canal = {
    isTextBased: () => true,
    send: async (p) => { enviados.push(p); return { id: 'm1' }; },
    // `cache` precisa existir: canais.adicionarMembro olha as overwrites para saber se o canal
    // está com conversa bloqueada. Sem isso o fake quebra por dentro do código de produção.
    permissionOverwrites: { cache: { some: () => false }, delete: async () => {}, edit: async () => {} },
    setParent: async () => {}, edit: async () => {},
    members: { fetch: async () => ({}) },
  };
  return {
    id: 'guild1',
    members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} }, setNickname: async () => true }) },
    channels: { fetch: async () => canal },
  };
}

let seq = 0;
const processoDeJuiz = (juizId) => {
  const numero = `10${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução', juiz: juizId, promotor: PROMOTOR_A,
    delegado: null, reus: [], canalId: 'c1', habilitacoes: [], modoEntrega: 'ingame',
  });
  return numero;
};

console.log('\n=== Ciclo demissão → contratação ===\n');

// ---------------------------------------------------------------------------
console.log('1) DEMISSÃO com substituto disponível → re-sorteia na hora');
// ---------------------------------------------------------------------------
async function secao1() {
  rh.contratar(JUIZ_A, 'Juiz', 'Juiz A');
  rh.contratar(JUIZ_B, 'Juiz', 'Juiz B');
  rh.contratar(PROMOTOR_A, 'Promotor', 'Promotor A');
  const n1 = processoDeJuiz(JUIZ_A);
  const n2 = processoDeJuiz(JUIZ_A);

  const saiu = await rhCmd.demitirComRole(fakeGuild(), JUIZ_A, 'staff1');
  ok(!!saiu && saiu.cargo === 'Juiz', '1a: a demissão devolve o cargo que a pessoa tinha');
  ok(!rh.getCargo(JUIZ_A), '1b: e ela sai do quadro');

  const p1 = db.buscarPorNumero('processos', n1);
  const p2 = db.buscarPorNumero('processos', n2);
  ok(p1.juiz === JUIZ_B && p2.juiz === JUIZ_B,
    '1c: os DOIS casos foram redistribuídos no ato, sem esperar varredura', `${p1.juiz} / ${p2.juiz}`);
  ok(!p1.semResponsavelPendente && !p2.semResponsavelPendente,
    '1d: e nenhum ficou marcado como pendência — havia substituto');

  const reat = (saiu.reatribuidos || []).filter(t => t.resultado === 'reatribuido');
  ok(reat.length === 2, '1e: o retorno diz quantos casos foram redistribuídos', `${reat.length}`);
  ok(reat.every(t => t.novoId === JUIZ_B), '1f: ...e para quem');

  // O resumo é o que a Staff lê na hora: sem ele, a redistribuição acontece em silêncio.
  const resumo = rhCmd.resumoDaDemissao(saiu);
  ok(/redistribuído/.test(resumo) && resumo.includes(JUIZ_B),
    '1g: o resumo nomeia quem assumiu', resumo.slice(0, 80));
}

// ---------------------------------------------------------------------------
console.log('\n2) DEMISSÃO do ÚLTIMO do cargo → aguardando designação');
// ---------------------------------------------------------------------------
async function secao2() {
  const n = processoDeJuiz(JUIZ_B);
  const saiu = await rhCmd.demitirComRole(fakeGuild(), JUIZ_B, 'staff1');

  const p = db.buscarPorNumero('processos', n);
  ok(p.juiz === null, '2a: o campo do Juiz é ESVAZIADO — nome de quem saiu nos autos é atribuição falsa');
  ok(p.semResponsavelPendente === true, '2b: o caso fica marcado como aguardando designação');
  ok((p.pendenciaPapeis || []).includes('Juiz'), '2c: com o papel que falta registrado');

  // Contar seria frágil: os casos da seção 1 também eram do JUIZ_B e viram pendência junto, o que
  // é correto. O que importa é ESTE caso estar na lista.
  const pend = (saiu.reatribuidos || []).filter(t => t.resultado === 'pendencia_sem_substituto');
  ok(pend.some(t => t.numero === n), '2d: o retorno aponta ESTE caso como pendência', pend.map(t => t.numero).join(','));
  ok(pend.every(t => t.novoId === null), '2e-b: e sem substituto nenhum indicado');
  ok(/aguardando designação/.test(rhCmd.resumoDaDemissao(saiu)),
    '2e: e o resumo avisa a Staff — não é órfão silencioso');
  ok(enviados.some(e => /não há substituto disponível/.test(e.content || '')),
    '2f: o canal do caso também é avisado');
}

// ---------------------------------------------------------------------------
console.log('\n3) CONTRATAÇÃO → o caso pendente vai para quem entrou, sozinho');
// ---------------------------------------------------------------------------
async function secao3() {
  const pendentesAntes = db.todos('processos', p => p.semResponsavelPendente).length;
  ok(pendentesAntes > 0, '3z: há caso aguardando designação para o teste valer', `${pendentesAntes}`);

  const JUIZ_NOVO = '160000000000000009';
  const r = await rhCmd.contratarComRole(fakeGuild(), JUIZ_NOVO, 'Juiz', 'staff1', 'Juiz Novo');

  ok((r.assumidos || []).length === pendentesAntes,
    '3a: contratar designa os casos que aguardavam', `${(r.assumidos || []).length}`);
  ok((r.assumidos || []).every(a => a.novoId === JUIZ_NOVO), '3b: para quem acabou de entrar');
  ok(db.todos('processos', p => p.semResponsavelPendente).length === 0,
    '3c: e nenhum caso continua aguardando designação');

  const p = db.buscarPorNumero('processos', (r.assumidos || [])[0].numero);
  ok(p.juiz === JUIZ_NOVO, '3d: o campo do Juiz está preenchido de novo');
  ok(!p.semResponsavelPendente && (p.pendenciaPapeis || []).length === 0,
    '3e: e as marcas de pendência foram limpas');
}

// ---------------------------------------------------------------------------
console.log('\n4) COBERTURA — a chefia recebe o caso quando não há ninguém do cargo');
// ---------------------------------------------------------------------------
async function secao4() {
  // Sem nenhum Promotor, o Procurador deve assumir: é o mesmo `cobreOPapel` que já o autoriza a
  // AGIR. Antes o sorteio só olhava o cargo exato, e o caso virava pendência com alguém apto ao lado.
  rh.contratar(PROCURADOR, 'Procurador', 'Procurador');
  const numero = `10${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução', juiz: null, promotor: PROMOTOR_A,
    delegado: null, reus: [], canalId: 'c1', habilitacoes: [],
  });

  await rhCmd.demitirComRole(fakeGuild(), PROMOTOR_A, 'staff1');
  const p = db.buscarPorNumero('processos', numero);
  ok(p.promotor === PROCURADOR,
    '4a: sem Promotor, o PROCURADOR assume (Procurador cobre Promotor)', String(p.promotor));
  ok(!p.semResponsavelPendente, '4b: e o caso não virou pendência à toa');

  // A ORDEM importa: com alguém do cargo exato disponível, a cobertura NÃO é usada.
  rh.contratar('160000000000000010', 'Promotor', 'Promotor Novo');
  const n2 = `10${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero: n2, tipo: 'Penal', status: 'Instrução', juiz: null, promotor: PROCURADOR,
    delegado: null, reus: [], canalId: 'c1', habilitacoes: [],
  });
  await rhCmd.demitirComRole(fakeGuild(), PROCURADOR, 'staff1');
  ok(db.buscarPorNumero('processos', n2).promotor === '160000000000000010',
    '4c: havendo Promotor de verdade, é ele que assume — cobertura é plantão, não distribuição');
}

// ---------------------------------------------------------------------------
console.log('\n5) ADVOGADO demitido — habilitação cai, processo volta a precisar de defesa');
// ---------------------------------------------------------------------------
async function secao5() {
  rh.contratar(ADVOGADO, 'Advogado', 'Advogado');
  rh.contratar(ADV_2, 'Advogado', 'Advogado 2');

  const soUm = `10${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero: soUm, tipo: 'Penal', status: 'Instrução', juiz: null, promotor: null, reus: [REU],
    canalId: 'c1', habilitacoes: [{ id: 1, advogadoId: ADVOGADO, reuId: REU, status: 'Aprovado' }],
  });
  const comOutro = `10${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero: comOutro, tipo: 'Penal', status: 'Instrução', juiz: null, promotor: null, reus: [REU],
    canalId: 'c1',
    habilitacoes: [
      { id: 1, advogadoId: ADVOGADO, reuId: REU, status: 'Aprovado' },
      { id: 2, advogadoId: ADV_2, reuId: REU, status: 'Aprovado' },
    ],
  });

  enviados.length = 0;
  const saiu = await rhCmd.demitirComRole(fakeGuild(), ADVOGADO, 'staff1');

  const p1 = db.buscarPorNumero('processos', soUm);
  ok(p1.habilitacoes[0].status === 'Revogada', '5a: a habilitação é REVOGADA');
  ok(p1.habilitacoes[0].revogadaPorDemissao === true, '5b: com o motivo registrado');
  ok(p1.habilitacoes.length === 1,
    '5c: e NÃO apagada — ato praticado não some dos autos, só deixa de dar acesso');
  ok(p1.aguardandoDefesa === true, '5d: o processo volta a precisar de defesa');

  const p2 = db.buscarPorNumero('processos', comOutro);
  ok(p2.habilitacoes.find(h => h.advogadoId === ADV_2).status === 'Aprovado',
    '5e: a habilitação do OUTRO advogado não foi tocada');
  ok(!p2.aguardandoDefesa,
    '5f: e o processo com outro defensor NÃO é marcado como sem defesa');

  ok(p1.juiz === null && p2.juiz === null,
    '5g: demitir advogado NÃO re-sorteia magistrado — ele é parte, não órgão');
  ok(enviados.some(e => /sem defesa constituída/.test(e.content || '')),
    '5h: o canal é avisado de que falta defesa');
  ok(/habilitação/.test(rhCmd.resumoDaDemissao(saiu)), '5i: e o resumo para a Staff também diz');
}

// ---------------------------------------------------------------------------
console.log('\n6) A VARREDURA continua como rede, com a trava de massa intacta');
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'responsaveis.js'), 'utf-8');
  ok(src.length > 1000, '6z: o arquivo foi lido (scan não vazio)');
  ok(/const LIMITE_RECONCILIACAO_SEM_CARGO = 5;/.test(src),
    '6a: a trava de massa segue em 5 — a correção não foi afrouxá-la');
  ok(/varrerResponsaveisFantasma/.test(src), '6b: e a varredura periódica continua existindo');

  // O evento é o mecanismo PRINCIPAL: quem demite chama o motor direto.
  const srcRh = fs.readFileSync(path.join(__dirname, '..', 'commands', 'rh.js'), 'utf-8');
  ok(/responsaveis\.tratarResponsavelInvalido\(guild, usuarioId, 'demitido'\)/.test(srcRh),
    '6c: a demissão redistribui NO ATO, pelo mesmo motor da varredura');
  ok(/responsaveis\.recuperarPendencias\(guild\)/.test(srcRh),
    '6d: e a contratação resolve as pendências pelo mesmo motor');
  ok(!/function reatribuir[A-Z]/.test(srcRh),
    '6e: sem motor paralelo em commands/rh.js — a regra vive em utils/responsaveis.js');
}

(async () => {
  await secao1();
  await secao2();
  await secao3();
  await secao4();
  await secao5();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
