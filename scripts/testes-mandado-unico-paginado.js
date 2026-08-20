/* eslint-disable */
// MANDADO: UM MODELO, UM DOCUMENTO, PAGINADO (20/08/2026). Rode com:
//   node scripts/testes-mandado-unico-paginado.js
//
// DOIS BUGS, pegos em teste pelo operador:
//
// (A) MÚLTIPLOS MODELOS. O select era `multi: true` e o finalizador rodava um laço sobre os tipos
//     marcados, expedindo UM DOCUMENTO POR TIPO — todos com a MESMA fundamentação e o MESMO
//     destinatário. O Juiz clicava uma vez e o canal recebia três mandados idênticos de título
//     trocado. Agora é um modelo só; quem precisa de um mandado abrangente escolhe "Outro" e o
//     NOMEIA ("Mandado de prisão, busca e apreensão") — o nome é rótulo, não uma lista que o bot
//     interpreta.
//
// (B) TIRA COMPRIDA. A renderização usava `gerarDocumentoPNG`, de página ÚNICA: com a fundamentação
//     por trechos (até 12.000 caracteres) o mandado saía como uma folha esticada até caber o texto
//     inteiro. Agora vai pelo `gerarPecaPNG`, o gerador PAGINADO das peças — mesmo `scriptPaginacao`
//     que compara scrollHeight > clientHeight e abre folha nova.
//
// O QUE NÃO PODE QUEBRAR: o mandado de modelo único (o caminho normal) e o mandado nascido de
// MEDIDA/referendo, que reusa `emitirMandadoNoProcesso` por outro caminho. E o Delegado, intocado.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-mandado-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');

// CHROMIUM STUBBADO — pelo mesmo motivo de scripts/testes-juiz-fala-nos-autos.js: cada emissão
// renderiza de verdade, e medido neste ambiente UMA chamada levou 5 minutos de ESPERA (0,18s de
// CPU). O que este arquivo precisa provar não é que o Chromium desenha, é QUAL gerador é chamado e
// com quais argumentos — e que o resultado vira N anexos no canal.
//
// O stub PAGINA por tamanho, imitando o gerador real: é isso que faz a asserção "texto longo gera
// mais de uma folha" significar alguma coisa aqui.
const CAMINHO_PECA_PNG = require.resolve('../services/gerarPecaPNG');
const CAMINHO_DOC_PNG = require.resolve('../services/gerarDocumentoPNG');
const chamadasPaginado = [];
const chamadasPaginaUnica = [];
const realDocPng = require('../services/gerarDocumentoPNG');

require.cache[CAMINHO_PECA_PNG] = {
  id: CAMINHO_PECA_PNG, filename: CAMINHO_PECA_PNG, loaded: true, children: [], paths: [],
  exports: {
    ...require('../services/gerarPecaPNG'),
    gerarPecaPNG: async (dados) => {
      chamadasPaginado.push(dados);
      // ~2.500 caracteres por folha, na mesma ordem de grandeza do gerador real.
      const folhas = Math.max(1, Math.ceil((dados.texto || '').length / 2500));
      return Array.from({ length: folhas }, (_, i) => Buffer.from(`pagina-${i + 1}`));
    },
  },
};
require.cache[CAMINHO_DOC_PNG] = {
  id: CAMINHO_DOC_PNG, filename: CAMINHO_DOC_PNG, loaded: true, children: [], paths: [],
  exports: {
    ...realDocPng,
    // Se alguém voltar a rotear o mandado por aqui, a chamada é REGISTRADA e a asserção 2c reprova.
    gerarDocumentoPNG: async (dados) => { chamadasPaginaUnica.push(dados); return Buffer.from('tira-comprida'); },
    nomeExibicao: async (_guild, id) => `Nome de ${id}`,
  },
};

