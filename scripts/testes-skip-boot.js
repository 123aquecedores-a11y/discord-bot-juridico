/* eslint-disable */
// Testes do MODO MANUTENÇÃO (SKIP_BOOT_TASKS) — ver utils/modoManutencao.js.
// Rode com:  node scripts/testes-skip-boot.js
//
// O que precisa ser provado, e como:
//   - com a flag ligada, NENHUMA tarefa automática do boot roda (garantirCanais, retroatividade,
//     varredura de fantasma, varredura do Diário, as 13 checagens de prazo, painel fixo) e NENHUM
//     setInterval é agendado;
//   - o teste consegue MESMO detectar execução — o mesmo cenário sem a flag tem que ver tudo rodar
//     (senão "nada rodou" não valeria nada);
//   - fail-safe: "0", "true", "sim" e afins mantêm o comportamento NORMAL; só "1" liga;
//   - a flag não desliga o atendimento a interações (os listeners continuam de pé).
//
// Como: carrega o index.js DE VERDADE num processo filho, com a classe Client do discord.js
// trocada por uma falsa (nada de rede) e com os módulos de tarefa trocados por contadores. Aí
// dispara o evento 'ready' na mão e olha os contadores. Um cenário por processo, porque o require
// cache do Node não desfaz — e é justamente isso que deixa cada cenário hermético.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const GUILD = '111111111111111111';

