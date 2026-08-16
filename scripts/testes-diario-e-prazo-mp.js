/* eslint-disable */
// Testes das duas decisões de política deste lote. Rode com:
//   node scripts/testes-diario-e-prazo-mp.js
//
// (a) SIGILO NO DIÁRIO — deny-list dura por tipo de mandado, em qualquer estado; allow-list como
//     regra efetiva (tipo novo nasce bloqueado); mandado não cumprido não publica nada; e o
//     arquivamento de inquérito publica o card SEM o PDF do relatório da Polícia Civil.
//
// (b) PRAZO DO MP — o reinício das 24h acontece UMA VEZ SÓ por petição (prazoMpJaReiniciado),
//     fechando o loop em que o Procurador trocava de promotor a cada 23h e travava o Juiz para
//     sempre. Toda troca avisa no canal e registra nos autos o que aconteceu com o prazo.
//
// Banco temporário — não encosta no dados.json de produção.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-diario-mp-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';            // o guard de guild recusa qualquer outra (utils/guildGuard.js)
process.env.CANAL_AUDITORIA_ID = '';
process.env.CARGO_STAFF_ID = '';
process.env.ROLE_SUPER_STAFF_ID = '';

const db = require('../database/db');
const estado = require('../utils/estado');
const diarioAtos = require('../utils/diarioAtos');
const anexos = require('../utils/anexos');
const responsaveis = require('../utils/responsaveis');
const rh = require('../utils/rh');
const peticaoCmd = require('../commands/peticao');

const documentoPng = require('../services/gerarDocumentoPNG');
documentoPng.nomeExibicao = async (g, id) => `Fulano ${id}`;

// ---- mini framework ----
let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// ---- mocks ----
const rec = { sends: [], chan: 0 };
function fakeChannel() {
  return {
    id: `chan_${++rec.chan}`, isTextBased: () => true,
    send: async (o) => { rec.sends.push(typeof o === 'string' ? { content: o } : o); return { id: 'msg1' }; },
    permissionOverwrites: { edit: async () => {}, delete: async () => {}, cache: { some: () => false, values: () => [][Symbol.iterator]() } },
    setParent: async () => {}, setTopic: async () => {},
  };
}
function fakeGuild() {
  return {
    id: 'guild1', roles: { everyone: 'e' },
    client: { user: { id: 'bot1' } },
    members: { me: { id: 'bot1' }, fetch: async (id) => ({ id, roles: { cache: { has: () => true } } }) },
    channels: { create: async () => fakeChannel(), fetch: async () => fakeChannel() },
  };
}
const textoDosSends = () => JSON.stringify(rec.sends);
const publicacoes = () => rec.sends.filter(s => Array.isArray(s.embeds) && s.embeds.length);

