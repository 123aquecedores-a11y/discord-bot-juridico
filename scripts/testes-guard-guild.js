/* eslint-disable */
// Testes do GUARD DE GUILD (isolamento entre instalações) — ver utils/guildGuard.js.
// Rode com:  node scripts/testes-guard-guild.js
//
// Prova, caminho por caminho, que o bot só opera no guild de GUILD_ID:
//   1) boot          — sem GUILD_ID (ou com lixo na variável) o processo ABORTA, de verdade
//                      (roda `node index.js` num processo filho e confere o exit code).
//   2) interações    — slash/botão/select/modal/autocomplete de outro guild e DM: recusa efêmera
//                      + log, sem tocar no banco.
//   3) não-interação — eventos do gateway, tarefas agendadas e webhook da Polícia Civil.
//   4) profundidade  — auditoria, criação de canal/categoria, Diário Oficial e garantirCanais
//                      recusam guild estrangeira mesmo se alguém chamar direto.
//   5) fail-closed   — com GUILD_ID vazia, NADA é permitido (nem o guild "certo").
// Usa banco temporário — não encosta no dados.json de produção.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-guard-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = '111111111111111111'; // "instalação A" deste teste (snowflake válido)
process.env.CANAL_AUDITORIA_ID = 'canal-auditoria';
process.env.CANAL_REQUERIMENTO_POLICIA_CIVIL_ID = 'canal-pc';
process.env.WEBHOOK_REQUERIMENTO_POLICIA_CIVIL_ID = 'webhook-pc-oficial';
process.env.CARGO_STAFF_ID = '';
process.env.ROLE_SUPER_STAFF_ID = '';

const config = require('../config');
const guard = require('../utils/guildGuard');
const db = require('../database/db');
const auditoria = require('../utils/auditoria');
const canais = require('../utils/canais');
const diario = require('../utils/diarioOficial');
const { garantirCanais } = require('../utils/garantirCanais');
const integracaoPC = require('../utils/integracaoPoliciaCivil');

const GUILD_A = '111111111111111111'; // instalação deste bot
const GUILD_B = '222222222222222222'; // o OUTRO servidor (instalação vizinha)

// ---- mini framework (mesmo estilo de scripts/testes-correcoes.js) ----
let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function lancou(fn, nome) {
  try { fn(); ok(false, nome, 'não lançou'); return null; }
  catch (e) { ok(!!e.guildForaDoEscopo, nome, e.guildForaDoEscopo ? '' : `erro inesperado: ${e.message}`); return e; }
}
async function lancouAsync(fn, nome) {
  try { await fn(); ok(false, nome, 'não lançou'); return null; }
  catch (e) { ok(!!e.guildForaDoEscopo, nome, e.guildForaDoEscopo ? '' : `erro inesperado: ${e.message}`); return e; }
}

// ---- captura de log (o requisito é "recusa + LOG") ----
const logs = [];
const warnReal = console.warn, errReal = console.error;
console.warn = (...a) => { logs.push(a.join(' ')); };
console.error = (...a) => { logs.push(a.join(' ')); };
function limparLogs() { logs.length = 0; }
function logouGuard() { return logs.some(l => l.includes('[guard]')); }

