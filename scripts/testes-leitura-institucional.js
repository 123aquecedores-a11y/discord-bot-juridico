/* eslint-disable */
// LEITURA INSTITUCIONAL DOS TICKETS (20/08/2026). Rode com:
//   node scripts/testes-leitura-institucional.js
//
// A MUDANÇA: os quatro cargos de magistratura e MP (Juiz, Promotor, Desembargador, Procurador)
// passam a VER todo canal de ticket — ViewChannel + ReadMessageHistory, nunca SendMessages.
//
// A TRAVA QUE VEM JUNTO, e sem a qual a abertura é um buraco: quem é PARTE no caso não lê o
// próprio caso, nem tendo o cargo. O impedimento casa RG do operador contra RG da parte e vira
// overwrite NEGATIVO por MEMBRO — no Discord, deny de membro vence allow de role, e essa é a
// única ordem que funciona, porque a role é justamente o que o impedido tem de sobra.
//
// E A EXCEÇÃO: busca e apreensão e quebra de sigilo NÃO recebem leitura por cargo. São diligências
// cujo vazamento queima a própria diligência.
//
// O QUE NÃO PODE REGREDIR, e por isso está testado aqui junto: `podeVerTeor` (ver o canal não é
// ver o teor), o mural cego dos advogados, e o CÓDIGO DE HABILITAÇÃO — que não pode aparecer em
// canal de ticket, senão esta abertura o entrega ao tribunal inteiro.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-leitura-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';
process.env.ROLE_JUIZ_ID = 'role-juiz';
process.env.ROLE_PROMOTOR_ID = 'role-promotor';
process.env.ROLE_DESEMBARGADOR_ID = 'role-desembargador';
process.env.ROLE_PROCURADOR_ID = 'role-procurador';

const db = require('../database/db');
const rh = require('../utils/rh');
const canais = require('../utils/canais');
const pecas = require('../utils/pecas');
const { PermissionFlagsBits, OverwriteType } = require('discord.js');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

const ROLES = ['role-juiz', 'role-promotor', 'role-desembargador', 'role-procurador'];

// O caso central do impedimento: um JUIZ cujo RG é o mesmo do réu do processo.
const JUIZ_LIMPO = '220000000000000001';
const JUIZ_QUE_EH_REU = '220000000000000002';
const PROMOTOR = '220000000000000003';
const RG_DO_REU = 'ABC12345';
rh.contratar(JUIZ_LIMPO, 'Juiz', 'Juiz Sem Impedimento', 'ZZZ99999');
rh.contratar(JUIZ_QUE_EH_REU, 'Juiz', 'Juiz Que É Réu', RG_DO_REU);
rh.contratar(PROMOTOR, 'Promotor', 'Promotor', 'PPP11111');

console.log('\n=== Leitura institucional dos tickets ===\n');

