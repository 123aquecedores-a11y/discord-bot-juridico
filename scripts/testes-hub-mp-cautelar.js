/* eslint-disable */
// HUB DO MP: A CAUTELAR VIROU REQUERIMENTO, E A DENÚNCIA ENTROU NO GATE (20/08/2026). Rode com:
//   node scripts/testes-hub-mp-cautelar.js
//
// DUAS CORREÇÕES, guardadas aqui porque as duas já passaram despercebidas antes:
//
// (1) O botão "Escrever denúncia" que o painel do MP devolve ao abrir processo penal sem delegado
//     apontava para `processo:oferecer` — o caminho que cai em executarParecerMp e posta teor+PNG
//     DIRETO no canal, sem peça, sem selo, sem entrega. O teste que existia passava porque conferia
//     se o botão EXISTIA, não para onde ele levava. Aqui a asserção é o destino.
//
// (2) O MP tinha botão próprio de "Solicitar medida" (e uma opção "Requerer medida cautelar" no
//     menu da Manifestação). Os dois saíram: a cautelar é requerimento como outro qualquer, vai
//     pela Manifestação do MP à apreciação do Juiz, e quem expede o mandado é o Juiz.
//
// A VERIFICAÇÃO QUE VEM ANTES DE TUDO (seção 1): remover o pedido do MP só é seguro se o Juiz
// tiver caminho PRÓPRIO para expedir mandado. Se um dia `emitir_mandado` passar a depender da peça
// `solicitacao_medida`, esta seção quebra — e tem que quebrar, porque aí o Juiz fica sem saída.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-hubmp-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const processoCmd = require('../commands/processo');
const medidaCmd = require('../commands/medida');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

// Um corpo de função, do cabeçalho até a primeira chave de fechamento na coluna zero, SEM as
// linhas de comentário. Sem tirar comentário, uma asserção casa com a explicação em vez do código
// — já aconteceu três vezes neste projeto.
function corpoDe(fonte, cabecalho) {
  const i = fonte.indexOf(cabecalho);
  if (i < 0) return '';
  const resto = fonte.slice(i);
  const fim = resto.indexOf('\n}\n');
  return resto.slice(0, fim < 0 ? resto.length : fim + 3)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

const PROMOTOR = '180000000000000001';
const JUIZ = '180000000000000002';
const ESTRANHO = '180000000000000003';
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(JUIZ, 'Juiz', 'Juiz');

const PROC = LER('commands', 'processo.js');
const PAINEL = LER('commands', 'painel.js');
const MANDADO = LER('commands', 'mandado.js');
const MEDIDA = LER('commands', 'medida.js');

console.log('\n=== Hub do MP: cautelar por requerimento, denúncia no gate ===\n');

// ---------------------------------------------------------------------------
console.log('1) VERIFICAÇÃO OBRIGATÓRIA — o Juiz expede mandado sem depender do MP');
// ---------------------------------------------------------------------------
{
  ok(PROC.length > 10000 && MANDADO.length > 5000 && PAINEL.length > 10000,
    '1z: os três arquivos foram lidos (scan não vazio)');

  // O botão vive no hub do JUIZ, com gate próprio de cargo.
  const hubJuiz = PROC.slice(PROC.indexOf("id: 'hubjuiz'"), PROC.indexOf("id: 'hubmp'"));
  ok(hubJuiz.length > 100, '1z2: o bloco do hub do Juiz foi localizado');
  ok(/'emitir_mandado'/.test(hubJuiz), '1a: "Emitir mandado" está no hub do Juiz');

  const iEntrada = PROC.indexOf("id: 'emitir_mandado'");
  const entrada = PROC.slice(iEntrada, iEntrada + 300);
  ok(iEntrada > 0, '1z3: a entrada do catálogo foi localizada');
  ok(/cargo: \['Juiz'\]/.test(entrada), '1b: e é ação de cargo Juiz');
  ok(/quando: \(p\) => faseComJuiz\(p\) && p\.tipo === 'Penal'/.test(entrada),
    '1c: cuja condição é só "tem juiz e é penal" — não "tem medida deferida"');

  // A CADEIA INTEIRA, do clique ao documento, sem passar por medida nenhuma.
  const cadeia = [
    'function botaoEmitirMandado',
    'async function abrirSelectTipo',
    'async function processarSelecaoTipo',
    'async function processarSelecaoDestinatario',
    'async function emitirMandado(',
    'async function emitirMandadosComFundamentacao',
    'async function emitirMandadoNoProcesso',
  ];
  for (const cab of cadeia) {
    const nome = cab.replace(/^(async )?function /, '').replace('(', '');
    const corpo = corpoDe(MANDADO, cab);
    ok(corpo.length > 40, `1d-z (${nome}): a função foi localizada`);
    ok(!/'medidas'|solicitacao_medida|abrirSolicitarMedidaDireta|medidaCmd/.test(corpo),
      `1d (${nome}): não lê medida nem depende de uma`);
  }

  ok(/setCustomId\(`painel:acao:mandado:emitir:\$\{numero\}`\)/.test(MANDADO),
    '1e: o botão do Juiz tem customId próprio');
  ok(/acao === 'emitir'\) return mandadoCmd\.abrirSelectTipo/.test(PAINEL),
    '1f: e o painel o roteia');

  // O outro nascimento do mandado (Juiz defere medida) CONTINUA existindo — a verificação é que
  // ele não é o ÚNICO, não que ele tenha sumido.
  ok(/emitirMandadoNoProcesso/.test(MEDIDA),
    '1g: o mandado nascido de medida continua existindo — são dois caminhos, não um');

  console.log('  -> VERIFICAÇÃO: o Juiz tem caminho independente. Remover o pedido do MP é seguro.');
}

