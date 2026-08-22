/* eslint-disable */
// DEMISSÃO PELO SISTEMA — registro obrigatório, bloqueio proibido (21/08/2026). Rode com:
//   node scripts/testes-demissao-de-sistema.js
//
// O BURACO: três pontos de utils/responsaveis.js chamam `rh.demitir()` para quem SAIU do Discord.
// São demissões de verdade — mudam quem pode o quê — e não entravam no `logRh`. O "📜 Log de RH"
// do painel ficava com um vazio INVISÍVEL: quem consultasse encontraria alguém fora do quadro sem
// nenhuma linha explicando por quê. É a repetição do caso de 21/08 (role de Promotor sem registro
// de RH e nada no log dizendo o que houve).
//
// O pior dos três era `sortearSubstitutoValido`: demitia sem log E sem auditoria, e a cadeia pode
// começar num clique humano — /rh demitir → redistribuição → re-sorteio → alguém ausente cai.
//
// ================= A ASSIMETRIA QUE ESTE ARQUIVO EXISTE PARA DEFENDER =================
//
//   Caminho de HUMANO   (commands/rh.js → exigirLogRh): log falha  →  A AÇÃO NÃO ACONTECE.
//   Caminho de SISTEMA  (utils/responsaveis.js):        log falha  →  console.error e SEGUE.
//
// Não é incoerência, é a diferença entre DECISÃO e CONSTATAÇÃO. No caminho humano há alguém
// escolhendo tirar o poder de outra pessoa: travar e pedir para repetir é barato e correto. No
// caminho de sistema não existe tela, não existe quem clicou, não existe "tente de novo" — e o
// alvo já saiu do servidor. Travar deixaria um fantasma no quadro sendo sorteado para casos.
//
// Se algum dia alguém "consertar a inconsistência", os testes 3 e 4 caem juntos e explicam por quê.
// ======================================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-sistema-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const logRh = require('../utils/logRh');
require('../utils/carteirinha').emitirCarteirinha = async () => null; // sem Chromium na suíte
const responsaveis = require('../utils/responsaveis');
const rhCmd = require('../commands/rh');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const SEM_COMENTARIO = (s) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const avisos = [];
const guildFalsa = {
  id: 'guild1',
  channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { avisos.push(p.content); } }) },
  members: { fetch: async () => { const e = new Error('Unknown Member'); e.code = 10007; throw e; } },
};
require('../config').canalAuditoriaId = 'canal-auditoria';

