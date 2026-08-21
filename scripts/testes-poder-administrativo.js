/* eslint-disable */
// PODER ADMINISTRATIVO DE DESEMBARGADOR E PROCURADOR (21/08/2026). Rode com:
//   node scripts/testes-poder-administrativo.js
//
// ONDE A CHECAGEM MORAVA: espalhada. `isAdmin(x) || isSuperStaff(x)` repetido em 8 pontos de
// commands/painel.js e 4 de commands/rh.js, cada um com a sua string de recusa. Acrescentar um
// cargo assim significa caçar cada condicional — e esquecer uma é como um poder fica pela metade.
//
// COMO ERA DECIDIDO: por ROLE DO DISCORD. `isAdmin` lê `member.permissions.has(Administrator)` e a
// role de staff; `isSuperStaff` lê a role "Staff Salve". Agora Desembargador e Procurador entram
// pelo CARGO ATIVO NO RH (`rh.temCargo`), que é a fonte da verdade do projeto — quem perde o cargo
// perde o poder no mesmo instante, sem ninguém mexer em role.
//
// O LOG: contratar, demitir e dar licença passam a exigir MOTIVO e a gravar em `logRh` — executor,
// CARGO do executor, alvo, ação, motivo e data. Consultável por "📜 Log de RH".

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-poder-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const logRh = require('../utils/logRh');
const permissoes = require('../utils/permissoes');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

const DESEMBARGADOR = '230000000000000001';
const PROCURADOR = '230000000000000002';
const JUIZ = '230000000000000003';
const PROMOTOR = '230000000000000004';
const ADVOGADO = '230000000000000005';
const NINGUEM = '230000000000000006';
const ALVO = '230000000000000009';
rh.contratar(DESEMBARGADOR, 'Desembargador', 'Des. Fulano', 'DES11111');
rh.contratar(PROCURADOR, 'Procurador', 'Proc. Beltrana', 'PRO22222');
rh.contratar(JUIZ, 'Juiz', 'Juiz', 'JUI33333');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor', 'PRM44444');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado');

// Sem Administrator, sem role de staff, sem role de superstaff — o poder tem que vir SÓ do RH.
const semRoles = (userId) => ({
  user: { id: userId },
  member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
});
// Staff de verdade: tem Administrator no Discord e nenhum cargo no RH.
const staffDiscord = (userId) => ({
  user: { id: userId },
  member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
});

console.log('\n=== Poder administrativo: Desembargador e Procurador ===\n');

// ---------------------------------------------------------------------------
console.log('1) A FUNÇÃO ÚNICA — e ela lê o RH, não a role do Discord');
// ---------------------------------------------------------------------------
{
  ok(typeof permissoes.podeAdministrar === 'function', '1a: `podeAdministrar` existe e é exportada');
  ok(JSON.stringify(permissoes.CARGOS_ADMINISTRATIVOS) === '["Desembargador","Procurador"]',
    '1b: e a lista de cargos é o único lugar que decide isso',
    JSON.stringify(permissoes.CARGOS_ADMINISTRATIVOS));

  ok(permissoes.podeAdministrar(semRoles(DESEMBARGADOR)), '1c: DESEMBARGADOR pode — só pelo cargo no RH');
  ok(permissoes.podeAdministrar(semRoles(PROCURADOR)), '1d: PROCURADOR pode — idem');
  ok(permissoes.podeAdministrar(staffDiscord('999')), '1e: e a staff do Discord continua podendo');

  ok(!permissoes.podeAdministrar(semRoles(JUIZ)), '1f: JUIZ não pode');
  ok(!permissoes.podeAdministrar(semRoles(PROMOTOR)), '1g: PROMOTOR não pode');
  ok(!permissoes.podeAdministrar(semRoles(ADVOGADO)), '1h: ADVOGADO não pode');
  ok(!permissoes.podeAdministrar(semRoles(NINGUEM)), '1i: quem não tem cargo, não pode');
  ok(!permissoes.podeAdministrar(null), '1j: e interação inválida não vira permissão');

  // A PROVA DE QUE É RH, e não role: a fonte é `rh.temCargo`, que não conhece discord.js.
  const src = LER('utils', 'permissoes.js');
  const corpo = src.slice(src.indexOf('function podeAdministrar'), src.indexOf('const RECUSA_ADMINISTRATIVA'));
  ok(corpo.length > 100, '1z: o corpo de podeAdministrar foi localizado', `${corpo.length} chars`);
  ok(/rh\.temCargo\(interaction\.user\.id, cargo\)/.test(corpo),
    '1k: decide por `rh.temCargo` — o cargo ATIVO no RH');
  ok(!/roles\.cache|member\.permissions/.test(corpo),
    '1l: e NÃO lê role do Discord para os cargos novos (isAdmin/isSuperStaff cuidam da staff)');
}

