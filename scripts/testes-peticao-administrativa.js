/* eslint-disable */
// PETIÇÃO ADMINISTRATIVA NO RITO NOVO (Faixa 2, SPEC §11). Rode com:
//   node scripts/testes-peticao-administrativa.js
//
// As quatro petições administrativas — porte de arma, troca de nome, limpeza de ficha e alvará de
// evento — eram o ÚLTIMO rito preso no anexo de PDF direto, enquanto o resto do bot já gerava a
// peça pelo formulário, com selo.
//
// O QUE JÁ EXISTIA e NÃO foi refeito (o operador pediu para reaproveitar, não criar paralelo):
//   - o checklist de documentos por tipo (DOCUMENTOS_NECESSARIOS), postado na abertura;
//   - a decisão do juiz: deferir / indeferir / converter em diligência.
// O que faltava era só a peça deixar de ser um PDF que o advogado sobe.
//
// DOIS BLOQUEIOS ESTRUTURAIS tiveram que cair para isso funcionar, e os dois estão cobertos aqui:
//   1. `peticoes` não carimbava `modoEntrega` — toda petição era `legado` por definição, e a
//      bifurcação nunca dispararia;
//   2. o emissor de uma petição não é habilitação nem slot de TABELAS_TICKET: é o advogado que
//      protocolou (`requerenteId`). Sem `emissorCampo`, podeEmitir recusaria justamente ele.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-peticao-adm-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const pecas = require('../utils/pecas');
const emissao = require('../utils/emissaoPeca');
const peticaoCmd = require('../commands/peticao');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const ADVOGADO = '810000000000000001';
const JUIZ = '810000000000000002';
const OUTRO = '810000000000000003';

const TIPOS_ADM = ['PorteArma', 'TrocaNome', 'LimpezaFicha', 'AlvaraEvento'];

function fakeInteraction(userId) {
  const rec = { replies: [], modais: [] };
  return {
    rec,
    user: { id: userId },
    member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } },
    guild: { id: 'guild1', channels: { fetch: async () => null } },
    channel: { awaitMessages: async () => { throw new Error('sem upload no teste'); } },
    reply: async (o) => { rec.replies.push(o); },
    followUp: async (o) => { rec.replies.push(o); },
    showModal: async (m) => { rec.modais.push(m); },
  };
}
const textoDe = (o) => (typeof o === 'string' ? o : (o && o.content) || '');

let seq = 0;
// `modo: null` grava SEM o campo — é como uma petição aberta ANTES desta mudança se parece.
function novaPeticao(tipo, modo) {
  const numero = `70${++seq}PA`;
  return db.inserir('peticoes', {
    numero, tipo, requerenteId: ADVOGADO, juiz: JUIZ, promotor: null,
    status: 'Pendente', canalId: 'canal1',
    rgCliente: '12345', nomeCliente: 'Fulano de Tal', enderecoCliente: 'Rua X, 1',
    ...(modo === null ? {} : { modoEntrega: modo }),
  });
}