(async () => {
  estado.definir('diarioOficialId', 'diariochan');

  // ==================================================================================
  console.log('\n(a) Sigilo no Diário — deny-list dura por tipo de mandado');
  // ==================================================================================
  {
    // 1) Todo tipo da deny-list, nos DOIS estados que existiriam: Emitido e Cumprido.
    for (const tipo of diarioAtos.MANDADOS_QUE_NUNCA_PUBLICAM) {
      const base = tipo.replace(/[^a-zA-Z]/g, '').slice(0, 8);
      for (const status of ['Emitido', 'Cumprido']) {
        const numero = `DENY-${base}-${status}`;
        db.inserir('mandados', { numero, tipo, alvo: `Alvo-${base}`, status, processoVinculado: 'PX', cumpridoPor: status === 'Cumprido' ? 'del1' : null });
        rec.sends.length = 0;
        const r = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', numero));
        ok(r === false && publicacoes().length === 0, `1-${tipo} (${status}): NÃO publica`);
      }
    }
    // O alvo desses mandados nunca pode ter saído em publicação nenhuma.
    ok(!/Alvo-/.test(textoDosSends()), '1z: nenhum alvo de mandado sigiloso apareceu em publicação');

    // 2) A deny-list não é furada por acento, caixa ou espaço duplicado.
    for (const variante of ['BUSCA E APREENSAO', 'busca e apreensão', 'Busca  e  Apreensao', ' Quebra de Sigilo ', 'INTERCEPTACAO TELEFONICA']) {
      const numero = `VAR-${variante.replace(/[^a-zA-Z]/g, '').slice(0, 10)}`;
      db.inserir('mandados', { numero, tipo: variante, alvo: 'AlvoVar', status: 'Cumprido', cumpridoPor: 'del1' });
      rec.sends.length = 0;
      const r = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', numero));
      ok(r === false, `2-"${variante}": variação de acento/caixa/espaço não fura a deny-list`);
    }

    // 3) Allow-list: prisão preventiva/temporária publicam — e SÓ no cumprimento.
    for (const tipo of diarioAtos.MANDADOS_QUE_PUBLICAM_AO_CUMPRIR) {
      const base = tipo.replace(/[^a-zA-Z]/g, '').slice(0, 8);
      db.inserir('mandados', { numero: `ALLOW-${base}`, tipo, alvo: `Preso-${base}`, status: 'Emitido', cumpridoPor: null });
      rec.sends.length = 0;
      const rEmitido = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', `ALLOW-${base}`));
      ok(rEmitido === false && publicacoes().length === 0, `3-${tipo}: emitido (ainda não cumprido) NÃO publica`);

      db.atualizar('mandados', `ALLOW-${base}`, { status: 'Cumprido', cumpridoPor: 'del1' });
      rec.sends.length = 0;
      const rCumprido = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', `ALLOW-${base}`));
      ok(rCumprido === true && publicacoes().length === 1, `  ...e CUMPRIDO publica (allow-list)`);
    }

    // 4) O ponto da decisão: tipo NOVO nasce bloqueado, sem ninguém precisar lembrar da deny-list.
    for (const tipoNovo of ['Interceptação Ambiental', 'Sequestro de Bens', 'Outro', 'qualquer coisa que o promotor digitou']) {
      const numero = `NOVO-${tipoNovo.replace(/[^a-zA-Z]/g, '').slice(0, 10)}`;
      db.inserir('mandados', { numero, tipo: tipoNovo, alvo: 'AlvoNovo', status: 'Cumprido', cumpridoPor: 'del1' });
      rec.sends.length = 0;
      const r = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', numero));
      ok(r === false, `4-"${tipoNovo}": tipo fora da allow-list nasce BLOQUEADO`);
    }
    db.inserir('mandados', { numero: 'SEM-TIPO', tipo: null, alvo: 'AlvoSemTipo', status: 'Cumprido', cumpridoPor: 'del1' });
    rec.sends.length = 0;
    ok(await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', 'SEM-TIPO')) === false,
      '4z: mandado SEM tipo não publica (fail-closed)');

    // 5) mandadoNaoCumprido não publica nada — nem chamado direto, nem pela varredura.
    db.inserir('medidas', { numero: 'MED-ENC', status: 'Deferida', arquivadoManual: true, delegado: 'delA', juiz: 'juizA' });
    db.inserir('mandados', { numero: 'MND-NC', tipo: 'Busca e Apreensão', alvo: 'AlvoNaoCumprido', status: 'Emitido', medidaNumero: 'MED-ENC', cumpridoPor: null });
    rec.sends.length = 0;
    const direto = await diarioAtos.publicarAto(fakeGuild(), 'mandadoNaoCumprido', db.buscarPorNumero('mandados', 'MND-NC'));
    ok(direto === false && publicacoes().length === 0, '5a: publicarAto("mandadoNaoCumprido") não publica nem chamado direto');
    ok(diarioAtos.mandadoAbandonado(db.buscarPorNumero('mandados', 'MND-NC')) === true, '5b: ...mesmo sendo um mandado de caso encerrado (o conceito continua, a publicação não)');
    rec.sends.length = 0;
    await diarioAtos.varrerDiario(fakeGuild());
    ok(!(db.buscarPorNumero('mandados', 'MND-NC') || {}).diarioPublicado, '5c: a varredura também não publica o não cumprido');
    ok(!/AlvoNaoCumprido/.test(textoDosSends()), '5d: nem o tipo nem o alvo vazaram na varredura');

    // 6) Arquivamento de inquérito: card sim, PDF do relatório não.
    db.inserir('processos', { numero: 'INQ-PDF', tipo: 'Penal', status: 'Arquivado', promotor: 'prom1' });
    anexos.criarDocumento({ tipo: 'relatorio_inquerito', url: 'https://cdn.fake/relatorio.pdf', nomeArquivo: 'Relatorio-INQ-PDF.pdf', autorId: 'del1', protocoloVinculado: 'INQ-PDF' });
    rec.sends.length = 0;
    const rArq = await diarioAtos.publicarAto(fakeGuild(), 'arquivamentoInquerito', db.buscarPorNumero('processos', 'INQ-PDF'));
    const card = publicacoes()[0];
    ok(rArq === true && !!card, '6a: arquivamento de inquérito publica o card');
    ok(!card.files, '6b: ...e NÃO anexa o PDF do relatório da Polícia Civil');
    ok(!/Relatorio-INQ-PDF\.pdf|cdn\.fake\/relatorio\.pdf/.test(textoDosSends()), '6c: ...nem o nome/URL do relatório aparecem no card');
    ok((anexos.listarPorProtocolo('INQ-PDF') || []).some(d => d.tipo === 'relatorio_inquerito'),
      '6d: o PDF continua guardado no ticket (só não vai pro canal público)');

    // 7) Varredura com mix: só a prisão preventiva cumprida sai.
    db.inserir('mandados', { numero: 'MIX-BA', tipo: 'Busca e Apreensão', alvo: 'MixAlvoBA', status: 'Cumprido', cumpridoPor: 'del1' });
    db.inserir('mandados', { numero: 'MIX-PP', tipo: 'Prisão Preventiva', alvo: 'MixAlvoPP', status: 'Cumprido', cumpridoPor: 'del1' });
    rec.sends.length = 0;
    await diarioAtos.varrerDiario(fakeGuild());
    ok(!!(db.buscarPorNumero('mandados', 'MIX-PP') || {}).diarioPublicado, '7a: varredura publica a prisão preventiva cumprida');
    ok(!(db.buscarPorNumero('mandados', 'MIX-BA') || {}).diarioPublicado, '7b: e não publica a busca e apreensão cumprida');
    ok(!/MixAlvoBA/.test(textoDosSends()) && /MixAlvoPP/.test(textoDosSends()), '7c: só o alvo do mandado ostensivo aparece');
  }

  // ==================================================================================
  console.log('\n(b) Prazo do MP — reinício ÚNICO por petição');
  // ==================================================================================
  {
    const guild = fakeGuild();
    rh.contratar('promA', 'Promotor'); rh.contratar('promB', 'Promotor');
    rh.contratar('promC', 'Promotor'); rh.contratar('promD', 'Promotor');

    const HORA = 60 * 60 * 1000;
    const inicio = new Date(Date.now() - 23 * HORA).toISOString(); // sorteio original, 23h atrás
    db.inserir('peticoes', {
      numero: 'MP-001', tipo: 'PorteArma', status: 'Pendente', juiz: 'juiz1', promotor: 'promA',
      canalId: 'cMP1', sorteioPromotorEm: inicio, manifestacoesMp: [{ posicao: 'Favorável', autorId: 'promA' }],
    });

    // 8) PRIMEIRA troca: reinicia (o promotor novo merece a janela cheia) e marca o consumo.
    rec.sends.length = 0;
    const t1 = await responsaveis.trocarManual(guild, { tabela: 'peticoes', numero: 'MP-001', papel: 'Promotor', novoId: 'promB', motivo: 'teste', executorId: 'proc1' });
    const p1 = db.buscarPorNumero('peticoes', 'MP-001');
    ok(t1.ok === true, '8a: primeira troca de Promotor é efetivada');
    ok(p1.sorteioPromotorEm !== inicio, '8b: ...e REINICIA o prazo de 24h');
    ok(p1.prazoMpJaReiniciado === true, '8c: ...marcando prazoMpJaReiniciado (o reinício foi consumido)');
    ok(/reiniciado por ato da Supervisão/i.test(textoDosSends()), '8d: ...com aviso no canal do ticket');
    ok((p1.manifestacoesMp || []).length === 1, '8e: ...e a manifestação anterior permanece nos autos');
    const andamento1 = db.todos('andamentos', a => a.processoNumero === 'MP-001' && a.tipo === 'prazo_mp')[0];
    ok(!!andamento1 && andamento1.metadata?.reiniciouAgora === true, '8f: ...e o histórico dos autos registra o reinício');

    // 9) SEGUNDA troca: não reinicia. É o loop do Procurador sendo fechado.
    const depoisDaPrimeira = db.buscarPorNumero('peticoes', 'MP-001').sorteioPromotorEm;
    rec.sends.length = 0;
    await responsaveis.trocarManual(guild, { tabela: 'peticoes', numero: 'MP-001', papel: 'Promotor', novoId: 'promC', motivo: 'teste', executorId: 'proc1' });
    const p2 = db.buscarPorNumero('peticoes', 'MP-001');
    ok(p2.promotor === 'promC', '9a: segunda troca é efetivada normalmente (a troca continua permitida)');
    ok(p2.sorteioPromotorEm === depoisDaPrimeira, '9b: ...mas o prazo NÃO é reiniciado');
    ok(/NÃO foi reiniciado/i.test(textoDosSends()), '9c: ...e o canal é avisado disso explicitamente');
    const andamentosMp = db.todos('andamentos', a => a.processoNumero === 'MP-001' && a.tipo === 'prazo_mp');
    ok(andamentosMp.length === 2 && andamentosMp.some(a => a.metadata?.reiniciouAgora === false), '9d: ...com registro próprio nos autos');

    // 10) O loop de verdade: trocar de promotor sem parar não segura mais o Juiz.
    //     Petição nasce agora; troca 1 reinicia; trocas seguintes não. Passadas 24h da troca 1,
    //     a trava do Juiz libera por decurso mesmo com promotor novo entrando toda hora.
    db.inserir('peticoes', {
      numero: 'MP-LOOP', tipo: 'PorteArma', status: 'Pendente', juiz: 'juiz1', promotor: 'promA',
      canalId: 'cLOOP', sorteioPromotorEm: new Date().toISOString(), manifestacoesMp: [],
    });
    await responsaveis.trocarManual(guild, { tabela: 'peticoes', numero: 'MP-LOOP', papel: 'Promotor', novoId: 'promB', motivo: 'loop', executorId: 'proc1' });
    const aposReinicio = new Date(db.buscarPorNumero('peticoes', 'MP-LOOP').sorteioPromotorEm).getTime();
    for (const novo of ['promC', 'promD', 'promA']) {
      await responsaveis.trocarManual(guild, { tabela: 'peticoes', numero: 'MP-LOOP', papel: 'Promotor', novoId: novo, motivo: 'loop', executorId: 'proc1' });
    }
    const pLoop = db.buscarPorNumero('peticoes', 'MP-LOOP');
    ok(new Date(pLoop.sorteioPromotorEm).getTime() === aposReinicio, '10a: 3 trocas seguidas não moveram o prazo um segundo');
    const bloqAntes = peticaoCmd.estadoManifestacaoMp(pLoop, aposReinicio + 23 * HORA).bloqueado;
    const estadoDepois = peticaoCmd.estadoManifestacaoMp(pLoop, aposReinicio + 25 * HORA);
    ok(bloqAntes === true, '10b: dentro das 24h o Juiz segue travado (a trava continua valendo)');
    ok(estadoDepois.bloqueado === false && estadoDepois.decurso === true, '10c: passadas as 24h o Juiz é LIBERADO por decurso — o loop está fechado');

    // 11) O reinício é por PETIÇÃO: uma petição nova tem o seu próprio, não herda o consumo.
    const inicioNovo = new Date(Date.now() - 5 * HORA).toISOString();
    db.inserir('peticoes', { numero: 'MP-002', tipo: 'TrocaNome', status: 'Pendente', juiz: 'juiz1', promotor: 'promA', canalId: 'cMP2', sorteioPromotorEm: inicioNovo, manifestacoesMp: [] });
    await responsaveis.trocarManual(guild, { tabela: 'peticoes', numero: 'MP-002', papel: 'Promotor', novoId: 'promB', motivo: 'teste', executorId: 'proc1' });
    const p3 = db.buscarPorNumero('peticoes', 'MP-002');
    ok(p3.sorteioPromotorEm !== inicioNovo && p3.prazoMpJaReiniciado === true, '11: outra petição tem seu próprio reinício único');

    // 12) O texto do aviso diz a verdade em cada situação (sem prometer prazo que não existe).
    const t = responsaveis.textoPrazoMp('peticoes', 'Promotor', { prazoMpJaReiniciado: false });
    const t2 = responsaveis.textoPrazoMp('peticoes', 'Promotor', { prazoMpJaReiniciado: true, sorteioPromotorEm: inicio });
    ok(/reiniciado/i.test(t) && /único/i.test(t), '12a: primeira troca — o aviso diz que reiniciou e que é o único');
    ok(/NÃO foi reiniciado/i.test(t2) && /segue correndo/i.test(t2), '12b: demais trocas — o aviso diz que o prazo segue correndo');
    ok(responsaveis.textoPrazoMp('processos', 'Promotor', {}) === null, '12c: não há aviso de prazo do MP fora de petição');
    ok(responsaveis.textoPrazoMp('peticoes', 'Juiz', {}) === null, '12d: nem em troca de outro papel');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`));
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})().catch(e => {
  console.error('ERRO FATAL no runner:', e);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(2);
});
