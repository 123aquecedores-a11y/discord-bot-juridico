/* eslint-disable */
// A PORTA ÚNICA DO MINISTÉRIO PÚBLICO (20/08/2026). Rode com:
//   node scripts/testes-hub-mp-cautelar.js
//
// O QUE MUDOU: o MP tinha quatro portas dentro do processo — botão "Solicitar medida", opção
// "Requerer cautelar", "Oferecer denúncia" e "Promover arquivamento", estas duas num select "Ato do
// MP nesta fase". Duas delas caíam FORA do gate (executarParecerMp despeja teor+PNG direto no
// canal). Agora há UMA: "Manifestação do MP", que abre direto o rascunho, o promotor NOMEIA o
// documento em texto livre, e sai uma peça `manifestacao_mp_gated` selada, entregue em cena.
//
// A classificação que o select pedia não é do promotor: quem lê o teor e decide o que fazer é o
// Juiz, com as ferramentas do processo penal que já existem.
//
// AS TRÊS COISAS QUE ESTE ARQUIVO GUARDA:
//   1. o Juiz tem caminho PRÓPRIO para expedir mandado (senão remover o pedido do MP o deixaria
//      sem saída — foi a verificação obrigatória antes da remoção);
//   2. nenhum caminho do MP chega mais ao módulo antigo de cautelar NEM ao parecer não-gated;
//   3. o processo penal aberto pelo MP volta a ganhar Juiz — pela PRIMEIRA manifestação recebida.
//      Sem esse elo, o processo ficava em 'Aguardando decisão do MP' para sempre (mapeamento de
//      20/08/2026: nenhuma das seis portas de designação alcançava esse status).

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
const emissao = require('../utils/emissaoPeca');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

// Um corpo de função, do cabeçalho até a primeira chave de fechamento na coluna zero, SEM as
// linhas de comentário. Sem tirar comentário, uma asserção casa com a explicação em vez do código
// — já aconteceu três vezes neste projeto.
//
// `\r?\n` e NÃO '\n}\n' literal: o repo roda em Windows e o git entrega CRLF. Com a busca literal
// o corte não achava nada, o corpo virava o ARQUIVO INTEIRO, e toda asserção positiva passava por
// acidente. Por isso os canários abaixo cobram TETO além de piso.
function corpoDe(fonte, cabecalho) {
  const i = fonte.indexOf(cabecalho);
  if (i < 0) return '';
  const resto = fonte.slice(i);
  const fim = resto.search(/\r?\n\}\r?\n/);
  return resto.slice(0, fim < 0 ? resto.length : fim)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}
// Piso E teto: um corpo que virou o arquivo inteiro reprova, em vez de dar confiança falsa.
const recortado = (corpo, teto = 3000) => corpo.length > 150 && corpo.length < teto;

const PROMOTOR = '180000000000000001';
const JUIZ = '180000000000000002';
const ESTRANHO = '180000000000000003';
rh.contratar(PROMOTOR, 'Promotor', 'Promotor');
rh.contratar(JUIZ, 'Juiz', 'Juiz');

const PROC = LER('commands', 'processo.js');
const PAINEL = LER('commands', 'painel.js');
const MANDADO = LER('commands', 'mandado.js');
const MEDIDA = LER('commands', 'medida.js');

console.log('\n=== Porta única do Ministério Público ===\n');

