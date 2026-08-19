/* eslint-disable */
// IDENTIDADE DO ALVO DA MEDIDA: NOME + RG (19/08/2026). Rode com:
//   node scripts/testes-alvo-medida.js
//
// O campo "Discord do alvo" saiu pela mesma razão que o @ do réu: o alvo é personagem de RP, não
// tem conta no servidor, e o dado não decidia nada. Quem identifica é NOME + RG — o mesmo trio do
// resto do bot (nome, RG, fundamentação).
//
// O RG É OPCIONAL DE PROPÓSITO, e essa é a parte que um teste desatento quebraria: busca e
// apreensão frequentemente tem por alvo um LOCAL ("galpão da Rua 5"), que não tem identidade civil.
// Exigir RG obrigaria o Delegado a inventar um.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-alvo-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

console.log('\n=== Alvo da medida: nome + RG ===\n');

// ---------------------------------------------------------------------------
console.log('1) O MODAL do painel — os três campos padrão');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'painel.js');
  ok(src.length > 1000, '1z: o arquivo foi lido (scan não vazio)');

  const i = src.indexOf("painel:modal:medida:solicitar:${tipoIndex}");
  ok(i > 0, '1y: o modal de solicitar medida foi localizado (scan não vazio)');
  const bloco = src.slice(i, i + 1600);

  ok(/setCustomId\('alvo'\)/.test(bloco), '1a: tem o campo do NOME do alvo');
  ok(/Nome do alvo \(pessoa ou local\)/.test(bloco), '1b: ...rotulado como nome, servindo pessoa e local');
  ok(/setCustomId\('alvo_rg'\)/.test(bloco), '1c: tem o campo do RG');
  ok(/setRequired\(false\)/.test(bloco.slice(bloco.indexOf("'alvo_rg'"))),
    '1d: ...OPCIONAL — alvo que é local não tem RG');
  ok(/RG do alvo \(vazio se for local\)/.test(bloco), '1e: ...e o rótulo diz isso ao Delegado');
  ok(/setCustomId\('motivo'\)/.test(bloco) && /Fundamentação \(motivo\/indícios\)/.test(bloco),
    '1f: e a FUNDAMENTAÇÃO, com o nome usado no resto do bot');

  ok(!/alvo_discord/.test(bloco), '1g: o campo "Discord do alvo" saiu do modal');
  ok(bloco.split('new ActionRowBuilder()').length - 1 === 3,
    '1h: exatamente três campos — nem sobrou o antigo, nem faltou um novo');
}

// ---------------------------------------------------------------------------
console.log('\n2) O SUBMIT grava o que o modal coleta');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'painel.js');
  const i = src.indexOf("modulo === 'medida' && acao === 'solicitar'");
  ok(i > 0, '2z: o submit foi localizado (scan não vazio)');
  const bloco = src.slice(i, i + 900);

  ok(/getTextInputValue\('alvo'\)/.test(bloco), '2a: lê o nome do alvo');
  ok(/rgAlvo: \(interaction\.fields\.getTextInputValue\('alvo_rg'\)/.test(bloco), '2b: lê o RG');
  ok(/\|\| null/.test(bloco.slice(bloco.indexOf('rgAlvo'))), '2c: ...e RG em branco vira null, não string vazia');
  ok(/getTextInputValue\('motivo'\)/.test(bloco), '2d: e a fundamentação');
  // Sem tirar os comentários, a asserção casava com a própria linha que EXPLICA a remoção — e um
  // teste que se satisfaz com um comentário não está olhando o código.
  const semComentarios = bloco.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/alvoDiscordId:/.test(semComentarios), '2e: NÃO grava mais Discord do alvo');
  ok(!/extrairMencoes\(interaction\.fields\.getTextInputValue\('alvo_discord'\)\)/.test(bloco),
    '2f: e não tenta extrair menção de um campo que não existe mais');
}

// ---------------------------------------------------------------------------
console.log('\n3) O SLASH /medida solicitar acompanha');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'medida.js');
  ok(src.length > 1000, '3z: o arquivo foi lido (scan não vazio)');

  ok(!/setName\('alvo_discord'\)/.test(src), '3a: a opção alvo_discord saiu do slash');
  ok(!/getUser\('alvo_discord'\)/.test(src), '3b: e a leitura dela também');
  ok(/setName\('alvo'\)[^)]*Nome do alvo \(pessoa ou local\)/.test(src) || /Nome do alvo \(pessoa ou local\)/.test(src),
    '3c: a opção de nome tem a mesma descrição do modal');
  ok(/deixe vazio se o alvo for um local/.test(src),
    '3d: e o RG diz que pode ficar vazio para local — igual ao modal');
}

// ---------------------------------------------------------------------------
console.log('\n4) A EXIBIÇÃO usa nome + RG');
// ---------------------------------------------------------------------------
{
  const src = LER('commands', 'medida.js');
  ok(!/name: 'Discord do alvo'/.test(src),
    '4a: o embed da medida não mostra mais o Discord do alvo');
  ok(/name: 'RG do alvo'/.test(src), '4b: mostra o RG no lugar');
  ok(/alvo é local, ou RG não informado/.test(src),
    '4c: ...e quando não há RG, explica por que — em vez de "Não identificado", que parecia erro');

  // O preset do painel penal pré-preenchia o campo de réus com a menção do alvo. Sem menção, o que
  // serve é o nome — deixar a menção quebrada ali produziria "<@null>", o mesmo defeito de hoje cedo.
  ok(!/campoReus\.setValue\(`<@\$\{medida\.alvoDiscordId\}>`\)/.test(src),
    '4d: o preset de réus não monta mais menção a partir do alvo');
  ok(/campoReus\.setValue\(String\(medida\.alvo\)/.test(src), '4e: usa o NOME do alvo');
}

// ---------------------------------------------------------------------------
console.log('\n5) O QUE NÃO FOI TOCADO');
// ---------------------------------------------------------------------------
{
  // A medida DIRETA do MP escolhe o destinatário num select das partes do processo — ali o Discord
  // é conhecido e legítimo (é uma parte de verdade, não um nome digitado). Não é o mesmo campo.
  const src = LER('commands', 'medida.js');
  ok(/alvoDiscordId: destinatario\?\.discordId \|\| null/.test(src),
    '5a: a medida direta do MP segue usando o destinatário escolhido nas partes do processo');

  // O webhook da Polícia Civil é fonte EXTERNA, não formulário do bot: continua aceitando o dado
  // quando o CAD manda. Remover ali quebraria a integração sem resolver nada.
  const integ = LER('utils', 'integracaoPoliciaCivil.js');
  ok(integ.length > 500 && /alvoDiscordId/.test(integ),
    '5b: a integração da Polícia Civil não foi alterada — é fonte externa, não formulário');

  // E o cruzamento por ficha continua achando por RG, que é o identificador que sobrou.
  const ficha = LER('utils', 'ficha.js');
  ok(/m\.rgAlvo === rg/.test(ficha), '5c: o cruzamento de fichas acha a medida pelo RG do alvo');
}

console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.exit(falhas.length ? 1 : 0);
