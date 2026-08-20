/* eslint-disable */
// PROCESSO PENAL ABERTO PELO MP, SEM DELEGADO (20/08/2026). Rode com:
//   node scripts/testes-penal-pelo-mp.js
//
// O PROBLEMA: só o Delegado abria processo penal. Nem toda cidade tem Delegado ativo, e onde não
// tem, o penal ficava travado na porta — o MP não tinha por onde começar.
//
// O DELEGADO NÃO FOI REMOVIDO. O fluxo dele segue idêntico: abre inquérito → MP decide denunciar
// ou arquivar. O que mudou é que passou a existir uma SEGUNDA porta, para quando não há polícia.
//
// A DIFERENÇA QUE IMPORTA, e que este arquivo guarda: o processo do MP nasce com `delegado: null`
// DE VERDADE. Sem isso, a regra de acúmulo (19/08/2026) faria o próprio promotor ocupar os dois
// papéis — e o bot passaria a ter um responsável por diligência policial que não existe.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-penal-mp-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const processoCmd = require('../commands/processo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

const DELEGADO = '170000000000000001';
const PROMOTOR = '170000000000000002';
const JUIZ = '170000000000000003';
const ZE = '170000000000000004';

rh.contratar(DELEGADO, 'Delegado', 'Delegado');
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(JUIZ, 'Juiz', 'Juiz');

const enviados = [];
function fakeGuild() {
  const canal = {
    id: 'c1', isTextBased: () => true,
    send: async (p) => { enviados.push(p); return { id: `m${enviados.length}` }; },
    permissionOverwrites: { cache: { some: () => false }, delete: async () => {}, edit: async () => {} },
    setParent: async () => {}, edit: async () => {}, messages: { fetch: async () => null },
  };
  return {
    id: 'guild1',
    // roles.everyone: criarCanalTicket monta as permission overwrites a partir dele.
    roles: { everyone: 'role-everyone' },
    members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} } }) },
    channels: { fetch: async () => canal, create: async () => canal },
  };
}

console.log('\n=== Processo penal aberto pelo MP, sem delegado ===\n');

// ---------------------------------------------------------------------------
console.log('1) O processo nasce SEM DELEGADO de verdade');
// ---------------------------------------------------------------------------
async function secao1() {
  const r = await processoCmd.criarProcessoPenal({
    guild: fakeGuild(), delegadoId: null, promotorId: PROMOTOR, semDelegado: true,
    crimesTexto: '121-homicidio-consumado', motivo: 'Fatos apurados diretamente pelo MP.', reuNome: 'Réu RP', reuRg: '999',
  });
  ok(!r.erro, '1z: o processo foi criado', r.erro || '');
  if (r.erro) return null;

  const p = db.buscarPorNumero('processos', r.numero);
  ok(p.delegado === null, '1a: o campo delegado fica VAZIO', String(p.delegado));
  ok(p.promotor === PROMOTOR, '1b: e o promotor que abriu é o responsável');

  // A trava que este teste existe para guardar: sem `semDelegado`, o acúmulo colocaria o próprio
  // promotor como delegado — e o bot teria um responsável por diligência policial que não existe.
  const r2 = await processoCmd.criarProcessoPenal({
    guild: fakeGuild(), delegadoId: null, promotorId: PROMOTOR,
    crimesTexto: '121-homicidio-consumado', motivo: 'Mesmo caso, sem a flag.', reuNome: 'Réu RP', reuRg: '999',
  });
  const p2 = db.buscarPorNumero('processos', r2.numero);
  ok(p2.delegado === PROMOTOR,
    '1c: SEM a flag, o acúmulo de 19/08 segue valendo — o promotor ocupa os dois papéis');
  ok(p.delegado !== p2.delegado, '1d: os dois caminhos produzem resultados diferentes de propósito');
  return r.numero;
}

// ---------------------------------------------------------------------------
console.log('\n2) O fluxo do DELEGADO não mudou');
// ---------------------------------------------------------------------------
async function secao2() {
  const r = await processoCmd.criarProcessoPenal({
    guild: fakeGuild(), delegadoId: DELEGADO, promotorId: null,
    crimesTexto: '121-homicidio-consumado', motivo: 'Inquérito policial.', reuNome: 'Réu', reuRg: '111',
  });
  const p = db.buscarPorNumero('processos', r.numero);
  ok(p.delegado === DELEGADO, '2a: delegado que abre continua sendo o delegado do caso');
  ok(p.promotor === PROMOTOR, '2b: e um promotor é sorteado para decidir');
  ok(p.status === 'Aguardando decisão do MP', '2c: o status do inquérito é o de sempre', p.status);
}