// ---------------------------------------------------------------------------
console.log('1) VERIFICAÇÃO OBRIGATÓRIA — o Juiz expede mandado sem depender do MP');
// ---------------------------------------------------------------------------
{
  ok(PROC.length > 10000 && MANDADO.length > 5000 && PAINEL.length > 10000,
    '1z: os três arquivos foram lidos (scan não vazio)');

  const hubJuiz = PROC.slice(PROC.indexOf("id: 'hubjuiz'"), PROC.indexOf("id: 'hubmp'"));
  ok(hubJuiz.length > 100, '1z2: o bloco do hub do Juiz foi localizado');
  ok(/'emitir_mandado'/.test(hubJuiz), '1a: "Emitir mandado" está no hub do Juiz');

  const iEntrada = PROC.indexOf("id: 'emitir_mandado'");
  ok(iEntrada > 0, '1z3: a entrada do catálogo foi localizada');
  const entrada = PROC.slice(iEntrada, iEntrada + 300);
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
    'async function emitirMandadoComFundamentacao',
    'async function emitirMandadoNoProcesso',
  ];
  for (const cab of cadeia) {
    const nome = cab.replace(/^(async )?function /, '').replace('(', '');
    const corpo = corpoDe(MANDADO, cab);
    ok(corpo.length > 40 && corpo.length < 4000, `1d-z (${nome}): o corpo foi RECORTADO`, `${corpo.length} chars`);
    ok(!/'medidas'|solicitacao_medida|abrirSolicitarMedidaDireta|medidaCmd/.test(corpo),
      `1d (${nome}): não lê medida nem depende de uma`);
  }

  ok(/setCustomId\(`painel:acao:mandado:emitir:\$\{numero\}`\)/.test(MANDADO),
    '1e: o botão do Juiz tem customId próprio');
  ok(/acao === 'emitir'\) return mandadoCmd\.abrirSelectTipo/.test(PAINEL), '1f: e o painel o roteia');
  ok(/emitirMandadoNoProcesso/.test(MEDIDA),
    '1g: o mandado nascido de medida continua existindo — são dois caminhos, não um');

  console.log('  -> VERIFICAÇÃO: o Juiz tem caminho independente. Remover as portas do MP é seguro.');
}

// ---------------------------------------------------------------------------
console.log('\n2) UMA PORTA SÓ — as outras três sumiram');
// ---------------------------------------------------------------------------
{
  const hubMp = PROC.slice(PROC.indexOf("id: 'hubmp'"), PROC.indexOf("id: 'hubadvogado'"));
  ok(hubMp.length > 100, '2z: o bloco do hub do MP foi localizado (scan não vazio)');
  const acoes = (hubMp.match(/acoes: \[([^\]]*)\]/) || [])[1] || '';
  ok(acoes.length > 10, '2z2: a lista de ações foi extraída', acoes);

  ok(/manifestacao_mp/.test(acoes), '2a: "Manifestação do MP" ficou');
  ok(/registrar_depoimento/.test(acoes), '2b: "Registrar depoimento" ficou');
  ok(/anexar_prova/.test(acoes), '2c: "Anexar prova" ficou');
  ok(!/solicitar_medida/.test(acoes), '2d: "Solicitar medida" não está mais no hub', acoes);
  // Sair da lista não basta: a entrada do catálogo também saiu, senão fica ação órfã — o padrão
  // que já mordeu este projeto seis vezes (função viva sem caminho de produção).
  ok(!/id: 'solicitar_medida'/.test(PROC), '2e: e a entrada do CATALOGO_ACOES saiu junto');

  // O SELECT INTEIRO morreu. Com ele, as opções "Oferecer denúncia", "Promover arquivamento" e
  // "Requerer medida cautelar".
  const abrir = corpoDe(PROC, 'async function abrirManifestacaoMp');
  ok(recortado(abrir), '2z3: o corpo de abrirManifestacaoMp foi RECORTADO', `${abrir.length} chars`);
  ok(!/StringSelectMenuBuilder/.test(abrir), '2f: a porta não abre mais um select de atos');
  for (const [rotulo, alvo] of [['Oferecer denúncia', "value: 'oferecer'"], ['Promover arquivamento', "value: 'arquivar'"], ['Requerer medida cautelar', "value: 'medida'"]]) {
    ok(!abrir.includes(alvo) && !abrir.includes(rotulo), `2g-${alvo}: "${rotulo}" saiu do menu`);
  }

  // NENHUM caminho do MP alcança o módulo antigo de cautelar. Varredura pelo ARQUIVO INTEIRO, não
  // por função: é a afirmação que o operador pediu por escrito, e ela só vale se for global.
  const semComentarioProc = PROC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(semComentarioProc.length > 10000, '2z4: o processo.js sem comentários foi montado (scan não vazio)');
  ok(!/abrirSolicitarMedidaDireta|botaoSolicitarMedidaDireta/.test(semComentarioProc),
    '2h: processo.js não chama mais o módulo antigo de cautelar em lugar nenhum');
  // O handler `oferecer()` (processo:oferecer -> modalParecerMp -> executarParecerMp) FICA de pé,
  // por decisão do operador: pareceres já em curso precisam terminar. O que este teste garante é
  // que ele ficou SEM PORTA — nenhuma linha viva do MP o alcança. Prova em três pontos:
  //   (i) `abrirManifestacaoMp`/`tratarManifestacaoMp` não chamam o parecer (abaixo);
  //   (ii) nenhum hub renderiza oferecer_denuncia/arquivar_mp (testes-anexos-em-canal, 5a3/5a4);
  //   (iii) nenhum painel monta o customId `processo:oferecer` (seção 7 deste arquivo).
  const tratar = corpoDe(PROC, 'async function tratarManifestacaoMp');
  ok(tratar.length > 20, '2z5: tratarManifestacaoMp foi localizada', `${tratar.length} chars`);
  ok(!/modalParecerMp|executarParecerMp/.test(abrir) && !/modalParecerMp|executarParecerMp/.test(tratar),
    '2i: nenhuma das duas portas do MP chama o parecer não-gated');
  ok(/abrirManifestacaoMp\(interaction, numero\)/.test(tratar),
    '2j: o select antigo, se algum cliente ainda tiver um aberto, cai na porta única');
}

