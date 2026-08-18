/* eslint-disable */
// Testes do módulo de peças com entrega in-game (utils/pecas.js). Rode com:
//   node scripts/testes-pecas-entrega.js
//
// Cobre os testes de aceitação da SPEC §15 que não dependem de UI do Discord: visibilidade,
// janela, selo, contadores separados, válvula de 24h, troca de responsável e modo carimbado.
// A camada de visibilidade é o ponto de maior risco do projeto (SPEC §8) — é aqui que ela é
// exercitada sem precisar subir bot.
//
// Banco temporário — não encosta no dados.json de produção.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-pecas-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';
delete process.env.JANELA_ENTREGA_MIN;

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');

// ---- mini framework ----
let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// ---- atores ----
const JUIZ = 'id_juiz_1', JUIZ2 = 'id_juiz_2', PROMOTOR = 'id_promotor', ADV = 'id_advogado';
const ADV2 = 'id_advogado_2', DESEMB = 'id_desembargador', ESTRANHO = 'id_estranho';

// O RH é fonte da verdade só para CARGO (supervisão). A ocupação de papel no processo vem do
// campo do registro — ver o comentário em utils/pecas.js sobre não reconferir RH no recebimento.
rh.contratar(DESEMB, 'Desembargador', 'Desa. Fulana', '1');

const MIN = 60 * 1000;
let seq = 0;
function novoProcesso(campos = {}) {
  const numero = `000${++seq}PN`;
  return db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
    juiz: JUIZ, promotor: PROMOTOR, delegado: null, advogados: [], habilitacoes: [],
    ...campos,
  });
}
const recarregar = (n) => db.buscarPorNumero('processos', n);
const peca = (n) => db.buscarPorNumero('pecas', n);

console.log('\n=== Peças com entrega in-game ===\n');

// ---------------------------------------------------------------------------
console.log('1) Geração e visibilidade inicial (SPEC §15.1)');
{
  const p = novoProcesso();
  const { ok: gerou, peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'TEOR SIGILOSO DA PEÇA',
    destinatarios: [{ papel: 'Juiz' }],
  });
  ok(gerou && pc, '1a: peça gerada');
  ok(pc.gated === true, '1b: processo ingame gera peça gated');
  ok(/^\d{6}$/.test(pc.digitos), '1c: selo tem os 6 dígitos de leitura humana');
  ok(pc.destinatarios[0].token && pc.destinatarios[0].token.startsWith('tk_'), '1d: destinatário tem token próprio');
  ok(!pc.destinatarios[0].token.includes(pc.numero), '1e: o token NÃO contém o número do documento');

  ok(pecas.podeVerTeor(PROMOTOR, pc.numero) === true, '1f: o autor vê o teor');
  ok(pecas.podeVerTeor(JUIZ, pc.numero) === false, '1g: o DESTINATÁRIO ainda NÃO vê o teor');
  ok(pecas.podeVerTeor(DESEMB, pc.numero) === true, '1h: supervisão (RH) vê o teor');
  ok(pecas.podeVerTeor(ESTRANHO, pc.numero) === false, '1i: estranho não vê');
  // Staff é role do Discord, não cargo do RH — entra por fora, e a omissão falha fechada.
  ok(pecas.podeVerTeor(ESTRANHO, pc.numero, null, { ehStaff: true }) === true, '1m: staff vê quando o chamador informa');
  ok(pecas.projetarParaUsuario(ESTRANHO, peca(pc.numero), null, { ehStaff: true }).texto === 'TEOR SIGILOSO DA PEÇA', '1n: ...e a projeção respeita isso');

  const projJuiz = pecas.projetarParaUsuario(JUIZ, peca(pc.numero));
  ok(projJuiz.texto === undefined, '1j: a projeção do destinatário NÃO carrega o teor');
  ok(projJuiz.numero === pc.numero && !!projJuiz.tipo, '1k: ...mas carrega os metadados');
  ok(pecas.projetarParaUsuario(PROMOTOR, peca(pc.numero)).texto === 'TEOR SIGILOSO DA PEÇA', '1l: a do autor carrega');
}

