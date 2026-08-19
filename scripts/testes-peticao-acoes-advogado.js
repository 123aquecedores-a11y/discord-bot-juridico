/* eslint-disable */
// AÇÕES DO ADVOGADO NA PETIÇÃO + FIM DO VÍNCULO DE DISCORD DO CLIENTE (19/08/2026). Rode com:
//   node scripts/testes-peticao-acoes-advogado.js
//
// DUAS MUDANÇAS, um arquivo:
//
// 1. O requerente precisa peticionar e juntar prova DENTRO da petição, igual num processo. A regra
//    de ouro aqui foi NÃO DUPLICAR: as funções são as do processo, recebendo em que tabela mexer.
//    Este arquivo prova que é a mesma implementação, não uma cópia que vai divergir em três meses.
//
// 2. O vínculo de Discord do cliente saiu. O cliente é personagem de RP: não tem conta no servidor,
//    e o dado nunca decidia nada. O risco da remoção não é o vínculo sumir — é algum fluxo que
//    dependia dele passar a falhar CALADO. A troca de nome é esse fluxo, e tem seção própria.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-adv-peticao-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const peticaoCmd = require('../commands/peticao');
const processoCmd = require('../commands/processo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const ADVOGADO = '900000000000000001';
const JUIZ = '900000000000000002';
const PROMOTOR = '900000000000000003';
const ESTRANHO = '900000000000000004';

rh.contratar(ADVOGADO, 'Advogado', 'Advogado');
rh.contratar(JUIZ, 'Juiz', 'Juiz');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(ESTRANHO, 'Advogado', 'Advogado de outro caso');

const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

let seq = 0;
function peticao(campos = {}) {
  const numero = `07${String(++seq).padStart(2, '0')}PA`;
  db.inserir('peticoes', {
    numero, tipo: 'PorteArma', status: 'Pendente', requerenteId: ADVOGADO,
    juiz: JUIZ, promotor: PROMOTOR, rgCliente: '12345', nomeCliente: 'Cliente RP',
    canalId: 'c1', ...campos,
  });
  return db.buscarPorNumero('peticoes', numero);
}

// Interação de mentira, só o suficiente para os gates e para capturar o que foi respondido.
// `member.permissions` precisa existir: isAdmin lê antes de qualquer outra coisa.
function fakeInteraction(userId, { campos = {} } = {}) {
  const capturado = { modal: null, replies: [], updates: [] };
  return {
    user: { id: userId },
    guild: { id: 'guild1', channels: { fetch: async () => null }, members: { fetch: async () => null } },
    member: {
      permissions: { has: () => false },
      roles: { cache: { has: () => false, some: () => false } },
    },
    fields: { getTextInputValue: (k) => campos[k] ?? '' },
    showModal: async (m) => { capturado.modal = m; return m; },
    reply: async (o) => { capturado.replies.push(o); return o; },
    update: async (o) => { capturado.updates.push(o); return o; },
    editReply: async (o) => { capturado.replies.push(o); return o; },
    followUp: async (o) => { capturado.replies.push(o); return o; },
    deferReply: async () => {},
    capturado,
  };
}

console.log('\n=== Petição: ações do advogado + fim do vínculo de Discord ===\n');

// ---------------------------------------------------------------------------
console.log('1) O PAINEL passa a ter as ações do advogado');
// ---------------------------------------------------------------------------
{
  const p = peticao();
  const linhas = peticaoCmd.botoesDecisao(p.numero);
  const rows = linhas.map(l => l.toJSON());
  const json = JSON.stringify(rows);

  ok(/painel:acao:peticao:anexardocumento:/.test(json), '1a: o painel traz o "Peticionar"');
  ok(/📄 Peticionar/.test(json), '1b: ...com esse nome, o mesmo do processo');
  ok(/painel:acao:peticao:anexarprova:/.test(json), '1c: o painel traz o "Anexar prova"');
  ok(/🧾 Anexar prova/.test(json), '1d: ...com o mesmo rótulo do processo');

  // As ações do juiz não podem ter sido deslocadas por isso.
  for (const acao of ['deferir', 'indeferir', 'diligencia', 'certidao', 'arquivarmanual']) {
    ok(new RegExp(`painel:acao:peticao:${acao}:`).test(json), `1e-${acao}: a ação do juiz continua no painel`);
  }
  ok(/supervisao/i.test(json), '1f: a entrada de Supervisão continua no painel');

  // Limite duro do Discord — 5 componentes por linha, 5 linhas por mensagem. Estourar isso derruba
  // a mensagem inteira, e já derrubou este painel antes.
  ok(rows.length <= 5, '1g: o painel cabe em 5 linhas', `${rows.length} linhas`);
  ok(rows.every(r => r.components.length <= 5), '1h: nenhuma linha passa de 5 componentes',
    rows.map(r => r.components.length).join('/'));

  // ANTIRREDUNDÂNCIA: "Peticionar" é o botão que já existia sob outro nome. Se algum dia nascer um
  // segundo botão para o mesmo ato, este teste avisa.
  const ids = rows.flatMap(r => r.components.map(c => c.custom_id)).filter(Boolean);
  ok(new Set(ids).size === ids.length, '1i: nenhum botão aparece duas vezes no painel', ids.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n2) NÃO É CÓPIA — é a função do processo, com a tabela por parâmetro');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'peticao.js');
  const srcProc = LER('commands', 'processo.js');
  ok(src.length > 1000 && srcProc.length > 1000, '2z: os arquivos foram lidos (o scan não passou vazio)');

  // O que peticao.js pode ter é DELEGAÇÃO. Se aparecer a mecânica da prova aqui dentro (gravar o
  // rol, montar o card), é porque alguém copiou — e as duas cópias vão divergir.
  ok(/require\('\.\/processo'\)\.abrirModalAnexarProva/.test(src),
    '2a: abrir o modal de prova DELEGA para commands/processo.js');
  ok(/require\('\.\/processo'\)\.salvarProva/.test(src),
    '2b: salvar a prova DELEGA para commands/processo.js');
  ok(!/provas:\s*\[\.\.\.provas/.test(src),
    '2c: peticao.js NÃO grava o rol de provas por conta própria (seria a cópia)');
  ok(!/Prova juntada aos autos/.test(src),
    '2d: peticao.js NÃO monta o card da prova por conta própria');

  // E a implementação única precisa mesmo aceitar a tabela. `Function.length` não serve aqui: ela
  // para de contar no primeiro parâmetro com default, que é justamente o `tabela`.
  for (const fn of ['salvarProva', 'abrirModalAnexarProva', 'verRolProvas']) {
    ok(new RegExp(`function ${fn}\\(interaction, numero, tabela = 'processos'\\)`).test(srcProc),
      `2e-${fn}: aceita a tabela por parâmetro, com 'processos' como padrão`);
  }
  ok(/db\.atualizar\(tabela, numero, \{ provas:/.test(srcProc),
    '2f: a gravação do rol usa a tabela recebida, não "processos" fixo');
}

// ---------------------------------------------------------------------------
console.log('\n3) COMPORTAMENTAL — a prova entra na PETIÇÃO, não num processo');
// ---------------------------------------------------------------------------
async function secao3() {
  const p = peticao();
  const i = fakeInteraction(ADVOGADO, {
    campos: { tipo: 'Documento', descricao: 'Comprovante de residência', link: 'https://exemplo/doc.pdf' },
  });
  await peticaoCmd.salvarProvaPeticao(i, p.numero);
  const depois = db.buscarPorNumero('peticoes', p.numero);

  ok((depois.provas || []).length === 1, '3a: a prova foi gravada na petição');
  ok(depois.provas[0].autorId === ADVOGADO, '3b: com o autor certo');
  ok(depois.provas[0].descricao === 'Comprovante de residência', '3c: e a descrição certa');
  ok(db.todos('processos', () => true).length === 0,
    '3d: NENHUM processo foi criado ou tocado — a prova ficou na tabela `peticoes`');

  // Quem não é parte não junta prova nesta petição.
  const p2 = peticao();
  const iEstranho = fakeInteraction(ESTRANHO, { campos: { tipo: 'x', descricao: 'y', link: 'https://e/1' } });
  await peticaoCmd.salvarProvaPeticao(iEstranho, p2.numero);
  ok((db.buscarPorNumero('peticoes', p2.numero).provas || []).length === 0,
    '3e: advogado de outro caso NÃO consegue juntar prova aqui');
  ok(iEstranho.capturado.replies.some(r => /Só as partes/.test(r.content || '')),
    '3f: ...e recebe a recusa dita, não silêncio');

  // O Juiz da petição é parte e pode juntar (mesma regra do processo).
  const iJuiz = fakeInteraction(JUIZ, { campos: { tipo: 'Ofício', descricao: 'Resposta do órgão', link: 'https://e/2' } });
  await peticaoCmd.salvarProvaPeticao(iJuiz, p2.numero);
  ok((db.buscarPorNumero('peticoes', p2.numero).provas || []).length === 1,
    '3g: o Juiz da petição é parte e junta normalmente');

  // O modal abre com o customId que volta para a PETIÇÃO. Errar isso mandaria o submit para o
  // roteador do processo, que procuraria o número numa tabela onde ele não existe.
  const iModal = fakeInteraction(ADVOGADO);
  await peticaoCmd.abrirModalAnexarProvaPeticao(iModal, p.numero);
  const cid = iModal.capturado.modal && iModal.capturado.modal.toJSON().custom_id;
  ok(cid === `painel:modal:peticao:anexarprova:${p.numero}`,
    '3h: o modal de prova volta pelo roteador da PETIÇÃO', String(cid));

  // E o processo continua funcionando exatamente como antes — a generalização não podia custar
  // uma regressão no caminho que já existia.
  db.inserir('processos', {
    numero: '0777CV', tipo: 'Civil', status: 'Aguardando defesa', autor: ADVOGADO,
    juiz: JUIZ, canalId: 'c9', habilitacoes: [], reus: [],
  });
  const iProc = fakeInteraction(ADVOGADO, { campos: { tipo: 'Foto', descricao: 'Cena', link: 'https://e/3' } });
  await processoCmd.salvarProva(iProc, '0777CV');
  ok((db.buscarPorNumero('processos', '0777CV').provas || []).length === 1,
    '3i: o caminho do PROCESSO segue igual — nenhuma regressão pela generalização');
}

// ---------------------------------------------------------------------------
console.log('\n4) O VÍNCULO DE DISCORD DO CLIENTE SAIU — de todos os lugares');
// ---------------------------------------------------------------------------
{
  const srcPeticao = LER('commands', 'peticao.js');
  const srcPainel = LER('commands', 'painel.js');
  ok(srcPeticao.length > 1000 && srcPainel.length > 1000, '4z: os arquivos foram lidos (scan não vazio)');

  ok(!/Vincular Discord do cliente/.test(srcPeticao), '4a: o select "Vincular Discord do cliente" sumiu');
  ok(!/Informar @\/ID na mão/.test(srcPeticao), '4b: o botão "Informar @/ID na mão" sumiu');
  ok(!/UserSelectMenuBuilder/.test(srcPeticao), '4c: o import do select de usuário sumiu junto');
  ok(!/function vincularClienteDiscord/.test(srcPeticao), '4d: o handler do select sumiu');
  ok(!/function processarVincularManual/.test(srcPeticao), '4e: o handler do modal manual sumiu');
  ok(peticaoCmd.vincularClienteDiscord === undefined, '4f: e não sobrou export órfão');

  // Botão já POSTADO em canal antigo continua existindo no Discord e ainda pode ser clicado. O
  // roteador tem de responder algo compreensível — "ação desconhecida" seria o erro silencioso.
  ok(/vincularmanual/.test(srcPainel) && /não existe mais/.test(srcPainel),
    '4g: clique num botão antigo de vínculo é respondido com explicação, não com erro genérico');
  ok(/vincularcliente#/.test(srcPainel) && !/peticaoCmd\.vincularClienteDiscord/.test(srcPainel),
    '4h: o select antigo idem — responde sem chamar handler que não existe mais');
  ok(!/peticaoCmd\.abrirModalVincularManual|peticaoCmd\.processarVincularManual/.test(srcPainel),
    '4i: o roteador não chama mais nenhum handler removido');
}

// ---------------------------------------------------------------------------
console.log('\n5) O FLUXO QUE DEPENDIA DO VÍNCULO — troca de nome, sem quebrar e sem silêncio');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'peticao.js');

  // A retificação do nome civil na ficha é o que de fato importa, e NÃO dependia do Discord.
  ok(/ficha\.registrarTrocaNome/.test(src), '5a: a troca de nome civil na ficha continua acontecendo');

  // O setNickname era a única coisa que precisava da conta. Some — mas com aviso nos autos.
  ok(!/setNickname/.test(src), '5b: não há mais tentativa de renomear conta de Discord');
  ok(!/apelidoAlterado/.test(src), '5c: e o estado morto que sobrava foi removido junto');
  ok(/trocaNomeSemVinculo = true/.test(src), '5d: a ausência é registrada explicitamente...');
  ok(/personagem de RP e não tem conta no servidor/.test(src),
    '5e: ...e vira aviso nos autos dizendo por quê — o oposto de falhar calado');
  ok(!/Vincule o Discord do cliente/.test(src),
    '5f: o aviso não manda mais o usuário para um fluxo que deixou de existir');

  // Sorteio do Juiz excluía o Discord do cliente; o campo nunca mais é preenchido.
  ok(!/discordIdCliente\]\.filter/.test(src),
    '5g: o sorteio de Juiz não tenta mais excluir um campo que ninguém preenche');
  const srcPrazos = LER('utils', 'prazos.js');
  ok(srcPrazos.length > 500 && !/p\.discordIdCliente/.test(srcPrazos),
    '5h: idem no sorteio automático de utils/prazos.js');

  // Status legado sem saída: nada mais cancela por falta de vínculo, mas registro antigo nesse
  // estado precisa de um caminho de volta.
  ok(/Cancelada — prazo de vínculo expirado/.test(src),
    '5i: petição legada cancelada por vínculo ainda tem ramo de reabertura');
  ok(/status: 'Pendente', criado_em/.test(src),
    '5j: ...e a reabertura devolve à fila de decisão, sem repedir o vínculo');
}

(async () => {
  await secao3();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