// ---------------------------------------------------------------------------
console.log('\n2) O CENÁRIO PEDIDO — Desembargador contrata, e ex-Desembargador não');
// ---------------------------------------------------------------------------
async function secao2() {
  const rhCmd = require('../commands/rh');
  const registrados = [];
  const guild = {
    id: 'guild1',
    members: { fetch: async (id) => ({ id, roles: { add: async () => {}, remove: async () => {} }, setNickname: async () => {} }) },
    channels: { fetch: async () => null },
  };
  const interacao = (userId, motivo) => ({
    ...semRoles(userId), guild,
    fields: { getTextInputValue: (c) => (c === 'motivo' ? motivo : '') },
    reply: async (p) => { registrados.push({ tipo: 'reply', ...p }); return p; },
    deferReply: async () => { registrados.push({ tipo: 'defer' }); },
    editReply: async (p) => { registrados.push({ tipo: 'edit', ...p }); return p; },
    followUp: async (p) => { registrados.push({ tipo: 'followUp', ...p }); return p; },
  });

  // (a) DESEMBARGADOR EXECUTA CONTRATAR -> PERMITIDO E LOGADO
  registrados.length = 0;
  await rhCmd.contratarViaModal(interacao(DESEMBARGADOR, 'Aprovado no seletivo 001/2026.'), ALVO, 'Juiz');
  const alvoReg = rh.getCargo(ALVO);
  ok(!!alvoReg && alvoReg.cargo === 'Juiz', '2a: o Desembargador CONTRATOU — o cargo foi criado',
    alvoReg ? alvoReg.cargo : 'sem registro');
  ok(!registrados.some(r => (r.content || '').includes('Só Staff')), '2b: e não recebeu recusa');

  const log = logRh.consultar({ acao: 'contratar', alvoId: ALVO });
  ok(log.length === 1, '2c: a contratação foi LOGADA', `${log.length} linha(s)`);
  const l = log[0] || {};
  ok(l.executorId === DESEMBARGADOR, '2d: com quem executou');
  ok(l.cargoExecutor === 'Desembargador', '2e: com o CARGO de quem executou', l.cargoExecutor);
  ok(l.alvoId === ALVO, '2f: com o alvo');
  ok(l.cargoAlvo === 'Juiz', '2g: com o cargo dado');
  ok(l.acao === 'contratar', '2h: com a ação');
  ok(l.motivo === 'Aprovado no seletivo 001/2026.', '2i: com o MOTIVO', l.motivo);
  ok(!!l.criadoEm && !Number.isNaN(new Date(l.criadoEm).getTime()), '2j: e com data/hora', l.criadoEm);

  // (b) EX-DESEMBARGADOR (cargo removido no RH) EXECUTA CONTRATAR -> RECUSADO
  rh.demitir(DESEMBARGADOR);
  ok(!rh.temCargo(DESEMBARGADOR, 'Desembargador'), '2z: o cargo foi removido do RH (cenário montado)');
  ok(!permissoes.podeAdministrar(semRoles(DESEMBARGADOR)),
    '2k: o EX-Desembargador perde o poder NO MESMO INSTANTE — sem mexer em role do Discord');

  const outro = '230000000000000010';
  registrados.length = 0;
  const antes = logRh.consultar({ acao: 'contratar' }).length;
  await rhCmd.contratarViaModal(interacao(DESEMBARGADOR, 'tentativa'), outro, 'Juiz');
  ok(!rh.getCargo(outro), '2l: a contratação NÃO aconteceu');
  ok(registrados.some(r => /Desembargador ou Procurador/.test(r.content || '')),
    '2m: e ele recebe a recusa explicando de onde vem o poder');
  ok(logRh.consultar({ acao: 'contratar' }).length === antes, '2n: nada foi logado — o ato não existiu');
}