(async () => {
console.log('\n=== Petição administrativa no rito novo (Faixa 2) ===\n');

console.log('1) O tipo existe no catálogo e é dirigido ao Juiz');
{
  ok(emissao.tipoAtivo('peticao_administrativa'), '1a: peticao_administrativa está no catálogo e ativa');
  const cfg = emissao.TIPOS.peticao_administrativa;
  ok(cfg.tabela === 'peticoes', '1b: opera na tabela `peticoes`, não em `processos`');
  ok(cfg.destinatarios.includes('Juiz'), '1c: o destinatário é o Juiz — é ele que defere ou indefere');
  ok(cfg.emissorCampo === 'requerenteId',
    '1d: o emissor vem do campo `requerenteId` — petição não tem habilitação nem slot de TABELAS_TICKET');
}

console.log('\n2) A petição NASCE com o modo carimbado (era o bloqueio nº 1)');
{
  // Sem isso, modoDoProcesso lia toda petição como `legado` e a bifurcação nunca dispararia.
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'peticao.js'), 'utf-8');
  ok(/modoEntrega: modoEntrega\.modoParaNovoProcesso\(guild\.id\)/.test(src),
    '2a: abrirTicketPeticao carimba o modo na abertura, como processo e medida');
  ok(/db\.inserir\('peticoes'/.test(src), '2z: ...no insert real de petições (o scan não passou vazio)');
}

console.log('\n3) CAMINHO DE ENTRADA — o botão que o advogado já usa abre o formulário');
{
  for (const tipo of TIPOS_ADM) {
    const p = novaPeticao(tipo, 'ingame');
    const i = fakeInteraction(ADVOGADO);
    await peticaoCmd.anexarDocumentoPeticao(i, p.numero);
    ok(i.rec.modais.length === 1, `3-${tipo}: abre o formulário gated (não o anexo de PDF)`);
  }
}

console.log('\n4) LEGADO intocado — o rito não muda no meio do próprio pedido');
{
  const p = novaPeticao('PorteArma', null); // sem o campo = aberta antes da mudança
  ok(pecas.modoDoProcesso(p) === 'legado', '4a: petição sem o campo é legado por definição');
  const i = fakeInteraction(ADVOGADO);
  await peticaoCmd.anexarDocumentoPeticao(i, p.numero).catch(() => {});
  ok(i.rec.modais.length === 0, '4b: e continua no anexo de PDF (SPEC §11.2.1)');
}

console.log('\n5) Só o ADVOGADO QUE PROTOCOLOU emite (era o bloqueio nº 2)');
{
  const p = novaPeticao('TrocaNome', 'ingame');
  const iOutro = fakeInteraction(OUTRO);
  await peticaoCmd.anexarDocumentoPeticao(iOutro, p.numero).catch(() => {});
  ok(iOutro.rec.modais.length === 0, '5a: quem não protocolou não abre o formulário');
  ok(iOutro.rec.replies.length > 0, '5b: ...e recebe recusa explicada, não silêncio');
}

console.log('\n6) A peça gerada sai com a QUALIFICAÇÃO da petição, não de "Ação Cível"');
{
  // O `if` binário antigo (Penal/Cível) classificaria um porte de arma como "Ação Cível" — a
  // petição administrativa é o terceiro rito, e foi ele que forçou a conversão para tabela.
  const p = novaPeticao('PorteArma', 'ingame');
  // A CLASSE, testada de verdade nos três ritos — é aqui que o `if` binário errava.
  const qPeticao = emissao.qualificacao(p, 'peticoes');
  ok(/Pedido de Porte de Arma/.test(qPeticao),
    '6-classe-a: porte de arma sai como "Pedido de Porte de Arma"', qPeticao.split('\n')[0]);
  ok(!/Ação Cível/.test(qPeticao),
    '6-classe-b: ...e NÃO como "Ação Cível", que era o que o if binário produzia');
  ok(/Requerente:.*Fulano/.test(qPeticao) && /RG 12345/.test(qPeticao),
    '6-classe-c: a parte é o CLIENTE (nome + RG), não autor/réu');
  for (const [tipo, esperado] of [['TrocaNome', /Retificação de Nome/], ['LimpezaFicha', /Reabilitação/], ['AlvaraEvento', /Alvará de Evento/]]) {
    ok(esperado.test(emissao.qualificacao({ ...p, tipo }, 'peticoes')), `6-classe-${tipo}: classe própria`);
  }
  // Sem regressão nos dois ritos que já existiam.
  ok(/Ação Penal/.test(emissao.qualificacao({ numero: 'X', tipo: 'Penal' }, 'processos')), '6-classe-penal: penal intocado');
  ok(/Ação Cível/.test(emissao.qualificacao({ numero: 'X', tipo: 'Civil' }, 'processos')), '6-classe-civel: cível intocado');

  const g = pecas.gerar({
    processoTabela: 'peticoes', processoNumero: p.numero, tipo: 'peticao_administrativa',
    autorId: ADVOGADO, autorPapel: 'Advogado', texto: 'teor do pedido',
    qualificacao: qPeticao,
    destinatarios: [{ papel: 'Juiz' }],
  });
  ok(g.ok, '6a: a peça é gerada na tabela peticoes');
  ok(pecas.ocupaDestinatario('peticoes', p, { papel: 'Juiz' }, JUIZ) === true,
    '6b: o Juiz da petição é reconhecido como destinatário (resolve por TABELAS_TICKET.peticoes)');
  ok(pecas.podeVerTeor(ADVOGADO, g.peca.numero, p) === true, '6c: o advogado que emitiu vê o próprio teor');
  ok(pecas.podeVerTeor(OUTRO, g.peca.numero, p) === false, '6d: quem não é parte não vê');
}

console.log('\n7) O que JÁ EXISTIA continua de pé (não foi criado paralelo)');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'peticao.js'), 'utf-8');
  for (const tipo of TIPOS_ADM) {
    ok(new RegExp(`DOCUMENTOS_NECESSARIOS\\.${tipo}`).test(src), `7-${tipo}: o checklist do tipo continua sendo postado`);
  }
  ok(/painel:acao:peticao:deferir/.test(src) && /painel:acao:peticao:indeferir/.test(src) && /painel:acao:peticao:diligencia/.test(src),
    '7d: a decisão do juiz (deferir / indeferir / diligência) segue intacta');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