// ===================== FILHO: roda UM cenário e devolve os contadores =====================
if (process.env.MODO_FILHO === '1') {
  const DB_TESTE = path.join(os.tmpdir(), `dados-teste-skipboot-${process.pid}.json`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.env.DADOS_JSON_PATH = DB_TESTE;
  process.env.RESETAR_BANCO = '';
  process.env.GUILD_ID = GUILD;
  process.env.DISCORD_TOKEN = 'token-falso-de-teste';
  process.env.SIMULAR = '';
  process.env.SIMULAR_DEMO = '';

  const chamadas = {};
  const contar = (nome) => { chamadas[nome] = (chamadas[nome] || 0) + 1; return Promise.resolve(); };

  // ---- 1) Troca as tarefas por contadores ANTES do index.js requerer qualquer uma delas.
  // O index faz destructuring de utils/prazos no topo, então a substituição tem que vir antes do
  // require dele — o destructuring copia a referência que estiver valendo naquele instante.
  const prazos = require('../utils/prazos');
  const FUNCOES_PRAZO = [
    'verificarPrazosJulgamento', 'verificarRenovacoesPorteArma', 'verificarProcessosSemJuiz',
    'verificarProcessosPenaisSemJuiz', 'verificarDiligenciasPendentes', 'verificarPeticoesSemJuiz',
    'verificarMedidasAguardandoMP', 'verificarMedidasAguardandoJuiz', 'verificarMandadosPendentes',
    'verificarApelacoesPendentes', 'verificarPrazosContestacao', 'verificarPrazoHabilitacao',
    'verificarPrazoDefesa',
  ];
  for (const f of FUNCOES_PRAZO) prazos[f] = () => contar(f); // DIA_MS fica intacto (é número, o index usa)

  require('../utils/garantirCanais').garantirCanais = () => contar('garantirCanais');
  require('../utils/retroatividade').aplicarRetroatividade = () => contar('aplicarRetroatividade');
  require('../utils/responsaveis').varrerResponsaveisFantasma = () => contar('varrerResponsaveisFantasma');
  require('../utils/diarioAtos').varrerDiario = () => contar('varrerDiario');
  require('../commands/painel').postarPainelFixo = () => contar('postarPainelFixo');
  require('../utils/auditoria').avisarBackupAtrasado = () => contar('avisarBackupAtrasado');
  require('../utils/reconciliacaoRoles').reconciliarTodos = () => contar('reconciliarTodos');

  // ---- 2) Client falso: o bot "conecta" sem rede nenhuma. Só a classe Client é trocada; o resto
  // do discord.js (builders, enums) continua real, senão os comandos nem carregariam.
  const { EventEmitter } = require('events');
  const dj = require('discord.js');
  const guildFake = {
    id: GUILD, name: 'servidor-de-teste',
    roles: { everyone: 'everyone_role' },
    channels: { create: async () => ({ id: 'c1' }), fetch: async () => null },
    members: { me: { id: 'bot1' }, fetch: async (id) => ({ id }) },
  };
  let clientCriado = null;
  class ClientFalso extends EventEmitter {
    constructor() {
      super();
      this.user = { tag: 'bot-de-teste#0001', id: 'bot1' };
      this.guilds = { fetch: async () => guildFake };
      clientCriado = this;
    }
    async login() { return 'ok'; }
  }
  dj.Client = ClientFalso;

  // ---- 3) Conta setInterval SEM agendar de verdade (agendar deixaria o processo pendurado).
  const setIntervalReal = global.setInterval;
  let intervalos = 0;
  global.setInterval = (...args) => { intervalos++; return { unref() {} }; };

  // ---- 4) Carrega o bot de verdade e dispara o 'ready'.
  const logs = [];
  const warnReal = console.warn;
  console.warn = (...a) => { logs.push(a.join(' ')); warnReal(...a); };

  require('../index.js');

  (async () => {
    clientCriado.emit('ready');
    // O handler do ready é async: dá um tempo pra ele terminar (os stubs resolvem na hora).
    await new Promise(r => setIntervalReal(() => r(), 400));
    global.setInterval = setIntervalReal;
    console.warn = warnReal;

    process.stdout.write('\nRESULTADO:' + JSON.stringify({
      chamadas,
      intervalos,
      manutencao: logs.some(l => l.includes('[manutencao]')),
      listeners: {
        interactionCreate: clientCriado.listenerCount('interactionCreate'),
        guildMemberAdd: clientCriado.listenerCount('guildMemberAdd'),
        guildMemberRemove: clientCriado.listenerCount('guildMemberRemove'),
        messageCreate: clientCriado.listenerCount('messageCreate'),
      },
    }) + '\n');
    try { fs.unlinkSync(DB_TESTE); } catch (_) {}
    process.exit(0);
  })();
  return;
}

// ===================== PAI: roda os cenários e confere =====================
let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function rodarCenario(valorFlag) {
  const env = { ...process.env, MODO_FILHO: '1' };
  if (valorFlag === undefined) delete env.SKIP_BOOT_TASKS;
  else env.SKIP_BOOT_TASKS = valorFlag;
  const r = spawnSync(process.execPath, [__filename], { env, encoding: 'utf-8', timeout: 120000 });
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  const m = saida.match(/RESULTADO:(\{.*\})/);
  if (!m) throw new Error(`cenário SKIP_BOOT_TASKS=${JSON.stringify(valorFlag)} não devolveu resultado.\n${saida.slice(-2000)}`);
  return JSON.parse(m[1]);
}

const TAREFAS_ESPERADAS = [
  'garantirCanais', 'aplicarRetroatividade', 'varrerResponsaveisFantasma', 'varrerDiario',
  'verificarPrazosJulgamento', 'verificarRenovacoesPorteArma', 'verificarProcessosSemJuiz',
  'verificarProcessosPenaisSemJuiz', 'verificarPeticoesSemJuiz', 'verificarDiligenciasPendentes',
  'verificarMedidasAguardandoMP', 'verificarMedidasAguardandoJuiz', 'verificarMandadosPendentes',
  'verificarApelacoesPendentes', 'verificarPrazosContestacao', 'verificarPrazoHabilitacao',
  'verificarPrazoDefesa', 'postarPainelFixo', 'avisarBackupAtrasado', 'reconciliarTodos',
];

console.log('\n== Modo manutenção (SKIP_BOOT_TASKS) ==');

// ---- 1) Controle: SEM a flag, tudo roda. Se este cenário falhar, o teste da flag não prova nada.
console.log('\n1) Controle — sem a flag, o boot roda tudo (prova que o teste enxerga execução):');
const normal = rodarCenario(undefined);
{
  const naoRodaram = TAREFAS_ESPERADAS.filter(t => !normal.chamadas[t]);
  ok(naoRodaram.length === 0, '1a: todas as tarefas de boot rodaram', naoRodaram.length ? `não rodaram: ${naoRodaram.join(', ')}` : '');
  ok(normal.intervalos === 2, '1b: os 2 setInterval (diário e 10 min) foram agendados', `intervalos=${normal.intervalos}`);
  ok(normal.manutencao === false, '1c: nenhum aviso de manutenção no log');
}

// ---- 2) O que importa: com a flag, NADA roda.
console.log('\n2) SKIP_BOOT_TASKS=1 — nada automático roda:');
const comFlag = rodarCenario('1');
{
  const rodaram = Object.keys(comFlag.chamadas);
  ok(rodaram.length === 0, '2a: NENHUMA tarefa de boot foi chamada', rodaram.length ? `rodaram: ${rodaram.join(', ')}` : '');
  ok(comFlag.intervalos === 0, '2b: NENHUM setInterval agendado — nada volta a rodar sozinho depois', `intervalos=${comFlag.intervalos}`);
  ok(comFlag.manutencao === true, '2c: o log avisa que está em modo manutenção (não some em silêncio)');
  for (const t of ['garantirCanais', 'aplicarRetroatividade', 'varrerDiario', 'varrerResponsaveisFantasma', 'verificarDiligenciasPendentes', 'verificarPrazoDefesa', 'postarPainelFixo']) {
    ok(!comFlag.chamadas[t], `2d-${t}: não rodou`);
  }
  ok(comFlag.listeners.interactionCreate === 1, '2e: interações CONTINUAM sendo atendidas (listener de pé)');
  ok(comFlag.listeners.guildMemberAdd === 1 && comFlag.listeners.guildMemberRemove === 1 && comFlag.listeners.messageCreate === 1,
    '2f: os listeners de evento seguem registrados — a flag só corta o automático do boot');
}

// ---- 3) Fail-safe: só "1" liga. Qualquer outro valor mantém o normal.
console.log('\n3) Fail-safe — só o valor exato "1" liga o modo:');
for (const valor of ['0', 'true', 'sim', 'yes', '', 'SKIP', '11', '2']) {
  const r = rodarCenario(valor);
  const rodouTudo = TAREFAS_ESPERADAS.every(t => r.chamadas[t]);
  ok(rodouTudo && r.intervalos === 2 && r.manutencao === false,
    `3-${JSON.stringify(valor)}: mantém o comportamento NORMAL`, rodouTudo ? '' : 'alguma tarefa não rodou');
}
{
  const comEspacos = rodarCenario('  1  ');
  ok(Object.keys(comEspacos.chamadas).length === 0 && comEspacos.manutencao === true,
    '3-"  1  ": espaço em volta do 1 ainda liga (colar valor no painel não fura a trava)');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`));
process.exit(falhas.length ? 1 : 0);
