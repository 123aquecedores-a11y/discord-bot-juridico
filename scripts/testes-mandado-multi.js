/* eslint-disable */
// MANDADO: VÁRIOS POR PROCESSO, MULTI-SELEÇÃO E "OUTRO" NOMEADO (19/08/2026). Rode com:
//   node scripts/testes-mandado-multi.js
//
// TRÊS MUDANÇAS, e a mais perigosa é a do meio:
//
//   A1 — emitir vários mandados no mesmo processo, sem exigir o anterior cumprido.
//   A3 — o Juiz marca VÁRIOS tipos de uma vez e sai um mandado para cada.
//   A4 — "Outro" abre campo para o Juiz nomear o mandado, em vez de sair "Mandado Outro".
//
// A3 CHEGOU A EXISTIR PELA METADE: o select virou múltiplo antes de o handler saber ler mais de um
// valor — o Juiz marcaria três tipos e sairia um mandado. Foi revertido antes de qualquer commit.
// Metade deste arquivo existe para que esse estado não volte: não basta o select aceitar vários,
// o caminho inteiro precisa levar todos até a emissão.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-mandado-multi-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const tipos = require('../utils/tiposMedidaCoercitiva');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

console.log('\n=== Mandado: multi-tipo, vários por processo, "Outro" nomeado ===\n');

// ---------------------------------------------------------------------------
console.log('1) O SELECT aceita vários tipos');
// ---------------------------------------------------------------------------
{
  const linha = tipos.selectTipoMedidaCoercitiva('x', { multi: true }).toJSON().components[0];
  ok(linha.min_values === 1, '1a: exige pelo menos um tipo');
  ok(linha.max_values === tipos.TIPOS_MEDIDA_COERCITIVA.length,
    '1b: e permite marcar todos', `max=${linha.max_values}`);

  // O modo simples continua existindo — a medida direta do MP ainda escolhe um tipo só.
  const simples = tipos.selectTipoMedidaCoercitiva('y').toJSON().components[0];
  ok(!simples.max_values || simples.max_values === 1, '1c: o modo de tipo único não foi quebrado');
}

// ---------------------------------------------------------------------------
console.log('\n2) OS ÍNDICES sobrevivem à viagem pelo customId');
// ---------------------------------------------------------------------------
{
  // O teto do customId do Discord é 100 caracteres. Três valores por extenso já passam de 55, e
  // somados ao número do processo estourariam — o Discord para de entregar o clique SEM erro
  // visível, que é o pior modo de falhar.
  const escolhidos = ['busca_apreensao', 'prisao_preventiva', 'conducao_coercitiva'];
  const idx = tipos.indicesDeValores(escolhidos);
  ok(JSON.stringify(tipos.valoresDeIndices(idx)) === JSON.stringify(escolhidos),
    '2a: ida e volta preserva os tipos e a ordem', idx);
  ok(idx.length < 12, '2b: e o resultado é curto o bastante para caber no customId', `"${idx}"`);

  const chave = `0001PN#${idx}#p2`;
  ok(`painel:modal:mandado:emitir:${chave}`.length <= 100,
    '2c: o customId completo cabe no limite de 100 do Discord', `${`painel:modal:mandado:emitir:${chave}`.length}`);

  ok(tipos.valoresDeIndices('').length === 0, '2d: entrada vazia devolve lista vazia, sem quebrar');
  ok(tipos.valoresDeIndices('99,abc').length === 0, '2e: índice inválido é descartado, não vira undefined');
}