const rh = require('../utils/rh');
const mandadoCmd = require('../commands/mandado');
const emissao = require('../utils/emissaoPeca');
// Índices, não valores: é o que o customId real carrega (ver utils/tiposMedidaCoercitiva.js).
const { indicesDeValores } = require('../utils/tiposMedidaCoercitiva');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const MANDADO = LER('commands', 'mandado.js');

const JUIZ = '200000000000000001';
const ALVO = '200000000000000002';
rh.contratar(JUIZ, 'Juiz', 'Juiz do caso');

const postados = [];
const canal = {
  id: 'c1', isTextBased: () => true,
  send: async (p) => { postados.push(p); return { id: `m${postados.length}`, attachments: { first: () => null } }; },
  permissionOverwrites: { cache: { some: () => false, values: () => [] }, delete: async () => {}, edit: async () => {} },
  setтатTopic: async () => {}, setTopic: async () => {}, parentId: null,
  setParent: async () => {}, edit: async () => {}, messages: { fetch: async () => null },
};
const guild = {
  id: 'guild1', roles: { everyone: 'role-everyone' },
  members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} } }) },
  channels: { fetch: async () => canal, create: async () => canal },
};

let seq = 0;
function processoPenal() {
  const numero = `08${String(++seq).padStart(2, '0')}PN`;
  db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
    juiz: JUIZ, promotor: null, delegado: null, reus: [ALVO], canalId: 'c1',
    // reuNome/reuRg como a produção cria: sem eles `embedProcesso` monta um field de value vazio
    // e o discord.js recusa o embed inteiro. Não é bug alcançável (a abertura penal exige o nome),
    // mas um cenário de teste que não espelha a criação real testa outra coisa.
    reuNome: 'Réu de Teste', reuRg: '12.345.678-9', crimes: [], motivo: 'Fatos apurados.',
    habilitacoes: [], advogados: [],
    partes: [{ id: 'p1', papel: 'reu', nome: 'Réu de Teste', discordId: ALVO }],
  });
  return db.buscarPorNumero('processos', numero);
}

const respostas = [];
const fakeInteraction = (userId) => ({
  user: { id: userId },
  member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
  guild, channel: canal,
  reply: async (p) => { respostas.push({ tipo: 'reply', ...p }); return p; },
  deferReply: async () => { respostas.push({ tipo: 'defer' }); },
  editReply: async (p) => { respostas.push({ tipo: 'edit', ...p }); return p; },
  showModal: async (m) => { respostas.push({ tipo: 'modal', id: m?.data?.custom_id || 'modal' }); return m; },
  values: [],
  fields: { getTextInputValue: () => '' },
});
const limpar = () => { respostas.length = 0; postados.length = 0; chamadasPaginado.length = 0; chamadasPaginaUnica.length = 0; };

// Emite um mandado pelo caminho REAL do finalizador: semeia o pendente como `emitirMandado` faria,
// põe o texto no rascunho e chama `emitirMandadoComFundamentacao`.
async function emitir({ tipoValue, tipoLivre = null, texto }) {
  const p = processoPenal();
  const i = fakeInteraction(JUIZ);
  // O pendente é gravado por `emitirMandado` (o submit do modal). Aqui se reproduz o mesmo formato:
  // se ele mudar de forma, o finalizador quebra e este teste acusa.
  mandadoCmd.emitirMandadoNoProcesso; // marca a dependência para quem lê
  const pend = require('../commands/mandado');
  // `pendentesDeFundamentacao` é interno; o caminho suportado é passar pelo modal. Como o modal
  // exige interação real, o teste chama o finalizador com o pendente semeado via emitirMandado.
  await pend.emitirMandado({
    ...i,
    fields: { getTextInputValue: (campo) => (campo === 'tipoLivre' ? (tipoLivre || '') : texto) },
  }, `${p.numero}#${indicesDeValores([tipoValue])}#p1`);
  emissao.semearRascunho(JUIZ, 'fundamentacao_mandado', p.numero, texto);
  limpar();
  await pend.emitirMandadoComFundamentacao(i, 'fundamentacao_mandado', p.numero);
  return p;
}