// ---------------------------------------------------------------------------
console.log('\n3) OS PONTOS que passaram a usar a função única');
// ---------------------------------------------------------------------------
{
  const painel = LER('commands', 'painel.js');
  const rhSrc = LER('commands', 'rh.js');
  ok(painel.length > 10000 && rhSrc.length > 5000, '3z: as fontes foram lidas (scan não vazio)');

  const noPainel = (painel.match(/podeAdministrar\(interaction\)/g) || []).length;
  ok(noPainel >= 8, '3a: painel.js decide por `podeAdministrar` em todos os pontos', `${noPainel} ponto(s)`);
  const noRh = (rhSrc.match(/podeAdministrar\(interaction\)/g) || []).length;
  ok(noRh >= 4, '3b: e rh.js também', `${noRh} ponto(s)`);

  // O QUE NÃO PODE SOBRAR: a condicional antiga, que deixaria um ponto fora da abertura.
  const painelCodigo = painel.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const rhCodigo = rhSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/isAdmin\(interaction\) \|\| isSuperStaff\(interaction\)/.test(painelCodigo),
    '3c: nenhum `isAdmin || isSuperStaff` sobrou em painel.js');
  ok(!/!isAdmin\(interaction\) && !isSuperStaff\(interaction\)/.test(painelCodigo),
    '3d: nem a forma negada');
  ok(!/isAdmin\(interaction\) \|\| isSuperStaff\(interaction\)/.test(rhCodigo),
    '3e: nem em rh.js');

  // A recusa é uma string só — 15 pontos não podem ter 15 textos para a mesma regra.
  ok(/RECUSA_ADMINISTRATIVA/.test(painelCodigo) && /RECUSA_ADMINISTRATIVA/.test(rhCodigo),
    '3f: e a mensagem de recusa vem de um lugar só');
  ok(/O poder vem do cargo ATIVO no/.test(LER('utils', 'permissoes.js')),
    '3g: dizendo de onde vem o poder, para quem for recusado entender');
}