// ---------------------------------------------------------------------------
console.log('\n3) O CAMINHO DE PRODUÇÃO: botão no painel do MP → denúncia');
// ---------------------------------------------------------------------------
{
  const painel = LER('commands', 'painel.js');
  ok(painel.length > 1000, '3z: o arquivo foi lido (scan não vazio)');

  ok(/'painel:acao:mp:penal', '⚖️ Abrir processo penal'/.test(painel),
    '3a: o botão existe no painel do MP');
  ok(/if \(acao === 'penal'\) return abrirModalProcessoPenal\(interaction, 'painel:modal:mp:penal'\)/.test(painel),
    '3b: e abre o MESMO formulário do Delegado — não um segundo modal');
  ok(/modulo === 'mp' && acao === 'penal'/.test(painel), '3c: o submit tem rota própria');
  ok(/tipo: 'penal-mp-direto'/.test(painel) && /semDelegado: true/.test(painel),
    '3d: que marca o rascunho como abertura sem delegado');
  ok(/semDelegado: !!rascunho\.dados\.semDelegado/.test(painel),
    '3e: e a flag chega em criarProcessoPenal');

  // Vai DIRETO para a denúncia: nada de perguntar "denunciar ou arquivar" a quem acabou de abrir.
  // A HISTÓRIA DESTA ASSERÇÃO, porque ela já falhou duas vezes de jeitos diferentes:
  //   até 20/08 (manhã) apontava para `processo:oferecer` e a asserção PASSAVA, porque só olhava
  //   se o botão existia — não para onde levava. `processo:oferecer` cai em executarParecerMp, que
  //   despeja teor+PNG direto no canal. Depois virou `escreverdenuncia`, um handler próprio. Agora
  //   é a PORTA ÚNICA do MP: o mesmo customId do hub, sem handler intermediário nenhum.
  ok(/painel:acao:processo:manifestacaomp:\$\{resultado\.numero\}/.test(painel),
    '3f: o botão leva à porta única do MP — a MESMA do hub, não um atalho próprio');
  ok(!/setCustomId\(`processo:oferecer:\$\{resultado\.numero\}`\)/.test(painel),
    '3f2: e NÃO para `processo:oferecer`, que pula a peça e o selo');
  ok(/📝 Escrever denúncia/.test(painel), '3g: com rótulo que diz o que fazer');
  // O bloco inteiro (mensagem + linha de botões) passa de 400 caracteres; o que importa é que a
  // resposta do caminho semDelegado use editReply e NÃO respostaSumindo.
  const blocoSemDelegado = painel.slice(painel.indexOf('if (rascunho.dados.semDelegado)'), painel.indexOf('if (rascunho.dados.semDelegado)') + 620);
  // Sem tirar os comentários, a asserção casaria com a própria linha que EXPLICA por que
  // respostaSumindo não serve aqui — teste que se satisfaz com comentário não olha o código.
  const codigoSemDelegado = blocoSemDelegado.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(/interaction\.editReply\(/.test(codigoSemDelegado) && !/respostaSumindo/.test(codigoSemDelegado),
    '3h: a mensagem NÃO some sozinha — respostaSumindo apagaria o botão em 45s');

  // SEM ATALHO PRÓPRIO. O botão reusa a rota que já existia; se um dia voltar a existir um handler
  // só para este botão, ele volta a poder divergir do hub — que foi exatamente o defeito de ontem.
  ok(/if \(acao === 'manifestacaomp'\) return processoCmd\.abrirManifestacaoMp\(interaction, extra\)/.test(painel),
    '3i: o botão é roteado pela porta única, não por um handler dedicado');
  ok(!/escreverdenuncia|abrirDenunciaGated/.test(painel),
    '3i2: e o atalho intermediário foi removido de vez');
  const proc = LER('commands', 'processo.js');
  ok(typeof processoCmd.abrirManifestacaoMp === 'function', '3j: e o handler existe e é exportado');
  // Fim da função = a primeira chave de fechamento na coluna zero. `\r?\n` e NÃO '\n}\n': o repo
  // roda em Windows e o git entrega os arquivos com CRLF — com a busca literal o corte não achava
  // nada, o corpo virava o arquivo inteiro e a asserção passava por acidente. Foi o canário
  // (3j-z) que pegou.
  const corpo = proc.slice(proc.indexOf('async function abrirManifestacaoMp'));
  const fimCorpo = corpo.search(/\r?\n\}\r?\n/);
  const corpoPorta = corpo.slice(0, fimCorpo < 0 ? corpo.length : fimCorpo)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // CANÁRIO com teto, não só piso: sem o teto, um corte que falha devolve o ARQUIVO INTEIRO e a
  // asserção seguinte passa porque `abrirEmissao` aparece em outro lugar qualquer do arquivo.
  ok(fimCorpo > 0 && corpoPorta.length > 200 && corpoPorta.length < 2500,
    '3j-z: o corpo foi RECORTADO (nem vazio, nem o arquivo todo)', `${corpoPorta.length} chars`);
  ok(/abrirEmissao\(interaction, 'manifestacao_mp_gated', numero\)/.test(corpoPorta),
    '3k: ele abre a emissão GATED — peça com selo, entregue em cena');
  ok(!/executarParecerMp|confirmarParecerMp/.test(corpoPorta),
    '3l: e não passa perto do parecer que posta direto no canal');
}

