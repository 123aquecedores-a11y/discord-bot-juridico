/* eslint-disable */
// MEDIDA REQUERIDA PELO MP, FORA DE UM PROCESSO (20/08/2026). Rode com:
//   node scripts/testes-medida-avulsa-mp.js
//
// O QUE ESTAVA ERRADO: o MP pedia a medida pelo painel e caía num ticket com "Aprovar / Negar" —
// ou seja, ele aprovava o próprio pedido. Uma etapa que não decide nada, porque quem pede já
// decidiu pedir.
//
// AGORA é o MESMO rito da medida de dentro do processo (A5): vira peça com selo, vai direto ao
// Juiz, ele recebe em cena, escreve a PRÓPRIA fundamentação e expede o mandado.
//
// O CAMINHO DO DELEGADO NÃO MUDA, e metade deste arquivo existe para provar isso: lá o MP triando
// o pedido é ato real — ele avalia o que a polícia pediu e pode negar. É a mesma diferença entre
// inquérito e denúncia direta.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-medida-avulsa-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');
const emissao = require('../utils/emissaoPeca');
const medidaCmd = require('../commands/medida');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

const PROMOTOR = '180000000000000001';
const JUIZ_A = '180000000000000002';
const JUIZ_B = '180000000000000003';
const DELEGADO = '180000000000000004';
const ADVOGADO = '180000000000000005';

rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(JUIZ_A, 'Juiz', 'Juiz A');
rh.contratar(JUIZ_B, 'Juiz', 'Juiz B');
rh.contratar(DELEGADO, 'Delegado', 'Delegado');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado');

const enviados = [];
function fakeGuild() {
  const canal = {
    id: 'cmed', isTextBased: () => true,
    send: async (p) => { enviados.push(p); return { id: `m${enviados.length}` }; },
    permissionOverwrites: { cache: { some: () => false }, delete: async () => {}, edit: async () => {} },
    setParent: async () => {}, edit: async () => {}, messages: { fetch: async () => null },
  };
  return {
    id: 'guild1',
    roles: { everyone: 'role-everyone' },
    members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} } }) },
    channels: { fetch: async () => canal, create: async () => canal },
  };
}

// Liga o modo in-game para este guild — é o que faz a peça nascer gated.
require('../utils/modoEntrega').ligar('guild1', 'staff-teste');

console.log('\n=== Medida requerida pelo MP, fora de processo ===\n');

// ---------------------------------------------------------------------------
console.log('1) O MP NÃO APROVA MAIS O PRÓPRIO PEDIDO');
// ---------------------------------------------------------------------------
async function secao1() {
  enviados.length = 0;
  const r = await medidaCmd.solicitarMedida({
    guild: fakeGuild(), porMp: true, promotorId: PROMOTOR, delegadoId: null,
    tipo: 'Busca e Apreensão', alvo: 'Galpão da Rua 5', rgAlvo: null,
    motivo: 'Indícios de depósito de produto de furto.',
  });
  ok(!r.erro, '1z: a medida foi criada', r.erro || '');
  if (r.erro) return null;

  const m = db.buscarPorNumero('medidas', r.numero);
  ok(m.status === 'Aprovada - aguardando juiz',
    '1a: nasce JÁ na fase do Juiz — não há triagem do MP a fazer sobre o próprio pedido', m.status);
  ok(m.delegado === null, '1b: sem delegado (não houve polícia neste pedido)');
  ok(m.promotor === PROMOTOR, '1c: o promotor que requereu é o responsável');
  ok(m.fundamentacaoPromotor === 'Indícios de depósito de produto de furto.',
    '1d: a fundamentação do MP fica gravada na medida, que é o lugar dela');

  // O canal NÃO pode nascer com Aprovar/Negar. Mas PRECISA nascer com "Entregar agora" — sem
  // esse botão a peça existe e ninguém consegue entregá-la, que é o defeito que a sentença teve.
  const todosOsIds = enviados.flatMap(e => (e.components || [])
    .flatMap(l => (l.toJSON ? l.toJSON().components : l.components) || [])
    .map(c => c.custom_id || ''));
  ok(!todosOsIds.some(i => /deferirdireta|indeferirdireta/.test(i)),
    '1e: o canal não recebe botões de DECIDIR — eles nascem quando um Juiz receber', todosOsIds.join(','));
  ok(todosOsIds.some(i => /^peca:entregar:/.test(i)),
    '1e-b: mas recebe o "Entregar agora" — peça sem ele é peça que ninguém entrega', todosOsIds.join(','));
  const texto = JSON.stringify(enviados);
  ok(!/deferirdireta|indeferirdireta|aprovar|negar/i.test(texto),
    '1f: nem os customId de Aprovar/Negar aparecem');
  ok(/Qualquer Juiz/i.test(texto), '1g: e a mensagem diz que qualquer Juiz pode assumir');
  return r.numero;
}