// ---------------------------------------------------------------------------
console.log('\n2) Os botões de medida SAÍRAM do hub do MP');
// ---------------------------------------------------------------------------
{
  const hubMp = PROC.slice(PROC.indexOf("id: 'hubmp'"), PROC.indexOf("id: 'hubadvogado'"));
  ok(hubMp.length > 100, '2z: o bloco do hub do MP foi localizado (scan não vazio)');
  const acoes = (hubMp.match(/acoes: \[([^\]]*)\]/) || [])[1] || '';
  ok(acoes.length > 10, '2z2: a lista de ações foi extraída', acoes);

  ok(!/solicitar_medida/.test(acoes), '2a: "Solicitar medida" não está mais na lista do hub', acoes);
  ok(/manifestacao_mp/.test(acoes), '2b: "Manifestação do MP" ficou');
  ok(/registrar_depoimento/.test(acoes), '2c: "Registrar depoimento" ficou');
  ok(/anexar_prova/.test(acoes), '2d: "Anexar prova" ficou');

  // Não basta sair da lista: a entrada do catálogo também saiu, senão fica ação órfã — o padrão
  // que já mordeu este projeto seis vezes (função viva sem caminho de produção).
  ok(!/id: 'solicitar_medida'/.test(PROC), '2e: e a entrada do CATALOGO_ACOES saiu junto');

  // A segunda porta: a opção dentro do menu da Manifestação.
  const abrir = corpoDe(PROC, 'async function abrirManifestacaoMp');
  ok(abrir.length > 200, '2z3: abrirManifestacaoMp foi localizada');
  ok(!/Requerer medida cautelar/.test(abrir), '2f: a opção "Requerer medida cautelar" saiu do menu');
  ok(!/value: 'medida'/.test(abrir), '2g: e o valor dela também');

  const tratar = corpoDe(PROC, 'async function tratarManifestacaoMp');
  ok(tratar.length > 200, '2z4: tratarManifestacaoMp foi localizada');
  ok(!/escolha === 'medida'/.test(tratar), '2h: e a rota que levava a abrirSolicitarMedidaDireta');
  ok(!/abrirSolicitarMedidaDireta/.test(tratar), '2i: nenhuma chamada sobrou no handler');
}

// ---------------------------------------------------------------------------
console.log('\n3) O requerimento continua tendo por onde sair — e vai ao Juiz');
// ---------------------------------------------------------------------------
{
  const abrir = corpoDe(PROC, 'async function abrirManifestacaoMp');
  ok(/value: 'livre'/.test(abrir), '3a: a "Manifestação / Requerimento livre" continua no menu');
  ok(/Requerimento livre \(c\/ documento\)/.test(abrir), '3b: com documento, como sempre');

  const tratar = corpoDe(PROC, 'async function tratarManifestacaoMp');
  ok(/abrirEmissao\(interaction, 'manifestacao_mp_gated', numero\)/.test(tratar),
    '3c: e ela entra no gate — peça com selo, entrega ao Juiz');

  // "requerimento" é o que vira pendência na fila do Juiz (deferir/indeferir). Se esse par sumisse,
  // a cautelar teria saído do hub sem ter para onde ir.
  ok(/deferirreqmp/.test(PROC) && /indeferirreqmp/.test(PROC),
    '3d: o Juiz continua com deferir/indeferir de requerimento do MP');
  ok(/decidirRequerimentoMp/.test(PAINEL), '3e: roteados no painel');
}

// ---------------------------------------------------------------------------
console.log('\n4) Medidas JÁ pedidas continuam decidíveis — não estrangulou o que está em curso');
// ---------------------------------------------------------------------------
{
  // O botão saiu; o handler NÃO. Quem já pediu uma medida direta precisa que o Juiz consiga
  // deferir/indeferir. Remover a rota junto deixaria pedidos pendentes sem desfecho possível.
  ok(typeof medidaCmd.abrirSolicitarMedidaDireta === 'function', '4a: o handler antigo continua vivo');
  ok(/acao === 'solicitardireta'\) return medidaCmd\.abrirSolicitarMedidaDireta/.test(PAINEL),
    '4b: e roteado, de propósito');
  ok(/acao === 'deferirdireta'\) return medidaCmd\.deferirMedidaDireta/.test(PAINEL),
    '4c: o deferimento do Juiz continua roteado');
  ok(/acao === 'indeferirdireta'\) return medidaCmd\.indeferirMedidaDireta/.test(PAINEL),
    '4d: e o indeferimento também');
}

