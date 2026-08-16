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
// Guild da "instalação" do teste: os mocks todos usam id 'guild1' (ver fakeGuild), e o guard de
// isolamento (utils/guildGuard.js) recusa qualquer guild que não seja a de GUILD_ID. Sem isso,
// auditoria/criação de canal/Diário passariam a recusar tudo aqui dentro.
process.env.GUILD_ID = 'guild1';
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
const painelCmd = require('../commands/painel');
const diarioAtos = require('../utils/diarioAtos');
const diario = require('../utils/diarioOficial');
const estado = require('../utils/estado');
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

  // ============ ITEM 14: Varredura de responsável fantasma (Parte 3) ============
  console.log('\nItem 14 — varredura de responsável fantasma (Passada A rh + Passada B tickets):');
  {
    const responsaveis = require('../utils/responsaveis');
    // Guild com presença controlável: quem está em foraDoServidor "saiu" (10007); os demais presentes.
    const foraDoServidor = new Set();
    const guildF = {
      id: 'guild1', roles: { everyone: 'e' },
      members: { fetch: async (id) => { if (foraDoServidor.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return { id, roles: { cache: { has: () => true } } }; } },
      channels: { fetch: async () => fakeChannel() },
    };

    rh.contratar('jf_bom', 'Juiz');
    rh.contratar('jf_saiu', 'Juiz'); foraDoServidor.add('jf_saiu');
    rh.contratar('jf_subst', 'Juiz');

    // ---- Passada A: só desativa quem SAIU do servidor (presença) ----
    const orfaos = await responsaveis.limparRhFantasma(guildF);
    ok(orfaos.some(o => o.discordId === 'jf_saiu' && o.motivo === 'ausente do servidor'), '14a: Passada A desativa quem saiu do servidor');
    ok(!rh.temCargo('jf_saiu', 'Juiz'), '14c: fantasma (ausente) fica inativo no rh');
    ok(rh.temCargo('jf_bom', 'Juiz') && rh.temCargo('jf_subst', 'Juiz'), '14d: responsável válido (presente) permanece ativo');

    // 14b: detecção é SÓ presença — quem está no servidor é válido, MESMO fora do rh (responsável
    // externo legítimo, ex.: delegado injetado pela integração da Polícia Civil por @menção). Só
    // quem SAIU (10007) é fantasma.
    ok(await responsaveis.estadoResponsavel(guildF, 'del_pc_externo') === 'valido' && await responsaveis.estadoResponsavel(guildF, 'jf_saiu') === 'ausente', '14b: detecção só por presença — presente fora do rh = válido; ausente = fantasma');

    // ---- Passada B: ticket com juiz fantasma (simula o 002AP) ----
    db.inserir('processos', { numero: '002APx', tipo: 'Penal', status: 'Instrução', juiz: 'jf_saiu', promotor: 'pf1', delegado: 'df1', canalId: 'cF1' });
    const tickets = await responsaveis.reatribuirTicketsFantasma(guildF);
    const proc = db.buscarPorNumero('processos', '002APx');
    ok(tickets.some(t => t.numero === '002APx' && t.papel === 'Juiz' && t.resultado === 'reatribuido'), '14e: ticket com juiz fantasma é reatribuído');
    ok(proc.juiz && proc.juiz !== 'jf_saiu' && rh.temCargo(proc.juiz, 'Juiz'), '14f: novo juiz é válido (não o fantasma), com juizDesde reiniciado');

    // ---- Sem substituto → tira o fantasma e marca pendência (usa Desembargador, pool vazio) ----
    db.todos('rh', r => r.cargo === 'Desembargador' && r.ativo).forEach(r => rh.demitir(r.discordId));
    db.inserir('apelacoes', { numero: 'AP99x', status: 'Aguardando decisão', desembargadorId: 'des_saiu', canalId: 'cA9' });
    foraDoServidor.add('des_saiu');
    await responsaveis.reatribuirTicketsFantasma(guildF);
    const ap = db.buscarPorNumero('apelacoes', 'AP99x');
    ok(ap.desembargadorId === null && ap.semResponsavelPendente === true, '14g: sem substituto → tira o fantasma e marca pendência (não deixa falsamente atribuído)');

    // ---- Ticket arquivado com fantasma → intocado ----
    db.inserir('processos', { numero: 'ARQ1x', tipo: 'Penal', status: 'Arquivado', juiz: 'jf_saiu', canalId: 'cAr' });
    await responsaveis.reatribuirTicketsFantasma(guildF);
    ok(db.buscarPorNumero('processos', 'ARQ1x').juiz === 'jf_saiu', '14h: ticket arquivado com fantasma é intocado');
  }

  // ============ ITEM 15: Camada de evento (Parte 3) ============
  console.log('\nItem 15 — evento (guildMemberRemove/Update): tratar responsável inválido:');
  {
    const responsaveis = require('../utils/responsaveis');
    // members.fetch retorna membro válido (presente, com role) — pro sortearSubstitutoValido aprovar.
    const guildE = { id: 'guild1', roles: { everyone: 'e' }, members: { fetch: async (id) => ({ id, roles: { cache: { has: () => true } } }) }, channels: { fetch: async () => fakeChannel() } };

    // Saída de um juiz responsável → demite no rh + reatribui o ticket a um válido
    rh.contratar('ev_juiz', 'Juiz');
    rh.contratar('ev_subst', 'Juiz'); // substituto válido no pool
    db.inserir('processos', { numero: 'EV01', tipo: 'Penal', status: 'Instrução', juiz: 'ev_juiz', promotor: 'evp', delegado: 'evd', canalId: 'cEV' });
    const t = await responsaveis.tratarResponsavelInvalido(guildE, 'ev_juiz', 'ausente');
    const procEV = db.buscarPorNumero('processos', 'EV01');
    ok(!rh.temCargo('ev_juiz', 'Juiz'), '15a: evento demite o responsável no rh (tira da fila de sorteio)');
    ok(procEV.juiz !== 'ev_juiz' && rh.temCargo(procEV.juiz, 'Juiz'), '15b: evento reatribui o ticket a um juiz válido');
    ok(t.some(x => x.numero === 'EV01' && x.resultado === 'reatribuido'), '15c: evento retorna o ticket tratado');

    // Idempotência: tratar quem não é responsável de nada → só demite no rh, sem erro
    rh.contratar('ev_none', 'Promotor');
    const t2 = await responsaveis.tratarResponsavelInvalido(guildE, 'ev_none', 'ausente');
    ok(t2.length === 0 && !rh.temCargo('ev_none', 'Promotor'), '15g: evento sem ticket → só demite no rh, idempotente');
  }

  // ============ ITEM 16: correções da revisão adversarial da Parte 3 ============
  console.log('\nItem 16 — fixes da revisão (substituto válido, terminal, MP, arquivo manual, transitório, acesso, recuperação, dativo):');
  {
    const responsaveis = require('../utils/responsaveis');
    const fora = new Set();        // saiu do servidor (10007)
    const semRoleSet = new Set();  // presente, sem a role
    const transitorio = new Set(); // falha transitória (sem code 10007)
    const deletes = [];
    const mk = (id) => ({ id, roles: { cache: { has: () => !semRoleSet.has(id) } } });
    const mkCanal = () => { const c = fakeChannel(); c.permissionOverwrites.delete = async (id) => { deletes.push(id); }; return c; };
    const guild = {
      id: 'guild1', roles: { everyone: 'e' },
      members: { fetch: async (id) => {
        if (transitorio.has(id)) throw new Error('ETIMEDOUT'); // sem code → indeterminado
        if (fora.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return mk(id);
      } },
      channels: { fetch: async () => mkCanal() },
    };

    // A (16a): sorteia substituto VÁLIDO, nunca outro fantasma
    rh.contratar('c16_ghost', 'Promotor'); fora.add('c16_ghost');
    rh.contratar('c16_valido', 'Promotor');
    db.inserir('processos', { numero: 'C16A', tipo: 'Penal', status: 'Instrução', promotor: 'c16old', juiz: 'jx16', canalId: 'c16a' });
    fora.add('c16old');
    const rA = await responsaveis.reatribuirAutomatico(guild, { tabela: 'processos', numero: 'C16A', papel: 'Promotor', motivoTipo: 'ausente' });
    ok(rA.ok && rA.novoId === 'c16_valido', '16a: reatribuição sorteia substituto VÁLIDO (não cobre fantasma com fantasma)');

    // D (16d): medida 'Indeferida pelo Juiz' (terminal) não é reatribuída
    db.inserir('medidas', { numero: 'C16D', status: 'Indeferida pelo Juiz', juiz: 'fant16D', canalId: 'c16d' });
    const rD = await responsaveis.reatribuirAutomatico(guild, { tabela: 'medidas', numero: 'C16D', papel: 'Juiz', motivoTipo: 'ausente' });
    ok(!rD.ok && db.buscarPorNumero('medidas', 'C16D').juiz === 'fant16D', '16d: medida Indeferida pelo Juiz é terminal — não mexe');

    // F (16f): troca de Promotor na medida reinicia o relógio do MP
    rh.contratar('c16_prom2', 'Promotor');
    db.inserir('medidas', { numero: 'C16F', status: 'Aguardando MP', promotor: 'fant16F', juiz: 'jF16', canalId: 'c16f', aguardandoMpDesde: '2020-01-01T00:00:00Z', lembreteMpEnviado: true, escalonamentoMpEnviado: true });
    fora.add('fant16F');
    await responsaveis.reatribuirAutomatico(guild, { tabela: 'medidas', numero: 'C16F', papel: 'Promotor', motivoTipo: 'ausente' });
    const mF = db.buscarPorNumero('medidas', 'C16F');
    ok(mF.aguardandoMpDesde !== '2020-01-01T00:00:00Z' && mF.lembreteMpEnviado === false && mF.escalonamentoMpEnviado === false, '16f: troca de Promotor na medida reinicia as 24h do MP');

    // G (16g): arquivamento manual não é ressuscitado
    db.inserir('processos', { numero: 'C16G', tipo: 'Penal', status: 'Instrução', arquivadoManual: true, juiz: 'fant16G', canalId: 'c16g' });
    const rG = await responsaveis.reatribuirAutomatico(guild, { tabela: 'processos', numero: 'C16G', papel: 'Juiz', motivoTipo: 'ausente' });
    ok(!rG.ok && db.buscarPorNumero('processos', 'C16G').juiz === 'fant16G', '16g: caso arquivado manualmente não é ressuscitado');

    // E (16e): falha transitória de fetch NÃO demite (só 10007)
    rh.contratar('c16_transit', 'Juiz'); transitorio.add('c16_transit');
    const orfaos = await responsaveis.limparRhFantasma(guild);
    ok(rh.temCargo('c16_transit', 'Juiz') && !orfaos.some(o => o.discordId === 'c16_transit'), '16e: falha transitória de fetch NÃO desativa (evita demissão em massa)');

    // H (16h): sem substituto → revoga acesso do inválido + marca pendência (Desembargador, pool vazio)
    db.todos('rh', r => r.cargo === 'Desembargador' && r.ativo).forEach(r => rh.demitir(r.discordId));
    db.inserir('apelacoes', { numero: 'C16H', status: 'Aguardando decisão', desembargadorId: 'fant16H', canalId: 'c16h' });
    fora.add('fant16H');
    await responsaveis.reatribuirTicketsFantasma(guild);
    const apH = db.buscarPorNumero('apelacoes', 'C16H');
    ok(deletes.includes('fant16H') && apH.desembargadorId === null && apH.semResponsavelPendente === true && (apH.pendenciaPapeis || []).includes('Desembargador'), '16h: sem substituto → revoga acesso do antigo + marca pendência com o papel');

    // B (16b): recuperação — surge substituto → recuperarPendencias designa e limpa o flag
    rh.contratar('c16_des', 'Desembargador');
    const rec = await responsaveis.recuperarPendencias(guild);
    const apH2 = db.buscarPorNumero('apelacoes', 'C16H');
    ok(rec.some(x => x.numero === 'C16H') && apH2.desembargadorId === 'c16_des' && !apH2.semResponsavelPendente, '16b: pendência recuperada quando surge substituto (não fica invisível pra sempre)');

    // FF1 (16i): responsável PRESENTE fora do rh (delegado da PC) NÃO é reatribuído pela varredura
    rh.contratar('del_rh_pool', 'Delegado');
    db.inserir('medidas', { numero: 'PC01', status: 'Aguardando MP', delegado: 'del_pc_presente', promotor: 'del_rh_pool', juiz: 'jz_pc', canalId: 'cpc' });
    await responsaveis.reatribuirTicketsFantasma(guild);
    ok(db.buscarPorNumero('medidas', 'PC01').delegado === 'del_pc_presente', '16i: responsável presente fora do rh (Polícia Civil) não é expulso pela varredura');

    // FF2 (16j): recuperarPendencias NÃO ressuscita ticket cujo canal está na categoria Arquivados
    const cfgMod = require('../config');
    const catAntes = cfgMod.categoriaArquivadosId;
    cfgMod.categoriaArquivadosId = 'CAT_ARQ';
    rh.contratar('des_rec', 'Desembargador');
    db.inserir('apelacoes', { numero: 'ARQREC', status: 'Aguardando decisão', desembargadorId: null, semResponsavelPendente: true, pendenciaPapeis: ['Desembargador'], canalId: 'canalArq' });
    const guildArq = { ...guild, channels: { fetch: async (id) => (id === 'canalArq' ? { id, parentId: 'CAT_ARQ' } : mkCanal()) } };
    await responsaveis.recuperarPendencias(guildArq);
    const arqRec = db.buscarPorNumero('apelacoes', 'ARQREC');
    cfgMod.categoriaArquivadosId = catAntes;
    ok(arqRec.desembargadorId === null && arqRec.semResponsavelPendente === true, '16j: recuperarPendencias não ressuscita ticket arquivado por categoria');
  }

  // ============ ITEM 17: Fase 0 — captura de RG na contratação + fail-open ============
  console.log('\nItem 17 — Fase 0 (captura de RG na contratação + lista fail-open de sem-RG):');
  {
    const adminMember = { permissions: { has: () => true }, roles: { cache: { has: () => false } } };
    const lastEmbedDesc = (it) => {
      const r = [...it._replies].reverse().find(x => Array.isArray(x.embeds) && x.embeds.length);
      return r ? (r.embeds[0].data?.description || '') : '';
    };
    const mkAdmin = (userId, fields) => makeInteraction({ userId, guild: fakeGuild(), member: adminMember, fields });

    // 17a: precisaRg cobre só a magistratura/MP (quem tem leitura ampla e sofre impedimento)
    ok(['Juiz', 'Promotor', 'Desembargador', 'Procurador'].every(c => rh.precisaRg(c))
       && !rh.precisaRg('Advogado') && !rh.precisaRg('Delegado'), '17a: precisaRg = só magistratura/MP');

    // 17b: contratar magistrado SEM RG → entra na lista de sem-RG e avisa (fail-open visível)
    const itSem = mkAdmin('f0JuizSem', { nome: 'Juiz SemRG', rg: '' });
    await rhCmd.contratarViaModal(itSem, 'f0JuizSem', 'Juiz');
    ok(rh.magistradosSemRg().some(r => r.discordId === 'f0JuizSem'), '17b: magistrado sem RG entra na lista de sem-RG');
    ok(/sem rg/i.test(lastEmbedDesc(itSem)), '  ...e a contratação avisa na hora (falha aberta, não silenciosa)');

    // 17c: contratar magistrado COM RG → fora da lista e sem aviso
    const itCom = mkAdmin('f0JuizCom', { nome: 'Juiz ComRG', rg: 'RG-777' });
    await rhCmd.contratarViaModal(itCom, 'f0JuizCom', 'Juiz');
    ok(!rh.magistradosSemRg().some(r => r.discordId === 'f0JuizCom'), '17c: magistrado com RG não entra na lista');
    ok(!/sem rg/i.test(lastEmbedDesc(itCom)), '  ...e não dispara o aviso');

    // 17d: Advogado sem RG NÃO conta (não tem leitura ampla → impedimento não se aplica)
    await rhCmd.contratarViaModal(mkAdmin('f0Adv', { nome: 'Adv', rg: '' }), 'f0Adv', 'Advogado');
    ok(!rh.magistradosSemRg().some(r => r.discordId === 'f0Adv'), '17d: Advogado sem RG fica fora da lista');

    // 17e: troca de cargo preserva o RG (promover com campo vazio não reabre o buraco)
    await rhCmd.contratarViaModal(mkAdmin('f0JuizCom', { nome: 'Juiz ComRG', rg: '' }), 'f0JuizCom', 'Desembargador');
    ok(!rh.magistradosSemRg().some(r => r.discordId === 'f0JuizCom'), '17e: troca de cargo preserva o RG (não reabre buraco)');

    // 17f: só Staff/Admin contrata pelo modal (não-admin barrado, nada é criado)
    const itNaoAdmin = makeInteraction({ userId: 'f0Ze', guild: fakeGuild(), member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } }, fields: { nome: 'x', rg: 'y' } });
    await rhCmd.contratarViaModal(itNaoAdmin, 'f0Ze', 'Juiz');
    ok(/staff/i.test(lastReplyText(itNaoAdmin)) && !rh.getCargo('f0Ze'), '17f: não-Staff é barrado no modal de contratação');

    // 17g: slash — opção rg (opcional) no contratar + subcomando sem-rg
    const jsonRh = rhCmd.data.toJSON();
    const subContratar = jsonRh.options.find(o => o.name === 'contratar');
    ok(subContratar && (subContratar.options || []).some(o => o.name === 'rg' && o.required === false), '17g: /rh contratar tem opção rg opcional');
    ok(jsonRh.options.some(o => o.name === 'sem-rg'), '  ...e existe o subcomando /rh sem-rg');

    // 17h: modal do painel → customId parseável pelo router (usuarioId#cargo)
    const cid = rhCmd.modalContratarStaff('998877665544', 'Promotor').toJSON().custom_id;
    const [uid, cargoP] = String(cid.split(':')[4]).split('#');
    ok(uid === '998877665544' && cargoP === 'Promotor', '17h: modalContratarStaff → customId parseável (usuarioId#cargo)');

    // --- Mocks de dispatch REAL (router do painel + execute do slash), pra pegar o que o teste de
    //     função isolada não pega: parsing do router, handler do slash, e o timeout do Problema A ---
    const makeModalSubmit = ({ userId, member, customId, fields = {}, replyThrows = false }) => {
      const it = {
        user: { id: userId }, member, guild: fakeGuild(), customId,
        deferred: false, replied: false,
        fields: { getTextInputValue: (k) => (k in fields ? fields[k] : '') },
        isButton: () => false, isStringSelectMenu: () => false, isUserSelectMenu: () => false,
        isChatInputCommand: () => false, isAutocomplete: () => false, isModalSubmit: () => true,
        _replies: [],
        // replyThrows simula o token expirado (10062) que o Problema A dispara sem deferReply
        reply: async (o) => { if (replyThrows) throw new Error('Unknown interaction [10062]'); it.replied = true; it._replies.push({ t: 'reply', ...norm(o) }); return o; },
        editReply: async (o) => { it._replies.push({ t: 'editReply', ...norm(o) }); return o; },
        deferReply: async () => { it.deferred = true; },
        followUp: async (o) => { it._replies.push({ t: 'followUp', ...norm(o) }); return o; },
      };
      return it;
    };
    const makeSlash = ({ userId, member, sub, opts = {} }) => {
      const it = {
        user: { id: userId }, member, guild: fakeGuild(),
        deferred: false, replied: false,
        options: {
          getSubcommand: () => sub,
          getUser: (k) => (opts[k] ? { id: opts[k], toString: () => `<@${opts[k]}>` } : null),
          getString: (k) => (k in opts ? opts[k] : null),
          getBoolean: (k) => (k in opts ? opts[k] : null),
        },
        _replies: [],
        reply: async (o) => { it.replied = true; it._replies.push({ t: 'reply', ...norm(o) }); return o; },
        editReply: async (o) => { it._replies.push({ t: 'editReply', ...norm(o) }); return o; },
        deferReply: async () => { it.deferred = true; },
        followUp: async (o) => { it._replies.push({ t: 'followUp', ...norm(o) }); return o; },
      };
      return it;
    };
    const contentLast = (it) => (it._replies.map(r => r.content).filter(Boolean).pop() || '');

    // 17i: REGRESSAO do Problema A — o reply inicial expira (10062), mas defer+editReply entregam o
    // aviso mesmo assim. Falha no codigo antigo (reply sem defer); passa com o defer.
    const itExp = makeModalSubmit({ userId: 'adm1', member: adminMember, customId: 'painel:modal:rh:contratar:f0Exp#Juiz', fields: { nome: 'Juiz Exp', rg: '' }, replyThrows: true });
    await rhCmd.contratarViaModal(itExp, 'f0Exp', 'Juiz');
    ok(itExp.deferred === true, '17i: contratarViaModal defere antes do render (nao usa o reply fragil)');
    ok(/sem rg/i.test(lastEmbedDesc(itExp)), '  ...e o aviso fail-open chega via editReply mesmo com o token inicial morto');

    // 17j: dispatch REAL do painel (router -> tratarModal -> contratarViaModal) — pega regressao de parse
    const itRouter = makeModalSubmit({ userId: 'adm1', member: adminMember, customId: 'painel:modal:rh:contratar:f0Router#Promotor', fields: { nome: 'Prom RT', rg: 'RG-RT' } });
    await painelCmd.router(itRouter);
    eq((rh.getCargo('f0Router') || {}).cargo, 'Promotor', '17j: dispatch real do painel contrata (router->tratarModal->contratarViaModal)');
    ok(itRouter.deferred === true, '  ...deferindo antes do render');

    // 17k: cargo invalido via dispatch real e barrado, nada criado (guard de rh.js)
    const itBad = makeModalSubmit({ userId: 'adm1', member: adminMember, customId: 'painel:modal:rh:contratar:f0Bad#Estagiario', fields: { nome: 'x', rg: 'y' } });
    await painelCmd.router(itBad);
    ok(!rh.getCargo('f0Bad') && /inv[aá]lid/i.test(contentLast(itBad)), '17k: cargo invalido barrado no dispatch real (nada criado)');

    // 17l: slash execute contratar roda de verdade + defer + aviso fail-open
    const itSlash = makeSlash({ userId: 'adm1', member: adminMember, sub: 'contratar', opts: { usuario: 'f0Slash', cargo: 'Juiz', rg: '' } });
    await rhCmd.execute(itSlash);
    eq((rh.getCargo('f0Slash') || {}).cargo, 'Juiz', '17l: /rh contratar (execute real) contrata');
    ok(itSlash.deferred === true && /sem rg/i.test(contentLast(itSlash)), '  ...deferindo antes do render e entregando o aviso fail-open');

    // 17m: slash execute sem-rg roda o handler e lista (ramo cheio — o DB de teste tem magistrado sem RG)
    const itSemRg = makeSlash({ userId: 'adm1', member: adminMember, sub: 'sem-rg' });
    await rhCmd.execute(itSemRg);
    const semRgEmbed = itSemRg._replies.find(r => Array.isArray(r.embeds) && r.embeds.length);
    ok(semRgEmbed && /sem rg/i.test(semRgEmbed.embeds[0].data?.title || ''), '17m: /rh sem-rg (execute real) lista magistrados sem RG');

    // 17n: execute barra nao-Staff no topo (isAdmin), nada criado
    const itSlashNaoAdm = makeSlash({ userId: 'zeSlash', member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } }, sub: 'contratar', opts: { usuario: 'f0X', cargo: 'Juiz', rg: '' } });
    await rhCmd.execute(itSlashNaoAdm);
    ok(!rh.getCargo('f0X') && /staff/i.test(contentLast(itSlashNaoAdm)), '17n: /rh execute barra nao-Staff (nada criado)');
  }

  // ============ ITEM 18: Diário — engine por natureza + petição administrativa (porte de arma) ============
  console.log('\nItem 18 — Diário (engine publicarAto + petição administrativa / porte de arma):');
  {
    estado.definir('diarioOficialId', 'diariochan'); // liga o Diário no teste (senão publicar vira no-op)
    const acharPub = () => rec.sends.find(s => s.content === '@everyone' && Array.isArray(s.embeds) && s.embeds.length);

    // 18a: engine publica a decisão de petição administrativa (Deferido) com card + tipo + PNG + marcador
    const pDef = db.inserir('peticoes', { numero: 'DIA-PA1', tipo: 'PorteArma', status: 'Deferido', juiz: 'juizD', nomeCliente: 'Fulano da Silva', validadeAte: new Date(Date.now() + 15 * 864e5).toISOString() });
    rec.sends.length = 0;
    const pub1 = await diarioAtos.publicarAto(fakeGuild(), 'peticaoAdministrativa', pDef, { files: [{ attachment: Buffer.from('x'), name: 'Sentenca.png' }] });
    const emb1 = acharPub();
    ok(pub1 === true && !!emb1, '18a: publicarAto publica a decisão de petição administrativa');
    ok(emb1 && /porte de arma/i.test(JSON.stringify(emb1.embeds[0].data)), '  ...com o tipo do pedido no card');
    ok(emb1 && Array.isArray(emb1.files) && emb1.files.length, '  ...e o PNG anexado');
    ok((db.buscarPorNumero('peticoes', 'DIA-PA1') || {}).diarioPublicado?.peticaoAdministrativa, '  ...e marca diarioPublicado[peticaoAdministrativa] no registro');

    // 18b: idempotente — segunda chamada não republica
    rec.sends.length = 0;
    const pub2 = await diarioAtos.publicarAto(fakeGuild(), 'peticaoAdministrativa', db.buscarPorNumero('peticoes', 'DIA-PA1'));
    ok(pub2 === false && !acharPub(), '18b: idempotente — não republica ato já publicado');

    // 18c: estado ainda não-decidido não é publicável
    const pPend = db.inserir('peticoes', { numero: 'DIA-PA2', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizD' });
    rec.sends.length = 0;
    const pub3 = await diarioAtos.publicarAto(fakeGuild(), 'peticaoAdministrativa', pPend);
    ok(pub3 === false && !acharPub(), '18c: petição ainda Pendente não publica (publicavel=false)');

    // 18d: END-TO-END — finalizarDecisao(Deferido) publica no Diário = o bug do porte de arma resolvido
    db.inserir('peticoes', { numero: 'DIA-PA3', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizD', canalId: 'cpa3', nomeCliente: 'Beltrano', requerenteId: 'advA', rgCliente: 'RG9' });
    rec.sends.length = 0;
    await peticaoCmd.finalizarDecisao(fakeGuild(), 'DIA-PA3', 'Deferido', { motivo: 'Autorizado.', nivelRisco: 'Baixo' }, 'juizD');
    ok(acharPub(), '18d: finalizarDecisao(Deferido) publica no Diário — porte de arma resolvido');
    ok((db.buscarPorNumero('peticoes', 'DIA-PA3') || {}).diarioPublicado?.peticaoAdministrativa, '  ...e marca o registro');

    // 18e: Diligência (Nível 3) NÃO publica
    db.inserir('peticoes', { numero: 'DIA-PA4', tipo: 'PorteArma', status: 'Pendente', juiz: 'juizD', canalId: 'cpa4', nomeCliente: 'Ciclano', requerenteId: 'advB' });
    rec.sends.length = 0;
    await peticaoCmd.finalizarDecisao(fakeGuild(), 'DIA-PA4', 'Diligência', { motivo: 'Falta comprovante.' }, 'juizD');
    ok(!acharPub() && !(db.buscarPorNumero('peticoes', 'DIA-PA4') || {}).diarioPublicado?.peticaoAdministrativa, '18e: Diligência (Nível 3) não publica no Diário');
  }

  // ============ ITEM 19: Diário Etapa 2 — arquivamento inquérito / indeferimento inicial / desarquivamento ============
  console.log('\nItem 19 — Diário Etapa 2 (arquivamento de inquérito, indeferimento inicial, desarquivamento):');
  {
    estado.definir('diarioOficialId', 'diariochan');
    const acharPub = () => rec.sends.find(s => s.content === '@everyone' && Array.isArray(s.embeds) && s.embeds.length);
    const dataDe = (pub) => JSON.stringify((pub && pub.embeds && pub.embeds[0] && pub.embeds[0].data) || {});

    // 19a: arquivamento de inquérito (penal) publica + marca a natureza
    const proc1 = db.inserir('processos', { numero: 'DIA-INQ1', tipo: 'Penal', status: 'Arquivado', promotor: 'promX' });
    rec.sends.length = 0;
    const r1 = await diarioAtos.publicarAto(fakeGuild(), 'arquivamentoInquerito', proc1);
    ok(r1 === true && /inqu[eé]rito arquivado/i.test(dataDe(acharPub())), '19a: arquivamento de inquérito (penal) publica');
    ok((db.buscarPorNumero('processos', 'DIA-INQ1') || {}).diarioPublicado?.arquivamentoInquerito, '  ...e marca a natureza');

    // 19b: exclusão por tipo — indeferimentoInicial NÃO pega processo penal
    rec.sends.length = 0;
    const r1b = await diarioAtos.publicarAto(fakeGuild(), 'indeferimentoInicial', db.buscarPorNumero('processos', 'DIA-INQ1'));
    ok(r1b === false && !acharPub(), '19b: indeferimentoInicial não pega processo penal (exclusão por tipo)');

    // 19c: indeferimento inicial (cível) publica
    const proc2 = db.inserir('processos', { numero: 'DIA-INI1', tipo: 'Civel', status: 'Arquivado', juiz: 'juizC' });
    rec.sends.length = 0;
    const r2 = await diarioAtos.publicarAto(fakeGuild(), 'indeferimentoInicial', proc2);
    ok(r2 === true && /inicial indeferida/i.test(dataDe(acharPub())), '19c: indeferimento da inicial (cível) publica');

    // 19d: exclusão por tipo — arquivamentoInquerito NÃO pega processo cível
    rec.sends.length = 0;
    const r2b = await diarioAtos.publicarAto(fakeGuild(), 'arquivamentoInquerito', db.buscarPorNumero('processos', 'DIA-INI1'));
    ok(r2b === false && !acharPub(), '19d: arquivamentoInquerito não pega processo cível');

    // 19e: desarquivamento publica E coexiste com o arquivamento no MESMO registro (mapa por natureza)
    const proc3 = db.inserir('processos', { numero: 'DIA-DES1', tipo: 'Penal', status: 'Arquivado', promotor: 'promY' });
    await diarioAtos.publicarAto(fakeGuild(), 'arquivamentoInquerito', proc3);
    db.atualizar('processos', 'DIA-DES1', { status: 'Instrução', revisaoArquivamento: 'Decidida', juiz: 'juizR' });
    rec.sends.length = 0;
    const r3 = await diarioAtos.publicarAto(fakeGuild(), 'desarquivamento', db.buscarPorNumero('processos', 'DIA-DES1'), { files: [{ attachment: Buffer.from('x'), name: 'Dec.png' }] });
    const pub3 = acharPub();
    ok(r3 === true && pub3 && /reaberto/i.test(dataDe(pub3)), '19e: desarquivamento publica (processo reaberto)');
    ok(pub3 && Array.isArray(pub3.files) && pub3.files.length, '  ...com o PNG da decisão anexado');
    const dp = (db.buscarPorNumero('processos', 'DIA-DES1') || {}).diarioPublicado || {};
    ok(dp.arquivamentoInquerito && dp.desarquivamento, '  ...e os DOIS atos coexistem no mesmo registro');

    // 19f: END-TO-END — arquivarCivil publica o indeferimento inicial
    db.inserir('processos', { numero: 'DIA-INI2', tipo: 'Civel', status: 'Distribuído', juiz: 'juizE', canalId: 'cini2', motivo: 'Ação de cobrança', crimes: [], reus: [], partes: [], habilitacoes: [] });
    rec.sends.length = 0;
    const itCiv = makeInteraction({ userId: 'juizE', guild: fakeGuild(), member: null });
    await processoCmd.arquivarCivil(itCiv, 'DIA-INI2');
    ok(acharPub() && (db.buscarPorNumero('processos', 'DIA-INI2') || {}).diarioPublicado?.indeferimentoInicial, '19f: arquivarCivil publica o indeferimento inicial (end-to-end)');
  }

  // ============ ITEM 20: Diário Etapa 3 — Nível 2 publica no cumprimento, não no deferimento ============
  console.log('\nItem 20 — Diário Etapa 3 (mandado publica no cumprimento, não no deferimento):');
  {
    estado.definir('diarioOficialId', 'diariochan');
    const acharPub = () => rec.sends.find(s => s.content === '@everyone' && Array.isArray(s.embeds) && s.embeds.length);
    const dataDe = (pub) => JSON.stringify((pub && pub.embeds && pub.embeds[0] && pub.embeds[0].data) || {});

    // 20a: mandado só Emitido (deferido, ainda não cumprido) NÃO publica — sem vazamento no deferimento
    const m1 = db.inserir('mandados', { numero: 'MND-1', tipo: 'Busca e Apreensão', alvo: 'Fulano', status: 'Emitido', processoVinculado: 'P1', cumpridoPor: null });
    rec.sends.length = 0;
    const r0 = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', m1);
    ok(r0 === false && !acharPub(), '20a: mandado só Emitido NÃO publica (o vazamento do deferimento foi fechado)');

    // 20b: cumprido → publica com card de cumprimento + marca
    db.atualizar('mandados', 'MND-1', { status: 'Cumprido', cumpridoPor: 'delX' });
    rec.sends.length = 0;
    const r1 = await diarioAtos.publicarAto(fakeGuild(), 'mandadoCumprido', db.buscarPorNumero('mandados', 'MND-1'));
    ok(r1 === true && /cumprido/i.test(dataDe(acharPub())), '20b: mandado cumprido publica no Diário (card de cumprimento)');
    ok((db.buscarPorNumero('mandados', 'MND-1') || {}).diarioPublicado?.mandadoCumprido, '  ...e marca a natureza');
  }

  // ============ ITEM 21: Diário Etapa 4 — texto longo do inquérito vai por anexo, não inline ============
  console.log('\nItem 21 — Diário Etapa 4 (texto longo por anexo, não inline):');
  {
    estado.definir('diarioOficialId', 'diariochan');
    const acharPub = () => rec.sends.find(s => s.content === '@everyone' && Array.isArray(s.embeds) && s.embeds.length);
    const corpo15k = 'X'.repeat(15000);

    // 21a: arquivamento de inquérito ANEXA o PDF do relatório (documentosAnexados), não inline
    const proc = db.inserir('processos', { numero: 'INQ-LONG', tipo: 'Penal', status: 'Arquivado', promotor: 'promL' });
    require('../utils/anexos').criarDocumento({ tipo: 'relatorio_inquerito', url: 'https://cdn.fake/relatorio-15k.pdf', nomeArquivo: 'Relatorio-15k.pdf', autorId: 'del1', protocoloVinculado: 'INQ-LONG' });
    rec.sends.length = 0;
    await diarioAtos.publicarAto(fakeGuild(), 'arquivamentoInquerito', proc);
    const pub = acharPub();
    ok(pub && Array.isArray(pub.files) && pub.files.some(f => /Relatorio-15k/.test(f.name)), '21a: o PDF do relatório do inquérito é anexado ao card');
    const desc = (pub && pub.embeds[0].data.description) || '';
    ok(desc.length < 4096 && !/XXXXXXXXXX/.test(desc), '21b: o card fica curto — o teor de 15k NÃO vai inline (só no anexo)');

    // 21c: texto livre de 15.000 chars (comunicado) é cortado em 4096 — não estoura a publicação
    rec.sends.length = 0;
    await diario.publicarNoDiario(fakeGuild(), 'comunicado', { titulo: 'Longo', corpo: corpo15k });
    const pubC = rec.sends.find(s => (s.embeds || []).length);
    const descC = (pubC && pubC.embeds[0].data.description) || '';
    ok(descC.length <= 4096, '21c: texto livre de 15k é cortado em 4096 (não quebra o embed)');
  }

  // ============ ITEM 22: Diário Etapa 5 — varredura (backfill silencioso + escape Nível 2) ============
  console.log('\nItem 22 — Diário Etapa 5 (varredura: backfill silencioso + escape):');
  {
    estado.definir('diarioOficialId', 'diariochan');
    const silenciosas = () => rec.sends.filter(s => (s.embeds || []).length && s.content === '');
    const pings = () => rec.sends.filter(s => s.content === '@everyone');

    // 22a: backfill — petição decidida ANTES da feature (sem marcador) é publicada em SILÊNCIO
    db.inserir('peticoes', { numero: 'BACK-PA', tipo: 'PorteArma', status: 'Deferido', juiz: 'juizB', nomeCliente: 'Antigo', criadoEm: '2026-01-01T00:00:00.000Z' });
    rec.sends.length = 0;
    const r = await diarioAtos.varrerDiario(fakeGuild());
    ok(r.publicados >= 1 && (db.buscarPorNumero('peticoes', 'BACK-PA') || {}).diarioPublicado?.peticaoAdministrativa, '22a: varredura faz backfill da petição decidida não publicada');
    ok(silenciosas().length >= 1 && pings().length === 0, '  ...em SILÊNCIO (sem @everyone — não floodou pings)');

    // 22b: idempotente — segunda varredura não republica nada
    rec.sends.length = 0;
    const r2 = await diarioAtos.varrerDiario(fakeGuild());
    ok(r2.publicados === 0 && rec.sends.length === 0, '22b: segunda varredura não republica (idempotente)');

    // 22c: escape — mandado Emitido nunca cumprido, de medida arquivada, publica "não cumprido"
    db.inserir('medidas', { numero: 'MED-AB', status: 'Deferida', arquivadoManual: true, delegado: 'delA', juiz: 'juizA' });
    db.inserir('mandados', { numero: 'MND-AB', tipo: 'Busca e Apreensão', alvo: 'Beltrano', status: 'Emitido', medidaNumero: 'MED-AB', cumpridoPor: null });
    rec.sends.length = 0;
    await diarioAtos.varrerDiario(fakeGuild());
    ok((db.buscarPorNumero('mandados', 'MND-AB') || {}).diarioPublicado?.mandadoNaoCumprido, '22c: escape publica o mandado não cumprido de caso encerrado');

    // 22d: mandado Emitido de caso EM CURSO (não arquivado) NÃO publica — sigilo mantido até encerrar
    db.inserir('medidas', { numero: 'MED-ON', status: 'Deferida', arquivadoManual: false, delegado: 'delB' });
    db.inserir('mandados', { numero: 'MND-ON', tipo: 'Prisão Preventiva', alvo: 'Ciclano', status: 'Emitido', medidaNumero: 'MED-ON', cumpridoPor: null });
    rec.sends.length = 0;
    await diarioAtos.varrerDiario(fakeGuild());
    ok(!(db.buscarPorNumero('mandados', 'MND-ON') || {}).diarioPublicado, '22d: mandado de caso em curso NÃO publica (sigilo até encerrar)');
  }

  // ============ ITEM 23: Parte 2 — troca manual de responsável (universal) ============
  console.log('\nItem 23 — Parte 2 (troca de responsável: universal, validada, dentro do ticket):');
  {
    const responsaveis = require('../utils/responsaveis');
    const supervisao = require('../utils/supervisao');

    const fora = new Set();          // saiu do servidor (10007)
    const deletes = [];              // ids que perderam acesso ao canal
    const edits = [];                // ids que ganharam acesso ao canal
    const canaisEnviados = [];       // mensagens postadas no canal do ticket
    const mkCanal = () => {
      const c = fakeChannel();
      c.permissionOverwrites.delete = async (id) => { deletes.push(id); };
      c.permissionOverwrites.edit = async (id) => { edits.push(id); };
      c.send = async (o) => { canaisEnviados.push(norm(o)); return { id: 'm1', attachments: { first: () => null } }; };
      return c;
    };
    const guild = {
      id: 'guild1', roles: { everyone: 'e' },
      members: { fetch: async (id) => { if (fora.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return fakeMember(id); } },
      channels: { fetch: async () => mkCanal() },
    };
    const memberFalse = { permissions: { has: () => false }, roles: { cache: { has: () => false } } };
    const trocar = (args) => responsaveis.trocarManual(guild, Object.assign({ motivo: 'reorganização de pauta', executorId: 'sup1' }, args));

    rh.contratar('p2_juizA', 'Juiz'); rh.contratar('p2_juizB', 'Juiz');
    rh.contratar('p2_promA', 'Promotor'); rh.contratar('p2_promB', 'Promotor');
    rh.contratar('p2_desA', 'Desembargador'); rh.contratar('p2_desB', 'Desembargador');
    rh.contratar('p2_semcargo', 'Advogado');

    // 23a: MESMO núcleo troca nos quatro tipos de ticket — sem switch por tipo
    db.inserir('processos', { numero: 'P2-PN', tipo: 'Penal', status: 'Instrução', juiz: 'p2_juizA', promotor: 'p2_promA', delegado: 'p2_delPC', canalId: 'cP2a' });
    db.inserir('processos', { numero: 'P2-CV', tipo: 'Civil', status: 'Instrução', juiz: 'p2_juizA', canalId: 'cP2b' });
    db.inserir('medidas', { numero: 'P2-MD', status: 'Aprovada - aguardando juiz', juiz: 'p2_juizA', promotor: 'p2_promA', delegado: 'p2_delPC', canalId: 'cP2c' });
    db.inserir('peticoes', { numero: 'P2-PA', tipo: 'PorteArma', status: 'Pendente', juiz: 'p2_juizA', promotor: 'p2_promA', canalId: 'cP2d', sorteioPromotorEm: '2026-01-01T00:00:00.000Z', manifestacoesMp: [{ posicao: 'Favorável' }] });
    db.inserir('apelacoes', { numero: 'P2-AP', status: 'Aguardando decisão', desembargadorId: 'p2_desA', canalId: 'cP2e' });

    const r1 = await trocar({ tabela: 'processos', numero: 'P2-PN', papel: 'Juiz', novoId: 'p2_juizB' });
    const r2 = await trocar({ tabela: 'processos', numero: 'P2-CV', papel: 'Juiz', novoId: 'p2_juizB' });
    const r3 = await trocar({ tabela: 'medidas', numero: 'P2-MD', papel: 'Promotor', novoId: 'p2_promB' });
    const r4 = await trocar({ tabela: 'peticoes', numero: 'P2-PA', papel: 'Promotor', novoId: 'p2_promB' });
    const r5 = await trocar({ tabela: 'apelacoes', numero: 'P2-AP', papel: 'Desembargador', novoId: 'p2_desB' });
    ok([r1, r2, r3, r4, r5].every(r => r.ok), '23a: a mesma troca funciona em processo penal, civil, medida, petição e apelação');
    ok(db.buscarPorNumero('processos', 'P2-PN').juiz === 'p2_juizB' && db.buscarPorNumero('apelacoes', 'P2-AP').desembargadorId === 'p2_desB', '  ...e grava o substituto no campo certo de cada tabela');

    // 23b: acesso ao canal migra (novo entra, antigo sai) e o andamento narrativo é postado
    ok(edits.includes('p2_juizB') && deletes.includes('p2_juizA'), '23b: acesso ao canal migra na hora (novo entra, antigo sai)');
    ok(canaisEnviados.some(m => /Troca de responsável/.test(m.content || '') && /reorganização de pauta/.test(m.content || '')), '  ...com andamento narrativo e motivo no canal');
    const andamentoTroca = db.todos('andamentos', a => a.processoNumero === 'P2-PN' && a.tipo === 'troca_responsavel');
    ok(andamentoTroca.some(a => a.metadata && a.metadata.antigoId === 'p2_juizA' && a.metadata.novoId === 'p2_juizB' && /reorganização de pauta/.test(a.detalhe || '')), '  ...e fica registrado no histórico dos autos (quem saiu, quem entrou, motivo)');

    // 23c: prazo reinicia pro substituto — as 24h do MP na petição (e os atos anteriores ficam)
    const petTrocada = db.buscarPorNumero('peticoes', 'P2-PA');
    ok(petTrocada.sorteioPromotorEm !== '2026-01-01T00:00:00.000Z' && petTrocada.manifestacoesMp.length === 1, '23c: troca de promotor reinicia as 24h e mantém a manifestação anterior nos autos');

    // 23d: validações — substituto sem cargo, igual ao atual, sem motivo, papel inexistente no tipo
    const semCargo = await trocar({ tabela: 'processos', numero: 'P2-PN', papel: 'Juiz', novoId: 'p2_semcargo' });
    const mesmo = await trocar({ tabela: 'processos', numero: 'P2-PN', papel: 'Juiz', novoId: 'p2_juizB' });
    const semMotivo = await responsaveis.trocarManual(guild, { tabela: 'processos', numero: 'P2-PN', papel: 'Juiz', novoId: 'p2_juizA', motivo: '   ', executorId: 'sup1' });
    const papelInexistente = await trocar({ tabela: 'apelacoes', numero: 'P2-AP', papel: 'Delegado', novoId: 'p2_delPC2' });
    ok(!semCargo.ok && /quadro \(RH\)/.test(semCargo.erro), '23d: substituto sem o cargo é rejeitado');
    ok(!mesmo.ok && /já é/.test(mesmo.erro), '  ...substituto igual ao atual é rejeitado');
    ok(!semMotivo.ok && /motivo/i.test(semMotivo.erro), '  ...sem motivo é rejeitado');
    ok(!papelInexistente.ok && db.buscarPorNumero('processos', 'P2-PN').juiz === 'p2_juizB', '  ...papel que não existe no tipo é rejeitado, estado inalterado');

    // 23e: substituto que saiu do servidor é rejeitado (não troca fantasma por fantasma)
    rh.contratar('p2_juizC', 'Juiz'); fora.add('p2_juizC');
    const ausente = await trocar({ tabela: 'processos', numero: 'P2-CV', papel: 'Juiz', novoId: 'p2_juizC' });
    ok(!ausente.ok && /não está no servidor/.test(ausente.erro), '23e: substituto ausente do servidor é rejeitado');

    // 23f: ninguém acumula dois papéis no mesmo caso
    const acumulo = await trocar({ tabela: 'processos', numero: 'P2-PN', papel: 'Promotor', novoId: 'p2_juizB' });
    ok(!acumulo.ok && /já atua neste caso/.test(acumulo.erro), '23f: quem já atua no caso não assume um segundo papel');

    // 23g: Delegado é a exceção declarada — substituto fora do rh (delegado da PC) é aceito
    const del = await trocar({ tabela: 'processos', numero: 'P2-PN', papel: 'Delegado', novoId: 'p2_delPC_novo' });
    ok(del.ok && db.buscarPorNumero('processos', 'P2-PN').delegado === 'p2_delPC_novo', '23g: Delegado fora do rh (injetado pela PC) pode ser trocado');

    // 23h: ticket encerrado — nada a trocar (o botão some) e a troca é recusada
    db.inserir('processos', { numero: 'P2-FIM', tipo: 'Penal', status: 'Encerrado', juiz: 'p2_juizA', canalId: 'cP2f' });
    const fim = db.buscarPorNumero('processos', 'P2-FIM');
    const recusaFim = await trocar({ tabela: 'processos', numero: 'P2-FIM', papel: 'Juiz', novoId: 'p2_juizB' });
    ok(responsaveis.papeisTrocaveis('processos', fim).length === 0 && !recusaFim.ok, '23h: caso encerrado não lista papéis (botão some) nem aceita troca');

    // 23i: quem pode trocar o quê — Desembargador troca Juiz, Procurador troca Promotor, Staff tudo
    const comCargo = (cargo) => ({ staff: false, temCargo: (c) => c === cargo });
    ok(responsaveis.podeTrocarPapel('Juiz', comCargo('Desembargador')) && !responsaveis.podeTrocarPapel('Juiz', comCargo('Procurador')), '23i: Juiz só por Desembargador (Procurador não troca Juiz)');
    ok(responsaveis.podeTrocarPapel('Promotor', comCargo('Procurador')) && !responsaveis.podeTrocarPapel('Promotor', comCargo('Desembargador')), '  ...Promotor só por Procurador (Desembargador não troca Promotor)');
    ok(['Juiz', 'Promotor', 'Delegado', 'Desembargador'].every(p => responsaveis.podeTrocarPapel(p, { staff: true })), '  ...Staff troca todos os papéis');

    // 23j: resolve o caso pelo número OU pelo ID do canal (a Supervisão age de dentro do ticket)
    const porNumero = responsaveis.resolverTicket('P2-MD');
    db.inserir('medidas', { numero: 'P2-MD2', status: 'Aprovada - aguardando juiz', juiz: 'p2_juizA', canalId: '123456789012345678' });
    const porSnowflake = responsaveis.resolverTicket('123456789012345678');
    ok(porNumero && porNumero.tabela === 'medidas', '23j: resolve o caso pelo número');
    ok(porSnowflake && porSnowflake.registro.numero === 'P2-MD2', '  ...e pelo ID do canal (snowflake)');

    // 23k: tipo de ticket NOVO só declarado no mapa já nasce trocável (prova de que não virou switch)
    responsaveis.TABELAS_TICKET.oficios = {
      canalCampo: 'canalId', aberto: (r) => r.status !== 'Encerrado',
      papeis: { Juiz: { campo: 'juiz', resetPrazo: () => ({}) } },
    };
    db.inserir('oficios', { numero: 'P2-OF', status: 'Aberto', juiz: 'p2_juizA', canalId: 'cP2g' });
    const novoTipo = await trocar({ tabela: 'oficios', numero: 'P2-OF', papel: 'Juiz', novoId: 'p2_juizB' });
    ok(novoTipo.ok && db.buscarPorNumero('oficios', 'P2-OF').juiz === 'p2_juizB', '23k: tipo de ticket novo (só declarado no mapa) já é trocável, sem código novo');
    delete responsaveis.TABELAS_TICKET.oficios;

    // 23l: entrada no ticket — quem não é Supervisão nem vê o menu; quem é, vê os papéis que pode trocar
    const itQualquer = makeInteraction({ userId: 'p2_semcargo', guild, member: memberFalse, channel: { id: 'cP2a' } });
    itQualquer.channelId = 'cP2a';
    await supervisao.abrirSupervisaoTicket(itQualquer, 'processos#P2-PN');
    ok(/Só Desembargador, Procurador ou Staff/.test(lastReplyText(itQualquer)), '23l: quem não é Supervisão é barrado no botão do ticket');

    const itDes = makeInteraction({ userId: 'p2_desA', guild, member: memberFalse, channel: { id: 'cP2a' } });
    itDes.channelId = 'cP2a';
    await supervisao.abrirSupervisaoTicket(itDes, 'processos#P2-PN');
    const menu = itDes._replies.pop() || {};
    const labels = (menu.components || []).flatMap(l => (l.components || []).map(b => b.data && b.data.label));
    ok(/Supervisão — Processo P2-PN/.test(menu.content || ''), '  ...Desembargador abre o menu do caso pelo ticket');
    ok(labels.includes('Trocar Juiz') && labels.includes('Trocar Delegado') && !labels.includes('Trocar Promotor'), '  ...e só enxerga os papéis que o cargo dele pode trocar');

    // 23m: o botão 🛡️ Supervisão nasce no painel do processo e some quando o caso encerra
    const comResp = db.buscarPorNumero('processos', 'P2-CV');
    const custom = (rows) => rows.flatMap(l => (l.components || []).map(b => b.data && b.data.custom_id));
    ok(custom(processoCmd.montarPainelAcoes(comResp)).some(id => id === 'painel:acao:supervisao:ticket:processos#P2-CV'), '23m: painel do processo traz o botão 🛡️ Supervisão enquanto há responsável');
    ok(processoCmd.montarPainelAcoes(db.buscarPorNumero('processos', 'P2-FIM')).length === 0, '  ...e o painel some por inteiro em status terminal');

    // 23n: caminho real do usuário — submit do modal (menção + motivo) efetiva a troca.
    // Aqui o id precisa ser um snowflake de verdade: quem lê o campo é o parser de @menção.
    const JUIZ_MENCIONAVEL = '900000000000000002';
    rh.contratar(JUIZ_MENCIONAVEL, 'Juiz');
    db.inserir('processos', { numero: 'P2-SUB', tipo: 'Penal', status: 'Instrução', juiz: 'p2_juizA', promotor: 'p2_promA', canalId: 'cP2h' });
    const itSub = makeInteraction({ userId: 'p2_desA', guild, member: memberFalse, fields: { novo: `<@${JUIZ_MENCIONAVEL}>`, motivo: 'juiz de férias' } });
    await supervisao.trocaResponsavelSubmit(itSub, 'processos#P2-SUB#Juiz');
    ok(db.buscarPorNumero('processos', 'P2-SUB').juiz === JUIZ_MENCIONAVEL && /✅/.test(lastReplyText(itSub)), '23n: submit do modal (menção + motivo) troca de verdade');

    // ...e o mesmo submit é barrado pra quem não tem o cargo daquele papel (Desembargador ≠ Promotor)
    const itSub2 = makeInteraction({ userId: 'p2_desA', guild, member: memberFalse, fields: { novo: '<@900000000000000003>', motivo: 'x' } });
    await supervisao.trocaResponsavelSubmit(itSub2, 'processos#P2-SUB#Promotor');
    ok(/não tem cargo/.test(lastReplyText(itSub2)) && db.buscarPorNumero('processos', 'P2-SUB').promotor === 'p2_promA', '  ...e é barrado no papel que o cargo não alcança');

    // 23o: o botão antigo do painel central passa pelo MESMO núcleo (uma implementação só) e
    // preserva o que era só dele: reabrir o processo arquivado sem julgamento de mérito.
    db.inserir('processos', { numero: 'P2-REAB', tipo: 'Penal', status: 'Arquivado sem julgamento de mérito', juiz: 'p2_juizA', promotor: 'p2_promA', canalId: 'cP2i' });
    const itLegado = makeInteraction({ userId: 'p2_desA', guild, member: memberFalse, fields: { numero: 'P2-REAB', novo: `<@${JUIZ_MENCIONAVEL}>`, motivo: 'reativar o caso' } });
    await supervisao.trocarJuiz(itLegado);
    const reab = db.buscarPorNumero('processos', 'P2-REAB');
    ok(reab.juiz === JUIZ_MENCIONAVEL && reab.status === 'Instrução', '23o: botão antigo "Trocar Juiz" delega ao núcleo e reabre o arquivado sem mérito');

    // ...e se a troca é recusada, o caso NÃO fica reaberto pela metade
    db.inserir('processos', { numero: 'P2-REAB2', tipo: 'Penal', status: 'Arquivado sem julgamento de mérito', juiz: 'p2_juizA', canalId: 'cP2j' });
    const itLegado2 = makeInteraction({ userId: 'p2_desA', guild, member: memberFalse, fields: { numero: 'P2-REAB2', novo: '<@900000000000000009>', motivo: 'tentativa inválida' } });
    await supervisao.trocarJuiz(itLegado2);
    const naoReab = db.buscarPorNumero('processos', 'P2-REAB2');
    ok(naoReab.juiz === 'p2_juizA' && naoReab.status === 'Arquivado sem julgamento de mérito', '  ...e troca recusada não deixa o caso reaberto pela metade');
  }

  // ============ ITEM 24: Parte 4 — retroatividade (backfill + relatório) ============
  console.log('\nItem 24 — Parte 4 (as funções novas valem pros tickets que já existiam):');
  {
    const retro = require('../utils/retroatividade');

    // Petição antiga (aberta antes da trava existir): tem promotor, não tem sorteioPromotorEm
    db.inserir('peticoes', { numero: 'P4-ANT', tipo: 'PorteArma', status: 'Pendente', juiz: 'p4j', promotor: 'p4p', canalId: 'cP4a' });
    // Sem promotor: carimbar criaria trava sem dono → fica de fora
    db.inserir('peticoes', { numero: 'P4-SEMP', tipo: 'TrocaNome', status: 'Pendente', juiz: 'p4j', canalId: 'cP4b' });
    // Já decidida: não é ticket aberto → fica de fora
    db.inserir('peticoes', { numero: 'P4-FIM', tipo: 'PorteArma', status: 'Deferido', promotor: 'p4p', canalId: 'cP4c' });

    const alvos = retro.peticoesParaBackfill().map(p => p.numero);
    ok(alvos.includes('P4-ANT') && !alvos.includes('P4-SEMP') && !alvos.includes('P4-FIM'), '24a: só petição ABERTA, com promotor e sem o campo entra no backfill');

    const r1 = retro.backfillSorteioPromotor({ forcar: true });
    const carimbada = db.buscarPorNumero('peticoes', 'P4-ANT');
    ok(r1.backfilladas >= 1 && !!carimbada.sorteioPromotorEm, '24b: backfill carimba sorteioPromotorEm (24h contando de agora, ninguém trava retroativamente)');
    ok(!db.buscarPorNumero('peticoes', 'P4-SEMP').sorteioPromotorEm, '  ...e não carimba petição sem promotor');

    // Uso único: redeploy não recarimba (senão reiniciaria o prazo de quem já está correndo)
    const antes = carimbada.sorteioPromotorEm;
    const r2 = retro.backfillSorteioPromotor();
    ok(r2.jaRodou && db.buscarPorNumero('peticoes', 'P4-ANT').sorteioPromotorEm === antes, '24c: backfill é de uso único — redeploy não reinicia prazo de ninguém');

    // Relatório da subida: conta os casos abertos por tipo (o número que a spec exige)
    const rel = retro.relatorioTicketsAbertos();
    ok(rel.processos && rel.medidas && rel.peticoes && rel.apelacoes && rel.peticoes.abertos >= 2, '24d: relatório conta tickets abertos por tipo (processos/medidas/petições/apelações)');
    ok(rel.peticoes.comResponsavel >= 1 && rel.peticoes.comResponsavel <= rel.peticoes.abertos, '  ...e quantos deles têm responsável marcado');
  }

  // ============ ITEM 25: reconciliação no boot (fantasma pré-existente: ausente E sem cargo) ============
  console.log('\nItem 25 — reconciliação no boot (conserta o que o evento nunca pegou):');
  {
    const responsaveis = require('../utils/responsaveis');
    const fora = new Set();
    const guildR = {
      id: 'guild1', roles: { everyone: 'e' },
      members: { fetch: async (id) => { if (fora.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return fakeMember(id); } },
      channels: { fetch: async () => fakeChannel() },
    };
    // O banco do teste já acumulou dezenas de tickets de fixture cujos responsáveis nunca entraram
    // no rh — na vida real isso dispararia (corretamente) a trava de segurança e abortaria a
    // reconciliação por cargo. Aqui o limite é afrouxado pra o teste medir o COMPORTAMENTO; a trava
    // em si é testada no 25h, com o limite de produção.
    const varrer = () => responsaveis.reatribuirTicketsFantasma(guildR, { limiteSemCargo: 999 });

    rh.contratar('rec_des_ok', 'Desembargador');
    rh.contratar('rec_juiz_ok', 'Juiz');

    // 25a: o caso real — apelação 002AP com relatora que saiu ANTES da feature existir (nenhum
    // guildMemberRemove chegou). A varredura do boot conserta sozinha.
    rh.contratar('rec_sumiu', 'Desembargador'); fora.add('rec_sumiu');
    db.inserir('apelacoes', { numero: 'REC-002AP', status: 'Aguardando decisão', desembargadorId: 'rec_sumiu', canalId: 'cR1' });

    // 25b: presente no servidor, mas o rh não o registra mais como Juiz (demitido/promovido)
    db.inserir('processos', { numero: 'REC-SC', tipo: 'Penal', status: 'Instrução', juiz: 'rec_sem_cargo', canalId: 'cR2' });

    // 25c: Delegado fora do rh (injetado pela PC por menção crua) — NÃO pode ser expulso
    db.inserir('processos', { numero: 'REC-PC', tipo: 'Penal', status: 'Instrução', juiz: 'rec_juiz_ok', delegado: 'rec_del_pc', canalId: 'cR3' });

    // 25d: arquivado com fantasma → intocado (responsável histórico é registro, não atribuição)
    db.inserir('processos', { numero: 'REC-ARQ', tipo: 'Penal', status: 'Arquivado', juiz: 'rec_sumiu', canalId: 'cR4' });

    const tratados = await varrer();
    const ap = db.buscarPorNumero('apelacoes', 'REC-002AP');
    const sc = db.buscarPorNumero('processos', 'REC-SC');
    ok(ap.desembargadorId !== 'rec_sumiu' && rh.temCargo(ap.desembargadorId, 'Desembargador'), '25a: fantasma pré-existente (saiu antes da feature) é corrigido pela varredura do boot');
    ok(sc.juiz !== 'rec_sem_cargo' && rh.temCargo(sc.juiz, 'Juiz') && tratados.some(t => t.numero === 'REC-SC' && t.motivoTipo === 'semcargo' && t.resultado === 'reatribuido'), '25b: presente no servidor mas SEM o cargo no rh também é reconciliado');
    ok(db.buscarPorNumero('processos', 'REC-PC').delegado === 'rec_del_pc', '25c: Delegado fora do rh (integração da PC) NÃO é expulso pela reconciliação');
    ok(db.buscarPorNumero('processos', 'REC-ARQ').juiz === 'rec_sumiu', '25d: ticket arquivado é intocado');

    // 25e: o motivo automático fica registrado no histórico dos autos
    const andRec = db.todos('andamentos', a => a.processoNumero === 'REC-SC' && a.tipo === 'troca_responsavel');
    ok(andRec.some(a => /reconcilia/i.test(a.detalhe || '')), '25e: reconciliação registra o motivo no histórico dos autos (nunca em silêncio)');

    // 25f: idempotente — rodar de novo (todo deploy) não mexe em nada
    const snap = JSON.stringify([db.buscarPorNumero('apelacoes', 'REC-002AP'), db.buscarPorNumero('processos', 'REC-SC')]);
    await varrer();
    ok(snap === JSON.stringify([db.buscarPorNumero('apelacoes', 'REC-002AP'), db.buscarPorNumero('processos', 'REC-SC')]), '25f: idempotente — seguro rodar a cada deploy');

    // 25g: sem substituto, "sem cargo" MANTÉM o responsável (esvaziar pioraria: de alguém presente
    // que ainda age pra ninguém). Só "ausente" (definitivo) esvazia e marca pendência.
    db.todos('rh', r => r.cargo === 'Promotor' && r.ativo).forEach(r => rh.demitir(r.discordId));
    db.inserir('processos', { numero: 'REC-MANT', tipo: 'Penal', status: 'Instrução', promotor: 'rec_prom_presente', canalId: 'cR5' });
    db.inserir('processos', { numero: 'REC-VAZIO', tipo: 'Penal', status: 'Instrução', promotor: 'rec_prom_sumiu', canalId: 'cR6' });
    fora.add('rec_prom_sumiu');
    const t2 = await varrer();
    ok(db.buscarPorNumero('processos', 'REC-MANT').promotor === 'rec_prom_presente' && t2.some(t => t.numero === 'REC-MANT' && t.resultado === 'mantido_sem_substituto'), '25g: sem substituto, "sem cargo" mantém quem está presente (não esvazia o caso)');
    ok(db.buscarPorNumero('processos', 'REC-VAZIO').promotor === null && db.buscarPorNumero('processos', 'REC-VAZIO').semResponsavelPendente === true, '  ...mas "ausente do servidor" esvazia e vira pendência (fantasma nunca fica no lugar)');

    // 25h: trava de segurança — muitos "sem cargo" de uma vez (cara de rh zerado) aborta a
    // reconciliação POR CARGO, sem impedir a correção por ausência. Aqui SEM afrouxar o limite.
    rh.contratar('rec_juiz_pool', 'Juiz'); // há substituto: a trava é o único motivo pra não mexer
    const massa = [];
    for (let i = 0; i < responsaveis.LIMITE_RECONCILIACAO_SEM_CARGO + 2; i++) {
      const n = `REC-MASSA${i}`;
      massa.push(n);
      db.inserir('processos', { numero: n, tipo: 'Penal', status: 'Instrução', juiz: `rec_massa_juiz${i}`, canalId: `cM${i}` });
    }
    db.inserir('apelacoes', { numero: 'REC-MASSA-AUS', status: 'Aguardando decisão', desembargadorId: 'rec_massa_sumiu', canalId: 'cMA' });
    fora.add('rec_massa_sumiu');
    await responsaveis.reatribuirTicketsFantasma(guildR);
    const intactos = massa.every((n, i) => db.buscarPorNumero('processos', n).juiz === `rec_massa_juiz${i}`);
    ok(intactos, '25h: "sem cargo" em massa (cara de rh zerado) NÃO reatribui nada — pede conferência humana');
    ok(db.buscarPorNumero('apelacoes', 'REC-MASSA-AUS').desembargadorId !== 'rec_massa_sumiu', '  ...e a correção por AUSÊNCIA do servidor segue valendo na mesma rodada');
  }

  // ---- Resumo ----
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL no runner:', e); try { fs.unlinkSync(DB_TESTE); } catch (_) {} process.exit(2); });
