/* eslint-disable */
// LEITURA AMPLA DA MAGISTRATURA E DO MP — a camada do BOT (20/08/2026). Rode com:
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
// A CAMADA DO CANAL mudou de arquivo em 20/08/2026 (tarde).
// ---------------------------------------------------------------------------
// Este arquivo nasceu cobrindo as duas camadas, quando a abertura era só do Desembargador. Depois
// ela virou LEITURA INSTITUCIONAL dos quatro cargos, com impedimento por RG e exceção para
// diligência sigilosa — e a camada de canal ficou grande demais para viver aqui de carona.
//
// Ela mora agora em scripts/testes-leitura-institucional.js, que cobre overwrites por cargo,
// menção única, impedimento (deny de membro vencendo allow de role), a exceção dos restritos e o
// backfill. Aqui fica só o que este arquivo sempre testou de único: a camada do BOT.
//
// Não é duplicação removida por preguiça — é a divisão que evita duas versões da mesma asserção
// divergindo, que é como um teste começa a mentir.

(async () => {
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