// ---------------------------------------------------------------------------
console.log('\n3) O CAMINHO INTEIRO leva UM tipo até a emissão');
// ---------------------------------------------------------------------------
// ESTE BLOCO FOI INVERTIDO EM 20/08/2026, por decisão do operador.
//
// Ele nasceu para impedir "marca 3 e sai 1": o select era múltiplo e um bug fazia só o primeiro
// tipo virar mandado. A correção da época foi emitir UM MANDADO POR TIPO — e é isso que o operador
// pegou em teste: o Juiz clicava uma vez e o canal recebia três mandados com a MESMA fundamentação
// e o MESMO destinatário, o mesmo documento repetido de título trocado.
//
// A múltipla seleção foi REMOVIDA. Quem precisa de um mandado abrangente escolhe "Outro" e o
// NOMEIA ("Mandado de prisão, busca e apreensão") — o nome é rótulo do documento, não uma lista
// que o bot interpreta. As asserções abaixo agora guardam o oposto do que guardavam: uma seleção,
// um documento.
//
// A maquinaria de índices no customId (seção 2) CONTINUA: ela existe por causa do teto de 100
// caracteres, e vale para um índice tanto quanto valia para três.
{
  const src = LER('commands', 'mandado.js');
  ok(src.length > 1000, '3z: o arquivo foi lido (scan não vazio)');
  const codigo = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(codigo.length > 1000, '3z2: e o código sem comentários foi extraído (a asserção não casa com a explicação)');

  ok(/selectTipoMedidaCoercitiva\(`painel:select:mandado:tipo:\$\{numero\}`\)/.test(codigo),
    '3a: o select do mandado NÃO é múltiplo');
  ok(!/multi: true/.test(codigo), '3a2: e não sobrou nenhuma opção de multi no fluxo do mandado');

  const corpo = codigo.slice(codigo.indexOf('async function emitirMandado(interaction, chave)'), codigo.indexOf('async function emitirMandadoNoProcesso'));
  ok(corpo.length > 500, '3y: o corpo de emitirMandado foi encontrado (scan não vazio)');
  ok(/const tipoValue = valoresDeIndices\(indices\)\[0\]/.test(corpo), '3e: a emissão lê UM tipo');
  ok(!/for \(const tipoValue of/.test(corpo), '3f: sem laço — um clique, um documento');
  ok(!/emitidos\.push|falhas\.push/.test(corpo), '3g: sem acumulador de vários mandados');
  ok(/catch \(err\)/.test(corpo) || /catch \(err\)/.test(codigo.slice(codigo.indexOf('async function emitirMandadoComFundamentacao'))),
    '3h: e a falha da emissão é tratada, não engolida');
  ok(/O mandado não pôde ser emitido/.test(codigo),
    '3i: se não sair, o Juiz é avisado em vez de receber silêncio');
}

// ---------------------------------------------------------------------------
console.log('\n4) "OUTRO" ganha nome, em qualquer posição da seleção');
// ---------------------------------------------------------------------------
{
  // O campo tem que nascer quando "outro" está ENTRE os marcados, não só quando é o único —
  // marcar "Busca + Outro" e não poder nomear o segundo seria o mesmo defeito de antes.
  const comOutro = tipos.modalTipoDestinatario({
    customId: 'a', titulo: 't', tipoValue: ['busca_apreensao', 'outro'],
    destinatarioRef: 'p1', campoTeor: 'teor', labelTeor: 'x',
  }).toJSON();
  const ids = comOutro.components.flatMap(l => l.components.map(c => c.custom_id));
  ok(ids.includes('tipoLivre'), '4a: "Outro" junto com outro tipo abre o campo de nome', ids.join(','));

  const semOutro = tipos.modalTipoDestinatario({
    customId: 'a', titulo: 't', tipoValue: ['busca_apreensao'],
    destinatarioRef: 'p1', campoTeor: 'teor', labelTeor: 'x',
  }).toJSON();
  ok(!semOutro.components.flatMap(l => l.components.map(c => c.custom_id)).includes('tipoLivre'),
    '4b: sem "Outro", o campo não aparece');

  // Compatibilidade: a medida direta do MP ainda passa uma string, não um array.
  const stringSolta = tipos.modalTipoDestinatario({
    customId: 'a', titulo: 't', tipoValue: 'outro',
    destinatarioRef: 'p1', campoTeor: 'j', labelTeor: 'x',
  }).toJSON();
  ok(stringSolta.components.flatMap(l => l.components.map(c => c.custom_id)).includes('tipoLivre'),
    '4c: quem passa uma string (medida direta) continua funcionando');

  ok(tipos.rotuloTipo('outro', 'Interdição de estabelecimento') === 'Interdição de estabelecimento',
    '4d: o nome escrito pelo Juiz é o que vai para o documento');
  ok(tipos.rotuloTipo('outro', '') === 'Outro', '4e: sem nome, o rótulo antigo segue como último recurso');
  ok(tipos.rotuloTipo('busca_apreensao') === 'Busca e Apreensão', '4f: os tipos da lista não mudaram');

  // A outra lista — a do painel "Solicitar medida cautelar" — tinha "Outra" sem campo nenhum.
  const painel = LER('commands', 'painel.js');
  ok(/setCustomId\('tipo_livre'\)/.test(painel), '4g: o modal de solicitar medida também nomeia a "Outra"');
  ok(/const tipo = tipoLivre \|\| tipoBase;/.test(painel),
    '4h: e o nome escrito substitui o literal "Outra" no registro');
}

// ---------------------------------------------------------------------------
console.log('\n5) VÁRIOS MANDADOS por processo, sem exigir o anterior cumprido');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'mandado.js');
  ok(!/const duplicado = db\.todos\('mandados'/.test(src),
    '5a: a trava de duplicidade saiu');
  ok(!/mensagemJaFeito\(\s*`O Mandado/.test(src),
    '5b: e a recusa que ela produzia também');

  // Prova comportamental: dois mandados abertos, mesmo processo, mesmo tipo, mesmo alvo.
  db.inserir('mandados', { numero: 'MO001', processoVinculado: '0001PN', tipo: 'Busca e Apreensão', alvo: 'Fulano', status: 'Emitido', emitidoPor: 'j1' });
  db.inserir('mandados', { numero: 'MO002', processoVinculado: '0001PN', tipo: 'Busca e Apreensão', alvo: 'Fulano', status: 'Emitido', emitidoPor: 'j1' });
  const doProcesso = db.todos('mandados', m => m.processoVinculado === '0001PN');
  ok(doProcesso.length === 2, '5c: dois mandados iguais coexistem em aberto no mesmo processo');
  ok(doProcesso.every(m => m.status === 'Emitido'), '5d: e nenhum precisou estar cumprido');

  // O mandado saiu da lista de atos com guarda de colisão, e a razão está escrita lá.
  const guarda = LER('scripts', 'testes-guarda-colisao.js');
  ok(/MANDADO SAIU DESTA LISTA/.test(guarda), '5e: a remoção está justificada no teste de colisão');
  ok(!/'commands\/mandado\.js', 'emitirMandado'/.test(guarda),
    '5f: e ele não é mais exigido lá');
}

// ---------------------------------------------------------------------------
console.log('\n6) CUMPRIR não pede mais PDF');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'medida.js');
  const i = src.indexOf('async cumprirMandado');
  ok(i > 0, '6z: cumprirMandado foi localizado (scan não vazio)');
  const corpo = src.slice(i, src.indexOf('\n  },', i));

  ok(!/coletarAnexoPdf/.test(corpo), '6a: não coleta mais PDF de auto de cumprimento');
  ok(!/gerarAnaliseEmbed/.test(corpo), '6b: e sem PDF não há análise de IA para rodar');
  ok(/status: 'Cumprido', cumpridoPor: interaction\.user\.id, cumpridoEm:/.test(corpo),
    '6c: marca cumprido, por quem e quando');
  ok(/publicarAto\(interaction\.guild, 'mandadoCumprido'/.test(corpo),
    '6d: e o Diário continua publicando no cumprimento — o alvo já foi alcançado');
  ok(/cumprido em diligência/.test(corpo),
    '6e: o andamento diz que a diligência foi em cena, sem prometer anexo que não existe');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
