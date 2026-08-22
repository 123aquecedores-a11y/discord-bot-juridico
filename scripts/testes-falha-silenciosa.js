/* eslint-disable */
// AS DUAS FALHAS SILENCIOSAS (21/08/2026). Rode com:
//   node scripts/testes-falha-silenciosa.js
//
// Dois `catch` mudos, achados na auditoria do dia, com a MESMA anatomia e o mesmo defeito:
//
//   database/db.js  — a cópia do `.bak` dentro de salvar(), sob um `catch {}` literalmente vazio.
//   utils/logRh.js  — a gravação do log de RH, sob um catch que só escrevia no console e devolvia
//                     null; e nenhum dos quatro chamadores olhava o retorno.
//
// Nos dois casos a decisão de NÃO derrubar a ação principal estava certa: backup não pode abortar a
// gravação do banco, log não pode desfazer uma demissão. O erro estava em confundir "não pode
// derrubar" com "não pode aparecer".
//
// O caso do logRh não é hipotético: a tabela `logRh` chegou a faltar em database/db.js, o
// db.inserir estourava a cada demissão, o catch engolia, e o único motivo de alguém ter descoberto
// foi um teste tropeçar nisso por acaso. Em produção teria passado despercebido indefinidamente.
//
// O que estes testes provam:
//   1) a falha APARECE (log, e aviso ao humano com o dado para lançar à mão);
//   2) a falha CONTINUA não derrubando nada (mutação: com a cópia quebrada, salvar() não lança);
//   3) o aviso não vira ruído (throttle: mil falhas seguidas não geram mil linhas).

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-silencio-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const logRh = require('../utils/logRh');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
// Comentário meu não é prova: varredura que casa com a própria explicação passa sempre. Fora eles.
const SEM_COMENTARIO = (src) => src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// Captura de console para provar o que foi (e o que NÃO foi) escrito.
function capturar(fn) {
  const originalErr = console.error; const originalLog = console.log;
  const linhas = [];
  console.error = (...a) => linhas.push(a.join(' '));
  console.log = (...a) => linhas.push(a.join(' '));
  try { return { retorno: fn(), linhas }; } finally { console.error = originalErr; console.log = originalLog; }
}

console.log('\n== As duas falhas silenciosas ==');

