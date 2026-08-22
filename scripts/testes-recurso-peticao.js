/* eslint-disable */
// RECURSO NA PETIÇÃO ADMINISTRATIVA (19/08/2026). Rode com:
//   node scripts/testes-recurso-peticao.js
//
// O PEDIDO: dar recurso ao Desembargador nas petições administrativas com a MESMA lógica e
// estrutura do penal/cível — sem criar um paralelo.
//
// POR QUE "SEM PARALELO" É A PARTE DIFÍCIL: dois fluxos de recurso que fazem quase a mesma coisa
// divergem na primeira correção que alguém aplica só num deles. Por isso metade deste arquivo não
// testa comportamento — testa que existe UM fluxo, parametrizado por origem, e que o caminho do
// processo continua idêntico ao que era.
//
// O que muda entre as origens é só: quem é parte, quem perdeu, e o que reformar/anular fazem nos
// autos. Isso vive em ORIGENS_RECURSO, um mapa por tabela.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-recurso-pet-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');
const emissao = require('../utils/emissaoPeca');
const processoCmd = require('../commands/processo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

const REQUERENTE = '140000000000000001';
const PROMOTOR = '140000000000000002';
const PROMOTOR_OUTRO = '140000000000000003';
const PROCURADOR = '140000000000000004';
const DESEMB = '140000000000000005';
const ADV_ESTRANHO = '140000000000000006';
const JUIZ = '140000000000000007';

rh.contratar(REQUERENTE, 'Advogado', 'Advogado requerente');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor da petição');
rh.contratar(PROMOTOR_OUTRO, 'Promotor', 'Outro promotor');
rh.contratar(PROCURADOR, 'Procurador', 'Procurador');
rh.contratar(DESEMB, 'Desembargador', 'Desembargador');
rh.contratar(ADV_ESTRANHO, 'Advogado', 'Advogado de fora');
rh.contratar(JUIZ, 'Juiz', 'Juiz');

let seq = 0;
function peticao(campos = {}) {
  const numero = `08${String(++seq).padStart(2, '0')}PA`;
  db.inserir('peticoes', {
    numero, tipo: 'PorteArma', status: 'Indeferido', requerenteId: REQUERENTE,
    juiz: JUIZ, promotor: PROMOTOR, canalId: 'cp1', modoEntrega: 'ingame',
    nomeCliente: 'Cliente RP', rgCliente: '999', motivo: 'Ausentes os requisitos.',
    ...campos,
  });
  return db.buscarPorNumero('peticoes', numero);
}
const inter = (userId) => ({
  user: { id: userId },
  member: { permissions: { has: () => false }, roles: { cache: { has: () => false, some: () => false } } },
});

console.log('\n=== Recurso na petição administrativa ===\n');

// ---------------------------------------------------------------------------
console.log('1) É O MESMO FLUXO — não nasceu um paralelo');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  ok(src.length > 1000, '1z: o arquivo foi lido (scan não vazio)');

  ok(/const ORIGENS_RECURSO = \{/.test(src), '1a: existe um mapa de origens do recurso');
  ok(/^\s+processos: \{/m.test(src) && /^\s+peticoes: \{/m.test(src),
    '1b: com as duas origens declaradas lado a lado');

  // Uma função só para cada etapa. Se aparecer um "criarApelacaoPeticao", é o paralelo nascendo.
  for (const fn of ['criarApelacao', 'finalizarApelacao', 'abrirModalRecorrer', 'confirmarRazoes', 'validarDecisaoApelacao']) {
    const decls = (src.match(new RegExp(`(?:async )?function ${fn}\\s*\\(`, 'g')) || []).length;
    ok(decls === 1, `1c-${fn}: existe UMA declaração, não uma por origem`, `${decls} declarações`);
  }
  ok(!/Peticao\s*\(interaction[^)]*\)\s*\{[^}]*apelacoes/.test(src),
    '1d: não há variante "…Peticao" do fluxo de apelação');

  // E o fluxo compartilhado recebe a tabela por parâmetro.
  ok(/async function criarApelacao\(interaction, numero, modo, tabela = 'processos'\)/.test(src),
    '1e: criarApelacao recebe a tabela de origem, com processos como padrão');
  ok(/async function abrirModalRecorrer\(interaction, numero, tabela = 'processos'\)/.test(src),
    '1f: abrirModalRecorrer idem');
}

// ---------------------------------------------------------------------------
console.log('\n2) QUEM PERDEU RECORRE');
// ---------------------------------------------------------------------------
{
  const cfg = processoCmd.ORIGENS_RECURSO.peticoes;

  // INDEFERIDO — perdeu o requerente.
  const ind = peticao({ status: 'Indeferido' });
  ok(cfg.podeRecorrer(inter(REQUERENTE), ind) === true, '2a: indeferido → o requerente recorre');
  ok(cfg.podeRecorrer(inter(PROMOTOR), ind) === false, '2b: ...e o MP NÃO recorre (ele venceu)');
  // A recusa tem que dizer QUEM tem o recurso, não só que esta pessoa não tem — recusa sem saída
  // é beco disfarçado, e é a regra que o projeto aplica em todas as outras.
  ok(/quem perdeu foi o requerente/.test(cfg.explicarNegacao(inter(PROMOTOR), ind)),
    '2c: ...e a recusa aponta quem de fato pode recorrer');

  // DEFERIDO — perdeu o MP, que recorre como fiscal.
  const def = peticao({ status: 'Deferido' });
  ok(cfg.podeRecorrer(inter(PROMOTOR), def) === true, '2d: deferido → o Promotor do caso recorre');
  ok(cfg.podeRecorrer(inter(PROMOTOR_OUTRO), def) === true,
    '2e: ...e QUALQUER Promotor também — o MP é órgão, não pessoa');
  ok(cfg.podeRecorrer(inter(PROCURADOR), def) === true, '2f: ...o Procurador cobre o Promotor');
  ok(cfg.podeRecorrer(inter(REQUERENTE), def) === false, '2g: ...e o requerente NÃO recorre (ele venceu)');

  // Quem não é parte nunca recorre.
  ok(cfg.podeRecorrer(inter(ADV_ESTRANHO), ind) === false, '2h: advogado de fora não recorre');
  ok(/não é parte/.test(cfg.explicarNegacao(inter(ADV_ESTRANHO), ind)), '2i: ...e a recusa explica por quê');
  ok(cfg.podeRecorrer(inter(JUIZ), ind) === false, '2j: nem o Juiz que decidiu');

  // Ainda não decidida: não há do que recorrer.
  const pend = peticao({ status: 'Pendente' });
  ok(cfg.podeRecorrer(inter(REQUERENTE), pend) === false, '2k: petição pendente não é recorrível');
  ok(/ainda não foi decidida/.test(cfg.explicarNegacao(inter(REQUERENTE), pend)),
    '2l: ...e a recusa diz que falta a decisão, não que a pessoa não é parte');

  // Parte contrária — quem é notificado do outro lado.
  ok(cfg.parteContraria(ind, REQUERENTE) === PROMOTOR, '2m: recorrendo o requerente, a contrária é o MP');
  ok(cfg.parteContraria(def, PROMOTOR) === REQUERENTE, '2n: recorrendo o MP, a contrária é o requerente');
}

// ---------------------------------------------------------------------------
console.log('\n3) A ENTREGA GATED é a mesma');
// ---------------------------------------------------------------------------
{
  // As razões do recurso da petição usam o MESMO tipo de peça e o mesmo destinatário do recurso
  // de processo — não há um "razoes_recurso_peticao".
  const src = LER('commands', 'processo.js');
  const corpo = src.slice(src.indexOf('async function criarApelacao'), src.indexOf('function botoesApelacao'));
  ok(corpo.length > 800, '3z: o corpo de criarApelacao foi encontrado (scan não vazio)');
  ok((corpo.match(/emitirAtoComoPeca/g) || []).length === 1,
    '3a: UMA emissão de razões, servindo as duas origens');
  ok(/tipo: 'razoes_recurso'/.test(corpo), '3b: pelo mesmo tipo de peça');
  ok(!/razoes_recurso_peticao/.test(src), '3c: e não nasceu um tipo paralelo para a petição');

  // O julgamento continua travado até o relator receber — é o mesmo gate.
  const ap = db.inserir('apelacoes', {
    numero: 'AP900', processoOriginalNumero: '0801PA', origemTabela: 'peticoes', tipo: 'Administrativo',
    recorrenteId: REQUERENTE, parteContrariaId: PROMOTOR, desembargadorId: DESEMB,
    razoes: 'Razões.', status: 'Aguardando decisão', canalId: 'cap9', modoEntrega: 'ingame',
  });
  const g = pecas.gerar({
    processoTabela: 'apelacoes', processoNumero: 'AP900', tipo: 'razoes_recurso',
    autorId: REQUERENTE, autorPapel: 'Advogado', texto: 'Razões.',
    destinatarios: [{ papel: 'Desembargador' }],
  });
  ok(g.ok && g.peca.gated, '3d: a peça das razões nasce gated');
  const idsDe = (linhas) => linhas.flatMap(l => l.toJSON().components.map(c => c.custom_id || ''));
  const antes = idsDe(processoCmd.botoesApelacao(db.buscarPorNumero('apelacoes', 'AP900')));
  ok(!antes.some(id => /:manter:|:reformar:|:anular:/.test(id)),
    '3e: Manter/Reformar/Anular não aparecem antes da entrega — igual ao recurso de processo');

  pecas.abrirEntrega(g.peca.numero, REQUERENTE);
  const token = db.buscarPorNumero('pecas', g.peca.numero).destinatarios[0].token;
  ok(pecas.receber(g.peca.numero, DESEMB, { tokenLido: token }).ok, '3f: o relator recebe em cena, com selo');
  const depois = idsDe(processoCmd.botoesApelacao(db.buscarPorNumero('apelacoes', 'AP900')));
  ok(depois.some(id => /:manter:/.test(id)) && depois.some(id => /:anular:/.test(id)),
    '3g: e só então o julgamento destrava');
}

// ---------------------------------------------------------------------------
console.log('\n4) MANTER / REFORMAR / ANULAR nos autos da petição');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  const corpo = src.slice(src.indexOf('async function finalizarApelacao'), src.indexOf('async function confirmarAcordao'));
  ok(corpo.length > 800, '4z: o corpo de finalizarApelacao foi encontrado (scan não vazio)');

  ok(/const origemTabela = apelacao\.origemTabela \|\| 'processos';/.test(corpo),
    '4a: a decisão despacha pela origem, e registro antigo vale como processo');
  ok(/if \(origemTabela === 'peticoes' && processoOriginal\) \{/.test(corpo),
    '4b: há um ramo próprio para a petição');
  ok(/origemTabela === 'processos' && decisao === 'reformar'/.test(corpo)
    && /origemTabela === 'processos' && decisao === 'anular'/.test(corpo),
    '4c: e os ramos do processo passaram a exigir a origem — nenhum dos dois roda no lugar do outro');

  // A regra de reformar: inverte o resultado.
  ok(/const novoStatus = processoOriginal\.status === 'Deferido' \? 'Indeferido' : 'Deferido';/.test(corpo),
    '4d: reformar INVERTE o resultado da petição');
  ok(/REFORMADA EM GRAU DE RECURSO/.test(corpo), '4e: ...deixando a nota nos autos');

  // Anular: volta à fila com outro Juiz.
  ok(/status: 'Pendente', juiz: novoJuizId \|\| processoOriginal\.juiz,/.test(corpo),
    '4f: anular devolve a petição à fila de decisão');
  ok(/excluirIds: \[processoOriginal\.juiz, processoOriginal\.requerenteId\]/.test(corpo),
    '4g: ...com OUTRO Juiz — quem proferiu a decisão anulada não a refaz');
  ok(/motivo: null, decisaoJuizEm: null, executadoPorId: null/.test(corpo),
    '4h: ...e limpa a decisão anulada, sem deixar fundamentação órfã nos autos');
  // Passou a exigir o INVÓLUCRO, não a função crua (21/08/2026): fecharJanelasDoProcesso direto
  // volta a engolir a falha, e janela aberta em processo anulado é porta para entregar documento
  // que não vale mais. Ver fecharJanelasEAvisar em utils/pecas.js.
  ok(/fecharJanelasEAvisar\(interaction\.guild, 'peticoes'/.test(corpo),
    '4i: ...e fecha entrega pendente da decisão anulada, pelo invólucro que avisa quando falha (SPEC §11.4)');
}

// ---------------------------------------------------------------------------
console.log('\n5) CAMINHO DE PRODUÇÃO — o clique real chega no fluxo');
// ---------------------------------------------------------------------------
{
  const pet = LER('commands', 'peticao.js');
  const painel = LER('commands', 'painel.js');
  ok(pet.length > 1000 && painel.length > 1000, '5z: os arquivos foram lidos (scan não vazio)');

  ok(/botaoRecorrer\(numero, 'peticao'\)/.test(pet),
    '5a: a petição decidida posta o botão Recorrer');
  ok(/acao === 'recorrer'\) return processoCmd\.abrirModalRecorrer\(interaction, extra, 'peticoes'\)/.test(painel),
    '5b: o clique chega em abrirModalRecorrer, dizendo a origem');
  ok(/modulo === 'peticao' && acao === 'recorrer'/.test(painel),
    '5c: e o submit do modal cai em confirmarRazoes com a origem');

  // A revisão-IA no meio do caminho não pode perder a origem.
  const proc = LER('commands', 'processo.js');
  ok(/const extra = tabela === 'peticoes' \? `\$\{numero\}#peticoes` : numero;/.test(proc),
    '5d: a origem viaja no `extra` da tela de revisão-IA');
  ok(/publicarRazoes\(interaction, extra\) \{ const \[n, t\] = String\(extra\)\.split\('#'\);/.test(proc),
    '5e: ...e é lida de volta ao protocolar');
  ok(/usarRevisadoRazoes\(interaction, extra\) \{ const \[n, t\] = String\(extra\)\.split\('#'\);/.test(proc),
    '5f: ...nos dois botões da tela, não só num deles');
}

// ---------------------------------------------------------------------------
console.log('\n6) O RECURSO DE PROCESSO não regrediu');
// ---------------------------------------------------------------------------
{
  // A generalização não pode ter mudado o comportamento que já existia.
  const cfg = processoCmd.ORIGENS_RECURSO.processos;
  const proc = db.inserir('processos', {
    numero: '0800PN', tipo: 'Penal', status: 'Encerrado', resultado: 'Condenado',
    juiz: JUIZ, promotor: PROMOTOR, reus: ['140000000000000099'], canalId: 'c1',
    habilitacoes: [{ id: 1, advogadoId: REQUERENTE, reuId: '140000000000000099', status: 'Aprovado' }],
  });
  ok(cfg.podeRecorrer(inter(REQUERENTE), proc) === true,
    '6a: penal condenado — a defesa continua podendo recorrer');
  ok(cfg.podeRecorrer(inter(PROMOTOR), proc) === false,
    '6b: e a acusação que venceu continua sem recurso');
  ok(cfg.parteContraria(proc, REQUERENTE) === PROMOTOR, '6c: a parte contrária segue a mesma');
  ok(cfg.tipoDoRegistro(proc) === 'Penal', '6d: e o tipo gravado na apelação continua vindo do processo');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