(async () => {
  console.log('\n== Demissão pelo sistema ==');

  // -------------------------------------------------------------------------
  console.log('\n1) O sentinela do executor é exibível — não vira `<@sistema>` na tela:');
  {
    ok(logRh.EXECUTOR_SISTEMA === 'sistema', '1a: existe um sentinela, e não é null', String(logRh.EXECUTOR_SISTEMA));
    const linha = logRh.registrar({
      acao: 'demitir', executorId: logRh.EXECUTOR_SISTEMA, cargoExecutor: logRh.CARGO_SISTEMA,
      alvoId: '777', cargoAlvo: 'Juiz', motivo: 'membro não encontrado no servidor (10007)', guildId: 'guild1',
    });
    ok(linha.ok, '1b: e o log aceita gravar com ele');
    const t = logRh.formatar(linha.registro);
    ok(!/<@sistema>/.test(t), '1c: formatar NÃO devolve a menção crua — era o risco de usar string no lugar de id');
    ok(/sistema/i.test(t), '1d: mas diz que foi o sistema, em texto legível', t.split('\n')[1]);
    ok(/<@777>/.test(t), '1e: e o ALVO continua sendo menção de verdade');
    ok(/Juiz/.test(t) && /10007/.test(t), '1f: com o cargo perdido e o motivo explícito');
    // O painel usa exatamente consultar + formatar (commands/painel.js, ação "log").
    const doPainel = logRh.consultar({ limite: 12 }).map(logRh.formatar).join('\n\n');
    ok(/sistema/i.test(doPainel) && !/<@sistema>/.test(doPainel),
      '1g: e é assim que o "📜 Log de RH" do painel vai mostrar (mesmo caminho: consultar + formatar)');
  }

  // -------------------------------------------------------------------------
  console.log('\n2) Quem sai do servidor entra no log de RH:');
  {
    const FANTASMA = '888';
    rh.contratar(FANTASMA, 'Promotor', 'Promotor Fantasma', null);
    const antesLog = db.todos('logRh', l => l.alvoId === FANTASMA).length;
    const antesAviso = avisos.length;

    // guildMemberRemove -> tratarResponsavelInvalido. A guild falsa responde 10007 a todo fetch.
    await responsaveis.tratarResponsavelInvalido(guildFalsa, FANTASMA, 'ausente');

    ok(!rh.getCargo(FANTASMA), '2a: o cargo foi desativado (a limpeza aconteceu)');
    const linhas = db.todos('logRh', l => l.alvoId === FANTASMA);
    ok(linhas.length === antesLog + 1, '2b: e a demissão ENTROU no log de RH — era o buraco', `linhas=${linhas.length}`);
    const l = linhas[0];
    ok(l.acao === 'demitir', '2c: como demissão');
    ok(l.executorId === logRh.EXECUTOR_SISTEMA, '2d: com o executor identificado como sistema', l.executorId);
    ok(l.cargoAlvo === 'Promotor', '2e: guardando o cargo que a pessoa perdeu', String(l.cargoAlvo));
    ok(/saiu do servidor/.test(l.motivo), '2f: e o motivo explícito', l.motivo);
    ok(avisos.length === antesAviso + 1, '2g: a auditoria no canal CONTINUA, como antes', `${avisos.length - antesAviso}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n3) ASSIMETRIA, lado SISTEMA — log falha, a limpeza SEGUE:');
  {
    const OUTRO = '999';
    rh.contratar(OUTRO, 'Juiz', 'Juiz Sumido', null);

    const inserirOriginal = db.inserir;
    db.inserir = (tabela, ...resto) => {
      if (tabela === 'logRh') throw new Error("tabela 'logRh' não existe");
      return inserirOriginal(tabela, ...resto);
    };
    let estourou = false;
    try { await responsaveis.tratarResponsavelInvalido(guildFalsa, OUTRO, 'ausente'); } catch (_) { estourou = true; }
    db.inserir = inserirOriginal;

    ok(estourou === false, '3a: MUTAÇÃO — a falha de log não lança na varredura');
    ok(!rh.getCargo(OUTRO),
      '3b: e a limpeza ACONTECEU MESMO ASSIM — travar deixaria um fantasma no quadro sendo sorteado');
    ok(db.todos('logRh', l => l.alvoId === OUTRO).length === 0,
      '3c: (o log realmente não gravou — o cenário testado é o certo)');
  }

  // -------------------------------------------------------------------------
  console.log('\n4) ASSIMETRIA, lado HUMANO — log falha, a ação NÃO acontece:');
  {
    const ALVO = '1010';
    rh.contratar(ALVO, 'Desembargador', 'Des. Teste', null);

    const inserirOriginal = db.inserir;
    db.inserir = (tabela, ...resto) => {
      if (tabela === 'logRh') throw new Error("tabela 'logRh' não existe");
      return inserirOriginal(tabela, ...resto);
    };
    const saiu = await rhCmd.demitirComRole(guildFalsa, ALVO, '2020', 'Inatividade.');
    db.inserir = inserirOriginal;

    ok(saiu && typeof saiu.recusa === 'string', '4a: a demissão por gente é RECUSADA');
    ok(!!rh.getCargo(ALVO), '4b: e o cargo CONTINUA — o oposto do lado sistema, de propósito');
    ok(rh.getCargo(ALVO).cargo === 'Desembargador', '4c: exatamente como estava');
  }

  // -------------------------------------------------------------------------
  console.log('\n5) Os TRÊS pontos de sistema passam pelo mesmo registro:');
  {
    const src = SEM_COMENTARIO(LER('utils', 'responsaveis.js'));
    ok(src.length > 15000, '5a: CANÁRIO — utils/responsaveis.js foi lido inteiro', `${src.length} chars`);

    const demissoes = (src.match(/rh\.demitir\(/g) || []).length;
    ok(demissoes === 3, '5b: CANÁRIO — os três rh.demitir continuam onde estavam', `achados=${demissoes}`);
    // `await ...` de propósito: sem isso a própria DEFINIÇÃO da função entraria na conta e o teste
    // passaria com dois pontos ligados e um mudo.
    const registros = (src.match(/await registrarDemissaoDeSistema\(guild/g) || []).length;
    ok(registros === 3, '5c: e os três registram — nenhum sobrou mudo', `registros=${registros}`);

    // Nenhum deles pode ter voltado a chamar auditoria direto e pular o logRh.
    const auditoriasSoltas = (src.match(/auditoria\.registrar\(guild, \{\s*\n?\s*acao: `?RH: desativa/g) || []).length;
    ok(auditoriasSoltas === 0, '5d: nenhum ponto avisa só a auditoria e pula o log', `soltas=${auditoriasSoltas}`);

    ok(/console\.error\(`\[responsaveis\] demissão automática/.test(src),
      '5e: a falha de log grita com contexto (regra do projeto: catch nunca mudo)');

    // O comentário da assimetria precisa continuar lá: é o que impede o "conserto" errado.
    const bruto = LER('utils', 'responsaveis.js');
    ok(/ASSIMETRIA COM O ITEM 5 É PROPOSITAL/.test(bruto),
      '5f: e a justificativa da assimetria está escrita na linha, não só no commit');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); process.exit(1); }
})();
