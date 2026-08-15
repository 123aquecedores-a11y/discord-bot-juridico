/* eslint-disable */
// Testes automatizados das correções de bugs (lote da auditoria) — chamam as funções REAIS com
// mocks de Discord e um banco ISOLADO (não toca no dados.json de produção). Rode com:
//   node scripts/testes-correcoes.js
// NÃO altera comportamento do bot: só stub de PNG/webhook e banco temporário.

// ---- 1) Ambiente isolado (DEVE vir antes de qualquer require do projeto) ----
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-correcoes-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
// config.js carrega dotenv; dotenv NÃO sobrescreve chave já presente em process.env — então setar
// '' aqui (falsy → null no config, via `|| null`) neutraliza qualquer valor do .env local e deixa
// o teste hermético: canais desligados → auditoria/andamentos/diário viram no-op, sem Discord real.
process.env.CANAL_AUDITORIA_ID = '';
process.env.CANAL_ADVOGAR_PEGAR_CASOS_ID = '';
process.env.CANAL_DIARIO_OFICIAL_ID = '';
process.env.CANAL_CONTRATACOES_ID = '';
process.env.CARGO_STAFF_ID = '';
process.env.ROLE_SUPER_STAFF_ID = '';
process.env.CATEGORIA_PETICOES_ID = '';
process.env.CATEGORIA_ARQUIVADOS_ID = '';
// Roles configuradas (pro teste de troca de cargo do RH conseguir add/remove role).
process.env.ROLE_DELEGADO_ID = 'role_delegado';
process.env.ROLE_PROMOTOR_ID = 'role_promotor';
process.env.ROLE_JUIZ_ID = 'role_juiz';
process.env.ROLE_ADVOGADO_ID = 'role_advogado';
process.env.ROLE_DESEMBARGADOR_ID = 'role_desembargador';
process.env.ROLE_PROCURADOR_ID = 'role_procurador';

// ---- 2) Requires + stubs (evita Puppeteer/Chromium e webhook externo) ----
const db = require('../database/db');
const ficha = require('../utils/ficha');
const { parseCriadoEm } = require('../utils/data');

const documentoPng = require('../services/gerarDocumentoPNG');
documentoPng.gerarDocumentoPNG = async () => Buffer.from('png-fake'); // "gera" PNG sem browser
documentoPng.nomeExibicao = async () => 'Fulano Teste';

const devolutiva = require('../utils/devolutivaPoliciaCivil');
devolutiva.enviarDevolutivaMandado = async () => {};
devolutiva.enviarDevolutivaSentenca = async () => {};

const processoCmd = require('../commands/processo');
const medidaCmd = require('../commands/medida');
const peticaoCmd = require('../commands/peticao');
const rhCmd = require('../commands/rh');
const rh = require('../utils/rh');
const config = require('../config');

// ---- 3) Mini framework de asserts ----
let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function eq(a, b, nome) { ok(a === b, nome, a === b ? '' : `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`); }

// ---- 4) Mocks de Discord ----
const rec = { sends: [], created: [], roleAdds: [], roleRemoves: [], nicks: [], chan: 0, msg: 0 };
function fakeChannel() {
  return {
    id: `chan_${++rec.chan}`, topic: null, parentId: null,
    isTextBased: () => true,
    send: async (opts) => {
      rec.sends.push(opts);
      const hasFile = Array.isArray(opts.files) && opts.files.length > 0;
      return { id: `msg_${++rec.msg}`, attachments: { first: () => hasFile ? { url: `https://cdn.fake/${(opts.files[0] && opts.files[0].name) || 'f.png'}` } : null } };
    },
    permissionOverwrites: { cache: { some: () => false, values: () => [][Symbol.iterator]() }, edit: async () => {}, delete: async () => {} },
    setParent: async () => {}, setTopic: async () => {},
  };
}
function fakeMember(id) {
  return {
    id,
    roles: { add: async (r) => { rec.roleAdds.push(r); }, remove: async (r) => { rec.roleRemoves.push(r); } },
    setNickname: async (n) => { rec.nicks.push(n); return true; },
    send: async () => {},
  };
}
// channelFetch: fn(id) => channel|null. Default: sempre um canal fake.
function fakeGuild({ channelFetch } = {}) {
  return {
    id: 'guild1',
    roles: { everyone: 'everyone_role' },
    channels: {
      create: async (opts) => { rec.created.push(opts); return fakeChannel(); },
      fetch: async (id) => (channelFetch ? channelFetch(id) : fakeChannel()),
    },
    members: { fetch: async (id) => fakeMember(id) },
  };
}
function norm(o) { return typeof o === 'string' ? { content: o } : (o || {}); }
function makeInteraction({ userId, fields = {}, guild, channel = null, member = null }) {
  const it = {
    user: { id: userId }, member, channel,
    guild: guild || fakeGuild(),
    deferred: false, replied: false,
    fields: { getTextInputValue: (k) => (k in fields ? fields[k] : '') },
    isModalSubmit: () => false,
    _replies: [],
    reply: async (o) => { it.replied = true; it._replies.push({ t: 'reply', ...norm(o) }); return o; },
    editReply: async (o) => { it._replies.push({ t: 'editReply', ...norm(o) }); return o; },
    followUp: async (o) => { it._replies.push({ t: 'followUp', ...norm(o) }); return o; },
    update: async (o) => { it._replies.push({ t: 'update', ...norm(o) }); return o; },
    deferReply: async () => { it.deferred = true; },
    deferUpdate: async () => { it.deferred = true; },
    showModal: async () => {},
  };
  return it;
}
const lastReplyText = (it) => (it._replies.map(r => r.content).filter(Boolean).pop() || '');

