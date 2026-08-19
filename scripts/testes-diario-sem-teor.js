/* eslint-disable */
// O DIÁRIO PUBLICA RESULTADO, NUNCA TEOR (19/08/2026). Rode com:
//   node scripts/testes-diario-sem-teor.js
//
// O VAZAMENTO: a decisão de porte de arma foi publicada no Diário com o PNG INTEIRO da sentença
// anexado, para @everyone. O acórdão do Desembargador, idem. Fundamentação e dispositivo ficaram
// públicos no instante da decisão — e a entrega em cena com selo virou enfeite, porque ninguém
// precisa procurar o juiz se o documento já está no Diário.
//
// A REGRA, e a distinção que ela NÃO pode perder: publicar o RESULTADO continua certo e continua
// acontecendo (é para isso que o Diário existe). O que sai é o TEOR. Um teste que apagasse a
// publicação junto com o anexo teria "passado" e quebrado o Diário — por isso cada bloco aqui
// confere as duas coisas ao mesmo tempo.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-diario-teor-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const diario = require('../utils/diarioOficial');
const diarioAtos = require('../utils/diarioAtos');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

// Guild de mentira que CAPTURA o que seria enviado ao canal do Diário.
const enviados = [];
function fakeGuild() {
  const canal = {
    isTextBased: () => true,
    permissionOverwrites: { edit: async () => {} },
    send: async (payload) => { enviados.push(payload); return { id: `msg${enviados.length}` }; },
  };
  return {
    id: 'guild1',
    members: { me: { id: 'bot1' } },
    client: { user: { id: 'bot1' } },
    channels: { fetch: async () => canal },
  };
}
diario.setCanalId('canal-diario');

const PNG = { attachment: Buffer.from('teor-do-documento'), name: 'Sentenca-0012PA.png' };

console.log('\n=== Diário Oficial: resultado sim, teor não ===\n');

// ---------------------------------------------------------------------------
console.log('1) COMPORTAMENTAL — o anexo não chega ao canal, o card chega');
// ---------------------------------------------------------------------------
async function secao1() {
  // Os tipos que carregam decisão judicial. Cada um destes já vazou ou poderia vazar.
  const DECISOES = ['sentenca', 'acordao', 'peticao_administrativa', 'desarquivamento',
    'arquivamento_inquerito', 'indeferimento_inicial', 'mandado_cumprido'];

  for (const tipo of DECISOES) {
    enviados.length = 0;
    const msg = await diario.publicarNoDiario(fakeGuild(), tipo, {
      numero: '0012PA', resultado: 'Deferido', magistrado: 'Juiz Fulano', relator: 'Des. Fulano',
      parte: 'Cliente', tipoProcesso: 'Penal', files: [PNG],
    });
    ok(!!msg, `1a-${tipo}: a publicação ACONTECE (o resultado continua indo ao Diário)`);
    const payload = enviados[0] || {};
    ok(!payload.files, `1b-${tipo}: e vai SEM anexo — o teor não sai daqui`);
    ok(Array.isArray(payload.embeds) && payload.embeds.length === 1,
      `1c-${tipo}: o card do resultado continua lá`);
  }

  // O @everyone continua: é publicação oficial, e o problema nunca foi o alcance — foi o anexo.
  enviados.length = 0;
  await diario.publicarNoDiario(fakeGuild(), 'sentenca', { numero: '1', resultado: 'Condenado', files: [PNG] });
  ok(enviados[0].content === '@everyone', '1d: o alcance público do Diário não mudou');

  // Os dois tipos liberados NÃO são decisão: comunicado é nota da Staff (o anexo é o conteúdo) e
  // edital é chamamento público, de inteiro teor público por natureza.
  enviados.length = 0;
  await diario.publicarNoDiario(fakeGuild(), 'comunicado', { titulo: 'Aviso', corpo: 'texto', files: [PNG] });
  ok(!!enviados[0].files, '1e: `comunicado` PODE anexar (é nota da Staff, não decisão)');
  enviados.length = 0;
  await diario.publicarNoDiario(fakeGuild(), 'edital_aberto', { numero: 'E1', files: [PNG] });
  ok(!!enviados[0].files, '1f: `edital_aberto` PODE anexar (chamamento público)');

  // FAIL-CLOSED: tipo que ninguém declarou não anexa. É o que fecha a CLASSE do bug, não só ele.
  enviados.length = 0;
  await diario.publicarNoDiario(fakeGuild(), 'tipo_que_alguem_criar_amanha', { numero: 'X', files: [PNG] });
  ok(!enviados[0].files, '1g: tipo NOVO nasce sem poder anexar — allowlist, não lista negra');
}