// ---------------------------------------------------------------------------
console.log('1) OS QUATRO CARGOS entram com LEITURA no canal novo');
// ---------------------------------------------------------------------------
async function secao1() {
  let criado = null; const postadas = [];
  const guild = {
    id: 'guild1', roles: { everyone: 'role-everyone' },
    channels: { create: async (o) => { criado = o; return { id: 'c1', ...o, send: async (m) => { postadas.push(m); return { id: 'm1' }; } }; } },
  };
  await canais.criarCanalTicket(guild, { categoriaId: 'cat', prefixo: 'processo', numero: '0900PN', membros: ['u-juiz', 'u-promotor'] });
  ok(!!criado, '1z: o canal foi criado (o cenário não passou vazio)');

  const ows = criado.permissionOverwrites;
  for (const role of ROLES) {
    const o = ows.find(x => x.id === role);
    ok(!!o && o.type === OverwriteType.Role, `1a-${role}: overwrite de ROLE presente`);
    ok(!!o && o.allow.includes(PermissionFlagsBits.ViewChannel), `1b-${role}: com ViewChannel`);
    ok(!!o && o.allow.includes(PermissionFlagsBits.ReadMessageHistory), `1c-${role}: e ReadMessageHistory`);
    ok(!!o && (o.deny || []).includes(PermissionFlagsBits.SendMessages),
      `1d-${role}: SEM SendMessages — canal de processo não tem bate-papo`);
  }
  ok(ows.some(o => o.id === 'role-everyone' && o.deny.includes(PermissionFlagsBits.ViewChannel)),
    '1e: @everyone continua sem ver');
  ok(ows.filter(o => o.type === OverwriteType.Member).length === 2, '1f: e os membros nominais continuam entrando');
  // Nenhum overwrite com id vazio — `staffRoleId` ausente não pode virar entrada inválida.
  ok(ows.every(o => !!o.id), '1g: nenhum overwrite sem id (instalação sem staffRole não quebra)');

  // MENÇÃO: uma vez, na primeira mensagem.
  ok(postadas.length === 1, '1h: exatamente UMA mensagem de menção no canal', String(postadas.length));
  const m = postadas[0] || {};
  for (const role of ROLES) ok((m.content || '').includes(`<@&${role}>`), `1i-${role}: mencionado no card de abertura`);
  ok(m.allowedMentions && m.allowedMentions.parse.includes('roles'),
    '1j: com allowedMentions explícito — sem isso o Discord não pinga a role');
}

// ---------------------------------------------------------------------------
console.log('\n2) IMPEDIMENTO — quem é PARTE não lê o próprio caso, nem com o cargo');
// ---------------------------------------------------------------------------
{
  const processo = {
    numero: '0901PN', tipo: 'Penal',
    partes: [{ papel: 'reu', nome: 'Fulano', rg: RG_DO_REU }],
  };
  const impedidos = rh.impedidosNoCaso(processo);
  ok(impedidos.includes(JUIZ_QUE_EH_REU), '2a: o Juiz cujo RG é o do réu aparece como IMPEDIDO', impedidos.join(','));
  ok(!impedidos.includes(JUIZ_LIMPO), '2b: e o Juiz sem relação com o caso, não');
  ok(!impedidos.includes(PROMOTOR), '2c: nem o Promotor');

  // Casa por RG, não por Discord ID — o operador entra no caso como PERSONAGEM.
  const porId = rh.impedidosNoCaso({ numero: 'X', partes: [{ papel: 'reu', discordId: JUIZ_QUE_EH_REU }] });
  ok(porId.length === 0, '2d: parte SEM RG não impede ninguém (é o RG que identifica no jogo)');

  // Todos os papéis que impedem, um a um.
  for (const papel of ['reu', 'investigado', 'alvo', 'autor', 'testemunha']) {
    const r = rh.impedidosNoCaso({ numero: 'Y', partes: [{ papel, rg: RG_DO_REU }] });
    ok(r.includes(JUIZ_QUE_EH_REU), `2e-${papel}: o papel "${papel}" impede`);
  }
  // Papel que NÃO impede — advogado da parte não é a parte.
  ok(rh.impedidosNoCaso({ numero: 'Z', partes: [{ papel: 'advogado', rg: RG_DO_REU }] }).length === 0,
    '2f: papel fora da lista não impede');

  // Campos soltos dos outros ritos (medida guarda o alvo em rgAlvo; a abertura penal em reuRg).
  ok(rh.impedidosNoCaso({ numero: 'W', rgAlvo: RG_DO_REU }).includes(JUIZ_QUE_EH_REU),
    '2g: `rgAlvo` da medida também impede');
  ok(rh.impedidosNoCaso({ numero: 'V', reuRg: RG_DO_REU }).includes(JUIZ_QUE_EH_REU),
    '2h: e `reuRg` da abertura penal');
  ok(rh.impedidosNoCaso({ numero: 'U', reuRg: `OUTRO, ${RG_DO_REU}, MAIS` }).includes(JUIZ_QUE_EH_REU),
    '2i: inclusive quando vêm vários RGs numa string só (penal com muitos réus)');

  // FAIL-OPEN e visível: sem RG cadastrado, não dá para casar — e `/rh sem-rg` existe por isso.
  const semRg = '220000000000000009';
  rh.contratar(semRg, 'Juiz', 'Juiz Sem RG');
  ok(!rh.impedidosNoCaso(processo).includes(semRg), '2j: magistrado SEM RG não é impedido (fail-open)');
  ok(rh.magistradosSemRg().some(r => r.discordId === semRg),
    '2k: mas aparece em `/rh sem-rg` — a falha é visível, não silenciosa');
}

