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

// `staff: true` faz isAdmin passar — é como os gates de cargo (ehMembroDoMp, etc.) são satisfeitos
// sem montar o RH inteiro. `channel` existe para o caminho LEGADO, que espera um upload: sem ele
// aguardarAnexoPDF estoura em vez de simplesmente não abrir modal.
function fakeInteraction(userId, { values = [], campos = {}, staff = false } = {}) {
  const rec = { replies: [], modais: [], sends: [] };
  return {
    rec,
    user: { id: userId },
    values,
    channel: { awaitMessages: async () => { throw new Error('sem upload no teste'); } },
    member: { roles: { cache: { has: () => false } }, permissions: { has: () => !!staff } },
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


console.log('\n8) UNIDADE do documento vem do PROCESSO, não do catálogo');
{
  // O catálogo trazia 'Vara Criminal' fixo nos dois tipos — e como a petição incidental também roda
  // em processo CÍVEL, toda petição cível saía com a vara errada impressa, visível ao jogador.
  const emissao = require('../utils/emissaoPeca');
  ok(/Criminal/.test(emissao.unidadeDoProcesso({ tipo: 'Penal' })), '8a: processo Penal → Vara Criminal');
  ok(/C[íi]vel/.test(emissao.unidadeDoProcesso({ tipo: 'Civil' })), '8b: processo Civil → Vara Cível (era o erro visível ao jogador)');
  ok(Object.values(emissao.TIPOS).every(t => !t.unidade), '8c: o catálogo NÃO carrega mais unidade — ele descreve o ATO, a vara é do processo');
}

console.log('\n9) OS DOIS "RECEBIMENTOS" SÃO COISAS DIFERENTES — e não podem virar uma só');
{
  // Existem dois "recebimentos" no penal, e confundi-los é inaceitável:
  //
  //   RECEBIMENTO DO PAPEL  — o gate. O juiz escaneia o QR e fica provado que o documento chegou
  //                            às mãos dele. Libera LER o teor. Só isso.
  //   RECEBIMENTO DA DENÚNCIA — ato JUDICIAL. O juiz aceita (ou rejeita) a acusação. É decisão de
  //                            mérito, tomada depois, num ato próprio.
  //
  // Se acoplarem, o juiz passa a aceitar acusação sem decidir nada — basta escanear um QR. Este
  // teste existe porque "está garantido por construção" é exatamente como o acoplamento aparece
  // três features depois, por conveniência de alguém.
  const p = db.inserir('processos', {
    numero: '0399PN', tipo: 'Penal', status: 'Denúncia oferecida - aguardando juiz', modoEntrega: 'ingame',
    juiz: JUIZ, promotor: '100000000000000009', habilitacoes: [], partes: [], canalId: 'c1',
  });
  const antes = { ...db.buscarPorNumero('processos', p.numero) };

  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
    autorId: '100000000000000009', autorPapel: 'Promotor', texto: 'Denúncia oferecida.',
    destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(g.peca.numero, '100000000000000009');
  const token = db.buscarPorNumero('pecas', g.peca.numero).destinatarios[0].token;
  const r = pecas.receber(g.peca.numero, JUIZ, { tokenLido: token });

  ok(r.ok, '9a: o juiz recebe o documento pelo gate (QR válido, janela aberta, papel certo)');
  ok(pecas.podeVerTeor(JUIZ, g.peca.numero) === true, '9b: ...e passa a poder LER o teor — é só isso que o gate libera');

  const depois = db.buscarPorNumero('processos', p.numero);
  ok(depois.status === antes.status,
    '9c: o STATUS DO PROCESSO não mudou — escanear QR não é aceitar denúncia', `${antes.status} → ${depois.status}`);
  ok(!depois.sentenca && !depois.resultado,
    '9d: nenhuma decisão de mérito foi tomada pelo recebimento do papel');
  ok(!/denunciaRecebida|acusacaoAceita/.test(JSON.stringify(depois)),
    '9e: nenhum campo de aceitação da acusação foi criado como efeito colateral');

  // O lado inverso: o gate também não pode DEPENDER de decisão judicial. Se um dia alguém exigir
  // "só recebe o papel se a denúncia já foi aceita", trava o processo — a aceitação vem depois.
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'pecas.js'), 'utf-8');
  const corpoReceber = src.slice(src.indexOf('function receber('), src.indexOf('function destravarSelo('));
  ok(!/status/.test(corpoReceber),
    '9f: pecas.receber não lê nem escreve status de processo — as duas decisões vivem separadas');
  ok(corpoReceber.length > 500, '9z: o trecho analisado é o corpo real da função (o scan não passou vazio)');
}