// ---------------------------------------------------------------------------
console.log('\n2) VIRA PEÇA, pelo MESMO tipo da medida de dentro do processo');
// ---------------------------------------------------------------------------
async function secao2(numero) {
  const pecasDaMedida = db.todos('pecas', p => p.processoTabela === 'medidas' && p.processoNumero === numero);
  ok(pecasDaMedida.length === 1, '2a: uma peça foi emitida para o requerimento', `${pecasDaMedida.length}`);
  if (!pecasDaMedida.length) return null;

  const peca = pecasDaMedida[0];
  ok(peca.tipo === 'solicitacao_medida',
    '2b: pelo MESMO tipo da medida de dentro do processo — não nasceu um paralelo', peca.tipo);
  ok(peca.gated === true, '2c: e nasce gated');
  ok((peca.destinatarios || [])[0].papel === 'Juiz', '2d: dirigida ao PAPEL Juiz');

  // A medida carimba o próprio modo: não há processo de onde herdá-lo.
  const m = db.buscarPorNumero('medidas', numero);
  ok(m.modoEntrega === 'ingame',
    '2e: a medida carrega o modo carimbado — sem isso seria lida como legado e nunca gatearia', String(m.modoEntrega));
  return peca.numero;
}

// ---------------------------------------------------------------------------
console.log('\n3) QUALQUER JUIZ pode receber e assumir — o mecanismo que já existia');
// ---------------------------------------------------------------------------
async function secao3(numero, numeroPeca) {
  const m = db.buscarPorNumero('medidas', numero);
  ok(m.juiz === null, '3a: a medida nasce SEM juiz (não há processo de onde herdar)');

  // É a mesma resolução por papel do resto do bot: com o slot vazio, o cargo cobre.
  ok(pecas.ocupaDestinatario('medidas', m, { papel: 'Juiz' }, JUIZ_A) === true,
    '3b: qualquer Juiz ocupa o papel de destinatário');
  ok(pecas.ocupaDestinatario('medidas', m, { papel: 'Juiz' }, JUIZ_B) === true, '3c: outro Juiz também');
  ok(pecas.ocupaDestinatario('medidas', m, { papel: 'Juiz' }, ADVOGADO) === false, '3d: advogado não');
  ok(pecas.ocupaDestinatario('medidas', m, { papel: 'Juiz' }, PROMOTOR) === false,
    '3e: nem o promotor que requereu — quem acusa não decide');

  // Recebimento real, com selo.
  pecas.abrirEntrega(numeroPeca, PROMOTOR);
  const token = db.buscarPorNumero('pecas', numeroPeca).destinatarios[0].token;
  const rec = pecas.receber(numeroPeca, JUIZ_B, { tokenLido: token });
  ok(rec.ok, '3f: um Juiz recebe em cena, pelo selo');

  const efeito = emissao.aplicarEfeitoDoRecebimento('solicitacao_medida',
    db.buscarPorNumero('medidas', numero), { numero: numeroPeca }, JUIZ_B);
  ok(!!efeito && !!efeito.campos, '3g: o recebimento produz efeito');
  ok(efeito.campos.juiz === JUIZ_B, '3h: e QUEM RECEBEU assume a medida — mesmo elo da denúncia');
  ok(/assume a medida/.test(efeito.aviso || ''), '3i: com aviso que diz isso a ele');

  const depois = db.buscarPorNumero('medidas', numero);
  ok(depois.juiz === JUIZ_B, '3j: a titularidade fica gravada');
  ok(!!depois.requerimentoRecebidoEm, '3k: e o recebimento também');

  // Segundo recebimento não reatribui.
  const segundo = emissao.aplicarEfeitoDoRecebimento('solicitacao_medida', depois, { numero: numeroPeca }, JUIZ_A);
  ok(segundo === null, '3l: um segundo Juiz recebendo não rouba o caso do primeiro');
}