// ---------------------------------------------------------------------------
console.log('\n4) SEM DELEGADO não deixa fluxo órfão');
// ---------------------------------------------------------------------------
async function secao4(numeroSemDelegado) {
  const proc = LER('commands', 'processo.js');

  // O arquivamento do MP mencionava `<@${processo.delegado}>` e oferecia "pedir revisão" — ato do
  // Delegado. Sem ele, isso produziria `<@null>` e um botão que ninguém pode clicar.
  ok(/if \(processo\.delegado\) \{/.test(proc), '4a: o arquivamento confere se há delegado antes de mencioná-lo');
  ok(/não teve inquérito policial, então não há pedido de revisão/.test(proc),
    '4b: e explica por que não há revisão a oferecer, em vez de sumir com o assunto');
  // A linha da menção CONTINUA existindo — e deve. O que mudou é que ela ficou dentro do guard.
  // Exigir que sumisse seria exigir que o Delegado deixasse de ser avisado quando existe.
  const iMencao = proc.indexOf('content: `<@${processo.delegado}>`, components: [botaoPedirRevisao');
  ok(iMencao > 0, '4c-z: a menção ao Delegado foi localizada (scan não vazio)');
  ok(/if \(processo\.delegado\) \{[\s\S]{0,120}$/.test(proc.slice(0, iMencao)),
    '4c: e está DENTRO do guard — sem delegado, nada é postado, então não sobra `<@null>`');

  // Cumprir mandado dependia do delegado; sem ele só SuperStaff conseguia, e o mandado ficava
  // eternamente "Emitido".
  const med = LER('commands', 'medida.js');
  ok(/const podeSemDelegado = isAdmin\(interaction\) \|\| isSuperStaff\(interaction\)/.test(med),
    '4d: sem delegado, o cumprimento tem regra própria');
  ok(/medida\?\.juiz \|\| interaction\.user\.id === processoDoMandado\?\.juiz/.test(med),
    '4e: o Juiz do caso pode registrar');
  ok(/medida\?\.promotor \|\| interaction\.user\.id === processoDoMandado\?\.promotor/.test(med),
    '4f: o Promotor do caso também');
  ok(/cobreOPapel\(interaction\.user\.id, 'Juiz'\)/.test(med),
    '4g: e quem cobre o papel, pela mesma regra do resto do bot');
  ok(!/só a Staff pode registrar o cumprimento/.test(med),
    '4h: a recusa antiga ("só a Staff") saiu');

  // Continua NÃO sendo qualquer um.
  ok(/if \(!podeSemDelegado\) \{/.test(med), '4i: quem não é nada disso continua recusado');

  // E o processo sem delegado é um ticket normal para o resto do bot.
  if (numeroSemDelegado) {
    const p = db.buscarPorNumero('processos', numeroSemDelegado);
    ok(!!p && p.tipo === 'Penal', '4j: o processo existe e é penal');
    ok(p.status !== 'Encerrado' && p.status !== 'Arquivado', '4k: e está aberto');
  }
}

// ---------------------------------------------------------------------------
console.log('\n5) SEM CAMINHO PARALELO — é a mesma abertura, com um parâmetro');
// ---------------------------------------------------------------------------
{
  const proc = LER('commands', 'processo.js');
  const criacoes = (proc.match(/async function criarProcessoPenal/g) || []).length;
  ok(criacoes === 1, '5a: existe UMA função de abertura penal', `${criacoes}`);
  ok(!/criarProcessoPenalMp|abrirPenalPeloMp/.test(proc), '5b: e nenhuma variante para o MP');

  const painel = LER('commands', 'painel.js');
  const modais = (painel.match(/function abrirModalProcessoPenal/g) || []).length;
  ok(modais === 1, '5c: e UM formulário, com o customId por parâmetro', `${modais}`);
  ok(/function abrirModalProcessoPenal\(interaction, customId = 'painel:modal:processo:penal'\)/.test(painel),
    '5d: o padrão preserva o caminho do Delegado sem tocá-lo');
}

(async () => {
  const numero = await secao1();
  await secao2();
  await secao4(numero);
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  process.exit(falhas.length ? 1 : 0);
})();