console.log('\n10) DEFENSOR DATIVO enxerga sem cena (exceção da SPEC §11.1 e §6.2)');
{
  // O dativo é nomeado pelo BOT quando passam 48h sem advogado constituído (utils/prazos.js,
  // nomearDefensorDativo — verificado que EXISTE antes de implementar a exceção). Fazê-lo esperar
  // uma cena para poder LER anula o propósito do sorteio: o réu voltaria a ficar sem defesa
  // efetiva, agora com um defensor nomeado que não consegue ver a acusação.
  const DAT = '200000000000000001', CONST = '200000000000000002';
  const p = db.inserir('processos', {
    numero: '0900PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame', juiz: JUIZ,
    habilitacoes: [
      { id: 1, advogadoId: DAT, status: 'Aprovado', dativo: true },
      { id: 2, advogadoId: CONST, status: 'Aprovado' },
    ],
  });
  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
    autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor',
    destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }, { papel: 'Advogado', habilitacaoId: 2 }],
  });

  ok(pecas.podeVerTeor(DAT, g.peca.numero) === true, '10a: dativo enxerga o teor SEM entrega — destrava ao ser nomeado');
  // O escopo é estreito de propósito: a exceção é do DATIVO, não de "todo advogado habilitado".
  ok(pecas.podeVerTeor(CONST, g.peca.numero) === false,
    '10b: advogado CONSTITUÍDO continua precisando receber em cena — a exceção não vazou para o caso geral');
}

console.log('\n11) BLOCO D — CAMINHO DE ENTRADA de cada tipo novo (o que faltava nos 5 órfãos)');
{
  // Tipo no catálogo NÃO é feature pronta. Os cinco órfãos deste projeto estavam todos no catálogo,
  // ativos e testados — faltava alguém CHEGAR neles. Cada caso abaixo parte do clique real.
  const emissao = require('../utils/emissaoPeca');
  const PROM = '400000000000000001', DELE = '400000000000000002', ADV2 = '400000000000000003';

  for (const t of ['denuncia_mp', 'manifestacao_mp_gated', 'contestacao', 'relatorio_inquerito']) {
    ok(emissao.tipoAtivo(t), `11-cat-${t}: está no catálogo e ativo`);
  }

  // 11a — RELATÓRIO DE INQUÉRITO: Delegado, botão "Anexar relatório".
  const pPenal = db.inserir('processos', {
    numero: '0910PN', tipo: 'Penal', status: 'Aguardando decisão do MP', modoEntrega: 'ingame',
    delegado: DELE, promotor: PROM, habilitacoes: [], partes: [], canalId: 'c1',
  });
  const iDel = fakeInteraction(DELE);
  await processoCmd.anexarRelatorioInquerito(iDel, pPenal.numero);
  ok(iDel.rec.modais.length === 1, '11a: Delegado clica "Anexar relatório" → abre o formulário gated (não o anexo de PDF)');

  // 11b — DENÚNCIA: Promotor, pelo menu de manifestação do MP.
  const iProm = fakeInteraction(PROM, { values: ['oferecer'], staff: true });
  await processoCmd.tratarManifestacaoMp(iProm, pPenal.numero);
  ok(iProm.rec.modais.length === 1, '11b: Promotor escolhe "Oferecer denúncia" → formulário gated');

  // 11c — ARQUIVAMENTO continua no fluxo antigo: é ato interno do MP, sem destinatário a quem
  // entregar. Gatear criaria peça pendente até a válvula sem nunca ter tido dono.
  const iArq = fakeInteraction(PROM, { values: ['arquivar'], staff: true });
  await processoCmd.tratarManifestacaoMp(iArq, pPenal.numero);
  ok(iArq.rec.modais.length === 1, '11c: arquivamento ainda abre modal (fluxo próprio, não gated)');

  // 11d — MANIFESTAÇÃO LIVRE: é a que tem teor, então é a que entra no gate.
  const pComJuiz = db.inserir('processos', {
    numero: '0911PN', tipo: 'Penal', status: 'Instrução', modoEntrega: 'ingame',
    juiz: JUIZ, promotor: PROM, habilitacoes: [], partes: [], canalId: 'c1',
  });
  const iLivre = fakeInteraction(PROM, { values: ['livre'], staff: true });
  await processoCmd.tratarManifestacaoMp(iLivre, pComJuiz.numero);
  ok(iLivre.rec.modais.length === 1, '11d: manifestação livre do MP → formulário gated');

  // 11e — CONTESTAÇÃO: advogado habilitado, pelo botão que ele já usa.
  const pCiv = db.inserir('processos', {
    numero: '0912CV', tipo: 'Civil', status: 'Aguardando contestação', modoEntrega: 'ingame',
    juiz: JUIZ, advogados: [ADV2], habilitacoes: [{ id: 1, advogadoId: ADV2, status: 'Aprovado' }],
    partes: [], canalId: 'c1',
  });
  const iCont = fakeInteraction(ADV2);
  await processoCmd.anexarContestacao(iCont, `${pCiv.numero}#1`);
  ok(iCont.rec.modais.length === 1, '11e: advogado clica "Anexar contestação" → formulário gated com título próprio');

  // 11f — LEGADO INTOCADO: o rito não muda no meio dos autos (SPEC §11.2.1).
  const pLeg = db.inserir('processos', {
    numero: '0913PN', tipo: 'Penal', status: 'Aguardando decisão do MP',
    delegado: DELE, promotor: PROM, habilitacoes: [], partes: [], canalId: 'c1',
  });
  const iLeg = fakeInteraction(DELE);
  await processoCmd.anexarRelatorioInquerito(iLeg, pLeg.numero).catch(() => {});
  ok(iLeg.rec.modais.length === 0, '11f: processo LEGADO não abre o formulário — segue no anexo de PDF');
}