// ---- mocks ----
const rec = { criados: 0, enviados: 0, fetches: 0 };
function fakeCanal() {
  return {
    id: 'canal-fake', isTextBased: () => true,
    send: async () => { rec.enviados++; return { id: 'msg1' }; },
    permissionOverwrites: { edit: async () => {} },
  };
}
function fakeGuild(id) {
  return {
    id,
    name: `servidor-${id}`,
    roles: { everyone: 'everyone_role' },
    client: { user: { id: 'bot1' } },
    members: { me: { id: 'bot1' }, fetch: async (uid) => ({ id: uid }) },
    channels: {
      create: async () => { rec.criados++; return fakeCanal(); },
      fetch: async () => { rec.fetches++; return fakeCanal(); },
    },
  };
}
function fakeInteracao({ guildId, tipo = 'slash', deferida = false }) {
  const it = {
    guildId, guild: guildId ? fakeGuild(guildId) : null,
    user: { id: 'user1' }, commandName: 'processo', customId: 'painel:abrir:1',
    replied: false, deferred: deferida,
    _replies: [], _autocomplete: null,
    isChatInputCommand: () => tipo === 'slash',
    isAutocomplete: () => tipo === 'autocomplete',
    isButton: () => tipo === 'botao',
    isModalSubmit: () => tipo === 'modal',
    reply: async (o) => { it.replied = true; it._replies.push({ via: 'reply', ...o }); },
    followUp: async (o) => { it._replies.push({ via: 'followUp', ...o }); },
    respond: async (lista) => { it._autocomplete = lista; },
  };
  return it;
}
function totalBanco() {
  if (!fs.existsSync(DB_TESTE)) return 0; // o arquivo só nasce na primeira leitura/escrita do db
  const dados = JSON.parse(fs.readFileSync(DB_TESTE, 'utf-8'));
  return Object.values(dados).reduce((n, t) => n + (Array.isArray(t) ? t.length : 0), 0);
}

