/* eslint-disable */
// A SEGUNDA INSTÂNCIA ENXERGA TODOS OS PROCESSOS (20/08/2026). Rode com:
//   node scripts/testes-desembargador-ve-tudo.js
//
// O QUE FALTAVA, e o que já existia — porque a diferença é o ponto todo desta mudança.
//
// O Desembargador JÁ podia ler os autos por toda porta do BOT desde 19/08/2026:
//   - `temAcessoTotal` (PAPEIS_COMPARTILHADOS) libera histórico e listagem;
//   - `CARGOS_QUE_VEEM_TEOR` libera o teor das peças gated.
// O que faltava era o DISCORD: o canal do ticket nega ViewChannel ao @everyone e só abre para os
// membros nominais e a staff. Ele podia ler o processo por comando e não via o canal existir.
//
// Por isso este arquivo testa as DUAS camadas: a do bot (que já valia, e não pode regredir) e a do
// canal (que é a mudança). Testar só a nova deixaria a antiga livre para quebrar em silêncio.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-des-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';
// A role precisa existir para o overwrite ser montado — é o gate de `overwriteSegundaInstancia`.
process.env.ROLE_DESEMBARGADOR_ID = 'role-desembargador';

const db = require('../database/db');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const pecas = require('../utils/pecas');
const processoCmd = require('../commands/processo');
const { PermissionFlagsBits, OverwriteType } = require('discord.js');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const DESEMBARGADOR = '210000000000000001';
const JUIZ = '210000000000000002';
const PROMOTOR = '210000000000000003';
const ADVOGADO = '210000000000000004';
const REU = '210000000000000005';
rh.contratar(DESEMBARGADOR, 'Desembargador', 'Desembargador');
rh.contratar(JUIZ, 'Juiz', 'Juiz');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado');

// Interação falsa: `member` sem permissão de admin e sem role de staff, para o acesso vir SÓ do
// cargo no /rh — que é exatamente o que esta mudança abre.
const fakeInteraction = (userId) => ({
  user: { id: userId },
  member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
});

db.inserir('processos', {
  numero: '0900PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
  juiz: JUIZ, promotor: PROMOTOR, delegado: null, reus: [REU], canalId: 'c900',
  reuNome: 'Réu de Teste', motivo: 'Fatos.', crimes: [],
  habilitacoes: [{ id: 1, advogadoId: ADVOGADO, status: 'Aprovado' }],
});
const PROC = db.buscarPorNumero('processos', '0900PN');

console.log('\n=== A segunda instância enxerga todos os processos ===\n');

// ---------------------------------------------------------------------------
console.log('1) CAMADA DO BOT — já valia, e não pode regredir');
// ---------------------------------------------------------------------------
{
  ok(processoCmd.temAcessoTotal(fakeInteraction(DESEMBARGADOR), PROC),
    '1a: o Desembargador tem acesso total aos autos, sem ser parte do caso');
  ok(processoCmd.temAcessoTotal(fakeInteraction(JUIZ), PROC), '1b: o Juiz do caso também');
  ok(processoCmd.temAcessoTotal(fakeInteraction(PROMOTOR), PROC), '1c: e o Promotor');

  // O QUE NÃO MUDOU — é isto que impede a abertura de virar vazamento.
  ok(processoCmd.temAcessoTotal(fakeInteraction(ADVOGADO), PROC),
    '1d: o advogado HABILITADO entra (pela habilitação, não pelo cargo)');
  const outroAdv = '210000000000000009';
  rh.contratar(outroAdv, 'Advogado', 'Advogado de outro caso');
  ok(!processoCmd.temAcessoTotal(fakeInteraction(outroAdv), PROC),
    '1e: advogado SEM habilitação neste processo continua de fora');
  ok(!processoCmd.temAcessoTotal(fakeInteraction(REU), PROC),
    '1f: e quem não é parte nem tem cargo, também');

  // Teor das peças gated: o Desembargador já estava na lista, e continua.
  const p = pecas.gerar({
    processoTabela: 'processos', processoNumero: '0900PN', tipo: 'denuncia_mp',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'Teor sigiloso.',
    destinatarios: [{ papel: 'Juiz' }],
  });
  ok(p.ok, '1z: a peça de teste foi criada');
  ok(pecas.podeVerTeor(DESEMBARGADOR, p.peca), '1g: e ele vê o teor da peça gated');
  ok(!pecas.podeVerTeor(outroAdv, p.peca), '1h: enquanto o advogado de fora não vê');
}