// ---------------------------------------------------------------------------
// 1) database/db.js — a cópia do .bak
// ---------------------------------------------------------------------------
console.log('\n1) database/db.js — o backup .bak parou de falhar em silêncio:');
{
  // Uma gravação normal primeiro, para o .bak nascer.
  db.inserir('estado', { chave: 'semente', valor: '1' });

  const saudeBoa = db.saudeDoBackup();
  ok(saudeBoa.existe === true, '1a: depois de uma gravação normal o .bak existe', JSON.stringify(saudeBoa.existe));
  ok(saudeBoa.ausente === false && saudeBoa.atrasado === false,
    '1b: e a saúde é reportada como normal (nem ausente, nem atrasado)',
    `ausente=${saudeBoa.ausente} atrasado=${saudeBoa.atrasado}`);
  ok(saudeBoa.atrasoMs !== null && saudeBoa.atrasoMs < 5000,
    '1c: o atraso entre .bak e dados.json é de milissegundos, não de minutos', `atrasoMs=${saudeBoa.atrasoMs}`);

  // --- Agora quebra a cópia de propósito. É o cenário do disco cheio / permissão negada.
  const copiaOriginal = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('ENOSPC: no space left on device'); };

  const r1 = capturar(() => db.inserir('estado', { chave: 'com-bak-quebrado', valor: '1' }));

  // MUTAÇÃO — a garantia que não pode se perder no conserto: com a cópia estourando, a gravação
  // do banco tem que continuar acontecendo. Se este teste falhar, o remédio virou a doença.
  ok(r1.retorno && r1.retorno.chave === 'com-bak-quebrado',
    '1d: MUTAÇÃO — com o .bak estourando, a gravação do banco CONTINUA funcionando (não lança)',
    JSON.stringify(r1.retorno && r1.retorno.chave));
  const gravado = db.buscarUm('estado', e => e.chave === 'com-bak-quebrado');
  ok(!!gravado, '1e: e o registro está no banco de verdade, não só no retorno');

  const gritou = r1.linhas.filter(l => /FALHA ao gravar o backup \.bak/.test(l));
  ok(gritou.length === 1, '1f: a falha APARECE no log (era um catch vazio)', `linhas=${gritou.length}`);
  ok(/ENOSPC/.test(gritou[0] || ''), '1g: e o log traz o erro real, não uma mensagem genérica', (gritou[0] || '').slice(0, 60));
  ok(/rede de seguran/i.test(gritou[0] || ''),
    '1h: o log diz explicitamente que o BANCO segue gravando — quem lê não entra em pânico à toa');

  // --- THROTTLE: salvar() roda a cada escrita. Sem freio, disco cheio afoga o log.
  const r2 = capturar(() => { for (let i = 0; i < 300; i++) db.inserir('estado', { chave: `rajada${i}`, valor: '1' }); });
  const naRajada = r2.linhas.filter(l => /FALHA ao gravar o backup \.bak/.test(l));
  ok(naRajada.length === 0,
    '1i: THROTTLE — 300 falhas seguidas não geram 300 linhas (a 1ª já falou, as outras esperam 5min)',
    `linhas=${naRajada.length}`);

  const durante = db.saudeDoBackup();
  ok(durante.falhas >= 301, '1j: mas a contagem de falhas continua subindo por dentro', `falhas=${durante.falhas}`);
  ok(durante.ultimoErro && /ENOSPC/.test(durante.ultimoErro),
    '1k: e o último erro fica guardado para quem for consultar a saúde', String(durante.ultimoErro).slice(0, 40));

  // --- A VOLTA também é notícia.
  fs.copyFileSync = copiaOriginal;
  const r3 = capturar(() => db.inserir('estado', { chave: 'voltou', valor: '1' }));
  const recuperou = r3.linhas.filter(l => /voltou a funcionar/.test(l));
  ok(recuperou.length === 1, '1l: quando volta ao normal o log AVISA (senão quem viu o alarme nunca soube que passou)');
  ok(/\d+ falha/.test(recuperou[0] || ''), '1m: e diz quantas falhas houve no intervalo', (recuperou[0] || '').slice(0, 70));
  ok(db.saudeDoBackup().falhas === 0, '1n: o contador zera na recuperação — o que interessa é a rajada em curso');

  // --- AUSENTE: nunca houve rede.
  fs.unlinkSync(`${DB_TESTE}.bak`);
  const semBak = db.saudeDoBackup();
  ok(semBak.ausente === true, '1o: .bak apagado é reportado como AUSENTE, não como atrasado', `ausente=${semBak.ausente}`);

  // --- ATRASADO: a rede existe mas parou de ser tecida. É por ATRASO, não por idade — num tribunal
  // parado ninguém grava nada, e um .bak de 3h atrás está perfeito.
  db.inserir('estado', { chave: 'refaz-bak', valor: '1' });
  const doisDias = Date.now() - (2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(`${DB_TESTE}.bak`, new Date(doisDias), new Date(doisDias));
  const velho = db.saudeDoBackup();
  ok(velho.atrasado === true, '1p: .bak dois dias atrás do dados.json é reportado como ATRASADO', `atrasoMs=${velho.atrasoMs}`);
  ok(velho.ausente === false, '1q: e NÃO como ausente — são diagnósticos diferentes e pedem providências diferentes');

  // Restaura o par para o resto do arquivo.
  db.inserir('estado', { chave: 'normaliza', valor: '1' });
  ok(db.saudeDoBackup().atrasado === false, '1r: uma gravação normal volta a saúde ao normal sozinha');
}

// ---------------------------------------------------------------------------
// 2) O aviso chega a um humano no boot
// ---------------------------------------------------------------------------
console.log('\n2) O aviso de backup chega a um humano (não só ao console):');
{
  const auditoria = require('../utils/auditoria');
  const enviados = [];
  const guildFalsa = {
    id: 'guild1',
    channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { enviados.push(p.content); } }) },
  };
  const config = require('../config');
  const canalAntes = config.canalAuditoriaId;
  config.canalAuditoriaId = 'canal-auditoria';

  (async () => {
    // Saúde normal: silêncio é a resposta certa. Aviso que aparece sempre vira ruído e é ignorado.
    db.inserir('estado', { chave: 'saude-ok', valor: '1' });
    const quieto = await auditoria.avisarBackupAtrasado(guildFalsa);
    ok(quieto.avisou === false && enviados.length === 0,
      '2a: com o backup saudável NÃO avisa nada (aviso que aparece sempre é aviso ignorado)', `enviados=${enviados.length}`);

    // Backup ausente: avisa.
    fs.unlinkSync(`${DB_TESTE}.bak`);
    const gritou = await auditoria.avisarBackupAtrasado(guildFalsa);
    ok(gritou.avisou === true && enviados.length === 1, '2b: com o .bak AUSENTE, avisa no canal de auditoria');
    ok(/N[ÃA]O EXISTE/i.test(enviados[0] || ''), '2c: e a mensagem diz o que está errado em português claro', (enviados[0] || '').slice(0, 50));
    ok(/recuperar|espa[çc]o em disco|permiss/i.test(enviados[0] || ''),
      '2d: e diz o que fazer a respeito, não só que há um problema');

    // Canal quebrado não pode derrubar o boot — o aviso de falha não pode ser a nova falha.
    config.canalAuditoriaId = 'canal-inexistente';
    const guildQuebrada = { id: 'guild1', channels: { fetch: async () => null } };
    let estourou = false;
    try { await auditoria.avisarBackupAtrasado(guildQuebrada); } catch (_) { estourou = true; }
    ok(estourou === false, '2e: MUTAÇÃO — canal de auditoria quebrado NÃO derruba o boot (o aviso cai para o console)');

    config.canalAuditoriaId = canalAntes;
    db.inserir('estado', { chave: 'restaura', valor: '1' });
    parte3();
  })();
}