// ---------------------------------------------------------------------------
console.log('\n3) A ORDEM DAS PERMISSÕES — deny de membro vence allow de role');
// ---------------------------------------------------------------------------
async function secao3() {
  let criado = null;
  const guild = {
    id: 'guild1', roles: { everyone: 'role-everyone' },
    channels: { create: async (o) => { criado = o; return { id: 'c2', ...o, send: async () => ({ id: 'm' }) }; } },
  };
  await canais.criarCanalTicket(guild, {
    categoriaId: 'cat', prefixo: 'processo', numero: '0902PN',
    membros: ['u-promotor', JUIZ_QUE_EH_REU], impedidos: [JUIZ_QUE_EH_REU],
  });
  const ows = criado.permissionOverwrites;

  const doImpedido = ows.filter(o => o.id === JUIZ_QUE_EH_REU);
  ok(doImpedido.length === 1, '3a: o impedido tem UM overwrite só — não um allow e um deny brigando',
    String(doImpedido.length));
  ok(doImpedido[0] && doImpedido[0].type === OverwriteType.Member,
    '3b: como MEMBRO — é o único nível que vence a role');
  ok(doImpedido[0] && doImpedido[0].deny.includes(PermissionFlagsBits.ViewChannel),
    '3c: negando ViewChannel');
  ok(doImpedido[0] && doImpedido[0].deny.includes(PermissionFlagsBits.ReadMessageHistory),
    '3d: e o histórico junto — sem ver o canal não há histórico a ler');
  ok(!doImpedido[0] || !(doImpedido[0].allow || []).length,
    '3e: e SEM allow nenhum — passar em `membros` não o readmite');

  // Ele continua com a role de Juiz no servidor: é justamente por isso que o deny precisa existir.
  ok(ows.some(o => o.id === 'role-juiz' && o.allow.includes(PermissionFlagsBits.ViewChannel)),
    '3f: a role de Juiz segue com leitura — o deny é o que o exclui, individualmente');

  // O caso que o operador pediu por escrito, dito na ordem em que o Discord avalia:
  //   @everyone (deny view) -> role-juiz (allow view) -> membro impedido (deny view) => NÃO VÊ.
  const everyoneNega = ows.some(o => o.id === 'role-everyone' && o.deny.includes(PermissionFlagsBits.ViewChannel));
  const roleLibera = ows.some(o => ROLES.includes(o.id) && o.allow.includes(PermissionFlagsBits.ViewChannel));
  const membroNega = doImpedido[0] && doImpedido[0].deny.includes(PermissionFlagsBits.ViewChannel);
  ok(everyoneNega && roleLibera && membroNega,
    '3g: MAGISTRADO QUE É PARTE NO PRÓPRIO PROCESSO NÃO VÊ O CANAL');
}

