/* eslint-disable */
// O caminho LEGADO (anexo de PDF) não pode vazar para processo do rito novo. Rode com:
//   node scripts/testes-caminho-legado.js
//
// ACHADO EM 18/08/2026 (verificação do briefing, item 1). A bifurcação legado/gated existia só no
// botão "📄 Peticionar". Os botões de anexo de PDF continuavam sendo POSTADOS incondicionalmente em
// três pontos — abertura do cível, aprovação de habilitação e citação — inclusive em processo
// `ingame`. O processo nascia gated e a primeira coisa que o advogado lia no canal era "clique aqui
// pra juntar o PDF": exatamente o rito que o modo in-game substitui, e que joga o teor no canal
// compartilhado sem selo, sem janela e sem recebimento.
//
// Cobre as DUAS metades, porque só esconder o botão não basta: mensagem antiga ainda na tela e
// replay de customId chegam no handler por fora da exibição.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-legado-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const pecas = require('../utils/pecas');
const processoCmd = require('../commands/processo');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const ADV = 'id_adv', OUTRO = 'id_outro';

function fakeInteraction(userId) {
  const rec = { replies: [], modais: [] };
  return {
    rec,
    user: { id: userId },
    member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } },
    guild: { id: 'guild1' },
    showModal: async (m) => { rec.modais.push(m); },
    reply: async (o) => { rec.replies.push(o); },
    followUp: async (o) => { rec.replies.push(o); },
  };
}
const textoDe = (o) => (typeof o === 'string' ? o : (o && o.content) || '');

let seq = 0;
// `modo: null` grava o registro SEM o campo `modoEntrega` — é assim que um processo anterior à
// feature se parece, e é exatamente o que modoDoProcesso() lê como 'legado'.
function novoCivil(modo) {
  const numero = `020${++seq}CV`;
  return db.inserir('processos', {
    numero, tipo: 'Civil', status: 'Aguardando contestação',
    ...(modo === null ? {} : { modoEntrega: modo }),
    autor: ADV, advogados: [ADV], juiz: 'id_juiz',
    habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r1', status: 'Aprovado' }],
    canalId: 'canal1',
  });
}