// ---------------------------------------------------------------------------
console.log('\n2) Janela de entrega (SPEC §15.2, §15.2b)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Promotor' }],
  });

  const semJanela = pecas.receber(pc.numero, PROMOTOR, { tokenLido: pc.destinatarios[0].token });
  ok(!semJanela.ok && semJanela.motivo === 'janela', '2a: Receber sem janela aberta → recusado');

  ok(!pecas.abrirEntrega(pc.numero, ESTRANHO).ok, '2b: estranho não abre a janela');
  const ab = pecas.abrirEntrega(pc.numero, JUIZ);
  ok(ab.ok && ab.minutos === 60, '2c: emissor abre a janela — padrão de 60 min');
  ok(pecas.janelaAberta(peca(pc.numero)), '2d: janela consta aberta');

  pecas.encerrarEntrega(pc.numero, JUIZ);
  const depoisEncerrar = pecas.receber(pc.numero, PROMOTOR, { tokenLido: pc.destinatarios[0].token });
  ok(!depoisEncerrar.ok && depoisEncerrar.motivo === 'janela', '2e: janela encerrada à mão → Receber recusado');

  // A janela vive no banco, não em setTimeout: sobrevive a restart (SPEC §15.17).
  pecas.abrirEntrega(pc.numero, JUIZ);
  const salva = peca(pc.numero).janela;
  ok(!!salva.expiraEm && new Date(salva.expiraEm).getTime() > Date.now(), '2f: horário-limite persistido no banco (sobrevive a restart)');
  ok(salva.aberturas === 2, '2g: cada reabertura é contada');
}

// ---------------------------------------------------------------------------
console.log('\n3) Recebimento com QR válido (SPEC §15.3)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(pc.numero, PROMOTOR);
  const r = pecas.receber(pc.numero, JUIZ, { tokenLido: pc.destinatarios[0].token, capturaUrl: 'http://cdn/captura.png' });
  ok(r.ok, '3a: QR válido dentro da janela → destrava');
  ok(r.destinatario.recebidoPorId === JUIZ && !!r.destinatario.recebidoEm, '3b: ato lavrado com quem recebeu e horário');
  ok(r.destinatario.recebidoComo === 'entrega pessoal', '3c: registrado como entrega pessoal');
  ok(r.destinatario.capturaUrl === 'http://cdn/captura.png', '3d: captura fica vinculada ao ato');
  ok(pecas.podeVerTeor(JUIZ, pc.numero) === true, '3e: agora o destinatário vê o teor');

  const reuso = pecas.receber(pc.numero, JUIZ, { tokenLido: pc.destinatarios[0].token });
  ok(!reuso.ok && reuso.motivo === 'ja_recebido', '3f: não recebe duas vezes');
}

// ---------------------------------------------------------------------------
console.log('\n4) Captura ilegível NÃO trava (SPEC §15.4, §15.5b)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Promotor' }],
  });
  pecas.abrirEntrega(pc.numero, JUIZ);

  let r;
  for (let i = 1; i <= 4; i++) r = pecas.receber(pc.numero, PROMOTOR, { tokenLido: null });
  ok(!r.ok && r.motivo === 'ilegivel', '4a: captura ilegível → recusa amigável');
  ok(/tire outra/i.test(r.razao), '4b: ...pedindo captura melhor');
  ok(!/dígito|digite|código/i.test(r.razao), '4c: ...e NENHUM campo de digitação é oferecido');
  ok(peca(pc.numero).destinatarios[0].travado === false, '4d: 4 ilegíveis não travaram nada');
  ok(!r.avisarStaff, '4e: ...e ainda não avisou a staff');

  r = pecas.receber(pc.numero, PROMOTOR, { tokenLido: null });
  ok(r.avisarStaff === true, '4f: na 5ª ilegível, avisa a staff');
  ok(peca(pc.numero).destinatarios[0].travado === false, '4g: ...mas NÃO trava — print ruim não é tentativa indevida');

  const bom = pecas.receber(pc.numero, PROMOTOR, { tokenLido: pc.destinatarios[0].token });
  ok(bom.ok, '4h: e a captura boa seguinte destrava normalmente');
}

