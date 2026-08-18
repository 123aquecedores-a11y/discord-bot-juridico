/* eslint-disable */
// BLOCO B — a intimação entra no módulo gated. Rode com:
//   node scripts/testes-intimacao-gated.js
//
// CONTEXTO: `intimacao_juiz` era o QUINTO caso de código órfão do projeto — estava no catálogo,
// `ativo: true`, com teste passando, e NADA no bot o acionava. O tipo mirava `Advogado`, e o
// seletor de destinatário do juiz listava só `partes[]` (réu, autor, testemunhas, terceiros): o
// único destinatário que o mecanismo sabia tratar era justamente o único que a UI não oferecia.
//
// Por isso o teste mais importante daqui não é "a função gera peça" — é CAMINHO DE ENTRADA:
// partindo do clique real do juiz, chega-se ao módulo gated? Suíte verde nunca respondeu isso, e é
// o que deixou cinco órfãos passarem.
//
// Regras exercitadas (decisões de 18/08/2026):
//   advogado habilitado → gated | autor com conta → gated | réu → exceção §11.1, sem gate
//   testemunha/terceiro/pessoa fora → caminho de sempre, sem selo
//   TRAVA ANTI-CONTORNO: quem é parte/advogado cai no gated mesmo escolhido como "pessoa fora"

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-intimacao-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const pecas = require('../utils/pecas');
const processoCmd = require('../commands/processo');
const partesProcesso = require('../utils/partesProcesso');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// Snowflakes de verdade (17-20 digitos): classificarIdLivre so reconhece Discord ID nesse formato,
// entao ID falso curto faria a trava anti-contorno passar por engano no teste.
const JUIZ = '100000000000000001', ADV = '100000000000000002', AUTOR = '100000000000000003', REU = '100000000000000004', TESTEMUNHA = '100000000000000005';

let seq = 0;
function novoProcesso(modo = 'ingame') {
  const numero = `030${++seq}CV`;
  return db.inserir('processos', {
    numero, tipo: 'Civil', status: 'Instrução', modoEntrega: modo,
    juiz: JUIZ, autor: ADV, autorDiscordId: AUTOR, advogados: [ADV],
    habilitacoes: [{ id: 1, advogadoId: ADV, reuId: REU, status: 'Aprovado' }],
    partes: [
      { id: 'p1', papel: 'autor', nome: 'Autor da Silva', discordId: AUTOR },
      { id: 'p2', papel: 'reu', nome: 'Réu de Souza', discordId: REU, rg: 'RG-REU-1' },
      { id: 'p3', papel: 'testemunha_acusacao', nome: 'Testemunha X', discordId: TESTEMUNHA },
    ],
    canalId: 'canal1',
  });
}

function fakeInteraction(userId, { values = [], campos = {} } = {}) {
  const rec = { replies: [], modais: [], sends: [] };
  return {
    rec,
    user: { id: userId },
    values,
    member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } },
    guild: { id: 'guild1', channels: { fetch: async () => ({ send: async (o) => { rec.sends.push(o); return { id: 'm1' }; } }) } },
    fields: { getTextInputValue: (k) => campos[k] },
    reply: async (o) => { rec.replies.push(o); },
    showModal: async (m) => { rec.modais.push(m); },
  };
}
const textoDe = (o) => (typeof o === 'string' ? o : (o && o.content) || '');