// ---------------------------------------------------------------------------
console.log('\n4) BOTÃO NÃO É TRAVA — o Discord não esconde botão por cargo');
// ---------------------------------------------------------------------------
{
  const painel = LER('commands', 'painel.js');
  // O gate do submenu roda no CLIQUE, não na montagem: quem chegar por customId antigo/replay
  // esbarra nele igual.
  ok(/if \(modulo === 'staff' && !podeAdministrar\(interaction\)\)/.test(painel),
    '4a: abrir o menu de Administração é checado no clique');
  ok(/if \(modulo === 'rh' && !podeAdministrar\(interaction\)\)/.test(painel),
    '4b: e o de RH também');
  // `\r?\n`, nunca `\n` literal: o repo roda em Windows e o git normaliza para CRLF quando toca o
  // arquivo. Esta asserção passou verde antes do commit e reprovou DEPOIS, no hook de pre-push —
  // terceira vez que o mesmo detalhe morde neste projeto.
  ok(/if \(modulo === 'rh'\) \{\r?\n\s*if \(!podeAdministrar\(interaction\)\)/.test(painel),
    '4c: e cada AÇÃO de RH revalida antes de executar — não confia no menu que a mostrou');
  // O executor final revalida de novo (defesa em profundidade).
  const rhSrc = LER('commands', 'rh.js');
  const corpo = rhSrc.slice(rhSrc.indexOf('async function contratarViaModal'), rhSrc.indexOf('async function contratarViaModal') + 900);
  ok(/podeAdministrar\(interaction\)/.test(corpo),
    '4d: e `contratarViaModal` — o último ponto antes de mexer no cargo — revalida também');
}

// ---------------------------------------------------------------------------
console.log('\n5) O LOG é consultável, e as três ações exigem motivo');
// ---------------------------------------------------------------------------
function secao5() {
  ok(JSON.stringify(logRh.ACOES) === '["contratar","demitir","licenca"]',
    '5a: as três ações são as declaradas', JSON.stringify(logRh.ACOES));

  logRh.registrar({ acao: 'demitir', executorId: PROCURADOR, cargoExecutor: 'Procurador', alvoId: ALVO, cargoAlvo: 'Juiz', motivo: 'Inatividade.' });
  logRh.registrar({ acao: 'licenca', executorId: PROCURADOR, cargoExecutor: 'Procurador', alvoId: ALVO, motivo: 'Afastamento — viagem.' });
  ok(logRh.consultar({ limite: 50 }).length >= 3, '5b: as linhas são consultáveis');
  ok(logRh.consultar({ acao: 'demitir' }).length === 1, '5c: filtrando por ação');
  ok(logRh.consultar({ executorId: PROCURADOR }).length === 2, '5d: por executor');
  ok(logRh.consultar({ alvoId: ALVO, limite: 50 }).length >= 3, '5e: e por alvo');

  // Ordem: mais recente primeiro — quem audita quer o que acabou de acontecer.
  const todas = logRh.consultar({ limite: 50 });
  const ordenado = todas.every((r, i) => i === 0 || new Date(todas[i - 1].criadoEm) >= new Date(r.criadoEm));
  ok(ordenado, '5f: mais recentes primeiro');

  const texto = logRh.formatar(todas[0]);
  ok(/Motivo:/.test(texto) && /<@/.test(texto) && /<t:\d+:f>/.test(texto),
    '5g: e a linha formatada traz alvo, executor, motivo e data', texto.slice(0, 60));

  // Motivo em branco NUNCA vira motivo vazio silencioso — o log não pode mentir.
  // O retorno virou { ok, registro, erro, aviso } em 21/08/2026 — ver scripts/testes-falha-silenciosa.js.
  const semMotivo = logRh.registrar({ acao: 'demitir', executorId: 'x', cargoExecutor: 'Staff/Administração', alvoId: 'y', motivo: '   ' });
  ok(semMotivo && semMotivo.ok && semMotivo.registro && semMotivo.registro.motivo === '(sem motivo informado)',
    '5h: motivo em branco vira marcador explícito, não string vazia', semMotivo && semMotivo.registro && semMotivo.registro.motivo);

  // OBRIGATÓRIO na porta de entrada: slash e modal.
  const rhSrc = LER('commands', 'rh.js');
  const opts = rhSrc.slice(rhSrc.indexOf(".setName('rh')"));
  ok((opts.match(/setName\('motivo'\)[\s\S]{0,80}setRequired\(true\)/g) || []).length === 3,
    '5i: os TRÊS subcomandos exigem motivo',
    String((opts.match(/setName\('motivo'\)[\s\S]{0,80}setRequired\(true\)/g) || []).length));
  ok(/setCustomId\('motivo'\)[\s\S]{0,160}setRequired\(true\)/.test(rhSrc),
    '5j: e o modal do painel também');

  // O botão de consulta existe e está no painel de Administração.
  const painel = LER('commands', 'painel.js');
  ok(/painel:acao:rh:log/.test(painel), '5k: há botão "Log de RH" no painel');
  ok(/logRh\.consultar\(/.test(painel), '5l: que consulta o arquivo de verdade');
  ok(/logRh\.formatar/.test(painel), '5m: e formata as linhas');
}

(async () => {
  await secao2();
  secao5();

  // FECHA O CHROMIUM antes de sair. Este arquivo não renderiza nada de propósito — ele testa
  // PERMISSÃO —, mas `contratarViaModal` chama `contratarComRole`, que emite a carteirinha, que
  // lança o Puppeteer. O PNG é subproduto e ninguém o olha aqui; o custo, não: o Node não encerra
  // enquanto o ChildProcess do Chromium e os sockets estiverem vivos, e o processo ficava preso
  // até o desligamento por ociosidade (5 min). Medido: 301s, dos quais ~2s eram trabalho.
  await require('../services/gerarDocumentoPNG').fecharBrowser();

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