// ---------------------------------------------------------------------------
console.log('\n5) Token inválido trava na 3ª (SPEC §15.5, §15.6, §15.7, §15.14)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Promotor' }],
  });
  pecas.abrirEntrega(pc.numero, JUIZ);

  const r1 = pecas.receber(pc.numero, PROMOTOR, { tokenLido: 'tk_falso' });
  ok(!r1.ok && r1.motivo === 'token_invalido' && !r1.travou, '5a: 1º token inválido → recusa, sem travar');
  pecas.receber(pc.numero, PROMOTOR, { tokenLido: 'tk_falso' });
  const r3 = pecas.receber(pc.numero, PROMOTOR, { tokenLido: 'tk_falso' });
  ok(r3.travou === true, '5b: na 3ª tentativa o selo trava');
  ok(pecas.podeVerTeor(PROMOTOR, pc.numero) === false, '5c: teor segue oculto após a trava');

  const travado = pecas.receber(pc.numero, PROMOTOR, { tokenLido: pc.destinatarios[0].token });
  ok(!travado.ok && travado.motivo === 'travado', '5d: mesmo com o token certo, travado recusa');

  ok(!pecas.destravarSelo(pc.numero, 'Promotor', DESEMB, '').ok, '5e: destravar exige motivo');
  const d = pecas.destravarSelo(pc.numero, 'Promotor', DESEMB, 'captura conferida com a staff');
  ok(d.ok && !d.destinatario.travado, '5f: desembargador destrava com motivo');
  ok(d.destinatario.destravadoMotivo === 'captura conferida com a staff', '5g: motivo registrado nos autos');
  ok(d.destinatario.token !== pc.destinatarios[0].token, '5h: o selo ganha token NOVO (o antigo pode ter vazado)');

  const depois = pecas.receber(pc.numero, PROMOTOR, { tokenLido: d.destinatario.token });
  ok(depois.ok, '5i: com o token novo, recebe normalmente');
}

// ---------------------------------------------------------------------------
console.log('\n6) Token de terceiro e papel errado (SPEC §15.7)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(pc.numero, PROMOTOR);
  const r = pecas.receber(pc.numero, ESTRANHO, { tokenLido: pc.destinatarios[0].token });
  ok(!r.ok && r.motivo === 'papel', '6a: quem não ocupa o papel é recusado, mesmo com o token certo');
  ok(peca(pc.numero).destinatarios[0].recusasToken === 0, '6b: ...e a tentativa dele não queima o contador do destinatário legítimo');
}