// ---------------------------------------------------------------------------
console.log('\n4) O CAMINHO DO DELEGADO não mudou');
// ---------------------------------------------------------------------------
async function secao4() {
  enviados.length = 0;
  const r = await medidaCmd.solicitarMedida({
    guild: fakeGuild(), delegadoId: DELEGADO, promotorId: null,
    tipo: 'Prisão Preventiva', alvo: 'Fulano', rgAlvo: '123', motivo: 'Indícios do inquérito.',
  });
  const m = db.buscarPorNumero('medidas', r.numero);
  ok(m.status === 'Aguardando MP', '4a: continua nascendo para a TRIAGEM do MP', m.status);
  ok(m.delegado === DELEGADO, '4b: com o delegado que pediu');
  ok(m.juiz === null, '4c: e sem juiz — quem sorteia é o MP ao aprovar');

  const texto = JSON.stringify(enviados);
  ok(/aprovar|negar/i.test(texto),
    '4d: e o canal recebe Aprovar/Negar — aqui a triagem é ato real, o MP pode negar');
  ok(db.todos('pecas', p => p.processoNumero === r.numero).length === 0,
    '4e: o pedido do delegado NÃO vira peça — ele não é dirigido ao Juiz ainda');
}

// ---------------------------------------------------------------------------
console.log('\n5) A EMISSÃO DO MANDADO funciona sem processo');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'medida.js');
  ok(src.length > 1000, '5z: o arquivo foi lido (scan não vazio)');

  // Antes recusava com "Processo vinculado não encontrado" e travava a medida avulsa.
  ok(/const processo = medida\.processoVinculado \? db\.buscarPorNumero\('processos', medida\.processoVinculado\) : null;/.test(src),
    '5a: a busca do processo é condicional');
  ok(/if \(medida\.processoVinculado && !processo\)/.test(src),
    '5b: só recusa quando o processo DEVERIA existir e sumiu');
  ok(/if \(!processo\) \{[\s\S]{0,400}emitirMandadoDaMedida/.test(src),
    '5c: sem processo, usa emitirMandadoDaMedida — a mesma função do referendo, que já tratava isso');
  ok(/emitirMandadoNoProcesso/.test(src),
    '5d: e com processo continua juntando aos autos, como antes');

  // Sem paralelo: uma função de requerimento pelo MP, chamada pela de sempre.
  const solicitacoes = (src.match(/async function solicitarMedida\b/g) || []).length;
  ok(solicitacoes === 1, '5e: existe UMA solicitarMedida', `${solicitacoes}`);
  ok(/if \(porMp\) return solicitarMedidaPeloMp/.test(src),
    '5f: e ela delega para o rito do MP por um parâmetro, não por um segundo comando');
}

// ---------------------------------------------------------------------------
console.log('\n6) O CARD: um RG só, e sem `<@null>`');
// ---------------------------------------------------------------------------
{
  const linha = medidaCmd.embedMedida
    ? medidaCmd.embedMedida({ numero: 'MD1', tipo: 'Busca', status: 'x', alvo: 'Galpão', motivo: 'y', promotor: PROMOTOR, delegado: null, rgAlvo: null })
    : null;
  if (linha) {
    const campos = linha.toJSON().fields;
    const rgs = campos.filter(f => f.name === 'RG do alvo');
    ok(rgs.length === 1, '6a: "RG do alvo" aparece UMA vez', `${rgs.length}`);
    ok(!JSON.stringify(campos).includes('<@null>'), '6b: e não há `<@null>` no card');
    ok(!campos.some(f => f.name === 'Delegado'),
      '6c: sem delegado, o campo nem aparece — em vez de mostrar menção vazia');
  } else {
    // embedMedida não é exportado: confere na fonte, que é o que importa.
    const src = LER('commands', 'medida.js');
    const bloco = src.slice(src.indexOf('function embedMedida'), src.indexOf('function embedMedida') + 1400);
    ok((bloco.match(/name: 'RG do alvo'/g) || []).length === 1,
      '6a: "RG do alvo" aparece UMA vez no card', `${(bloco.match(/name: 'RG do alvo'/g) || []).length}`);
    ok(/medida\.delegado \? \[\{ name: 'Delegado'/.test(bloco),
      '6b: o Delegado só é mencionado quando existe — sem isso o card imprimia `<@null>`');
    ok(/medida\.promotor \? `<@\$\{medida\.promotor\}>` : '—'/.test(bloco),
      '6c: e o Promotor idem');
  }
}

(async () => {
  const numero = await secao1();
  const numeroPeca = numero ? await secao2(numero) : null;
  if (numero && numeroPeca) await secao3(numero, numeroPeca);
  await secao4();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