// ---------------------------------------------------------------------------
console.log('\n5) O botão "Escrever denúncia" leva ao caminho GATED — de verdade, não no comentário');
// ---------------------------------------------------------------------------
async function secao5() {
  ok(typeof processoCmd.abrirDenunciaGated === 'function', '5a: abrirDenunciaGated existe e é exportada');

  const corpo = corpoDe(PROC, 'async function abrirDenunciaGated');
  ok(corpo.length > 300, '5z: o corpo foi localizado (scan não vazio)');
  ok(/abrirEmissao\(interaction, 'denuncia_mp', numero\)/.test(corpo), '5b: e abre a emissão gated');
  ok(!/executarParecerMp|confirmarParecerMp/.test(corpo),
    '5c: sem passar pelo parecer que posta direto no canal');
  ok(/podeAtuarNoCaso\(interaction, processo, 'promotor'\)/.test(corpo),
    '5d: mantendo a trava de dono do caso, igual ao hub');
  ok(/ehLegado\(processo\)/.test(corpo), '5e: e a bifurcação por modo, igual ao hub');

  // COMPORTAMENTO, não texto: monta o processo de verdade e vê onde a chamada aterrissa.
  const emissao = require('../utils/emissaoPeca');
  const original = emissao.abrirEmissao;
  const pousos = [];
  emissao.abrirEmissao = async (interaction, tipo, numero) => { pousos.push({ tipo, numero }); return 'gated'; };

  const canal = {
    id: 'c1', isTextBased: () => true, send: async () => ({ id: 'm1' }),
    permissionOverwrites: { cache: { some: () => false }, delete: async () => {}, edit: async () => {} },
    setParent: async () => {}, edit: async () => {}, messages: { fetch: async () => null },
  };
  const guild = {
    id: 'guild1', roles: { everyone: 'role-everyone' },
    members: { fetch: async (id) => ({ id, user: { id }, roles: { add: async () => {}, remove: async () => {} } }) },
    channels: { fetch: async () => canal, create: async () => canal },
  };

  const r = await processoCmd.criarProcessoPenal({
    guild, delegadoId: null, promotorId: PROMOTOR, semDelegado: true,
    crimesTexto: '121-homicidio-consumado', motivo: 'Apurado pelo MP.', reuNome: 'Réu RP', reuRg: '999',
  });
  ok(!r.erro, '5f-z: o processo de teste foi criado', r.erro || '');
  if (r.erro) { emissao.abrirEmissao = original; return; }

  const respostas = [];
  const fakeInteraction = (userId) => ({
    user: { id: userId },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    guild,
    reply: async (p) => { respostas.push(p); return p; },
    showModal: async (m) => { respostas.push({ modal: m?.data?.custom_id || 'modal' }); return m; },
  });

  const saida = await processoCmd.abrirDenunciaGated(fakeInteraction(PROMOTOR), r.numero);
  ok(pousos.length === 1, '5f: o promotor dono do caso chega em abrirEmissao', JSON.stringify(pousos));
  ok(pousos[0]?.tipo === 'denuncia_mp', '5g: com o tipo denuncia_mp', pousos[0]?.tipo);
  ok(pousos[0]?.numero === r.numero, '5h: e o número do processo recém-aberto');
  ok(saida === 'gated', '5i: e o retorno vem de lá — não de um modal de parecer');
  ok(!respostas.some(x => x.modal), '5j: nenhum modal de parecer foi aberto');

  // A trava continua: quem não é do caso não emite denúncia por este botão.
  pousos.length = 0; respostas.length = 0;
  await processoCmd.abrirDenunciaGated(fakeInteraction(JUIZ), r.numero);
  ok(pousos.length === 0, '5k: um Juiz não entra pela porta do MP');
  ok(respostas.length === 1, '5l: e recebe recusa em vez de silêncio');

  pousos.length = 0; respostas.length = 0;
  await processoCmd.abrirDenunciaGated(fakeInteraction(ESTRANHO), r.numero);
  ok(pousos.length === 0, '5m: nem quem não tem cargo nenhum');

  emissao.abrirEmissao = original;
}

// ---------------------------------------------------------------------------
console.log('\n6) O caminho NÃO-GATED não é mais alcançável por botão de painel');
// ---------------------------------------------------------------------------
{
  // `processo:oferecer` / executarParecerMp FICAM (o arquivamento ainda depende deles — decisão do
  // operador em 20/08/2026). O que este teste guarda é que nenhum painel volte a apontar para lá.
  ok(/executarParecerMp/.test(PROC), '6a: executarParecerMp continua existindo, como combinado');
  ok(!/setCustomId\(`processo:oferecer:\$\{resultado\.numero\}`\)/.test(PAINEL),
    '6b: mas o painel do MP não aponta mais para ele');
  const semComentario = PAINEL.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(semComentario.length > 10000, '6z: o painel sem comentários foi montado (scan não vazio)');
  ok(!/processo:oferecer/.test(semComentario),
    '6c: e nenhuma outra linha de código do painel monta esse customId');
}

(async () => {
  await secao5();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