// ---------------------------------------------------------------------------
console.log('\n7) Advogado é habilitação específica, não a lista (correção do desenho)');
{
  const p = novoProcesso({
    habilitacoes: [
      { id: 1, advogadoId: ADV, reuId: 'reu1', status: 'Aprovado' },
      { id: 2, advogadoId: ADV2, reuId: 'reu2', status: 'Aprovado' },
    ],
    advogados: [ADV, ADV2],
  });
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor',
    destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
  });
  pecas.abrirEntrega(pc.numero, JUIZ);

  const outro = pecas.receber(pc.numero, ADV2, { tokenLido: pc.destinatarios[0].token });
  ok(!outro.ok && outro.motivo === 'papel', '7a: advogado da OUTRA parte não recebe a intimação que não é dele');
  ok(pecas.podeVerTeor(ADV2, pc.numero) === false, '7b: ...e não vê o teor');

  const certo = pecas.receber(pc.numero, ADV, { tokenLido: pc.destinatarios[0].token });
  ok(certo.ok, '7c: o advogado daquela habilitação recebe');

  const semHab = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Advogado' }],
  });
  ok(!semHab.ok, '7d: destinatário Advogado sem habilitacaoId é rejeitado na geração');

  // Habilitação revogada: ninguém ocupa, o ato fica pendente e a válvula resolve. Sem fallback.
  const p2 = novoProcesso({ habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r', status: 'Aprovado' }] });
  const { peca: pc2 } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p2.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
  });
  db.atualizar('processos', p2.numero, { habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r', status: 'Revogado' }] });
  pecas.abrirEntrega(pc2.numero, JUIZ);
  const revogado = pecas.receber(pc2.numero, ADV, { tokenLido: pc2.destinatarios[0].token });
  ok(!revogado.ok && revogado.motivo === 'papel', '7e: habilitação revogada → ninguém ocupa, ninguém recebe');
  ok(pecas.ocupanteAtual('processos', recarregar(p2.numero), { papel: 'Advogado', habilitacaoId: 1 }) === null, '7f: ...o slot fica vago, sem fallback inventado');
}

// ---------------------------------------------------------------------------
console.log('\n8) Dois destinatários, um token cada (SPEC §15.21)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'decisao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor',
    destinatarios: [{ papel: 'Promotor' }, { papel: 'Advogado', habilitacaoId: 1 }],
  });
  db.atualizar('processos', p.numero, { habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r', status: 'Aprovado' }] });
  pecas.abrirEntrega(pc.numero, JUIZ);
  const [dPromotor, dAdv] = pc.destinatarios;
  ok(dPromotor.token !== dAdv.token, '8a: cada destinatário tem seu próprio token');

  const cruzado = pecas.receber(pc.numero, PROMOTOR, { tokenLido: dAdv.token });
  ok(!cruzado.ok && cruzado.motivo === 'token_invalido', '8b: o promotor não recebe com o token do advogado');

  pecas.receber(pc.numero, PROMOTOR, { tokenLido: dPromotor.token });
  ok(peca(pc.numero).destinatarios.filter(d => d.recebidoEm).length === 1, '8c: um recebeu, o outro segue pendente');
  ok(pecas.podeVerTeor(ADV, pc.numero) === false, '8d: quem ainda não recebeu continua sem ver');
  pecas.receber(pc.numero, ADV, { tokenLido: dAdv.token });
  ok(peca(pc.numero).destinatarios.every(d => d.recebidoEm), '8e: o ato só se cumpre por inteiro quando todos receberam');
}

// ---------------------------------------------------------------------------
console.log('\n9) Válvula de 24h (SPEC §15.8)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  ok(pecas.varrerValvula({ agora: Date.now() + 23 * 60 * MIN }).length === 0, '9a: às 23h ainda não destrava');

  const destravadas = pecas.varrerValvula({ agora: Date.now() + 25 * 60 * MIN });
  ok(destravadas.some(d => d.peca === pc.numero), '9b: passadas 24h, destrava sozinho');
  const d = peca(pc.numero).destinatarios[0];
  ok(d.automatico === true, '9c: marcado como automático');
  ok(/cartório/i.test(d.recebidoComo), '9d: lavrado como distribuição automática pelo cartório');
  ok(d.recebidoPorId === null, '9e: ...sem atribuir o recebimento a ninguém');
  ok(pecas.podeVerTeor(JUIZ, pc.numero) === true, '9f: e o juiz passa a ver o teor');
}

// ---------------------------------------------------------------------------
console.log('\n10) Troca de responsável (SPEC §15.15, §15.16)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(pc.numero, PROMOTOR);

  ok(pecas.pendentesDoPapel('processos', p.numero, 'Juiz').length === 1, '10a: o substituto vê a lista do que herdou');

  // Troca de juiz — nada é regenerado, o token continua o mesmo.
  db.atualizar('processos', p.numero, { juiz: JUIZ2 });
  const valvulaAntes = peca(pc.numero).destinatarios[0].valvulaEm;
  pecas.reiniciarValvulaPorTroca('processos', p.numero, 'Juiz', { agora: Date.now() + 10 * MIN });
  ok(peca(pc.numero).destinatarios[0].valvulaEm > valvulaAntes, '10b: a válvula reinicia na troca');

  const antigo = pecas.receber(pc.numero, JUIZ, { tokenLido: pc.destinatarios[0].token });
  ok(!antigo.ok && antigo.motivo === 'papel', '10c: o juiz ANTERIOR não recebe mais');
  const novo = pecas.receber(pc.numero, JUIZ2, { tokenLido: pc.destinatarios[0].token });
  ok(novo.ok, '10d: o substituto recebe com o MESMO token, sem regenerar nada');

  // Depois do recebimento, troca de novo: o terceiro juiz enxerga o teor por papel.
  db.atualizar('processos', p.numero, { juiz: 'id_juiz_3' });
  ok(pecas.podeVerTeor('id_juiz_3', pc.numero) === true, '10e: juiz seguinte enxerga o teor (visibilidade por papel, não por ID)');
  ok(pecas.podeVerTeor(JUIZ2, pc.numero) === false, '10f: ...e quem saiu do papel deixa de ver');
}

// ---------------------------------------------------------------------------
console.log('\n11) Recebimento é irreversível e sentença abre tudo (SPEC §15.11, §15.18)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(pc.numero, PROMOTOR);
  pecas.receber(pc.numero, JUIZ, { tokenLido: pc.destinatarios[0].token });

  db.atualizar('processos', p.numero, { status: 'Aguardando defesa' });
  ok(pecas.podeVerTeor(JUIZ, pc.numero) === true, '11a: voltar fase NÃO re-trava o que já foi recebido');

  ok(pecas.podeVerTeor(ADV, pc.numero) === false, '11b: antes da sentença, advogado não vê');
  db.atualizar('processos', p.numero, {
    status: 'Encerrado', sentenca: 'julgo procedente',
    habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r', status: 'Aprovado' }],
  });
  ok(pecas.podeVerTeor(ADV, pc.numero) === true, '11c: após a sentença, todos os habilitados veem tudo');
  ok(pecas.podeVerTeor(ESTRANHO, pc.numero) === false, '11d: ...mas quem não é do processo continua fora');
}

// ---------------------------------------------------------------------------
console.log('\n12) Modo carimbado no processo (SPEC §11.2)');
{
  const legado = novoProcesso({ modoEntrega: undefined });
  ok(pecas.modoDoProcesso(recarregar(legado.numero)) === 'legado', '12a: registro sem o campo é legado (sem migração)');

  const aberto = novoProcesso({ modoEntrega: 'aberto' });
  const { peca: pcAberto } = pecas.gerar({
    processoTabela: 'processos', processoNumero: aberto.numero, tipo: 'peticao_inicial_penal',
    autorId: PROMOTOR, autorPapel: 'Promotor', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  ok(pcAberto.gated === false, '12b: modo aberto gera peça SEM gate');
  ok(pcAberto.digitos === null && pcAberto.destinatarios[0].token === null, '12c: ...sem selo nem token');
  ok(!!pcAberto.destinatarios[0].recebidoEm, '12d: ...e nasce recebida');
  ok(pecas.podeVerTeor(JUIZ, pcAberto.numero) === true, '12e: visível às partes desde a criação');
  ok(/modo aberto/.test(pcAberto.destinatarios[0].recebidoComo), '12f: os autos registram que NÃO houve entrega pessoal');

  // Trocar o interruptor não pode mexer em processo que já está correndo.
  const ingame = novoProcesso();
  const { peca: pcIngame } = pecas.gerar({
    processoTabela: 'processos', processoNumero: ingame.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Promotor' }],
  });
  ok(pcIngame.gated === true && pecas.podeVerTeor(PROMOTOR, pcIngame.numero) === false, '12g: processo ingame segue gated');
}

// ---------------------------------------------------------------------------
console.log('\n13) Janela configurável (SPEC §6.2)');
{
  const casos = [['', 60], ['30', 30], ['120', 120], ['10', 10], ['5', 60], ['9999', 60], ['abc', 60], ['0', 60]];
  for (const [valor, esperado] of casos) {
    if (valor === '') delete process.env.JANELA_ENTREGA_MIN; else process.env.JANELA_ENTREGA_MIN = valor;
    ok(pecas.janelaMinutos() === esperado, `13: JANELA_ENTREGA_MIN="${valor}" → ${esperado} min`);
  }
  delete process.env.JANELA_ENTREGA_MIN;
}

// ---------------------------------------------------------------------------
console.log('\n14) Processo arquivado limpa janelas órfãs (SPEC §11.4)');
{
  const p = novoProcesso();
  const { peca: pc } = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Promotor' }],
  });
  pecas.abrirEntrega(pc.numero, JUIZ);
  const fechadas = pecas.fecharJanelasDoProcesso('processos', p.numero);
  ok(fechadas.includes(pc.numero), '14a: arquivar fecha as janelas pendentes');
  ok(!pecas.janelaAberta(peca(pc.numero)), '14b: ...e não sobra estado órfão');
  ok(!peca(pc.numero).destinatarios[0].recebidoEm, '14c: ...sem marcar nada como recebido');
}

// ---------------------------------------------------------------------------
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