console.log('\n=== Mandado: um modelo, um documento, paginado ===\n');

// ---------------------------------------------------------------------------
console.log('1) BUG A — o select não aceita mais múltiplos modelos');
// ---------------------------------------------------------------------------
{
  ok(MANDADO.length > 5000, '1z: mandado.js foi lido (scan não vazio)');

  const abrir = MANDADO.slice(MANDADO.indexOf('async function abrirSelectTipo'), MANDADO.indexOf('async function processarSelecaoTipo'));
  ok(abrir.length > 200, '1z2: abrirSelectTipo foi localizada', `${abrir.length} chars`);
  // Sem tirar os comentários, a asserção casa com a própria linha que EXPLICA a mudança — erro que
  // já apareceu três vezes neste projeto, e apareceu de novo aqui na primeira rodada.
  const abrirCodigo = abrir.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(abrirCodigo.length > 100, '1z3: o código sem comentários foi extraído', `${abrirCodigo.length} chars`);
  ok(!/multi: true/.test(abrirCodigo), '1a: o select do mandado NÃO é mais múltiplo');
  ok(/selectTipoMedidaCoercitiva\(`painel:select:mandado:tipo:\$\{numero\}`\)/.test(abrir),
    '1b: chamado sem opção de multi — um modelo só');
  ok(/Escolha \*\*um\*\*/.test(abrir), '1c: e o texto diz isso a quem clica');
  ok(/Outro/.test(abrir), '1d: apontando "Outro" como a saída para mandado abrangente');

  // O LAÇO sumiu. É a diferença entre "um clique, um documento" e "um clique, três documentos".
  const fin = MANDADO.slice(MANDADO.indexOf('async function emitirMandadoComFundamentacao'), MANDADO.indexOf('async function emitirMandadoNoProcesso'));
  ok(fin.length > 500, '1z3: o finalizador foi localizado', `${fin.length} chars`);
  const semComentario = fin.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/for \(const tipoValue of/.test(semComentario), '1e: o laço sobre tipos SUMIU do finalizador');
  ok((semComentario.match(/emitirMandadoNoProcesso\(/g) || []).length === 1,
    '1f: e há UMA chamada de emissão, não uma por tipo');
  ok(!/tipoValues/.test(semComentario), '1g: nem sobrou a lista de tipos no estado pendente');

  // O nome no plural também saiu — nome que mente sobre o que a função faz é o começo do problema.
  ok(!/emitirMandadosComFundamentacao/.test(MANDADO), '1h: a função no plural não existe mais');
}

// ---------------------------------------------------------------------------
console.log('\n2) BUG B — a renderização vai pelo gerador PAGINADO');
// ---------------------------------------------------------------------------
{
  const emitirNoProcesso = MANDADO.slice(MANDADO.indexOf('async function emitirMandadoNoProcesso'));
  const fim = emitirNoProcesso.search(/\r?\n\}\r?\n/);
  const corpo = emitirNoProcesso.slice(0, fim < 0 ? emitirNoProcesso.length : fim);
  ok(corpo.length > 800 && corpo.length < 5000, '2z: o corpo foi RECORTADO', `${corpo.length} chars`);

  ok(/gerarPecaPNG\(/.test(corpo), '2a: o documento é renderizado pelo gerador PAGINADO das peças');
  ok(/gated: false/.test(corpo), '2b: sem selo — mandado é exclusão por urgência (SPEC §11.1)');
  const semComentario = corpo.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/gerarDocumentoPNG\(/.test(semComentario), '2c: e NÃO pelo de página única, que fazia a tira comprida');
  ok(/files: folhas/.test(semComentario), '2d: uma folha = um anexo');
}

// ---------------------------------------------------------------------------
console.log('\n3) COMPORTAMENTO — "Outro" nomeado sai como UM documento com o nome dado');
// ---------------------------------------------------------------------------
async function secao3() {
  const NOME = 'Mandado de prisão, busca e apreensão';
  const p = await emitir({ tipoValue: 'outro', tipoLivre: NOME, texto: 'Fundamentação curta.' });

  const mandados = db.todos('mandados', m => m.processoVinculado === p.numero);
  ok(mandados.length === 1, '3a: sai UM mandado, não vários', `${mandados.length} mandado(s)`);
  ok(mandados[0] && mandados[0].tipo === NOME, '3b: com o nome que o Juiz deu', mandados[0] && mandados[0].tipo);
  // A RESPOSTA AO JUIZ confirma UM mandado, pelo número. Esta asserção existe porque a contagem no
  // banco sozinha NÃO pegou a mutação "emitir duas vezes": a segunda emissão lança, o catch a
  // engole e o banco fica com um só — mas o Juiz recebe "❌ não pôde ser emitido" em vez da
  // confirmação. Um teste que só olha o banco daria verde para um fluxo visivelmente quebrado.
  const confirmacao = respostas.filter(r => r.tipo === 'edit').pop();
  ok(!!confirmacao, '3a2: o Juiz recebe resposta');
  ok(!!confirmacao && /Mandado \*\*/.test(confirmacao.content || ''),
    '3a3: e ela CONFIRMA a emissão, com o número', confirmacao && (confirmacao.content || '').slice(0, 70));
  ok(!!confirmacao && !/❌/.test(confirmacao.content || ''),
    '3a4: sem erro — uma emissão, um desfecho limpo');

  const comAnexo = postados.filter(m => m.files && m.files.length);
  ok(comAnexo.length === 1, '3c: e UMA mensagem com documento no canal', `${comAnexo.length} mensagem(ns)`);
  ok(chamadasPaginado.length === 1, '3d: uma renderização só', `${chamadasPaginado.length}`);
  ok(chamadasPaginaUnica.length === 0, '3e: e nenhuma pelo gerador de página única');
  ok(chamadasPaginado[0] && chamadasPaginado[0].titulo === `MANDADO DE ${NOME.toUpperCase()}`,
    '3f: o título do documento é o nome dado', chamadasPaginado[0] && chamadasPaginado[0].titulo);
  ok(chamadasPaginado[0] && chamadasPaginado[0].gated === false, '3g: renderizado sem selo');

  // Modelo da LISTA continua funcionando — era o caminho que não podia quebrar.
  limpar();
  const p2 = await emitir({ tipoValue: 'prisao_preventiva', texto: 'Fundamentação da preventiva.' });
  const m2 = db.todos('mandados', m => m.processoVinculado === p2.numero);
  ok(m2.length === 1, '3h: modelo da lista também sai UM só', `${m2.length}`);
  ok(m2[0] && /preventiva/i.test(m2[0].tipo), '3i: com o rótulo do catálogo', m2[0] && m2[0].tipo);
}

// ---------------------------------------------------------------------------
console.log('\n4) TEXTO LONGO — pagina, não estica');
// ---------------------------------------------------------------------------
async function secao4() {
  limpar();
  // ~9.000 caracteres: no stub dá 4 folhas; no gerador real passa de uma página com folga.
  const longo = 'Considerando os elementos de convicção coligidos nos autos, DEFIRO a medida. '.repeat(120);
  const p = await emitir({ tipoValue: 'busca_apreensao', texto: longo });

  ok(chamadasPaginado.length === 1, '4a: uma renderização', `${chamadasPaginado.length}`);
  const comAnexo = postados.filter(m => m.files && m.files.length);
  ok(comAnexo.length === 1, '4b: postado numa mensagem só');
  const folhas = comAnexo[0] ? comAnexo[0].files.length : 0;
  ok(folhas > 1, '4c: e o texto longo gerou MAIS DE UMA folha — não uma tira comprida', `${folhas} folha(s)`);
  ok(comAnexo[0] && /-fl1\.png$/.test(comAnexo[0].files[0].name),
    '4d: com o sufixo de folha no nome', comAnexo[0] && comAnexo[0].files[0].name);
  ok(comAnexo[0] && comAnexo[0].files.every(f => /^Mandado-/.test(f.name)),
    '4e: todas identificadas como o mesmo mandado');

  // Mandado curto continua em UMA folha, sem sufixo — senão o nome mentiria sobre a paginação.
  limpar();
  await emitir({ tipoValue: 'conducao_coercitiva', texto: 'Compareça em juízo.' });
  const curto = postados.filter(m => m.files && m.files.length)[0];
  ok(curto && curto.files.length === 1, '4f: documento curto sai em UMA folha', curto && `${curto.files.length}`);
  ok(curto && !/-fl/.test(curto.files[0].name), '4g: e sem sufixo de folha no nome', curto && curto.files[0].name);

  ok(db.todos('mandados', () => true).length === 4,
    '4z: os 4 mandados do teste foram emitidos (o cenário não passou vazio)');
}

// ---------------------------------------------------------------------------
console.log('\n5) NÃO QUEBRAR — o mandado da MEDIDA usa o mesmo ponto, e o Delegado não foi tocado');
// ---------------------------------------------------------------------------
{
  const MEDIDA = LER('commands', 'medida.js');
  ok(MEDIDA.length > 5000, '5z: medida.js foi lido (scan não vazio)');
  ok(/emitirMandadoNoProcesso/.test(MEDIDA),
    '5a: a medida continua emitindo pelo MESMO ponto quando há processo vinculado');

  // O REFERENDO tem caminho PRÓPRIO de renderização (o Juiz defere a medida e o mandado sai no
  // canal dela). Ele tinha o MESMO bug de página única — e é o mandado mais LONGO do bot, porque
  // junta a fundamentação do MP com a do Juízo. Corrigido junto, senão seria meio conserto.
  const ref = MEDIDA.slice(MEDIDA.indexOf('const paginasMandado = await'), MEDIDA.indexOf('const paginasMandado = await') + 1400);
  ok(ref.length > 400, '5z2: o bloco de renderização do referendo foi localizado', `${ref.length} chars`);
  ok(/gerarPecaPNG\(/.test(ref), '5a2: o referendo também renderiza pelo gerador PAGINADO');
  ok(/gated: false/.test(ref), '5a3: sem selo, pela mesma exclusão de urgência');
  const medSemComentario = MEDIDA.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/gerarDocumentoPNG\(\{[\s\S]{0,200}mandado_generico/.test(medSemComentario),
    '5a4: e não sobrou renderização de mandado em página única');
  ok(/name: `Mandado-\$\{numeroMandado\}\$\{fl\}\.png`/.test(medSemComentario),
    '5a5: com uma folha por anexo, como no mandado direto');

  ok(/gateBloqueia: \(interaction, medida\) => interaction\.user\.id !== medida\.delegado/.test(MEDIDA),
    '5b: o gate do Delegado na reconsideração segue intacto');
  ok(/Só o Delegado que solicitou esta medida pode anexar os indícios/.test(MEDIDA),
    '5c: e a juntada de indícios dele também');
  ok(/async function solicitarMedida\(/.test(MEDIDA), '5d: o ticket clássico do Delegado segue de pé');

  // O resto do mandado não foi tocado: entrega privada e cumprimento vêm depois, por decisão do
  // operador. Se sumirem daqui, foi acidente.
  ok(/botaoCumprir\(/.test(MANDADO), '5e: o botão Cumprir continua no card do mandado');
  ok(/medida:cumprir:\$\{numero\}/.test(MANDADO), '5f: com o customId de sempre');
}

(async () => {
  await secao3();
  await secao4();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