// ---------------------------------------------------------------------------
console.log('\n4) EXCEÇÃO — busca e apreensão e quebra de sigilo seguem restritos');
// ---------------------------------------------------------------------------
async function secao4() {
  ok(canais.ehTicketRestrito('Busca e Apreensão'), '4a: "Busca e Apreensão" é restrito');
  ok(canais.ehTicketRestrito('busca e apreensao'), '4b: sem acento e minúsculo também');
  ok(canais.ehTicketRestrito('Quebra de Sigilo'), '4c: "Quebra de Sigilo" também');
  ok(canais.ehTicketRestrito('Quebra do sigilo bancário'), '4d: e a variação com "do"');
  ok(!canais.ehTicketRestrito('Prisão Preventiva'), '4e: prisão preventiva NÃO é restrita');
  ok(!canais.ehTicketRestrito(null), '4f: sem rótulo, não é restrito');

  let criado = null; const postadas = [];
  const guild = {
    id: 'guild1', roles: { everyone: 'role-everyone' },
    channels: { create: async (o) => { criado = o; return { id: 'c3', ...o, send: async (m) => { postadas.push(m); return { id: 'm' }; } }; } },
  };
  await canais.criarCanalTicket(guild, {
    categoriaId: 'cat', prefixo: 'medida', numero: '0903MD',
    membros: ['u-juiz', 'u-promotor'], rotuloTipo: 'Busca e Apreensão',
  });
  ok(!criado.permissionOverwrites.some(o => ROLES.includes(o.id)),
    '4g: ticket restrito NÃO recebe leitura por cargo');
  ok(criado.permissionOverwrites.filter(o => o.type === OverwriteType.Member).length === 2,
    '4h: só o juiz e o promotor do caso entram');
  ok(postadas.length === 0, '4i: e NÃO menciona ninguém — a diligência não se anuncia');

  // A flag existe no topo, fácil de inverter, como pedido.
  const src = LER('utils', 'canais.js');
  ok(/const TIPOS_TICKET_RESTRITO = \[/.test(src), '4j: a exceção é uma constante no topo');
  ok(src.indexOf('TIPOS_TICKET_RESTRITO') < src.indexOf('async function criarCanalTicket'),
    '4k: declarada ANTES do uso — inverter é apagar uma linha, não caçar condição');
}

// ---------------------------------------------------------------------------
console.log('\n5) BACKFILL — os canais que já existiam também migram');
// ---------------------------------------------------------------------------
async function secao5() {
  const editados = [];
  const canal = {
    id: 'c-antigo',
    permissionOverwrites: { cache: new Map(), edit: async (id, perms, opts) => { editados.push({ id, perms, opts }); } },
  };
  const mexeu = await canais.garantirLeituraPorCargo(canal, { impedidos: [JUIZ_QUE_EH_REU] });
  ok(mexeu === 5, '5a: 4 cargos + 1 impedido = 5 alterações', String(mexeu));

  const doImpedido = editados.find(e => e.id === JUIZ_QUE_EH_REU);
  ok(!!doImpedido && doImpedido.perms.ViewChannel === false, '5b: o impedido é barrado');
  ok(editados.indexOf(doImpedido) === 0,
    '5c: e é o PRIMEIRO — se a chamada falhar no meio, o pior estado é "barrado sem os cargos", nunca o contrário');
  for (const role of ROLES) {
    const e = editados.find(x => x.id === role);
    ok(!!e && e.perms.ViewChannel === true && e.perms.SendMessages === false, `5d-${role}: cargo liberado só para leitura`);
    ok(!!e && e.opts.type === OverwriteType.Role, `5e-${role}: com type explícito`);
  }

  // IDEMPOTENTE: roda todo boot.
  editados.length = 0;
  const jaMigrado = {
    id: 'c-ja',
    permissionOverwrites: {
      cache: new Map(ROLES.map(r => [r, { allow: { has: (p) => p === PermissionFlagsBits.ViewChannel } }])),
      edit: async (id, perms, opts) => { editados.push({ id, perms, opts }); },
    },
  };
  ok(await canais.garantirLeituraPorCargo(jaMigrado) === 0, '5f: canal já migrado não é reescrito');
  ok(editados.length === 0, '5g: zero chamadas de API — rodar todo boot é de graça');

  // Restrito não recebe cargo nem no backfill.
  editados.length = 0;
  const restrito = { id: 'c-r', permissionOverwrites: { cache: new Map(), edit: async (id, p, o) => { editados.push({ id, p, o }); } } };
  await canais.garantirLeituraPorCargo(restrito, { restrito: true });
  ok(editados.length === 0, '5h: ticket restrito não ganha cargo no backfill');

  // Falha não derruba o boot.
  const ruim = { id: 'c-ruim', permissionOverwrites: { cache: new Map(), edit: async () => { throw new Error('Missing Permissions'); } } };
  let explodiu = false;
  try { await canais.garantirLeituraPorCargo(ruim); } catch { explodiu = true; }
  ok(!explodiu, '5i: canal que recusa a edição não derruba o boot');

  // E o boot realmente chama o backfill.
  const idx = LER('index.js');
  ok(/garantirLeituraPorCargo\(canal/.test(idx), '5j: o boot chama o backfill');
  ok(/rh\.impedidosNoCaso\(r\)/.test(idx), '5k: passando os impedidos do caso');
  ok(/ehTicketRestrito\(r\.tipo\)/.test(idx), '5l: e respeitando a exceção dos restritos');
  ok(/!x\.arquivadoManual/.test(idx), '5m: só nos tickets ABERTOS');
}

// ---------------------------------------------------------------------------
console.log('\n6) O QUE NÃO PODE REGREDIR');
// ---------------------------------------------------------------------------
{
  // (a) VER O CANAL NÃO É VER O TEOR. `podeVerTeor` decide pela tabela `pecas`, não pelo Discord.
  db.inserir('processos', {
    numero: '0904PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
    juiz: JUIZ_LIMPO, promotor: PROMOTOR, reus: [], canalId: 'c904', partes: [],
  });
  const p = pecas.gerar({
    processoTabela: 'processos', processoNumero: '0904PN', tipo: 'denuncia_mp',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'Teor.', destinatarios: [{ papel: 'Juiz' }],
  });
  ok(p.ok, '6z: a peça foi criada (o cenário não passou vazio)');
  const advogado = '220000000000000020';
  rh.contratar(advogado, 'Advogado', 'Advogado de fora');
  ok(!pecas.podeVerTeor(advogado, p.peca), '6a: advogado de fora não vê o teor — o gate é o mesmo');
  const pecasSrc = LER('utils', 'pecas.js');
  ok(/const CARGOS_QUE_VEEM_TEOR = \['Juiz', 'Promotor', 'Desembargador', 'Procurador'\]/.test(pecasSrc),
    '6b: `CARGOS_QUE_VEEM_TEOR` intacto — nenhum cargo entrou por causa desta mudança');
  ok(!/ViewChannel|permissionOverwrites/.test(pecasSrc),
    '6c: e `pecas.js` não olha permissão de canal — ver o canal nunca vira ver o teor');

  // (b) MURAL CEGO DO ADVOGADO: ele entra pela habilitação, e a capa penal não revela o caso.
  const proc = LER('commands', 'processo.js');
  ok(/if \(p\.tipo === 'Penal'\)/.test(proc.slice(proc.indexOf('function embedCapaPublica'))),
    '6d: a capa pública do penal continua cega');
  ok(!ROLES.some(r => new RegExp(r).test(proc)), '6e: nenhuma role de cargo foi parar no fluxo do processo');

  // (c) O CÓDIGO DE HABILITAÇÃO NÃO VAI A CANAL — a checagem que o operador pediu.
  //     Este é o ponto que a abertura transformaria em vazamento: o código de 4 dígitos abre a
  //     defesa, e o canal passou a ser lido por todo o tribunal.
  const iIntimar = proc.indexOf('async function intimarReu');
  const bloco = proc.slice(iIntimar, proc.indexOf('async function marcarCitacaoCumprida'));
  ok(bloco.length > 800, '6z2: o corpo de intimarReu foi localizado', `${bloco.length} chars`);
  const codigo = bloco.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // O PNG com o código existe...
  ok(/corpoComCodigo/.test(codigo), '6f: a via do réu continua sendo gerada, com o código impresso');
  // ...mas vai para a DM, e o `canal.send` do bloco NÃO leva arquivo.
  ok(/dm\.send\(\{/.test(codigo) && /files: \[\{ attachment: png/.test(codigo.slice(codigo.indexOf('dm.send'))),
    '6g: e vai por DM a quem emitiu');
  const envioCanal = codigo.slice(codigo.indexOf('canal.send({'), codigo.indexOf('andamentos.registrar'));
  ok(envioCanal.length > 50, '6z3: o envio ao canal foi localizado');
  ok(!/files:/.test(envioCanal), '6h: o `canal.send` da intimação NÃO anexa arquivo nenhum');
  ok(!/codigo/.test(envioCanal), '6i: nem escreve o código no texto da mensagem do canal');

  // Varredura ampla: nenhuma linha viva junta o código a um envio de canal.
  const DIRS = ['commands', 'utils', 'services'];
  const arquivos = DIRS.flatMap(d => fs.readdirSync(path.join(__dirname, '..', d)).filter(f => f.endsWith('.js')).map(f => path.join(d, f)));
  ok(arquivos.length > 20, '6z4: a varredura encontrou arquivos (não passou vazia)', `${arquivos.length}`);
  const suspeitas = [];
  for (const rel of arquivos) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
    src.split('\n').forEach((l, i) => {
      if (l.trim().startsWith('//')) return;
      if (/canal\.send|canalTicket\.send/.test(l) && /codigo|corpoComCodigo|corpoIntimacaoReu/.test(l)) {
        suspeitas.push(`${rel}:${i + 1}`);
      }
    });
  }
  ok(suspeitas.length === 0, '6j: nenhuma linha viva posta o código de habilitação num canal', suspeitas.join(' | '));
}


// ---------------------------------------------------------------------------
console.log('\n7) OS CHAMADORES ligam impedimento e exceção JÁ NA CRIAÇÃO');
// ---------------------------------------------------------------------------
// `criarCanalTicket` aceita `impedidos` e `rotuloTipo`, mas aceitar não basta: se os ritos não
// passarem, a exceção e o impedimento só valeriam no backfill do próximo boot — e existiria uma
// janela entre abrir o caso e reiniciar o bot em que o magistrado-parte leria o próprio processo,
// e a busca e apreensão nasceria aberta ao tribunal.
{
  const proc = LER('commands', 'processo.js');
  const med = LER('commands', 'medida.js');
  ok(proc.length > 10000 && med.length > 5000, '7z: as fontes foram lidas (scan não vazio)');

  const impPenal = (proc.match(/impedidos: rh\.impedidosNoCaso\(/g) || []).length;
  ok(impPenal >= 2, '7a: a abertura penal E a cível calculam os impedidos na criação', `${impPenal} ponto(s)`);
  ok(/impedidos: rh\.impedidosNoCaso\(\{ numero, reuRg, partes: \[\] \}\)/.test(proc),
    '7b: o penal casa pelo RG do réu');
  ok(/impedidos: rh\.impedidosNoCaso\(\{ numero, reuRg, autorRg, partes: \[\] \}\)/.test(proc),
    '7c: o cível casa por réu E autor — nada impede o Juiz de ser autor de uma causa pessoal');

  const impMed = (med.match(/rotuloTipo: tipo, impedidos: rh\.impedidosNoCaso\(\{ numero, rgAlvo \}\)/g) || []).length;
  ok(impMed === 2, '7d: as DUAS aberturas de medida passam rótulo e impedidos', `${impMed}`);
  ok(/rotuloTipo: tipo/.test(med),
    '7e: e o rótulo é o que faz busca e apreensão nascer restrita, sem depender do boot');
}

(async () => {
  await secao1();
  await secao3();
  await secao4();
  await secao5();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