(async () => {
console.log('\n=== Bloco B: intimação gated ===\n');

console.log('1) A REGRA (pecas.classificarDestinatarioIntimacao) — pura, sem Discord');
{
  const p = novoProcesso();
  const c = (opts) => pecas.classificarDestinatarioIntimacao(p, opts);

  ok(c({ discordId: ADV }).via === 'gated', '1a: advogado habilitado → gated');
  ok(c({ discordId: ADV }).habilitacaoId === 1, '1b: ...resolvido pela habilitação específica, não por advogados[]');
  ok(c({ parteId: 'p1' }).via === 'gated' && c({ parteId: 'p1' }).papel === 'Autor', '1c: autor com conta → gated');
  ok(c({ parteId: 'p2' }).via === 'reu', '1d: réu → exceção da SPEC §11.1, sem gate');
  ok(c({ parteId: 'p3' }).via === 'aberto', '1e: testemunha → caminho de sempre, sem selo');
  ok(c({ discordId: 'id_desconhecido' }).via === 'aberto', '1f: pessoa sem papel → caminho de sempre');

  console.log('   TRAVA ANTI-CONTORNO — a porta de entrada não muda a classificação:');
  ok(c({ discordId: ADV, parteId: 'p3' }).via === 'gated',
    '1g: advogado escolhido como se fosse terceiro → AINDA gated (o atalho não existe)');
  ok(c({ discordId: REU }).via === 'reu', '1h: réu digitado como "pessoa fora" → cai na exceção do réu, não vira terceiro');
  ok(c({ discordId: AUTOR }).via === 'gated', '1i: autor digitado como "pessoa fora" → AINDA gated');
}

console.log('\n2) O AUTOR é resolvível como ocupante (sem isso ele nunca receberia)');
{
  const p = novoProcesso();
  ok(pecas.ocupaDestinatario('processos', p, { papel: 'Autor' }, AUTOR) === true,
    '2a: quem ocupa o papel Autor é reconhecido — TABELAS_TICKET só tem Juiz/Promotor/Delegado');
  ok(pecas.ocupaDestinatario('processos', p, { papel: 'Autor' }, REU) === false, '2b: o réu não ocupa o papel de autor');
  ok(pecas.ocupaDestinatario('processos', p, { papel: 'Advogado', habilitacaoId: 1 }, ADV) === true, '2c: advogado segue resolvido pela habilitação');
}

console.log('\n3) CAMINHO DE ENTRADA — o clique do juiz chega no módulo gated');
// Este é o teste que faltava nos cinco órfãos. Não é "a função funciona", é "alguém chega nela".
{
  const p = novoProcesso();

  // 3.1 — o seletor precisa OFERECER o advogado. Antes de hoje ele não aparecia em lugar nenhum.
  const row = partesProcesso.selectDestinatario('x', p, { incluirAdvogados: true });
  const opcoes = row.components[0].options.map(o => o.data ? o.data.value : o.value);
  ok(opcoes.includes('hab:1'), '3a: o seletor do juiz oferece o advogado habilitado (antes: impossível escolher)');
  ok(opcoes.includes('p2') && opcoes.includes('fora'), '3b: ...sem perder réu e "pessoa fora"');
  const semAdv = partesProcesso.selectDestinatario('x', p).components[0].options.map(o => o.data ? o.data.value : o.value);
  ok(!semAdv.some(v => String(v).startsWith('hab:')), '3c: mandado/medida NÃO ganham advogado no seletor (mudança isolada na intimação)');

  // 3.2 — escolher o advogado leva ao modal do módulo gated, não ao caminho antigo.
  const i = fakeInteraction(JUIZ, { values: ['hab:1'] });
  await processoCmd.processarSelecaoDestinatarioIntimacao(i, p.numero);
  ok(i.rec.modais.length === 1, '3d: escolher o advogado abre o MODAL do módulo gated (caminho de produção existe)');
  ok(!i.rec.replies.some(r => /teor da intima/i.test(textoDe(r))), '3e: ...e NÃO cai no fluxo antigo de teor');

  // 3.3 — réu e testemunha seguem no caminho antigo.
  const iReu = fakeInteraction(JUIZ, { values: ['p2'] });
  await processoCmd.processarSelecaoDestinatarioIntimacao(iReu, p.numero);
  ok(iReu.rec.modais.length === 0 && /teor da intima/i.test(textoDe(iReu.rec.replies[0])),
    '3f: réu segue no caminho de sempre (exceção §11.1 preservada)');

  const iTest = fakeInteraction(JUIZ, { values: ['p3'] });
  await processoCmd.processarSelecaoDestinatarioIntimacao(iTest, p.numero);
  ok(/teor da intima/i.test(textoDe(iTest.rec.replies[0])), '3g: testemunha segue no caminho de sempre');

  // 3.4 — autor vai para o gated.
  const iAutor = fakeInteraction(JUIZ, { values: ['p1'] });
  await processoCmd.processarSelecaoDestinatarioIntimacao(iAutor, p.numero);
  ok(iAutor.rec.modais.length === 1, '3h: autor abre o módulo gated');
}

console.log('\n4) TRAVA ANTI-CONTORNO no caminho "pessoa fora do processo"');
{
  const p = novoProcesso();
  const antes = (db.buscarPorNumero('processos', p.numero).partes || []).length;

  // Juiz digita o ID do advogado habilitado na tela de "pessoa fora".
  const i = fakeInteraction(JUIZ, { campos: { nomeCompleto: 'Fulano', idTexto: ADV } });
  await processoCmd.confirmarDestinatarioForaIntimacao(i, p.numero);
  ok(i.rec.modais.length === 1, '4a: advogado digitado como "pessoa fora" é forçado ao gated');

  const depois = (db.buscarPorNumero('processos', p.numero).partes || []).length;
  ok(depois === antes, '4b: ...e NÃO sujou os autos criando um "terceiro" que na verdade é parte');

  // Réu digitado ali é recusado com explicação, não vira terceiro.
  const iReu = fakeInteraction(JUIZ, { campos: { nomeCompleto: 'Réu', idTexto: REU } });
  await processoCmd.confirmarDestinatarioForaIntimacao(iReu, p.numero);
  ok(/r[ée]u/i.test(textoDe(iReu.rec.replies[0])) && /cumprida/i.test(textoDe(iReu.rec.replies[0])),
    '4c: réu digitado ali é recusado e apontado para o fluxo próprio');

  // Pessoa realmente de fora continua funcionando.
  const iFora = fakeInteraction(JUIZ, { campos: { nomeCompleto: 'Zé Ninguém', idTexto: '999888' } });
  await processoCmd.confirmarDestinatarioForaIntimacao(iFora, p.numero);
  ok(/teor da intima/i.test(textoDe(iFora.rec.replies[0])), '4d: pessoa genuinamente de fora segue no caminho de sempre');

  // BURACO ACHADO ESCREVENDO ESTE TESTE: classificarIdLivre só reconhece Discord ID com 17-20
  // dígitos. Digitando o RG de uma parte, `discordId` saía null e a trava não disparava — o RG era
  // um contorno silencioso da trava anti-contorno. Por isso o classificador passou a casar por RG.
  const p2 = novoProcesso();
  const iRg = fakeInteraction(JUIZ, { campos: { nomeCompleto: 'Réu por RG', idTexto: 'RG-REU-1' } });
  await processoCmd.confirmarDestinatarioForaIntimacao(iRg, p2.numero);
  ok(/r[ée]u/i.test(textoDe(iRg.rec.replies[0])),
    '4e: RG de uma parte também dispara a trava (o RG era um contorno silencioso)');
}

console.log('\n5) Processo NÃO gated não muda de rito (aberto/legado intocados)');
{
  const aberto = novoProcesso('aberto');
  const i = fakeInteraction(JUIZ, { values: ['hab:1'] });
  await processoCmd.processarSelecaoDestinatarioIntimacao(i, aberto.numero);
  ok(i.rec.modais.length === 0 && /teor da intima/i.test(textoDe(i.rec.replies[0])),
    '5a: em processo `aberto` até o advogado segue no caminho de sempre — o rito não muda no meio');
  ok(pecas.classificarDestinatarioIntimacao(aberto, { discordId: ADV }).via === 'gated',
    '5b: (a REGRA pura ainda diz gated — quem filtra por modo é a camada de UI, viaDaIntimacao)');
}

console.log('\n6) O teor da intimação não é mais persistido em andamento (último vazamento cru)');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  const crus = (src.match(/detalhe: `Destinatário: \$\{[^`]*\}\\nTeor: \$\{teor\}`/g) || []).length;
  ok(crus === 0, '6a: nenhum dos 2 pontos grava `Teor:` cru direto no andamento', `ainda cru em ${crus} ponto(s)`);
  const viaPonto = (src.match(/detalheDeAndamento\(/g) || []).length;
  ok(viaPonto >= 5, '6b: os atos passam pelo ponto único de decisão', `achou ${viaPonto}`);
  // CANÁRIO: se o regex de 6a parar de casar por mudança de formatação, ele aprovaria em silêncio.
  ok(/Teor: \$\{teor\}/.test(src), '6z: o texto "Teor: ${teor}" ainda existe no arquivo (o scan de 6a não é vácuo)');
}

console.log('\n7) O PNG não vai mais para o canal compartilhado em processo gated');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  const bloco = src.slice(src.indexOf('EM PROCESSO `ingame` O TEOR NÃO VAI PARA O CANAL'), src.indexOf('EM PROCESSO `ingame` O TEOR NÃO VAI PARA O CANAL') + 1400);
  ok(/modoDoProcesso\(processo\) === 'ingame'/.test(bloco), '7a: a postagem no canal decide pelo modo do processo');
  ok(/restrito até a entrega pessoal/.test(bloco), '7b: no gated posta metadado, não o teor');
  ok(/textoIntimacao/.test(bloco) && /pngIntimacao/.test(bloco), '7c: o caminho não-gated segue postando texto e PNG (sem regressão)');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