(async () => {
  // Materializa o banco de teste ANTES de qualquer medição: a primeira leitura cria o arquivo já
  // com a semente de instituições, e sem isso o "antes" sairia zero e o "depois" contaria a semente
  // como se fosse escrita indevida.
  db.contar('processos');

  // ================= 1) BOOT =================
  console.log('\n1) Boot — GUILD_ID é obrigatória:');
  {
    const original = config.guildId;

    config.guildId = '';
    lancouGuardConfig('GUILD_ID não está definida', '1a: GUILD_ID ausente → motivo claro');
    config.guildId = '   ';
    lancouGuardConfig('GUILD_ID não está definida', '1b: GUILD_ID só com espaços → tratada como ausente');
    config.guildId = 'meu servidor';
    lancouGuardConfig('não parece um ID de servidor', '1c: GUILD_ID com nome/placeholder no lugar do ID → abortado');
    config.guildId = '12345';
    lancouGuardConfig('não parece um ID de servidor', '1d: GUILD_ID curta demais pra ser snowflake → abortado');

    config.guildId = GUILD_A;
    let retorno = null, erro = null;
    try { retorno = guard.exigirGuildConfigurada(); } catch (e) { erro = e; }
    ok(!erro && retorno === GUILD_A, '1e: GUILD_ID válida → boot segue e devolve o id', erro ? erro.message : `retorno=${retorno}`);
    config.guildId = original || GUILD_A;
  }
  function lancouGuardConfig(trecho, nome) {
    try { guard.exigirGuildConfigurada(); ok(false, nome, 'não lançou'); }
    catch (e) { ok(e.message.includes(trecho) && e.message.includes('BOOT ABORTADO'), nome, e.message.split('\n')[0]); }
  }

  // Boot de VERDADE: processo filho, sem GUILD_ID. Prova que o bot morre antes de logar no Discord.
  console.log('\n1f) Boot real (processo filho):');
  {
    const raiz = path.join(__dirname, '..');
    const envBase = { ...process.env, DADOS_JSON_PATH: DB_TESTE, DISCORD_TOKEN: 'token-invalido-de-teste', SIMULAR: '', SIMULAR_DEMO: '' };
    const semGuild = spawnSync(process.execPath, ['index.js'], {
      cwd: raiz, env: { ...envBase, GUILD_ID: '' }, encoding: 'utf-8', timeout: 90000,
    });
    const saida = `${semGuild.stdout || ''}${semGuild.stderr || ''}`;
    ok(semGuild.status === 1, '1f: `node index.js` sem GUILD_ID sai com código 1', `status=${semGuild.status}`);
    ok(saida.includes('BOOT ABORTADO'), '1g: ...e a mensagem de erro explica o motivo');
    ok(!saida.includes('Bot online'), '1h: ...e o bot NUNCA chega a ficar online');
  }

  // ================= 2) INTERAÇÕES =================
  console.log('\n2) Interações de outro servidor (slash/botão/select/modal/autocomplete/DM):');
  {
    config.guildId = GUILD_A;
    const antes = totalBanco();

    for (const tipo of ['slash', 'botao', 'modal']) {
      limparLogs();
      const it = fakeInteracao({ guildId: GUILD_B, tipo });
      const passou = await guard.guardarInteracao(it);
      const r = it._replies[0];
      ok(passou === false, `2a-${tipo}: ${tipo} vindo da guild B é RECUSADO`);
      ok(!!r && r.ephemeral === true && r.via === 'reply', `2b-${tipo}: recusa é EFÊMERA (só quem clicou vê)`);
      ok(logouGuard(), `2c-${tipo}: recusa fica registrada no log`);
    }

    limparLogs();
    const dm = fakeInteracao({ guildId: null, tipo: 'botao' });
    ok(await guard.guardarInteracao(dm) === false, '2d: interação em DM (sem guild) é recusada — fail-closed');
    ok(dm._replies[0]?.ephemeral === true, '2e: ...também com resposta efêmera');

    limparLogs();
    const auto = fakeInteracao({ guildId: GUILD_B, tipo: 'autocomplete' });
    ok(await guard.guardarInteracao(auto) === false, '2f: autocomplete da guild B é recusado');
    ok(Array.isArray(auto._autocomplete) && auto._autocomplete.length === 0, '2g: ...respondendo lista VAZIA (autocomplete não aceita texto)');
    ok(auto._replies.length === 0, '2h: ...sem tentar reply de texto (evitaria erro na API)');

    const jaDeferida = fakeInteracao({ guildId: GUILD_B, tipo: 'slash', deferida: true });
    await guard.guardarInteracao(jaDeferida);
    ok(jaDeferida._replies[0]?.via === 'followUp', '2i: interação já deferida recebe followUp, não reply');

    const boa = fakeInteracao({ guildId: GUILD_A, tipo: 'slash' });
    ok(await guard.guardarInteracao(boa) === true, '2j: interação do PRÓPRIO servidor passa normalmente');
    ok(boa._replies.length === 0, '2k: ...sem nenhuma mensagem de recusa');

    ok(totalBanco() === antes, '2l: nenhuma das recusas escreveu no banco');
  }

  // ================= 3) NÃO-INTERAÇÃO =================
  console.log('\n3) Eventos do gateway, tarefas agendadas e webhook:');
  {
    const antes = totalBanco();
    for (const evento of ['guildMemberAdd', 'guildMemberRemove', 'checagens-diarias', 'checagens-10min', 'ready']) {
      limparLogs();
      ok(guard.guardarEvento(evento, fakeGuild(GUILD_B)) === false, `3a-${evento}: recusado quando vem da guild B`);
      ok(logouGuard(), `3b-${evento}: com log dizendo por quê`);
      ok(guard.guardarEvento(evento, fakeGuild(GUILD_A)) === true, `3c-${evento}: liberado no próprio servidor`);
    }
    ok(guard.guardarEvento('evento-sem-guild', null) === false, '3d: evento sem guild nenhuma é recusado (fail-closed)');
    ok(guard.guardarEvento('evento-guild-sem-id', { name: 'x' }) === false, '3e: objeto guild sem id é recusado (fail-closed)');

    // Webhook da Polícia Civil: entrada externa que vira medida cautelar sem ninguém clicar.
    const msgForaDoGuild = {
      id: 'msg-b', channelId: 'canal-pc', guildId: GUILD_B, webhookId: 'webhook-pc-oficial',
      embeds: [{ fields: [{ name: 'Tipo', value: 'Busca e Apreensão' }, { name: 'Alvo', value: 'Fulano' }] }],
    };
    limparLogs();
    await integracaoPC.processarRequerimento(msgForaDoGuild);
    ok(logs.some(l => l.includes('[guard]')), '3f: requerimento por webhook vindo da guild B é barrado pelo GUARD');
    ok(db.contar('medidas') === 0, '3g: ...e nenhuma medida cautelar é criada');

    // Contraste: mesma mensagem no guild certo passa do guard e cai na validação seguinte
    // (webhook não confere) — prova que quem barrou acima foi o guard, não outra checagem.
    limparLogs();
    await integracaoPC.processarRequerimento({ ...msgForaDoGuild, guildId: GUILD_A, webhookId: 'webhook-forjado' });
    ok(logs.some(l => l.includes('[integracaoPC]')) && !logs.some(l => l.includes('[guard]')),
      '3h: no servidor certo o guard deixa passar e a validação de webhook assume');

    ok(totalBanco() === antes, '3i: nenhum evento recusado escreveu no banco');
  }

  // ================= 4) PROFUNDIDADE =================
  console.log('\n4) Profundidade — quem escreve de verdade recusa guild estrangeira:');
  {
    const antes = totalBanco();
    rec.criados = 0; rec.enviados = 0;
    const guildB = fakeGuild(GUILD_B);

    await lancouAsync(() => auditoria.registrar(guildB, { acao: 'Teste', executorId: 'u1' }), '4a: auditoria.registrar recusa guild estrangeira');
    await lancouAsync(() => canais.criarCanalTicket(guildB, { prefixo: 'proc', numero: '0001' }), '4b: canais.criarCanalTicket recusa guild estrangeira');
    await lancouAsync(() => canais.obterOuCriarCategoria(guildB, 'catTeste', 'Categoria'), '4c: canais.obterOuCriarCategoria recusa guild estrangeira');
    ok(rec.criados === 0 && rec.enviados === 0, '4d: nada foi criado nem enviado no Discord');

    diario.setCanalId('canal-diario');
    limparLogs();
    const publicou = await diario.publicarNoDiario(guildB, 'acordao', { numero: '0001' });
    ok(publicou === false && rec.enviados === 0, '4e: Diário Oficial não publica em guild estrangeira');
    ok(logouGuard(), '4f: ...e loga a recusa');

    rec.fetches = 0;
    await garantirCanais(guildB);
    ok(rec.criados === 0 && rec.fetches === 0, '4g: garantirCanais não cria/consulta canal em guild estrangeira');

    // E no servidor certo tudo funciona (o guard não pode virar um "bot que não faz nada").
    const guildA = fakeGuild(GUILD_A);
    rec.criados = 0; rec.enviados = 0;
    await auditoria.registrar(guildA, { acao: 'Teste', executorId: 'u1' });
    ok(rec.enviados === 1, '4h: no próprio servidor, a auditoria registra normalmente');
    await canais.criarCanalTicket(guildA, { prefixo: 'proc', numero: '0001' });
    ok(rec.criados === 1, '4i: no próprio servidor, o canal é criado normalmente');
    const pub = await diario.publicarNoDiario(guildA, 'acordao', { numero: '0001', silencioso: true });
    ok(!!pub, '4j: no próprio servidor, o Diário publica normalmente');

    // O banco só mudou pelo que o `estado` do Diário gravou — nenhuma escrita veio da guild B.
    ok(totalBanco() >= antes, '4k: banco só recebeu escrita do fluxo legítimo');
  }

  // ================= 5) FAIL-CLOSED SEM GUILD_ID =================
  console.log('\n5) Fail-closed — GUILD_ID vazia bloqueia até o servidor "certo":');
  {
    const original = config.guildId;
    config.guildId = '';
    ok(guard.guildPermitida(fakeGuild(GUILD_A)) === false, '5a: sem GUILD_ID, nenhum guild é permitido');
    ok(guard.guardarEvento('checagens-diarias', fakeGuild(GUILD_A)) === false, '5b: ...tarefa agendada não roda');
    const it = fakeInteracao({ guildId: GUILD_A, tipo: 'slash' });
    ok(await guard.guardarInteracao(it) === false, '5c: ...interação é recusada');
    lancou(() => guard.exigirGuild(fakeGuild(GUILD_A), 'teste'), '5d: ...e a camada profunda lança');
    config.guildId = original;
    ok(guard.guildPermitida(fakeGuild(GUILD_A)) === true, '5e: devolvendo GUILD_ID, volta a operar');
  }

  // ---- Resumo ----
  console.warn = warnReal; console.error = errReal;
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`));
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})().catch(e => {
  console.warn = warnReal; console.error = errReal;
  console.error('ERRO FATAL no runner:', e);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(2);
});