// ---------------------------------------------------------------------------
console.log('\n2) A ENGINE DE ATOS não tem mais por onde passar anexo');
// ---------------------------------------------------------------------------
async function secao2() {
  const src = LER('utils', 'diarioAtos.js');
  ok(src.length > 500, '2z: o arquivo foi lido (scan não vazio)');
  ok(!/opts\.files/.test(src), '2a: publicarAto não aceita mais anexo do chamador');
  ok(!/def\.files/.test(src), '2b: nem a natureza pode buscar um por conta própria');
  ok(!/\{ files \}/.test(src), '2c: e nada é repassado ao publicarNoDiario');

  // E funciona de ponta a ponta: o ato publica, sem anexo.
  db.inserir('peticoes', {
    numero: '0012PA', tipo: 'PorteArma', status: 'Deferido', requerenteId: 'a1', juiz: 'j1',
    nomeCliente: 'Cliente RP', rgCliente: '123', validadeAte: new Date(Date.now() + 864e5).toISOString(),
    motivo: 'Fundamentação secreta que não pode vazar.',
  });
  enviados.length = 0;
  const pub = await diarioAtos.publicarAto(fakeGuild(), 'peticaoAdministrativa', db.buscarPorNumero('peticoes', '0012PA'));
  ok(pub === true, '2d: o ato administrativo É publicado no Diário (o resultado segue público)');
  ok(enviados.length === 1 && !enviados[0].files, '2e: e sem nenhum anexo');

  // A fundamentação não pode vazar nem por dentro do card.
  const textoDoCard = JSON.stringify(enviados[0].embeds || []);
  ok(!/Fundamentação secreta/.test(textoDoCard), '2f: o card não carrega a fundamentação no corpo');
  ok(/0012PA/.test(textoDoCard), '2g: mas carrega o protocolo — é resumo de resultado, não teor');
}

// ---------------------------------------------------------------------------
console.log('\n3) AS ORIGENS — nenhum chamador ainda monta o anexo');
// ---------------------------------------------------------------------------
{
  // A trava no ponto de saída é a rede de segurança. Deixar o chamador montando o PNG "porque a
  // rede pega" mantém o código dizendo uma coisa e fazendo outra — e a próxima refatoração da rede
  // reabre o vazamento inteiro.
  const alvos = {
    'commands/processo.js': LER('commands', 'processo.js'),
    'commands/peticao.js': LER('commands', 'peticao.js'),
    'utils/supervisao.js': LER('utils', 'supervisao.js'),
  };
  ok(Object.values(alvos).every(s => s.length > 500), '3z: os arquivos foram lidos (scan não vazio)');

  // Assinatura do vazamento: um `files:` com PNG de decisão dentro de uma chamada ao Diário.
  const VAZAMENTO = /(publicarNoDiario|publicarAto)\([^;]*files:\s*png/i;
  for (const [nome, src] of Object.entries(alvos)) {
    ok(!VAZAMENTO.test(src), `3a-${nome}: não passa PNG de decisão para o Diário`);
  }

  // E as publicações CONTINUAM existindo — remover o vazamento não podia matar o Diário.
  const proc = alvos['commands/processo.js'];
  ok(/publicarNoDiario\(interaction\.guild, 'acordao'/.test(proc), '3b: o acórdão continua sendo publicado');
  ok(/publicarNoDiario\(interaction\.guild, 'sentenca'/.test(proc), '3c: a sentença continua sendo publicada');
  ok(/publicarAto\(guild, 'peticaoAdministrativa', peticao\)/.test(alvos['commands/peticao.js']),
    '3d: a decisão administrativa continua sendo publicada — agora só o card');
  ok(/publicarAto\(guild, 'desarquivamento'/.test(alvos['utils/supervisao.js']),
    '3e: o desarquivamento continua sendo publicado');
}

(async () => {
  await secao1();
  await secao2();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
