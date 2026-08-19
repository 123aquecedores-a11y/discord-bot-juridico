/* eslint-disable */
// SENTENÇA E RECURSO — absolvição, PNG, entrega e render (19/08/2026). Rode com:
//   node scripts/testes-sentenca-e-recurso.js
//
// QUATRO DEFEITOS RELATADOS NO TESTE IN-GAME, um bloco cada:
//
//   1. ABSOLVER sumiu. A regra "não marcado = absolvido" sempre esteve certa no código, mas
//      absolver em TUDO exigia enviar um select vazio — que na prática ninguém consegue enviar.
//      O caminho existia e era inalcançável, que é o defeito recorrente deste projeto.
//   2. A sentença não gerou PNG. Ela chamava `pecas.gerar` direto, que só INSERE o registro: sem
//      render, sem DM, e sem o card do botão "Entregar agora" — o card mandava usar um botão que
//      não existia em lugar nenhum.
//   3. O recurso publicava as razões CRUAS no embed de um canal que tem o relator, o recorrente e
//      a parte contrária dentro, e os botões de julgar nasciam antes de qualquer entrega.
//   4. `<@null>` no lugar do réu sem Discord, e "Regime inicial: 58" — pena e regime eram um blob
//      só, sem amarração com o crime.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-sent-rec-${process.pid}.json`);
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

const JUIZ = '120000000000000001';
const DESEMB = '120000000000000002';
const ADVOGADO = '120000000000000003';
const PROMOTOR = '120000000000000004';

rh.contratar(JUIZ, 'Juiz', 'Juiz');
rh.contratar(DESEMB, 'Desembargador', 'Desembargador');
rh.contratar(ADVOGADO, 'Advogado', 'Advogado');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');

console.log('\n=== Sentença e recurso ===\n');

// ---------------------------------------------------------------------------
console.log('1) ABSOLVIÇÃO — a porta explícita que faltava');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  ok(src.length > 1000, '1z: o arquivo foi lido (scan não vazio)');

  ok(/absolvertodos/.test(src), '1a: existe um botão de absolver em todos os crimes');
  ok(/Absolver em TODOS os crimes/.test(src), '1b: ...com rótulo explícito para o Juiz');
  ok(/async absolverTodos\(/.test(src), '1c: e o handler existe');
  ok(typeof processoCmd.absolverTodos === 'function', '1d: exportado (não é órfão)');

  // CAMINHO DE PRODUÇÃO: o clique tem que chegar no handler pelo roteador, senão é botão morto.
  const painel = LER('commands', 'painel.js');
  ok(/'absolvertodos'/.test(painel) && /processoCmd\.absolverTodos/.test(painel),
    '1e: o roteador do painel leva o clique ao handler — o botão não é decorativo');

  // O handler zera o veredicto e cai no MESMO modal do veredicto vazio: nenhuma lógica paralela.
  const corpo = src.slice(src.indexOf('async absolverTodos('), src.indexOf('async absolverTodos(') + 900);
  ok(/rascunhoVeredicto\.set\(chaveDecisao\([^;]*\[\]\);/.test(corpo), '1f: absolver = veredicto vazio, o caminho que já existia');
  ok(/modalSentencaPorCrime\(numero, processo, \[\]\)/.test(corpo), '1g: e abre o modal só de fundamentação');
  ok(/podeAtuarNoCaso/.test(corpo), '1h: com a mesma trava de cargo dos demais atos do julgamento');
}

// ---------------------------------------------------------------------------
console.log('\n2) A REGRA do resultado agregado');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  const corpo = src.slice(src.indexOf('async function salvarSentencaPorCrime'), src.indexOf('async function executarSentenca'));
  ok(corpo.length > 500, '2z: o corpo de salvarSentencaPorCrime foi encontrado (scan não vazio)');

  ok(/const resultado = temCondenacao \? 'Condenado' : 'Absolvido';/.test(corpo),
    '2a: um condenado basta para Condenado; nenhum → Absolvido (absolvição total)');
  ok(/resultado: condenadosIds\.includes\(c\.id\) \? 'Condenado' : 'Absolvido'/.test(corpo),
    '2b: cada crime é Condenado OU Absolvido, individualmente');
  ok(/pena: condenadosIds\.includes\(c\.id\) \? \(penaPorCrimeId\[c\.id\] \|\| null\) : null/.test(corpo),
    '2c: PENA só vai para o crime CONDENADO — absolvido com pena seria contradição nos autos');
}