(async () => {
console.log('\n=== Caminho legado (PDF) não vaza para o rito novo ===\n');

console.log('1) Sanidade: modoDoProcesso classifica os três casos');
{
  ok(pecas.modoDoProcesso(novoCivil(null)) === 'legado', '1a: processo sem o campo = legado');
  ok(pecas.modoDoProcesso(novoCivil('ingame')) === 'ingame', '1b: ingame');
  ok(pecas.modoDoProcesso(novoCivil('aberto')) === 'aberto', '1c: aberto');
}

console.log('\n2) Handler anexarPeticaoInicial fora do legado abre o FORMULÁRIO GATED');
{
  // MUDOU EM 19/08/2026, de propósito. Antes o handler RECUSAVA e mandava usar "Peticionar" noutro
  // menu — conserto mínimo de quando a petição inicial ainda não tinha tipo próprio. Agora tem
  // (`peticao_inicial_civel`), então o MESMO botão abre o formulário certo e o documento sai com o
  // título PETIÇÃO INICIAL, não PETIÇÃO.
  //
  // O que este arquivo protege NÃO mudou: o anexo de PDF continua inacessível fora do legado —
  // antes por recusa, agora por desvio.
  for (const modo of ['ingame', 'aberto']) {
    const p = novoCivil(modo);
    const i = fakeInteraction(ADV); // o AUTOR — passaria em todos os outros gates
    await processoCmd.anexarPeticaoInicial(i, p.numero);
    ok(i.rec.modais.length === 1,
      `2-${modo}: processo ${modo} abre o formulário gated (e NÃO o anexo de PDF)`);
  }

  // Legado continua funcionando: usa OUTRO usuário para parar no gate SEGUINTE (autoria) em vez de
  // ficar preso esperando o upload do PDF — o que importa é ter PASSADO pelo gate de modo.
  const pLegado = novoCivil(null);
  const iLegado = fakeInteraction(OUTRO);
  await processoCmd.anexarPeticaoInicial(iLegado, pLegado.numero);
  const tLegado = textoDe(iLegado.rec.replies[0]);
  ok(!/rito novo/i.test(tLegado) && /respons[áa]vel pela autoria/i.test(tLegado),
    '2-legado: processo legado NÃO é barrado pelo modo (cai no gate de autoria, como antes)', tLegado);
}

console.log('\n3) Handler anexarContestacao fora do legado abre o FORMULÁRIO GATED');
{
  // MUDOU NO BLOCO D, de propósito. Antes o handler RECUSAVA e mandava usar "Peticionar" — era o
  // conserto mínimo do vazamento, quando a contestação ainda não tinha tipo próprio. Agora ela tem
  // (`contestacao` no catálogo), então o MESMO botão em que o advogado já clica abre o formulário
  // certo: o documento sai com o título CONTESTAÇÃO, não PETIÇÃO.
  //
  // O que NÃO mudou, e é o que este arquivo protege: o caminho do PDF continua inacessível fora do
  // legado. Antes por recusa, agora por desvio — o efeito de segurança é o mesmo.
  for (const modo of ['ingame', 'aberto']) {
    const p = novoCivil(modo);
    const i = fakeInteraction(ADV);
    await processoCmd.anexarContestacao(i, `${p.numero}#1`);
    ok(i.rec.modais.length === 1,
      `3-${modo}: processo ${modo} abre o formulário gated (e NÃO o anexo de PDF)`);
  }

  const pLegado = novoCivil(null);
  const iLegado = fakeInteraction(OUTRO);
  await processoCmd.anexarContestacao(iLegado, `${pLegado.numero}#1`);
  const tLegado = textoDe(iLegado.rec.replies[0]);
  ok(!/rito novo/i.test(tLegado) && /habilitado/i.test(tLegado),
    '3-legado: processo legado NÃO é barrado pelo modo (cai no gate de habilitação)', tLegado);
}

console.log('\n4) Os pontos que POSTAM o botão passam pelo mesmo gate');
// Estático: garante que nenhum dos três call sites volte a postar o botão sem consultar ehLegado.
// Comportamental só pegaria isso subindo guild/canal falsos por três fluxos diferentes; o custo não
// se paga, e o risco real aqui é alguém adicionar um QUARTO ponto de postagem sem o gate.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  const linhas = src.split('\n');
  const semGate = [];
  linhas.forEach((l, i) => {
    if (!/botaoAnexarPeticaoInicial\(|botaoAnexarContestacao\(/.test(l)) return;
    if (/^function botaoAnexar/.test(l)) return; // a própria definição
    // O gate pode estar na mesma linha (ternário) ou até 3 linhas acima (if/const legado).
    const janela = linhas.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (!/ehLegado|legado \?|\blegado\b/.test(janela)) semGate.push(`linha ${i + 1}: ${l.trim()}`);
  });
  ok(semGate.length === 0, '4a: todo ponto que posta botão de PDF consulta o modo do processo', semGate.join(' | '));

  // CANÁRIO. Se o nome do helper mudar, o scan acima varre zero linhas e aprova em silêncio —
  // teste vazio dá confiança falsa, é pior que teste ausente.
  //
  // ERAM 3 SITES ATÉ 19/08/2026; hoje são 2. O terceiro (citação cível) passou a postar
  // `botoesDefesaCivel`, que traz contestação + prova juntas — e aquele botão NÃO consulta o modo
  // na exibição de propósito: quem bifurca é o handler `anexarContestacao` (legado → PDF, novo →
  // formulário com selo), coberto pelos blocos 2 e 3 deste mesmo arquivo. Este canário foi quem
  // avisou da mudança em vez de deixá-la passar silenciosa.
  const sitesVarridos = linhas.filter((l, i) =>
    /botaoAnexarPeticaoInicial\(|botaoAnexarContestacao\(/.test(l) && !/^function botaoAnexar/.test(l)).length;
  ok(sitesVarridos >= 2, '4z: o scan realmente inspecionou os pontos de postagem (não passou vazio)', `varreu ${sitesVarridos}`);

  // E o caminho novo (botoesDefesaCivel) tem que existir e apontar para o handler que bifurca —
  // senão a defesa cível ficaria sem botão nenhum e o processo travaria depois da citação.
  ok(/function botoesDefesaCivel/.test(src), '4y: a defesa cível tem botões próprios (contestação + prova)');
  ok(/painel:acao:processo:anexarcontestacao/.test(src), '4x: ...e a contestação aponta para o handler que bifurca por modo');

  ok(/const ehLegado = /.test(src), '4b: existe um único helper de decisão (ehLegado), não a regra copiada em cada ponto');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