// ---------------------------------------------------------------------------
console.log('\n2) CAMADA DO CANAL — a mudança: ele passa a VER o canal existir');
// ---------------------------------------------------------------------------
async function secao2() {
  // Canal novo: o overwrite nasce junto.
  let criado = null;
  const guild = {
    id: 'guild1',
    roles: { everyone: 'role-everyone' },
    channels: { create: async (opts) => { criado = opts; return { id: 'c-novo', ...opts }; } },
  };
  await canais.criarCanalTicket(guild, { categoriaId: 'cat1', prefixo: 'processo', numero: '0901PN', membros: [JUIZ, PROMOTOR] });
  ok(!!criado, '2z: o canal foi criado (o cenário não passou vazio)');

  const ows = criado.permissionOverwrites;
  const doDes = ows.find(o => o.id === 'role-desembargador');
  ok(!!doDes, '2a: o canal nasce com overwrite para a role de Desembargador');
  ok(!!doDes && doDes.type === OverwriteType.Role, '2b: como ROLE, não como membro');
  ok(!!doDes && doDes.allow.includes(PermissionFlagsBits.ViewChannel), '2c: com ViewChannel — ele vê o canal');
  ok(!!doDes && doDes.allow.includes(PermissionFlagsBits.ReadMessageHistory), '2d: e lê o histórico');
  ok(!!doDes && (doDes.deny || []).includes(PermissionFlagsBits.SendMessages),
    '2e: mas NÃO escreve — é instância recursal, acompanha e supervisiona');

  // O que não pode ter mudado na criação.
  ok(ows.some(o => o.id === 'role-everyone' && o.deny.includes(PermissionFlagsBits.ViewChannel)),
    '2f: @everyone continua sem ver o canal');
  ok(ows.filter(o => o.type === OverwriteType.Member).length === 2,
    '2g: e os membros nominais continuam entrando', String(ows.filter(o => o.type === OverwriteType.Member).length));

  // SEM A ROLE CONFIGURADA, nada é adicionado — instalação que não tem o cargo não quebra.
  const salvo = require('../config').roleDesembargadorId;
  require('../config').roleDesembargadorId = null;
  criado = null;
  await canais.criarCanalTicket(guild, { categoriaId: 'cat1', prefixo: 'processo', numero: '0902PN', membros: [JUIZ] });
  ok(!criado.permissionOverwrites.some(o => o.id === 'role-desembargador'),
    '2h: sem ROLE_DESEMBARGADOR_ID configurado, nenhum overwrite é inventado');
  require('../config').roleDesembargadorId = salvo;
}

// ---------------------------------------------------------------------------
console.log('\n3) RETROATIVO — os canais que já existiam também abrem');
// ---------------------------------------------------------------------------
async function secao3() {
  const editados = [];
  const canalAntigo = {
    id: 'c-antigo',
    permissionOverwrites: { cache: new Map(), edit: async (id, perms, opts) => { editados.push({ id, perms, opts }); } },
  };
  const mudou = await canais.garantirAcessoSegundaInstancia(canalAntigo);
  ok(mudou === true, '3a: canal sem o overwrite é liberado');
  ok(editados.length === 1 && editados[0].id === 'role-desembargador', '3b: para a role de Desembargador');
  ok(editados[0].perms.ViewChannel === true && editados[0].perms.ReadMessageHistory === true,
    '3c: com ver e ler');
  ok(editados[0].perms.SendMessages === false, '3d: e sem escrever');
  ok(editados[0].opts && editados[0].opts.type === OverwriteType.Role,
    '3e: com type explícito — sem ele o discord.js quebra fora do cache (ver nota em canais.js)');

  // IDEMPOTENTE: roda todo boot, então não pode reescrever o que já está lá.
  editados.length = 0;
  const canalJaAberto = {
    id: 'c-ja',
    permissionOverwrites: {
      cache: new Map([['role-desembargador', { allow: { has: (p) => p === PermissionFlagsBits.ViewChannel } }]]),
      edit: async (id, perms, opts) => { editados.push({ id, perms, opts }); },
    },
  };
  ok(await canais.garantirAcessoSegundaInstancia(canalJaAberto) === false, '3f: canal que já tem o acesso é pulado');
  ok(editados.length === 0, '3g: sem reescrever nada — roda todo boot de graça');

  // FALHA NÃO DERRUBA: permissão negada num canal não pode parar o boot.
  const canalRuim = {
    id: 'c-ruim',
    permissionOverwrites: { cache: new Map(), edit: async () => { throw new Error('Missing Permissions'); } },
  };
  let explodiu = false;
  try { await canais.garantirAcessoSegundaInstancia(canalRuim); } catch { explodiu = true; }
  ok(!explodiu, '3h: canal que recusa a edição não derruba o boot');
}

// ---------------------------------------------------------------------------
console.log('\n4) O BOOT liga a passada retroativa — senão a mudança só valeria para casos novos');
// ---------------------------------------------------------------------------
{
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
  ok(idx.length > 1000, '4z: index.js foi lido (scan não vazio)');
  ok(/garantirAcessoSegundaInstancia\(canal\)/.test(idx), '4a: o boot chama a liberação retroativa');
  ok(/\['processos', 'medidas', 'peticoes', 'oficios', 'apelacoes'\]/.test(idx),
    '4b: sobre as cinco tabelas de ticket');
  ok(/!x\.arquivadoManual/.test(idx), '4c: só nos tickets ABERTOS — caso arquivado fica como está');
  ok(/2ª instância/.test(idx), '4d: e reporta no log quantos liberou');
  // Blindado: uma permissão negada não pode impedir o bot de subir.
  const bloco = idx.slice(idx.indexOf('[2ª instância]') - 1800, idx.indexOf('[2ª instância]') + 200);
  ok(/try \{/.test(bloco) && /catch \(e\)/.test(bloco), '4e: dentro de try/catch — não derruba o boot');
}

(async () => {
  await secao2();
  await secao3();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