console.log('\n12) BLOCO E — a SENTENÇA está no catálogo e o teor não vaza pelas outras portas');
{
  const emissao = require('../utils/emissaoPeca');
  ok(emissao.tipoAtivo('sentenca'), '12a: sentença está no catálogo e ativa');
  ok(emissao.TIPOS.sentenca.destinatarios.includes('Advogado'),
    '12b: destinatário é o ADVOGADO de cada parte — um token por habilitação (SPEC §11.3)');
  ok(!emissao.TIPOS.acordao, '12c: acórdão ficou FORA de propósito — emissor mora em `apelacoes` e destinatários em `processos`');

  // As três portas por onde a sentença vazava, todas condicionadas ao modo agora.
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
  // lastIndexOf no fim: `postarOuAtualizarCapaPublica` também é chamado na ABERTURA do cível, muito
  // antes no arquivo — indexOf pegava aquela e devolvia fatia vazia. Foi o canário 12z que pegou.
  const trecho = src.slice(src.indexOf('const sentencaGated ='), src.lastIndexOf('await postarOuAtualizarCapaPublica(interaction.guild, numero)'));
  ok(trecho.length > 800, '12z: o trecho analisado é o corpo real do julgamento (o scan não passou vazio)');

  ok(/if \(!sentencaGated\) \{\s*try \{\s*await diario\.publicarNoDiario/.test(trecho),
    '12d: DIÁRIO não recebe sentença em processo gated (política cancelada — se o resultado é público, ninguém procura o juiz)');
  ok(/tipo === 'Penal' && !sentencaGated/.test(trecho),
    '12e: devolutiva à Polícia Civil também não sai no gated (seria segunda porta do teor)');
  ok(/const anexoUrlSentenca = null/.test(trecho),
    '12f: URL de anexo não é mais guardada (SPEC §3.7 — link do CDN expira em 24h e vira link morto)');
  ok(/canal && !sentencaGated\) await canais\.arquivarCanal/.test(trecho),
    '12g: canal NÃO é arquivado no gated — arquivar antes da entrega trancaria a sentença para sempre');
  ok(/restrito até a entrega pessoal/.test(trecho), '12h: o canal recebe metadado, não o teor');
}

console.log('\n13) §6.2 — a válvula reinicia na troca de responsável (era o SEXTO órfão)');
{
  // `pecas.reiniciarValvulaPorTroca` existia, testado, e NUNCA era chamado: a regra da SPEC §7 não
  // valia em produção. O substituto herdava um caso cuja válvula já estava correndo e que podia
  // destravar sozinho em minutos — a cena nunca aconteceria e ninguém saberia por quê.
  const resp = fs.readFileSync(path.join(__dirname, '..', 'utils', 'responsaveis.js'), 'utf-8');
  ok(/reiniciarValvulaPorTroca\(tabela, numero, papel\)/.test(resp),
    '13a: a troca de responsável AGORA chama o reinício da válvula (caminho de produção existe)');
  const corpo = resp.slice(resp.indexOf('async function trocarManual'), resp.indexOf('function componentesPendencia'));
  ok(corpo.length > 500, '13z: o trecho analisado é o corpo real de trocarManual (não passou vazio)');
  ok(/reiniciarValvulaPorTroca/.test(corpo), '13b: ...e a chamada está DENTRO de trocarManual, não solta no arquivo');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