// ---------------------------------------------------------------------------
console.log('\n3) O FLUXO ÚNICO — título livre, trechos, documento opcional, tudo gated');
// ---------------------------------------------------------------------------
{
  const cfg = emissao.TIPOS.manifestacao_mp_gated;
  ok(!!cfg && cfg.ativo, '3a: o tipo manifestacao_mp_gated está ativo');
  ok(cfg.emissor === 'Promotor', '3b: emitido pelo Promotor');
  ok(JSON.stringify(cfg.destinatarios) === '["Juiz"]', '3c: dirigido ao Juiz');
  ok(cfg.tituloLivre === true, '3d: com nomenclatura escolhida por quem escreve');
  ok(cfg.documentoOpcional === true, '3e: e documento opcional');
  ok(!cfg.semPeca, '3f: vira PEÇA — selo e entrega em cena');
  // Brasão: o gerador decide por regex sobre `orgao`, então o que este teste guarda é o `orgao`.
  ok(/minist/i.test(cfg.orgao), '3g: órgão do MP — é o que faz o gerador escolher o brasão do MPSP', cfg.orgao);

  const EMISSAO = LER('utils', 'emissaoPeca.js');
  ok(EMISSAO.length > 10000, '3z: emissaoPeca.js foi lido (scan não vazio)');
  // Título livre só no PRIMEIRO trecho: a continuação é do MESMO documento.
  ok(/if \(cfg\.tituloLivre && n === 1\)/.test(EMISSAO), '3h: o campo de título só aparece no trecho 1');
  ok(/setCustomId\('tituloLivre'\)/.test(EMISSAO), '3i: como campo próprio do modal');
  // REUSO, não caminho paralelo: o rascunho é o mesmo componente de sempre.
  const corpoAnexo = corpoDe(EMISSAO, 'async function anexarAoRascunho');
  ok(recortado(corpoAnexo, 4000), '3z2: anexarAoRascunho foi RECORTADA', `${corpoAnexo.length} chars`);
  ok(/aguardarAnexos/.test(corpoAnexo), '3j: o anexo reusa a janela de upload que já existia');
  ok(/criarDocumento/.test(EMISSAO), '3k: e a juntada aos autos usa anexos.criarDocumento');

  // O TÍTULO É RÓTULO — nenhuma regra o lê. Se alguém rotear por ele um dia, isto quebra.
  ok(!/rascunho\.tituloLivre ===|tituloLivre ===|tituloLivre\.includes|tituloLivre\.match/.test(EMISSAO),
    '3l: nada compara o título com nada — é rótulo, não roteamento');

  // As DUAS vias do arquivo único leem o mesmo campo. Divergir aqui é o defeito da SPEC §3.7.
  ok(/titulo: peca\.tituloLivre \|\| cfg\.titulo/.test(EMISSAO), '3m: o PNG da DM usa o título escolhido');
  ok(/titulo: dados\.tituloLivre \|\| cfg\.titulo/.test(LER('services', 'servidorPecas.js')),
    '3n: e a página impressa no jogo também — as duas vias não divergem');
}