// ---------------------------------------------------------------------------
// 3) utils/logRh.js — a gravação do log de RH
// ---------------------------------------------------------------------------
function parte3() {
  console.log('\n3) utils/logRh.js — a falha do log de RH chega a quem clicou:');

  const bom = logRh.registrar({
    acao: 'demitir', executorId: '111', cargoExecutor: 'Procurador',
    alvoId: '222', cargoAlvo: 'Juiz', motivo: 'Inatividade prolongada.', guildId: 'guild1',
  });
  ok(bom.ok === true && bom.registro && bom.registro.acao === 'demitir',
    '3a: no caminho feliz devolve { ok: true, registro }', JSON.stringify(bom.ok));
  ok(bom.aviso === null, '3b: e não inventa aviso nenhum quando deu tudo certo');

  // Quebra a gravação. É exatamente o que acontecia quando a tabela `logRh` faltava em db.js.
  const inserirOriginal = db.inserir;
  db.inserir = (tabela, ...resto) => {
    if (tabela === 'logRh') throw new Error("tabela 'logRh' não existe");
    return inserirOriginal(tabela, ...resto);
  };

  const dados = {
    acao: 'demitir', executorId: '111', cargoExecutor: 'Procurador',
    alvoId: '222', cargoAlvo: 'Promotor', motivo: 'Abandono de função.', guildId: 'guild1',
  };
  let lancou = false; let ruim = null;
  try { ruim = logRh.registrar(dados); } catch (_) { lancou = true; }

  // MUTAÇÃO — a garantia que não pode se perder: o log falhar NÃO pode desfazer nem bloquear a
  // demissão. O cargo já foi mexido quando isto roda.
  ok(lancou === false, '3c: MUTAÇÃO — a falha de log NÃO lança (não desfaz nem bloqueia a demissão)');
  ok(ruim && ruim.ok === false, '3d: mas o retorno diz claramente que falhou', JSON.stringify(ruim && ruim.ok));
  ok(ruim && typeof ruim.aviso === 'string' && ruim.aviso.length > 0, '3e: e vem com um aviso pronto para mostrar a quem clicou');

  const a = (ruim && ruim.aviso) || '';
  // O aviso tem que BASTAR SOZINHO: quem for lançar à mão não tem a tela de onde veio, nem lembra
  // do ID de ninguém. Cada campo é conferido individualmente porque perder UM já inutiliza a linha.
  ok(/<@222>/.test(a), '3f: o aviso repete o ALVO');
  ok(/<@111>/.test(a), '3g: o aviso repete o EXECUTOR');
  ok(/Procurador/.test(a), '3h: o aviso repete o CARGO de quem executou (é com que poder ele agiu)');
  ok(/Promotor/.test(a), '3i: o aviso repete o CARGO do alvo');
  ok(/Abandono de função\./.test(a), '3j: o aviso repete o MOTIVO na íntegra');
  ok(/Demiss/.test(a), '3k: o aviso diz QUAL ação foi');
  ok(/<t:\d+:f>/.test(a), '3l: o aviso repete QUANDO, em timestamp do Discord');
  ok(/logRh|tabela/.test(a), '3m: e traz o erro técnico, para quem for consertar a causa');
  ok(/N[ÃA]O foi gravado|n[ãa]o foi gravado/.test(a),
    '3n: o aviso deixa explícito que o REGISTRO falhou, e o que precisa ser lançado à mão');

  db.inserir = inserirOriginal;

  // -------------------------------------------------------------------------
  console.log('\n4) O retorno virou CONDIÇÃO da ação, não aviso depois do fato:');
  // MUDANÇA DE CONTRATO EM 21/08/2026, decisão do operador. A primeira versão desta correção fazia
  // a ação acontecer e avisar que o log falhou. Não bastava: contratar, demitir e dar licença mudam
  // QUEM PODE O QUÊ no tribunal, e poder que muda sem registro é poder que ninguém audita depois.
  //
  // Agora o log vem PRIMEIRO e a ação só acontece se ele gravar. Por isso as chamadas espalhadas
  // sumiram: existe UMA trava (exigirLogRh) e todo mundo passa por ela. O comportamento em si é
  // provado em scripts/testes-falha-que-aparece.js; aqui fica a garantia estrutural de que ninguém
  // volta a chamar o logRh por fora.
  const rhSrc = SEM_COMENTARIO(LER('commands', 'rh.js'));
  const painelSrc = SEM_COMENTARIO(LER('commands', 'painel.js'));
  ok(rhSrc.length > 5000 && painelSrc.length > 5000, '4a: CANÁRIO — os dois arquivos foram lidos inteiros',
    `${rhSrc.length}/${painelSrc.length} chars`);

  const diretas = (rhSrc.match(/logRh\.registrar\(/g) || []).length + (painelSrc.match(/logRh\.registrar\(/g) || []).length;
  ok(diretas === 1, '4b: só UMA chamada a logRh.registrar sobrou — a de dentro da trava', `diretas=${diretas}`);
  ok(/function exigirLogRh/.test(rhSrc) && /logRh\.registrar\(dados\)/.test(rhSrc),
    '4c: e ela vive dentro de exigirLogRh, que é quem decide se a ação prossegue');

  const travas = (rhSrc.match(/exigirLogRh\(/g) || []).length + (painelSrc.match(/rhCmd\.exigirLogRh\(/g) || []).length;
  ok(travas === 5, '4d: a trava é aplicada nos 4 caminhos de ação (+ a própria definição)', `usos=${travas}`);

  const recusas = (rhSrc.match(/trava\.ok|\.recusa/g) || []).length + (painelSrc.match(/trava\.ok|\.recusa/g) || []).length;
  ok(recusas >= 8, '4e: e todos os caminhos tratam a recusa em vez de seguir em frente', `tratamentos=${recusas}`);

  // O que NÃO pode voltar: ação primeiro, log depois. Se `rh.contratar`/`rh.demitir` aparecer antes
  // da trava, a janela de "cargo mudou sem registro" reabre.
  const corpoContratar = rhSrc.slice(rhSrc.indexOf('async function contratarComRole'));
  ok(corpoContratar.indexOf('exigirLogRh(') < corpoContratar.indexOf('rh.contratar('),
    '4f: MUTAÇÃO — a trava continua ANTES da escrita no RH (é a ordem que dispensa rollback)');

  // -------------------------------------------------------------------------
  console.log('\n5) Os catch mudos não voltam sozinhos:');
  const dbSrc = SEM_COMENTARIO(LER('database', 'db.js'));
  ok(dbSrc.length > 3000, '5a: CANÁRIO — database/db.js foi lido inteiro', `${dbSrc.length} chars`);
  ok(!/catch\s*\{\s*\}/.test(dbSrc), '5b: nenhum `catch {}` literalmente vazio sobrou em db.js');
  ok(/copiarBak\(\)/.test(dbSrc), '5c: a cópia do .bak passa pela função que registra a falha');
  ok(/saudeDoBackup/.test(dbSrc) && /module\.exports[^\n]*saudeDoBackup/.test(dbSrc),
    '5d: e a saúde do backup é exportada para quem for avisar humano');

  const logRhSrc = SEM_COMENTARIO(LER('utils', 'logRh.js'));
  ok(logRhSrc.length > 1500, '5e: CANÁRIO — utils/logRh.js foi lido inteiro', `${logRhSrc.length} chars`);
  ok(!/return null;/.test(logRhSrc), '5f: registrar() não devolve mais um null mudo');
  ok(/ok: false/.test(logRhSrc) && /aviso: avisoDeFalha/.test(logRhSrc), '5g: devolve ok:false com o aviso montado');
  ok(!/throw/.test(logRhSrc), '5h: e continua sem lançar — a demissão nunca é desfeita por causa do log');

  const indexSrc = SEM_COMENTARIO(LER('index.js'));
  ok(/avisarBackupAtrasado\(guild\)/.test(indexSrc), '5i: o boot chama a checagem do backup');
  const posGate = indexSrc.indexOf('avisarBackupAtrasado(guild)');
  const posManutencao = indexSrc.indexOf('modoManutencao.ativo()');
  ok(posManutencao > -1 && posGate > posManutencao,
    '5j: e a chamada fica DEPOIS do gate de manutenção — SKIP_BOOT_TASKS=1 continua parando tudo',
    `gate=${posManutencao} chamada=${posGate}`);

  fim();
}

function fim() {
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); process.exit(1); }
}