// ---------------------------------------------------------------------------
console.log('\n3) A SENTENÇA passa pelo pipeline completo de emissão');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  const corpo = src.slice(src.indexOf('async function executarSentenca'));
  ok(corpo.length > 1000, '3z: o corpo de executarSentenca foi encontrado (scan não vazio)');

  ok(/emitirAtoComoPeca/.test(corpo), '3a: a sentença emite pelo pipeline completo');
  ok(!/pecas'\)\.gerar\(/.test(corpo) && !/pecas\.gerar\(/.test(corpo),
    '3b: e NÃO chama mais pecas.gerar cru — era isso que pulava o PNG e o botão de entrega');

  // O pipeline precisa mesmo fazer as quatro coisas; sem isso a troca acima seria cosmética.
  const emi = LER('utils', 'emissaoPeca.js');
  const fin = emi.slice(emi.indexOf('async function finalizarPeca('), emi.indexOf('async function emitirAtoComoPeca('));
  ok(fin.length > 400, '3z2: o corpo de finalizarPeca foi encontrado (scan não vazio)');
  ok(/renderizar\(/.test(fin), '3c: finalizarPeca RENDERIZA o PNG');
  ok(/enviarAoEmissor\(/.test(fin), '3d: ...manda ao emissor (o Juiz recebe a via para imprimir no jogo)');
  ok(/postarNoCanal\(/.test(fin), '3e: ...posta o card com o botão "Entregar agora" — o que faltava');
  ok(/andamentos\.registrar\(/.test(fin), '3f: ...e lavra o andamento da emissão');

  // criarPeca (o fluxo do formulário) tem que usar o MESMO pipeline, senão são duas cópias.
  const criar = emi.slice(emi.indexOf('async function criarPeca('), emi.indexOf('async function criarPeca(') + 4000);
  ok(/finalizarPeca\(/.test(criar), '3g: criarPeca usa o mesmo finalizarPeca — uma implementação, não duas');

  // A falha da peça não pode desfazer o julgamento: a sentença é ato consumado.
  ok(/A sentença está lavrada nos autos, mas a peça de entrega falhou/.test(corpo),
    '3h: se a emissão falhar, o Juiz é avisado e a sentença CONTINUA lavrada');
}

// ---------------------------------------------------------------------------
console.log('\n4) O RECURSO segue o mesmo rito de entrega');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'processo.js');
  const corpo = src.slice(src.indexOf('async function criarApelacao'), src.indexOf('function botoesApelacao'));
  ok(corpo.length > 800, '4z: o corpo de criarApelacao foi encontrado (scan não vazio)');

  ok(!/name: 'Razões do recurso', value: truncar\(razoes\)/.test(corpo),
    '4a: as razões NÃO vão mais cruas no embed do canal (o canal tem a parte contrária dentro)');
  ok(/emitirAtoComoPeca/.test(corpo) && /razoes_recurso/.test(corpo),
    '4b: elas viram peça, pelo mesmo pipeline da sentença');

  // O tipo precisa existir de verdade no catálogo, com rótulo — tipo órfão imprime "DOCUMENTO".
  ok(!!emissao.TIPOS.razoes_recurso, '4c: o tipo razoes_recurso existe no catálogo de emissão');
  ok(emissao.TIPOS.razoes_recurso.destinatarios.includes('Desembargador'),
    '4d: e é dirigido ao Desembargador');
  ok(emissao.TIPOS.razoes_recurso.tabela === 'apelacoes', '4e: na tabela da apelação');
  const catalogo = require('../utils/catalogoAtos');
  ok(catalogo.rotuloDe ? catalogo.rotuloDe('razoes_recurso').titulo === 'RAZÕES DE RECURSO'
    : /RAZÕES DE RECURSO/.test(LER('utils', 'catalogoAtos.js')),
    '4f: com rótulo próprio no catálogo (senão o PNG sairia como "DOCUMENTO")');

  // O julgamento só destrava com o recebimento.
  ok(!!emissao.EFEITOS_POS_RECEBIMENTO.razoes_recurso,
    '4g: receber as razões é um elo de destravamento registrado');
}

// ---------------------------------------------------------------------------
console.log('\n5) COMPORTAMENTAL — os botões de julgar só nascem depois da entrega');
// ---------------------------------------------------------------------------
{
  const ap = db.inserir('apelacoes', {
    numero: 'AP001', processoOriginalNumero: '0900PN', tipo: 'Penal',
    recorrenteId: ADVOGADO, parteContrariaId: PROMOTOR, desembargadorId: DESEMB,
    razoes: 'Razões da defesa.', status: 'Aguardando decisão', decisao: null,
    canalId: 'cap1', modoEntrega: 'ingame',
  });
  const idsDe = (linhas) => linhas.flatMap(l => l.toJSON().components.map(c => c.custom_id || ''));

  // Ainda sem peça emitida: nada a esperar, o relator pode agir (é o estado de um recurso antigo).
  ok(processoCmd.aguardandoEntregaDasRazoes(ap) === false,
    '5a: sem peça de razões emitida não há entrega pendente (recurso legado não trava)');

  // Emitida a peça gated, o julgamento fecha.
  const g = pecas.gerar({
    processoTabela: 'apelacoes', processoNumero: 'AP001', tipo: 'razoes_recurso',
    autorId: ADVOGADO, autorPapel: 'Advogado', texto: 'Razões da defesa.',
    destinatarios: [{ papel: 'Desembargador' }],
  });
  ok(g.ok && g.peca.gated, '5b: a peça das razões nasce gated em processo ingame');

  const apGated = db.buscarPorNumero('apelacoes', 'AP001');
  ok(processoCmd.aguardandoEntregaDasRazoes(apGated) === true, '5c: com peça gated pendente, a entrega está pendente');
  const antes = idsDe(processoCmd.botoesApelacao(apGated));
  ok(!antes.some(id => /:manter:|:reformar:|:anular:/.test(id)),
    '5d: Manter/Reformar/Anular NÃO aparecem antes da entrega', antes.join(','));
  ok(antes.some(id => /arquivarmanual/.test(id)),
    '5e: ...mas Arquivar continua (é administrativo, não julga)');

  // Recebimento com o selo correto.
  pecas.abrirEntrega(g.peca.numero, ADVOGADO);
  const token = db.buscarPorNumero('pecas', g.peca.numero).destinatarios[0].token;
  const r = pecas.receber(g.peca.numero, DESEMB, { tokenLido: token });
  ok(r.ok, '5f: o Desembargador recebe as razões pelo selo');

  const apRecebida = db.buscarPorNumero('apelacoes', 'AP001');
  ok(processoCmd.aguardandoEntregaDasRazoes(apRecebida) === false, '5g: entrega deixa de estar pendente');
  const depois = idsDe(processoCmd.botoesApelacao(apRecebida));
  ok(depois.some(id => /:manter:/.test(id)) && depois.some(id => /:reformar:/.test(id)) && depois.some(id => /:anular:/.test(id)),
    '5h: e os três botões de julgamento aparecem', depois.join(','));

  // O efeito grava o destravamento e credita quem recebeu.
  const efeito = emissao.aplicarEfeitoDoRecebimento('razoes_recurso', apRecebida, { numero: g.peca.numero }, DESEMB);
  ok(!!efeito && !!efeito.campos, '5i: o recebimento produz efeito na apelação');
  ok(!!db.buscarPorNumero('apelacoes', 'AP001').razoesRecebidasEm, '5j: com o horário gravado');

  // Quem não é relator recebe explicação, não silêncio.
  const outro = emissao.aplicarEfeitoDoRecebimento('razoes_recurso',
    db.inserir('apelacoes', { numero: 'AP002', desembargadorId: DESEMB, status: 'Aguardando decisão', canalId: 'c2' }),
    { numero: 'AP002-P1' }, ADVOGADO);
  ok(!!outro && !!outro.recusa, '5k: quem não cobre o papel de Desembargador não destrava, e é avisado');

  // TRAVA NO CLIQUE — botão já postado continua clicável; a checagem que vale é a do clique.
  const srcProc = LER('commands', 'processo.js');
  const val = srcProc.slice(srcProc.indexOf('async function validarDecisaoApelacao'), srcProc.indexOf('async function abrirSelecaoResultadoReforma'));
  ok(val.length > 300, '5z: o corpo de validarDecisaoApelacao foi encontrado (scan não vazio)');
  ok(/aguardandoEntregaDasRazoes\(apelacao\)/.test(val),
    '5l: e a decisão reconfere a entrega no clique, não só na hora de desenhar o botão');
}

// ---------------------------------------------------------------------------
console.log('\n6) DEFEITOS DE RENDER do card');
// ---------------------------------------------------------------------------
{
  // <@null> — réu sem conta de Discord.
  ok(processoCmd.refDoReu({ reuId: ADVOGADO }) === `<@${ADVOGADO}>`, '6a: réu com conta vira menção');
  ok(processoCmd.refDoReu({ reuId: null, reuNome: 'João Silva', reuRg: '4455' }) === '**João Silva** (RG 4455)',
    '6b: réu sem conta vira nome + RG — o `<@null>` acabou');
  ok(processoCmd.refDoReu({ reuId: null, reuNome: 'João Silva' }) === '**João Silva**',
    '6c: sem RG, ao menos o nome');
  ok(!/<@null>/.test(processoCmd.refDoReu({})), '6d: e sem dado nenhum ainda assim não imprime <@null>');

  const src = LER('commands', 'processo.js');
  ok(!/\(defende <@\$\{h\.reuId\}>\)/.test(src),
    '6e: o embed não monta mais a menção crua do réu');

  // Pena e regime — por crime, não um blob rotulado errado.
  // Delimita pela PRÓXIMA função, não por um número de caracteres: janela fixa já cortou o trecho
  // no meio neste projeto e produziu falha que não era do código.
  const iEmb = src.indexOf('function embedProcesso(');
  const emb = src.slice(iEmb, iEmb + src.slice(iEmb + 10).search(/\nfunction |\nasync function / ) + 10);
  ok(emb.length > 500, '6z: o corpo de embedProcesso foi encontrado (scan não vazio)');
  ok(/Julgamento por crime/.test(emb), '6f: o card mostra o julgamento crime a crime');
  ok(/sc\.pena \|\| 'não fixada'/.test(emb), '6g: com a pena DE CADA crime, e dizendo quando não foi fixada');
  ok(/} else if \(p\.pena\) \{/.test(emb),
    '6h: sentença antiga (sem pena por crime) continua exibida como antes — nada reescrito no passado');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