// ---------------------------------------------------------------------------
console.log('\n4) O DELEGADO ESTÁ INTACTO — só as portas do MP saíram');
// ---------------------------------------------------------------------------
{
  // A maquinaria de medida NÃO foi arrancada: o ticket do Delegado, a reconsideração, o referendo
  // e o cumprimento continuam inteiros. O que sumiu foram as entradas do MP.
  for (const fn of ['solicitarMedida', 'abrirSolicitarMedidaDireta', 'deferirMedidaDireta', 'indeferirMedidaDireta']) {
    ok(typeof medidaCmd[fn] === 'function', `4a-${fn}: continua exportada`);
  }
  ok(/gateBloqueia: \(interaction, medida\) => interaction\.user\.id !== medida\.delegado/.test(MEDIDA),
    '4b: a reconsideração do Delegado segue com o gate dele');
  ok(/Só o Delegado que solicitou esta medida pode anexar os indícios/.test(MEDIDA),
    '4c: e a juntada de indícios também');
  ok(/async function solicitarMedida\(/.test(MEDIDA), '4d: o ticket clássico do Delegado segue de pé');
  // A ABERTURA de medida pelo MP foi APOSENTADA em 20/08/2026 — botão, selects e submissão do modal
  // saíram de painel.js. `abrirSolicitarMedidaDireta` continua exportada só para não quebrar quem a
  // importa; nenhuma rota chega nela. A DECISÃO continua viva (deferir/indeferir), porque medidas
  // já pedidas precisam de desfecho.
  ok(!/if \(acao === 'solicitardireta'\) return medidaCmd\.abrirSolicitarMedidaDireta/.test(PAINEL),
    '4e: a abertura de medida pelo MP não é mais roteada');
  ok(/Este fluxo foi aposentado/.test(PAINEL),
    '4e2: e quem clicar num botão sobrevivente recebe a explicação, não um erro mudo');
  ok(!/campo === 'tipodireta'|campo === 'destinatariodireta'/.test(PAINEL),
    '4e3: os selects do meio da cadeia saíram junto — nada leva a meio caminho');
  ok(!/acao === 'solicitardireta'\) return medidaCmd\.criarSolicitacaoMedidaDireta/.test(PAINEL),
    '4e4: e a submissão do modal também');

  // Medidas JÁ pedidas precisam continuar decidíveis: remover ESTAS rotas deixaria pedidos
  // pendentes sem desfecho possível. Aposentar a abertura não é o mesmo que estrangular o curso.
  ok(/acao === 'deferirdireta'\) return medidaCmd\.deferirMedidaDireta/.test(PAINEL),
    '4f: o deferimento do Juiz continua roteado');
  ok(/acao === 'indeferirdireta'\) return medidaCmd\.indeferirMedidaDireta/.test(PAINEL),
    '4g: e o indeferimento também');

  // O hub do Delegado não foi tocado.
  const hubDel = PROC.slice(PROC.indexOf("id: 'hubdelegado'"), PROC.indexOf("id: 'hubdelegado'") + 400);
  ok(hubDel.length > 100, '4z: o bloco do hub do Delegado foi localizado');
  ok(/'identificar_reu'/.test(hubDel) && /'anexar_relatorio'/.test(hubDel),
    '4h: as ações do Delegado seguem as mesmas');
}