// ---- Helpers de seed ----
function seedProcesso(numero, extra) {
  return db.inserir('processos', Object.assign({
    numero, tipo: 'Penal', status: 'Instrução', crimes: [], motivo: 'm',
    reuNome: null, reuRg: null, reus: [], partes: [], habilitacoes: [], tentativasHabilitacao: [],
    juiz: 'juiz1', delegado: 'del1', promotor: 'prom1', canalId: 'c-proc',
    intimacaoReuCumpridaEm: new Date().toISOString(), codigoHabilitacao: '1234',
  }, extra));
}

(async () => {
  console.log(`\n== Testes das correções (banco isolado: ${DB_TESTE}) ==\n`);

  // ============ ITEM 10: parseCriadoEm ============
  console.log('Item 10 — parseCriadoEm (pt-BR / ISO / vazio / lixo):');
  {
    const ptbr = parseCriadoEm('13/08/2026, 12:34:56');
    ok(ptbr instanceof Date && !isNaN(ptbr) && ptbr.getFullYear() === 2026 && ptbr.getMonth() === 7 && ptbr.getDate() === 13, 'pt-BR vira Date correta (13/08/2026)');
    const iso = parseCriadoEm('2026-08-13T12:34:56.000Z');
    ok(iso instanceof Date && !isNaN(iso.getTime()) && iso.getTime() === Date.parse('2026-08-13T12:34:56.000Z'), 'ISO vira Date válida (antes: Invalid Date)');
    eq(parseCriadoEm(''), null, 'string vazia → null');
    eq(parseCriadoEm(undefined), null, 'undefined → null');
    eq(parseCriadoEm('xyz-nao-data'), null, 'lixo (sem "/") → null');
  }

  // ============ ITENS 1 + reuIdentificado/dadosBatemComReu (via criarHabilitacao) ============
  console.log('\nItens 1 — habilitação penal por código:');
  {
    // P1: réu NÃO identificado + código CERTO → deve PASSAR sem queimar tentativa
    seedProcesso('0001CR', { reuNome: null, reuRg: null });
    const it1 = makeInteraction({ userId: 'adv1', fields: { nome: 'Fulano', rg: '99', codigo: '1234' } });
    await processoCmd.criarHabilitacao(it1, '0001CR');
    let p = db.buscarPorNumero('processos', '0001CR');
    ok((p.habilitacoes || []).length === 1 && p.habilitacoes[0].status === 'Pendente', 'réu sem nome+RG + código certo → habilitação criada (não trava)');
    eq((p.tentativasHabilitacao || []).length, 0, '  ...e NÃO queimou tentativa (código certo)');

    // P2: réu IDENTIFICADO + dados ERRADOS (código certo) → deve RECUSAR e contar tentativa
    seedProcesso('0002CR', { reuNome: 'Réu Certo', reuRg: '55' });
    const it2 = makeInteraction({ userId: 'adv2', fields: { nome: 'Nome Errado', rg: '00', codigo: '1234' } });
    await processoCmd.criarHabilitacao(it2, '0002CR');
    p = db.buscarPorNumero('processos', '0002CR');
    ok((p.habilitacoes || []).length === 0, 'réu identificado + dados errados → NÃO habilita');
    const t2 = (p.tentativasHabilitacao || []).find(t => t.advogadoId === 'adv2');
    ok(t2 && t2.erros === 1, '  ...e conta 1 tentativa');
    ok(/incorret/i.test(lastReplyText(it2)), '  ...e responde "dados/código incorretos"');

    // P3: réu identificado + dados CERTOS + código certo → PASSA (controle: dadosBatemComReu ok)
    seedProcesso('0003CR', { reuNome: 'Réu Certo', reuRg: '55' });
    const it3 = makeInteraction({ userId: 'adv3', fields: { nome: 'Réu Certo', rg: '55', codigo: '1234' } });
    await processoCmd.criarHabilitacao(it3, '0003CR');
    p = db.buscarPorNumero('processos', '0003CR');
    ok((p.habilitacoes || []).length === 1, 'réu identificado + dados certos → habilita');

    // P4: código ERRADO conta tentativa; depois código CERTO passa sem queimar a tentativa a mais
    seedProcesso('0004CR', { reuNome: null, reuRg: null });
    const it4a = makeInteraction({ userId: 'adv4', fields: { nome: 'X', rg: '1', codigo: '0000' } });
    await processoCmd.criarHabilitacao(it4a, '0004CR');
    p = db.buscarPorNumero('processos', '0004CR');
    let t4 = (p.tentativasHabilitacao || []).find(t => t.advogadoId === 'adv4');
    ok(t4 && t4.erros === 1 && (p.habilitacoes || []).length === 0, 'código errado → recusa e conta tentativa (erros=1)');
    const it4b = makeInteraction({ userId: 'adv4', fields: { nome: 'X', rg: '1', codigo: '1234' } });
    await processoCmd.criarHabilitacao(it4b, '0004CR');
    p = db.buscarPorNumero('processos', '0004CR');
    t4 = (p.tentativasHabilitacao || []).find(t => t.advogadoId === 'adv4');
    ok((p.habilitacoes || []).some(h => h.advogadoId === 'adv4'), 'depois, código certo → habilita');
    eq(t4.erros, 1, '  ...e NÃO incrementou tentativa (código certo não queima as 3)');
  }

  // ============ ITEM 3: referendo grava processoVinculado + documentosAnexados ============
  console.log('\nItem 3 — referendo de medida (schema do mandado):');
  {
    db.inserir('processos', { numero: '0009CR', tipo: 'Penal', status: 'Instrução', canalId: 'cp9', juiz: 'juizM', delegado: 'delM', promotor: 'promM', reus: [] });
    db.inserir('medidas', {
      numero: '0001MD', tipo: 'Busca e Apreensão', status: 'Aprovada - aguardando juiz',
      alvo: 'Alvo X', juiz: 'juizM', delegado: 'delM', promotor: 'promM', canalId: 'cmd1',
      processoVinculado: '0009CR', fundamentacaoPromotor: 'fp',
    });
    const itR = makeInteraction({ userId: 'juizM', guild: fakeGuild() });
    await medidaCmd.processarReferendo(itR, '0001MD', 'Fundamentação do Juízo.');

    const mand = db.todos('mandados', m => m.medidaNumero === '0001MD')[0];
    ok(!!mand, 'mandado do referendo foi criado');
    eq(mand && mand.processoVinculado, '0009CR', '  ...com processoVinculado preenchido (antes: ausente)');
    eq(mand && mand.medidaNumero, '0001MD', '  ...e medidaNumero preenchido');
    const doc = db.todos('documentosAnexados', d => d.atoOrigemId === (mand && mand.numero))[0];
    ok(!!doc && doc.tipo === 'mandado', '  ...e o PNG entrou em documentosAnexados (antes: só o mandado direto registrava)');
    eq(doc && doc.protocoloVinculado, '0009CR', '  ...com protocolo = processo vinculado');

    // Controle: medida SEM processo vinculado → processoVinculado null, protocolo = número da medida
    db.inserir('medidas', { numero: '0002MD', tipo: 'Prisão', status: 'Aprovada - aguardando juiz', alvo: 'Y', juiz: 'juizM', delegado: 'delM', promotor: 'promM', canalId: 'cmd2', fundamentacaoPromotor: 'fp2' });
    const itR2 = makeInteraction({ userId: 'juizM', guild: fakeGuild() });
    await medidaCmd.processarReferendo(itR2, '0002MD', 'Fund.');
    const mand2 = db.todos('mandados', m => m.medidaNumero === '0002MD')[0];
    eq(mand2 && mand2.processoVinculado, null, 'medida sem processo → mandado.processoVinculado = null');
    const doc2 = db.todos('documentosAnexados', d => d.atoOrigemId === (mand2 && mand2.numero))[0];
    eq(doc2 && doc2.protocoloVinculado, '0002MD', '  ...e protocolo cai pro número da medida');
  }

  // ============ ITEM 8: anulação limpa sentencaPorCrime ============
  console.log('\nItem 8 — anulação (finalizarApelacao) limpa sentencaPorCrime:');
  {
    db.inserir('processos', {
      numero: '0010CR', tipo: 'Penal', status: 'Encerrado', canalId: 'cp10',
      juiz: 'juizA', delegado: 'delA', promotor: 'promA', autor: null, reus: [],
      sentenca: 'texto da sentença', resultado: 'Condenado',
      sentencaPorCrime: [{ nome: 'Homicídio', codigo_artigo: '121', resultado: 'Condenado' }],
    });
    db.inserir('apelacoes', { numero: '0001AP', status: 'Aguardando decisão', desembargadorId: 'des1', processoOriginalNumero: '0010CR', canalId: 'cap1' });
    const guildNoCanal = fakeGuild({ channelFetch: () => null }); // pula ops de canal
    const itA = makeInteraction({ userId: 'des1', guild: guildNoCanal, channel: null });
    try { await processoCmd.finalizarApelacao(itA, '0001AP', 'anular', { fundamentacao: 'Anulada por nulidade.' }); }
    catch (e) { console.log(`     (aviso: finalizarApelacao lançou após a limpeza — ${e.message})`); }
    const p10 = db.buscarPorNumero('processos', '0010CR');
    eq(p10.sentencaPorCrime, null, 'sentencaPorCrime foi limpo (antes: ficava órfão)');
    eq(p10.sentenca, null, '  ...sentenca limpa');
    eq(p10.resultado, null, '  ...resultado limpo');
  }

  // ============ ITEM 4: AlvaraEvento NÃO grava endereço na ficha do organizador ============
  console.log('\nItem 4 — AlvaraEvento não polui a ficha com o local do evento:');
  {
    const itAE = makeInteraction({
      userId: 'adv-ae', guild: fakeGuild(),
      fields: { pessoas: '20', rg: 'RG-AE', nome: 'Organizador Nome', evento: 'Festa Junina', local: 'Rua do Evento, 123' },
    });
    try { await peticaoCmd.processarModalAlvaraEvento(itAE); }
    catch (e) { console.log(`     (aviso: fluxo lançou após a criação — ${e.message})`); }
    const fAE = ficha.buscarPorRG('RG-AE');
    ok(!!fAE, 'ficha do organizador foi criada (nome+RG)');
    eq((fAE && fAE.enderecos || []).length, 0, '  ...mas SEM endereço gravado (o local do evento não vira endereço pessoal)');

    // Controle: PorteArma DEVE gravar o endereço do cliente (prova que adicionarEndereco funciona)
    const itPA = makeInteraction({
      userId: 'adv-pa', guild: fakeGuild(),
      fields: { rg: 'RG-PA', nome: 'Cliente Nome', endereco: 'Rua de Casa, 1' },
    });
    try { await peticaoCmd.processarModalPorteArma(itPA); }
    catch (e) { console.log(`     (aviso: fluxo PorteArma lançou após a criação — ${e.message})`); }
    const fPA = ficha.buscarPorRG('RG-PA');
    ok(fPA && (fPA.enderecos || []).length === 1 && /Rua de Casa/.test(fPA.enderecos[0].endereco), 'controle: PorteArma grava o endereço do cliente normalmente');
  }

  // ============ ITEM 11: RH ============
  console.log('\nItem 11 — RH (troca de cargo remove role antiga; auto-atendimento restrito):');
  {
    // 11a: promover Delegado → Juiz remove a role de Delegado e adiciona a de Juiz
    rh.contratar('userX', 'Delegado', 'Personagem X');
    rec.roleAdds.length = 0; rec.roleRemoves.length = 0;
    await rhCmd.contratarComRole(fakeGuild(), 'userX', 'Juiz', 'staff1', 'Personagem X');
    ok(rec.roleRemoves.includes(config.roleDelegadoId), '11a: role antiga (Delegado) removida ao trocar de cargo');
    ok(rec.roleAdds.includes(config.roleJuizId), '  ...e role nova (Juiz) adicionada');
    eq((rh.getCargo('userX') || {}).cargo, 'Juiz', '  ...e o registro do rh agora é Juiz');

    // 11b (select): auto-atendimento não oferece Juiz/Desembargador/Procurador
    const menu = rhCmd.selectCargoDesejado().toJSON().components[0];
    const vals = menu.options.map(o => o.value);
    ok(!vals.includes('Juiz') && !vals.includes('Desembargador') && !vals.includes('Procurador'), '11b: select de auto-atendimento oculta cargos altos');
    ok(vals.includes('Delegado') && vals.includes('Promotor') && vals.includes('Advogado'), '  ...e mantém os cargos autossolicitáveis');

    // 11b (handler): solicitar 'Juiz' é rejeitado e NÃO cria solicitação
    // RG obrigatório no formulário de cargo (Update 2): o mock precisa fornecê-lo, senão a rejeição
    // viria do check de RG e não da trava de cargo alto (o que este teste quer isolar).
    const antes = db.todos('solicitacoesCargo').length;
    const itJ = makeInteraction({ userId: 'userY', guild: fakeGuild(), fields: { nome: 'Nome Y', rg: 'RG-Y' } });
    await rhCmd.solicitarCargo(itJ, 'Juiz');
    ok(/não pode ser solicitad/i.test(lastReplyText(itJ)), '11b: solicitar cargo alto (Juiz) é recusado no handler');
    eq(db.todos('solicitacoesCargo').length, antes, '  ...e nenhuma solicitação foi criada');

    // Controle: solicitar 'Advogado' cria a solicitação normalmente (RG obrigatório — Update 2)
    const itAdv = makeInteraction({ userId: 'userZ', guild: fakeGuild(), fields: { nome: 'Nome Z', rg: 'RG-Z' } });
    await rhCmd.solicitarCargo(itAdv, 'Advogado');
    const sol = db.todos('solicitacoesCargo', s => s.discordId === 'userZ' && s.cargo === 'Advogado')[0];
    ok(!!sol && sol.status === 'Pendente', 'controle: solicitar Advogado (baixo) cria a solicitação');
  }

  // ============ ITEM 2: /processo civil com @ opcional (backend criarProcessoCivil) ============
  console.log('\nItem 2 — abrir processo civil sem @ (autor/réu só por nome):');
  {
    let r = null, erro = null;
    try {
      r = await processoCmd.criarProcessoCivil({
        guild: fakeGuild(), advogadoId: 'advC', nomeAcao: 'Ação indenizatória',
        autorNome: 'Autor Sem Discord', autorDiscordId: null,
        reuNome: 'Réu Sem Discord', reuDiscordId: null,
      });
    } catch (e) { erro = e; }
    ok(!erro && r && r.numero, 'criarProcessoCivil aceita autor/réu SEM Discord (não lança)');
    const pc = r && db.buscarPorNumero('processos', r.numero);
    ok(pc && pc.autorNome === 'Autor Sem Discord' && !pc.autorDiscordId && !pc.reuDiscordId, '  ...processo criado com autorDiscordId/reuDiscordId nulos');
  }

  // ============ ITEM 6: TrocaNome deferida sem vínculo avisa (não pula em silêncio) ============
  console.log('\nItem 6 — TrocaNome sem discordIdCliente avisa que o apelido não muda:');
  {
    // Sem vínculo
    db.inserir('peticoes', { numero: '0001TN', tipo: 'TrocaNome', requerenteId: 'advT', juiz: 'juizT', promotor: null, status: 'Pendente', canalId: 'ctn1', rgCliente: 'RG-TN', nomeAtual: 'Nome Velho', nomeNovo: 'Nome Novo', discordIdCliente: null });
    rec.sends.length = 0;
    await peticaoCmd.finalizarDecisao(fakeGuild(), '0001TN', 'Deferido', { motivo: 'deferido' }, 'juizT');
    const avisouSemVinculo = rec.sends.some(s => JSON.stringify(s).includes('não tem conta de Discord vinculada'));
    ok(avisouSemVinculo, 'sem vínculo → posta aviso "apelido não será alterado" (antes: silêncio)');
    ok((ficha.buscarPorRG('RG-TN') || {}).nomeCivil === 'Nome Novo', '  ...e ainda retifica o nome civil no registro');

    // Controle: com vínculo (membro existe) → aplica apelido, mostra ✅, sem o aviso ℹ️
    db.inserir('peticoes', { numero: '0002TN', tipo: 'TrocaNome', requerenteId: 'advT', juiz: 'juizT', promotor: null, status: 'Pendente', canalId: 'ctn2', rgCliente: 'RG-TN2', nomeAtual: 'A', nomeNovo: 'Nome Aplicado', discordIdCliente: 'cliente123' });
    rec.sends.length = 0; rec.nicks.length = 0;
    await peticaoCmd.finalizarDecisao(fakeGuild(), '0002TN', 'Deferido', { motivo: 'ok' }, 'juizT');
    ok(rec.nicks.includes('Nome Aplicado'), 'controle: com vínculo → setNickname aplicado');
    ok(!rec.sends.some(s => JSON.stringify(s).includes('não tem conta de Discord vinculada')), '  ...e NÃO mostra o aviso de "sem vínculo"');
  }

  // ============ ITEM 7: removerHabilitacao não monta <@null> quando réu é só nome/RG ============
  console.log('\nItem 7 — removerHabilitacao com réu sem Discord (reuId null):');
  {
    db.inserir('processos', { numero: '0020CR', tipo: 'Penal', status: 'Instrução', canalId: 'c20', juiz: 'juizH', delegado: 'delH', promotor: 'promH', reus: [],
      habilitacoes: [{ id: 1, reuId: null, reuNome: 'Réu Sem Discord', advogadoId: 'advH', nomeCliente: 'Réu Sem Discord', rgCliente: '77', status: 'Aprovado' }] });
    const itH = makeInteraction({ userId: 'juizH', guild: fakeGuild() });
    rec.sends.length = 0;
    await processoCmd.removerHabilitacao(itH, '0020CR', '1');
    const textoCanal = rec.sends.map(s => JSON.stringify(s)).join(' ');
    const textoUpdate = itH._replies.map(r => r.content || '').join(' ');
    ok(!/<@null>/.test(textoCanal + textoUpdate), 'nenhuma menção quebrada <@null> gerada');
    ok(/Réu Sem Discord/.test(textoCanal) || /Réu Sem Discord/.test(textoUpdate), '  ...usa o nome do réu no lugar da menção');
  }

  // ============ ITEM 9: flag "avisado" só após canal.send bem-sucedido ============
  console.log('\nItem 9 — prazos: envio que falha NÃO marca o flag (retenta depois):');
  {
    const desde30h = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    db.inserir('medidas', { numero: '0050MD', tipo: 'Prisão', status: 'Aguardando MP', promotor: 'promP', delegado: 'delP', canalId: 'cm50', aguardandoMpDesde: desde30h });
    const prazos = require('../utils/prazos');
    const clienteDummy = { users: { fetch: async () => ({ send: async () => {} }) } };

    // 1) canal.send FALHA → flag deve continuar falsy (aviso será retentado)
    const guildFalha = { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { throw new Error('discord fora do ar'); } }) } };
    await prazos.verificarMedidasAguardandoMP(clienteDummy, guildFalha);
    let m = db.buscarPorNumero('medidas', '0050MD');
    ok(!m.lembreteMpEnviado, 'envio falhou → lembreteMpEnviado continua falsy (antes: já marcava e perdia o aviso)');

    // 2) canal.send OK → agora o flag é gravado
    const guildOk = fakeGuild();
    await prazos.verificarMedidasAguardandoMP(clienteDummy, guildOk);
    m = db.buscarPorNumero('medidas', '0050MD');
    ok(m.lembreteMpEnviado === true, 'envio ok → lembreteMpEnviado gravado (após o send)');
  }

  // ============ ITEM 12: Trava de manifestação do MP em petição (Parte 1) ============
  console.log('\nItem 12 — trava de manifestação do MP (petição): bloqueio/liberação/decurso/lazy:');
  {
    const agora = Date.now();
    const recente = new Date(agora - 2 * 60 * 60 * 1000).toISOString();   // 2h atrás (dentro das 24h)
    const antigo = new Date(agora - 25 * 60 * 60 * 1000).toISOString();   // 25h atrás (prazo estourado)

    // 12a: sem manifestação, dentro das 24h → deferir travado
    db.inserir('peticoes', { numero: '9001PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'c1', sorteioPromotorEm: recente, manifestacoesMp: [] });
    const it1 = makeInteraction({ userId: 'juizP', guild: fakeGuild() });
    await peticaoCmd.decidir(it1, '9001PA', 'deferir');
    ok(/Aguardando manifestação do Ministério Público/i.test(lastReplyText(it1)), '12a: deferir travado sem manifestação (dentro das 24h)');

    // 12b: com manifestação → deferir liberado (vai pro diálogo de confirmação)
    db.inserir('peticoes', { numero: '9002PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'c2', sorteioPromotorEm: recente, manifestacoesMp: [{ posicao: 'Nada a opor', autorId: 'promP', data: recente }] });
    const it2 = makeInteraction({ userId: 'juizP', guild: fakeGuild() });
    await peticaoCmd.decidir(it2, '9002PA', 'deferir');
    ok(/Confirma que os documentos/i.test(lastReplyText(it2)), '12b: com manifestação, deferir é liberado');

    // 12c: decurso — 25h sem manifestação → deferir liberado (sem trava)
    db.inserir('peticoes', { numero: '9003PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'c3', sorteioPromotorEm: antigo, manifestacoesMp: [] });
    const it3 = makeInteraction({ userId: 'juizP', guild: fakeGuild() });
    await peticaoCmd.decidir(it3, '9003PA', 'deferir');
    ok(/Confirma que os documentos/i.test(lastReplyText(it3)) && !/Aguardando manifest/i.test(lastReplyText(it3)), '12c: decurso das 24h libera a decisão');

    // 12d: diligência NÃO é travada (a trava é só sobre a decisão final)
    const it4 = makeInteraction({ userId: 'juizP', guild: fakeGuild() });
    await peticaoCmd.decidir(it4, '9001PA', 'diligencia');
    ok(!/Aguardando manifest/i.test(lastReplyText(it4)), '12d: diligência não é bloqueada pela trava');

    // 12e: liberação é LAZY — estadoManifestacaoMp libera após 24h sem rodar job nenhum
    const petLazy = { sorteioPromotorEm: recente, manifestacoesMp: [] };
    const bloqAgora = peticaoCmd.estadoManifestacaoMp(petLazy, agora).bloqueado;
    const bloqFuturo = peticaoCmd.estadoManifestacaoMp(petLazy, agora + 25 * 60 * 60 * 1000).bloqueado;
    ok(bloqAgora === true && bloqFuturo === false, '12e: liberação lazy (bloqueado agora, liberado após 24h — sem cron/job)');

    // 12f: decidir sem manifestação após o prazo grava o texto de decurso nos autos
    rec.sends.length = 0;
    db.inserir('peticoes', { numero: '9004PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'c4', sorteioPromotorEm: antigo, manifestacoesMp: [], nomeCliente: 'C', rgCliente: 'r' });
    await peticaoCmd.finalizarDecisao(fakeGuild(), '9004PA', 'Indeferido', { motivo: 'm' }, 'juizP');
    ok(rec.sends.some(s => /Decorrido o prazo de 24/i.test(s.content || '')), '12f: decurso grava o texto de prazo decorrido nos autos');

    // 12g: petição sem sorteioPromotorEm (aberta antes da mudança) → sem trava (fluxo antigo)
    db.inserir('peticoes', { numero: '9005PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'c5', manifestacoesMp: [] });
    const it5 = makeInteraction({ userId: 'juizP', guild: fakeGuild() });
    await peticaoCmd.decidir(it5, '9005PA', 'deferir');
    ok(/Confirma que os documentos/i.test(lastReplyText(it5)), '12g: petição pré-mudança (sem sorteioPromotorEm) não é travada');
  }

  // ============ ITEM 13: Manifestação do MP — fluxo aditivo (Parte 1) ============
  console.log('\nItem 13 — manifestação do MP (registro, IA-fallback, gates):');
  {
    const cartorio = require('../utils/cartorio');
    const memberFalse = { permissions: { has: () => false }, roles: { cache: { has: () => false } } };
    const mkProm = (fields) => makeInteraction({ userId: 'promP', guild: fakeGuild(), fields: fields || {}, member: memberFalse });
    const mkPet = (numero, extra = {}) => db.inserir('peticoes', Object.assign({ numero, tipo: 'PorteArma', status: 'Pendente', juiz: 'juizP', promotor: 'promP', canalId: 'cm', sorteioPromotorEm: new Date().toISOString(), manifestacoesMp: [], nomeCliente: 'C', rgCliente: 'r' }, extra));
    const getPet = (numero) => db.buscarPorNumero('peticoes', numero);

    // 13a: "Nada a opor" registra em 1 clique, sem modal/texto
    mkPet('9101PA');
    const it1 = mkProm();
    await peticaoCmd.registrarNadaAOpor(it1, '9101PA');
    const m1 = getPet('9101PA').manifestacoesMp;
    ok(m1.length === 1 && m1[0].posicao === 'Nada a opor' && m1[0].fundamentacao === null, '13a: "Nada a opor" registra em 1 clique (sem texto)');

    // 13b: Favorável com fundamentação registra o texto (modal -> registrar assim, sem IA)
    mkPet('9102PA');
    await peticaoCmd.processarModalManifestacao(mkProm({ fundamentacao: 'Parecer favorável fundamentado.' }), '9102PA#favoravel');
    await peticaoCmd.finalizarManifestacao(mkProm(), '9102PA', false);
    const m2 = getPet('9102PA').manifestacoesMp;
    ok(m2.length === 1 && m2[0].posicao === 'Favorável' && /favorável fundamentado/i.test(m2[0].fundamentacao), '13b: Favorável com fundamentação registra o texto');

    // 13c: IA fora do ar → fallback registra o texto ORIGINAL (não congela o fluxo)
    const revOrig = cartorio.revisarTexto;
    cartorio.revisarTexto = async () => null; // simula IA indisponível/timeout
    mkPet('9103PA');
    await peticaoCmd.processarModalManifestacao(mkProm({ fundamentacao: 'Texto original do promotor.' }), '9103PA#desfavoravel');
    const itRev = mkProm();
    await peticaoCmd.revisarManifestacao(itRev, '9103PA');
    const caiuNoFallback = itRev._replies.some(r => /não está disponível|texto original/i.test(r.content || ''));
    await peticaoCmd.finalizarManifestacao(mkProm(), '9103PA', false);
    const m3 = getPet('9103PA').manifestacoesMp;
    cartorio.revisarTexto = revOrig; // restaura
    ok(caiuNoFallback && m3.length === 1 && /original do promotor/i.test(m3[0].fundamentacao), '13c: IA fora do ar → fallback registra o texto original (não congela)');

    // 13d: fundamentação vazia em Favorável/Desfavorável é barrada, nada registrado
    mkPet('9104PA');
    const it4 = mkProm({ fundamentacao: '   ' });
    await peticaoCmd.processarModalManifestacao(it4, '9104PA#favoravel');
    ok(/obrigatória/i.test(lastReplyText(it4)) && getPet('9104PA').manifestacoesMp.length === 0, '13d: fundamentação vazia é barrada');

    // 13e: juiz não pode manifestar (é o MP fiscalizando, não o julgador)
    mkPet('9105PA');
    const itJuiz = makeInteraction({ userId: 'juizP', guild: fakeGuild(), member: memberFalse });
    await peticaoCmd.registrarNadaAOpor(itJuiz, '9105PA');
    ok(/Só o Promotor/i.test(lastReplyText(itJuiz)) && getPet('9105PA').manifestacoesMp.length === 0, '13e: juiz é barrado de se manifestar');

    // 13f: manifestação DEPOIS do prazo (25h), antes da decisão, ainda é aceita
    mkPet('9106PA', { sorteioPromotorEm: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    await peticaoCmd.registrarNadaAOpor(mkProm(), '9106PA');
    ok(getPet('9106PA').manifestacoesMp.length === 1, '13f: manifestação após o prazo (antes da decisão) é aceita');
  }

  // ---- Resumo ----
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL no runner:', e); try { fs.unlinkSync(DB_TESTE); } catch (_) {} process.exit(2); });