// ---------------------------------------------------------------------------
console.log('\n5) O JUIZ GANHOU VOZ — arquivar com razões, e despachar nos autos');
// ---------------------------------------------------------------------------
{
  const hubJuiz = PROC.slice(PROC.indexOf("id: 'hubjuiz'"), PROC.indexOf("id: 'hubmp'"));
  ok(/'despachar'/.test(hubJuiz), '5a: "Manifestar-se nos autos" está no hub do Juiz');
  ok(/'arquivar_manual'/.test(hubJuiz), '5b: e "Arquivar" continua lá');

  // ARQUIVAR não é mais um clique: passa pelo rascunho de razões.
  ok(/painel:acao:processo:arquivarcomrazoes:\$\{numero\}/.test(PROC),
    '5c: o botão de arquivar aponta para o fluxo de RAZÕES');
  const abrirArq = corpoDe(PROC, 'async function abrirArquivarComRazoes');
  ok(recortado(abrirArq), '5z: abrirArquivarComRazoes foi RECORTADA', `${abrirArq.length} chars`);
  ok(/abrirModalTrecho\(interaction, 'razoes_arquivamento', numero\)/.test(abrirArq),
    '5d: que reusa o rascunho multi-trecho — não um modal próprio');
  const arq = corpoDe(PROC, 'async function arquivarComRazoes', 5000);
  ok(arq.length > 300, '5z2: arquivarComRazoes foi localizada', `${arq.length} chars`);
  ok(/Não há razões escritas/.test(arq), '5e: sem razões, não arquiva');
  // O ANDAMENTO agora sai por `publicarAtoNoCanal`, junto com o PNG e a postagem no canal — não
  // mais por uma chamada solta a `andamentos.registrar`. Foi a correção do bug de 20/08 (tarde):
  // `andamentos.registrar` NÃO posta no canal do processo, só grava no banco e espelha o título na
  // auditoria. A resposta dizia "visível às partes" e não havia nada para ver.
  ok(/publicarAtoNoCanal\(/.test(arq) && /razoes/.test(arq),
    '5f: as razões vão para os autos E para o canal — nunca em silêncio');
  ok(/tipo: 'processo_arquivado'/.test(arq), '5f2: lavradas como andamento próprio');
  ok(arq.indexOf('publicarAtoNoCanal') < arq.indexOf('arquivarManual'),
    '5g: e publicadas ANTES de o canal fechar (depois, o envio já está travado)');
  ok(/jaExecutado|bloqueioPorJaExecutado/.test(arq), '5h: com guarda de colisão contra duplo clique');
  // O RECURSO: mesmo botão da sentença, na mensagem — o painel some em status terminal.
  ok(/componentes: \[botaoRecorrer\(numero\)\]/.test(arq),
    '5h2: e o arquivamento abre recurso ao Desembargador, pelo botão que já existia');
  ok(/status: 'Arquivado sem julgamento de mérito'/.test(arq),
    '5h3: gravando o status que libera o recurso');

  // DESPACHO: COM documento publicado, mas SEM selo e SEM entrega — publicado não é entregue.
  const desp = corpoDe(PROC, 'async function publicarDespacho', 4000);
  ok(recortado(desp, 4000), '5z3: publicarDespacho foi RECORTADA', `${desp.length} chars`);
  ok(/publicarAtoNoCanal\(/.test(desp), '5i: o despacho vira andamento E documento no canal');
  ok(!/criarPeca|emitirAtoComoPeca|pecas\.gerar/.test(desp),
    '5j: sem virar peça — nada de selo, token ou janela de entrega');
  ok(emissao.TIPOS.despacho_juiz && emissao.TIPOS.despacho_juiz.semPeca === true,
    '5k: e o tipo é declarado semPeca no catálogo');
  ok(emissao.TIPOS.razoes_arquivamento && emissao.TIPOS.razoes_arquivamento.semPeca === true,
    '5l: as razões do arquivamento também');

  // Sem menu de classificação: o Juiz age pelas ferramentas que já existem.
  ok(!/classificarManifestacao|tipoDaManifestacao|selectClassificacao/.test(PROC),
    '5m: nenhum menu de "classificar a manifestação" foi criado');
}

// ---------------------------------------------------------------------------
console.log('\n6) COMPORTAMENTO — a porta leva ao gate, e o processo volta a andar');
// ---------------------------------------------------------------------------
async function secao6() {
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

  // O processo penal aberto PELO MP: sem delegado, sem juiz, status 'Aguardando decisão do MP'.
  const r = await processoCmd.criarProcessoPenal({
    guild, delegadoId: null, promotorId: PROMOTOR, semDelegado: true,
    crimesTexto: '121-homicidio-consumado', motivo: 'Apurado pelo MP.', reuNome: 'Réu RP', reuRg: '999',
  });
  ok(!r.erro, '6z: o processo de teste foi criado', r.erro || '');
  if (r.erro) { emissao.abrirEmissao = original; return; }
  const inicial = db.buscarPorNumero('processos', r.numero);
  ok(inicial.juiz === null, '6a: ele nasce SEM juiz', String(inicial.juiz));

  const respostas = [];
  const fakeInteraction = (userId) => ({
    user: { id: userId },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    guild,
    reply: async (p) => { respostas.push(p); return p; },
    showModal: async (m) => { respostas.push({ modal: m?.data?.custom_id || 'modal' }); return m; },
  });

  const saida = await processoCmd.abrirManifestacaoMp(fakeInteraction(PROMOTOR), r.numero);
  ok(pousos.length === 1, '6b: o promotor dono do caso chega em abrirEmissao', JSON.stringify(pousos));
  ok(pousos[0]?.tipo === 'manifestacao_mp_gated', '6c: pelo tipo da porta única', pousos[0]?.tipo);
  ok(pousos[0]?.numero === r.numero, '6d: e no processo recém-aberto');
  ok(saida === 'gated', '6e: o retorno vem de lá — não de um modal de parecer');
  ok(!respostas.some(x => x.modal), '6f: nenhum modal de parecer foi aberto');

  // As travas continuam: a porta é do MP, e do promotor DESTE caso.
  pousos.length = 0; respostas.length = 0;
  await processoCmd.abrirManifestacaoMp(fakeInteraction(JUIZ), r.numero);
  ok(pousos.length === 0, '6g: um Juiz não entra pela porta do MP');
  ok(respostas.length === 1, '6h: e recebe recusa em vez de silêncio');

  pousos.length = 0; respostas.length = 0;
  await processoCmd.abrirManifestacaoMp(fakeInteraction(ESTRANHO), r.numero);
  ok(pousos.length === 0, '6i: nem quem não tem cargo nenhum');
  emissao.abrirEmissao = original;

  // O ELO QUE DESTRAVA — a razão de tudo isto existir. Sem ele, este processo ficaria em
  // 'Aguardando decisão do MP' para sempre: nenhuma das portas de designação alcança esse status.
  const efeito = emissao.aplicarEfeitoDoRecebimento(
    'manifestacao_mp_gated', db.buscarPorNumero('processos', r.numero), { numero: `${r.numero}-P1` }, JUIZ, 'processos',
  );
  ok(!!efeito && !!efeito.campos, '6j: o recebimento da PRIMEIRA manifestação produz efeito');
  const depois = db.buscarPorNumero('processos', r.numero);
  ok(depois.juiz === JUIZ, '6k: o Juiz que recebeu assume o processo', String(depois.juiz));
  ok(depois.status === 'Instrução', '6l: e o processo avança para Instrução', depois.status);
  ok(depois.distribuidoPorRecebimento === true, '6m: marcado como distribuído pelo recebimento');

  // E o hub do Juiz aparece — é o que torna o avanço utilizável, não só um campo no banco.
  const painelDoJuiz = processoCmd.montarPainelAcoes
    ? JSON.stringify(processoCmd.montarPainelAcoes(depois))
    : null;
  if (painelDoJuiz !== null) {
    ok(/hubjuiz/.test(painelDoJuiz), '6n: e o hub do Juiz passa a ser renderizado no painel');
  } else {
    ok(true, '6n: montarPainelAcoes não é exportada — cobertura pelo campo juiz acima');
  }
}

// ---------------------------------------------------------------------------
console.log('\n7) O caminho NÃO-GATED não é alcançável por painel nenhum');
// ---------------------------------------------------------------------------
{
  // `processo:oferecer` / executarParecerMp FICAM: pareceres já em curso precisam terminar
  // (decisão do operador). O que este teste guarda é que nenhum painel volte a apontar para lá.
  ok(/executarParecerMp/.test(PROC), '7a: executarParecerMp continua existindo, como combinado');
  const semComentario = PAINEL.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(semComentario.length > 10000, '7z: o painel sem comentários foi montado (scan não vazio)');
  ok(!/processo:oferecer/.test(semComentario),
    '7b: nenhuma linha de código do painel monta esse customId');
  ok(!/escreverdenuncia|abrirDenunciaGated/.test(semComentario),
    '7c: e o atalho intermediário de ontem foi removido de vez');
}

(async () => {
  await secao6();
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { falhas.forEach(f => console.log(`   - ${f.nome}${f.detalhe ? ` (${f.detalhe})` : ''}`)); process.exit(1); }
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
})();
