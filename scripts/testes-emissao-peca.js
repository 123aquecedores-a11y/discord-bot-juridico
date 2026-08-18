/* eslint-disable */
// Testes do lado da EMISSÃO da Faixa 1 (utils/emissaoPeca.js). Rode com:
//   node scripts/testes-emissao-peca.js
//
// O recebimento não está construído de propósito — ele depende de o QR sobreviver ao caminho real
// dentro do jogo, e botão sobre premissa não verificada é o que se evita. Há teste garantindo que
// ele continue desligado, para ninguém ligar por engano antes do teste in-game passar.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-emissao-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');
const modoEntrega = require('../utils/modoEntrega');
const emissao = require('../utils/emissaoPeca');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

const JUIZ = 'id_juiz', ADV = 'id_adv', ADV2 = 'id_adv2', ESTRANHO = 'id_estranho';

// ---- interação falsa: registra o que o bot responderia, sem Discord ----
function fakeInteraction(userId, customId, campos = {}) {
  const rec = { replies: [], modais: [], defer: false, edits: [], sends: [] };
  return {
    rec,
    user: { id: userId, createDM: async () => ({ send: async (o) => { rec.sends.push(o); return { id: 'dm1', attachments: new Map() }; } }) },
    customId,
    member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } },
    guild: { id: 'guild1', channels: { fetch: async () => ({ send: async (o) => { rec.sends.push(o); return { id: 'm1' }; } }) }, members: { fetch: async () => null } },
    fields: { getTextInputValue: (k) => campos[k] },
    isButton: () => !customId.startsWith('modal'),
    isModalSubmit: () => customId.startsWith('modal'),
    reply: async (o) => { rec.replies.push(o); },
    followUp: async (o) => { rec.replies.push(o); },
    editReply: async (o) => { rec.edits.push(o); },
    deferReply: async () => { rec.defer = true; },
    showModal: async (m) => { rec.modais.push(m); },
  };
}
const textoDe = (o) => (typeof o === 'string' ? o : (o && o.content) || '');

let seq = 0;
// `modo: null` cria o registro SEM o campo — é assim que um processo anterior à feature se
// parece, e é o que `modoDoProcesso` tem que ler como legado. Passar `undefined` não serviria:
// acionaria o valor padrão do parâmetro e o processo nasceria ingame.
function novoProcesso(modo = 'ingame', extra = {}) {
  const numero = `010${++seq}PN`;
  return db.inserir('processos', {
    numero, tipo: 'Penal', status: 'Instrução',
    ...(modo === null ? {} : { modoEntrega: modo }),
    juiz: JUIZ, promotor: null, delegado: null, advogados: [],
    habilitacoes: [{ id: 1, advogadoId: ADV, reuId: 'r1', status: 'Aprovado' }],
    canalId: 'canal1', ...extra,
  });
}

(async () => {
  console.log('\n=== Emissão da Faixa 1 ===\n');

  console.log('1) Catálogo e ativação por tipo (SPEC §11)');
  {
    ok(emissao.tipoAtivo('peticao_incidental'), '1a: petição incidental está na Faixa 1');
    ok(!emissao.TIPOS.peticao_inicial_penal, '1a2: "petição inicial penal" não existe — no penal o caso nasce de inquérito ou ato do MP');
    ok(emissao.tipoAtivo('intimacao_juiz'), '1b: intimação do juiz está na Faixa 1');
    ok(!emissao.tipoAtivo('sentenca'), '1c: tipo fora da faixa não está ativo');
    const papeis = Object.values(emissao.TIPOS).flatMap(t => [t.emissor, ...t.destinatarios]);
    ok(papeis.every(p => /^[A-Z]/.test(p) && !/^\d+$/.test(p)), '1d: catálogo usa PAPÉIS, nunca IDs');
  }

  console.log('\n2) Quem pode emitir (SPEC §6.2)');
  {
    const p = novoProcesso();
    const i1 = fakeInteraction(ESTRANHO, 'peca:emitir');
    await emissao.abrirEmissao(i1, 'intimacao_juiz', p.numero);
    ok(!i1.rec.modais.length && /papel de \*\*Juiz\*\*/.test(textoDe(i1.rec.replies[0])), '2a: quem não ocupa o papel do emissor é recusado');

    const i2 = fakeInteraction(JUIZ, 'peca:emitir');
    await emissao.abrirEmissao(i2, 'intimacao_juiz', p.numero);
    ok(i2.rec.modais.length === 1, '2b: o juiz do processo abre o modal');

    const i3 = fakeInteraction(ADV, 'peca:emitir');
    await emissao.abrirEmissao(i3, 'peticao_incidental', p.numero);
    ok(i3.rec.modais.length === 1, '2c: advogado habilitado abre o modal da petição');

    const i4 = fakeInteraction(ADV2, 'peca:emitir');
    await emissao.abrirEmissao(i4, 'peticao_incidental', p.numero);
    ok(!i4.rec.modais.length, '2d: advogado SEM habilitação neste processo é recusado');
  }

  console.log('\n3) Processo legado não entra no rito novo (SPEC §11.2.1)');
  {
    const p = novoProcesso(null); // sem o campo = legado, sem migração (SPEC §11.2.2)
    const i = fakeInteraction(JUIZ, 'peca:emitir');
    await emissao.abrirEmissao(i, 'intimacao_juiz', p.numero);
    const msg = textoDe(i.rec.replies[0]);
    ok(!i.rec.modais.length && /anterior ao formul/i.test(msg), '3a: processo legado recusa e explica por quê');
    ok(/não muda no meio dos autos/i.test(msg), '3b: ...deixando claro que o rito não muda no meio');
    // Recusa sem saída é o que vira reclamação de "bug": a mensagem tem que dizer o que fazer.
    ok(/Peticionar/.test(msg) && /PDF/i.test(msg), '3c: ...e diz exatamente qual botão usar no lugar');
  }

  console.log('\n4) Modal tem UM campo, de 4.000 (SPEC §12)');
  {
    const p = novoProcesso();
    const i = fakeInteraction(JUIZ, 'peca:emitir');
    await emissao.abrirEmissao(i, 'intimacao_juiz', p.numero);
    const modal = i.rec.modais[0].toJSON();
    ok(modal.components.length === 1, '4a: um campo só — o resto vem preenchido pelo sistema', `tem ${modal.components.length}`);
    const campo = modal.components[0].components[0];
    ok(campo.max_length === 4000, '4b: teto de 4.000 caracteres', `max=${campo.max_length}`);
    ok(campo.style === 2, '4c: campo de parágrafo, não linha única');
  }

  console.log('\n5) Criação da peça sem destinatário disponível');
  {
    // Intimação vai para Advogado; sem habilitação aprovada, não há a quem dirigir.
    const p = novoProcesso('ingame', { habilitacoes: [] });
    // O teor vem do rascunho, não do campo do modal: escreve o trecho e só então envia.
    await emissao.receberTrecho(fakeInteraction(JUIZ, 'modal', { tese: 'Intime-se.' }), 'intimacao_juiz', p.numero);
    const i = fakeInteraction(JUIZ, 'peca:enviar');
    await emissao.criarPeca(i, 'intimacao_juiz', p.numero);
    ok(/não há quem ocupe o papel/i.test(textoDe(i.rec.replies[0])), '5a: recusa quando ninguém ocupa o papel do destinatário');
    ok(db.todos('pecas', x => x.processoNumero === p.numero).length === 0, '5b: ...e NÃO cria peça órfã');
  }

  console.log('\n6) Janela de entrega (SPEC §6.2)');
  {
    const p = novoProcesso();
    const g = pecas.gerar({
      processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
      autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
    });
    const numero = g.peca.numero;

    const iEstranho = fakeInteraction(ESTRANHO, 'peca:entregar');
    await emissao.entregarAgora(iEstranho, numero);
    ok(/❌/.test(textoDe(iEstranho.rec.replies[0])), '6a: estranho não abre a janela');

    const i = fakeInteraction(JUIZ, 'peca:entregar');
    await emissao.entregarAgora(i, numero);
    ok(/60 minutos/.test(textoDe(i.rec.replies[0])), '6b: emissor abre a janela de 60 minutos');
    ok(pecas.janelaAberta(db.buscarPorNumero('pecas', numero)), '6c: a janela consta aberta no banco');
    ok(i.rec.sends.some(s => /Entrega aberta/.test(textoDe(s))), '6d: o canal é avisado');
    ok(i.rec.sends.some(s => /sanção/i.test(textoDe(s))), '6e: com o aviso de sanção — o mecanismo é anunciado (SPEC §3.10)');

    const iFecha = fakeInteraction(JUIZ, 'peca:encerrar');
    await emissao.encerrarEntrega(iFecha, numero);
    ok(!pecas.janelaAberta(db.buscarPorNumero('pecas', numero)), '6f: o emissor encerra a janela manualmente');
  }

  console.log('\n7) O recebimento continua DESLIGADO até o teste in-game');
  {
    const i = fakeInteraction(ADV, 'peca:receber:0101PN-P1');
    await emissao.router(i);
    ok(/ainda não está ativado/i.test(textoDe(i.rec.replies[0])), '7a: o botão Receber responde que não está ativado');

    const fonte = fs.readFileSync(path.join(__dirname, '..', 'utils', 'emissaoPeca.js'), 'utf-8');
    ok(!/lerSelo|lerToken/.test(fonte), '7b: a emissão não importa o leitor de selo');
    ok(!/pecas\.receber\s*\(/.test(fonte), '7c: e não chama pecas.receber em lugar nenhum');
    ok(/setDisabled\(true\)/.test(fonte), '7d: o botão Receber é postado desabilitado (SPEC §6.1)');
  }

  console.log('\n9) Nenhuma URL de anexo é guardada (SPEC §3.7, corrigido em 18/08)');
  // As URLs do CDN do Discord são links assinados e expiram em 24h. Medido em produção: 29 dos 34
  // anexos guardados já retornavam 404, incluindo 11 provas em processos reais. O original da peça
  // é o REGISTRO no banco, e o PNG se regera do texto — determinístico, nada expira.
  {
    // O que se proíbe é copiar a URL do ANEXO do Discord — ela é o link assinado que expira. A URL
    // do nosso próprio servidor (BASE_URL_PECAS/p/<token>.png) é o oposto disso: não expira, e nem
    // sequer é gravada — o que fica no banco é o token, e a URL se monta na hora.
    const fontes = ['utils/emissaoPeca.js', 'utils/pecas.js'];
    const infratores = [];
    for (const f of fontes) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
      if (/\.attachments\b/.test(src) || /cdn\.discordapp/.test(src)) infratores.push(f);
    }
    ok(infratores.length === 0, '9a: nenhuma URL de anexo do Discord é lida ou copiada', infratores.join('; '));

    const p = novoProcesso();
    const g = pecas.gerar({
      processoTabela: 'processos', processoNumero: p.numero, tipo: 'peticao_incidental',
      autorId: ADV, autorPapel: 'Advogado', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
    });
    pecas.registrarEnvio(g.peca.numero, { totalPaginas: 3 });
    const salvo = JSON.stringify(db.buscarPorNumero('pecas', g.peca.numero));
    ok(!/https?:\/\//.test(salvo), '9b: o registro salvo não contém URL nenhuma');
    ok(/totalPaginas/.test(salvo), '9c: guarda só metadado da entrega (quantas páginas)');
    ok(/"texto"/.test(salvo), '9d: e o texto, que é o original do qual o PNG se regera');
  }

  console.log('\n10) Peça escrita em trechos');
  // O teto de 4.000 é do CAMPO do modal, não da peça. Quem precisa de mais escreve em trechos, que
  // se acumulam e viram um documento só, paginado.
  {
    const p = novoProcesso();
    const chave = ['peticao_incidental', p.numero];

    // Trecho 1
    const i1 = fakeInteraction(ADV, 'modal', { tese: 'A'.repeat(3000) });
    await emissao.receberTrecho(i1, ...chave);
    const painel1 = i1.rec.replies[0];
    ok(!!painel1.embeds, '10a: escrever um trecho devolve o painel de rascunho, não a peça');
    ok(/1 de 3/.test(painel1.embeds[0].data.description), '10b: mostra quantos trechos foram escritos');
    ok(/3\.000 caracteres/.test(painel1.embeds[0].data.description), '10c: mostra o total de caracteres');
    ok(/impress/i.test(painel1.embeds[0].data.description), '10d: e o custo em impressões no jogo');
    ok(db.todos('pecas', x => x.processoNumero === p.numero).length === 0, '10e: nada é gerado ainda');

    // Trecho 2 — acumula
    const i2 = fakeInteraction(ADV, 'modal', { tese: 'B'.repeat(3000) });
    await emissao.receberTrecho(i2, ...chave);
    const d2 = i2.rec.replies[0].embeds[0].data.description;
    ok(/2 de 3/.test(d2), '10f: o segundo trecho acumula');
    // 6.002 e não 6.000: o join insere a linha em branco que separa os trechos.
    ok(/6\.002 caracteres/.test(d2), '10g: e o contador soma os dois', d2.slice(0, 60));

    // Ver o acumulado
    const iVer = fakeInteraction(ADV, 'peca:ver');
    await emissao.verRascunho(iVer, ...chave);
    ok(/Trecho 1/.test(textoDe(iVer.rec.replies[0])), '10h: dá para ver o texto acumulado antes de enviar');

    // Apagar o último — é o conserto para erro no primeiro pedaço
    const iUndo = fakeInteraction(ADV, 'peca:undo');
    await emissao.desfazerTrecho(iUndo, ...chave);
    ok(/apagado \(3000 caracteres\)/.test(textoDe(iUndo.rec.replies[0])), '10i: apaga o último trecho');
    ok(/1 de 3/.test(iUndo.rec.replies[0].embeds[0].data.description), '10j: e o painel volta a 1 trecho');

    // Teto de 3
    await emissao.receberTrecho(fakeInteraction(ADV, 'modal', { tese: 'C'.repeat(100) }), ...chave);
    await emissao.receberTrecho(fakeInteraction(ADV, 'modal', { tese: 'D'.repeat(100) }), ...chave);
    const iQuarto = fakeInteraction(ADV, 'peca:add');
    await emissao.abrirModalTrecho(iQuarto, ...chave);
    ok(!iQuarto.rec.modais.length && /já escreveu os 3/i.test(textoDe(iQuarto.rec.replies[0])), '10k: o 4º trecho é recusado');

    // Enviar: vira UMA peça só, com os trechos concatenados
    const iEnviar = fakeInteraction(ADV, 'peca:enviar');
    await emissao.criarPeca(iEnviar, ...chave);
    const pecasDoProcesso = db.todos('pecas', x => x.processoNumero === p.numero);
    ok(pecasDoProcesso.length === 1, '10l: os 3 trechos viram UMA peça só', `saíram ${pecasDoProcesso.length}`);
    ok(pecasDoProcesso[0].texto.length === 3000 + 100 + 100 + 4, '10m: com os trechos concatenados por linha em branco');

    // Rascunho consumido: reenviar não duplica a peça
    const iDeNovo = fakeInteraction(ADV, 'peca:enviar');
    await emissao.criarPeca(iDeNovo, ...chave);
    ok(/rascunho pode ter expirado/i.test(textoDe(iDeNovo.rec.replies[0])), '10n: o rascunho é consumido no envio');
    ok(db.todos('pecas', x => x.processoNumero === p.numero).length === 1, '10o: ...e reenviar não cria segunda peça');
  }

  console.log('\n11) Estimativa de páginas — medida, não chutada');
  {
    // Cada par abaixo veio de medição no Chromium com o leiaute atual. Se alguém mexer no leiaute e
    // não remedir, estes casos quebram — é o ponto deles.
    const MEDIDOS = [[2739, 1], [3289, 2], [5489, 2], [6589, 3], [8239, 3], [9889, 4], [12089, 4]];
    for (const [chars, paginas] of MEDIDOS) {
      const est = emissao.estimarPaginas('x'.repeat(chars));
      ok(est === paginas, `11: ${chars} chars → ${paginas} página(s)`, `estimou ${est}`);
    }
    ok(emissao.estimarPaginas('') === 1, '11d: nunca estima menos de 1 página');
    ok(/impressões no jogo/.test(emissao.linhaCusto('x'.repeat(9000))), '11e: a linha de custo fala em impressões');
    ok(/impressão no jogo/.test(emissao.linhaCusto('x'.repeat(500))), '11f: com singular quando é uma só');
    ok(emissao.MAX_TRECHOS * emissao.MAX_CHARS_TRECHO === 12000, '11g: teto total de 12.000 caracteres');
    // O teto inteiro tem que caber em 4 páginas — era 7 antes da compactação do leiaute.
    ok(emissao.estimarPaginas('x'.repeat(12000)) <= 4, '11h: o teto de 12.000 custa no máximo 4 impressões');
  }

  console.log('\n12) TTL do rascunho');
  {
    ok(emissao.TTL_RASCUNHO_MS === 2 * 60 * 60 * 1000, '12a: rascunho dura 2 horas, não 20 minutos');

    // O prazo renova a cada leitura: sem isso, as 2h contariam do primeiro trecho, e quem escreve
    // devagar perderia o texto no meio da terceira parte.
    const { RascunhoTTL } = require('../utils/rascunhoTtl');
    const r = new RascunhoTTL(120);
    r.set('k', { trechos: ['a'] });
    await new Promise(res => setTimeout(res, 80));
    r.set('k', r.get('k')); // é o que lerRascunho faz
    await new Promise(res => setTimeout(res, 80));
    ok(r.get('k') !== undefined, '12b: reescrever no get renova o prazo (2h de inatividade, não de vida)');
  }

  console.log('\n13) O caminho antigo NÃO foi quebrado');
  // Processos legado são gente travada no servidor se o botão antigo sumir. O fluxo novo entra
  // BIFURCANDO o "Peticionar" que já existe, e não substituindo — em processo legado ele continua
  // caindo no anexo de PDF.
  {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');

    ok(/function botaoAnexarPeticaoInicial/.test(fonte), '13a: o botão "Anexar petição inicial" continua existindo');
    ok(/function anexarPeticaoInicial/.test(fonte), '13b: ...com o handler dele');
    ok(/function botaoAnexarContestacao/.test(fonte), '13c: "Anexar contestação" também');
    ok(/aguardarAnexoPDF\(interaction\)/.test(fonte), '13d: e o fluxo de anexar PDF segue no peticionar');

    // A bifurcação: legado segue no PDF, processo novo vai para o formulário.
    ok(/modoDoProcesso\(processo\) !== 'legado'/.test(fonte), '13e: "Peticionar" bifurca por modo');
    const i = fonte.indexOf("modoDoProcesso(processo) !== 'legado'");
    const j = fonte.indexOf('aguardarAnexoPDF(interaction)', i);
    ok(i !== -1 && j !== -1 && j > i, '13f: ...e o caminho do PDF vem DEPOIS da bifurcação (legado cai nele)');

    const painel = fs.readFileSync(path.join(__dirname, '..', 'commands', 'painel.js'), 'utf-8');
    ok(/acao === 'anexarpeticaoinicial'/.test(painel), '13g: o roteamento do botão antigo está intacto');
    ok(/acao === 'peticionar'/.test(painel), '13h: e o do Peticionar também');
  }

  console.log('\n8) Carimbo do modo na abertura (SPEC §11.2)');
  {
    const proc = require('../commands/processo');
    ok(typeof proc === 'object', '8a: commands/processo carrega com o import de modoEntrega');
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'commands', 'processo.js'), 'utf-8');
    const carimbos = (fonte.match(/modoEntrega\.modoParaNovoProcesso\(/g) || []).length;
    ok(carimbos === 2, '8b: penal e cível carimbam o modo na abertura', `achei ${carimbos}`);

    ok(modoEntrega.modoParaNovoProcesso('guild1') === 'aberto', '8c: sem registro, processo novo nasce aberto');
    modoEntrega.ligar('guild1', 'id_staff');
    ok(modoEntrega.modoParaNovoProcesso('guild1') === 'ingame', '8d: com o interruptor ligado, nasce ingame');
  }

  console.log('\n14) Válvula de 24h ligada à varredura periódica (achado: nunca estava)');
  // A função pecas.varrerValvula() sempre existiu e sempre passou nos testes isolados, mas nada em
  // produção a chamava — o boot não tinha esse fio. Descoberto ao investigar a pergunta sobre o link
  // público, que precisa da mesma varredura periódica.
  {
    const fakeGuild = { channels: { fetch: async () => null } };
    const p = novoProcesso();
    const g = pecas.gerar({
      processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
      autorId: JUIZ, autorPapel: 'Juiz', texto: 'teor', destinatarios: [{ papel: 'Advogado', habilitacaoId: 1 }],
    });
    // Força o horário-limite para o passado — sem isso o teste levaria 24h de verdade.
    const vencida = db.buscarPorNumero('pecas', g.peca.numero);
    db.atualizar('pecas', g.peca.numero, {
      destinatarios: vencida.destinatarios.map(d => ({ ...d, valvulaEm: new Date(Date.now() - 1000).toISOString() })),
    });

    await emissao.verificarValvulaEEncerramento({}, fakeGuild);

    const depois = db.buscarPorNumero('pecas', g.peca.numero);
    ok(depois.destinatarios[0].recebidoEm && depois.destinatarios[0].automatico, '14a: a varredura periódica destrava a peça vencida');

    const autos = require('../utils/andamentos').doProcesso(p.numero);
    const lavrado = autos.find(a => a.tipo === 'peca_valvula_24h');
    ok(!!lavrado, '14b: e LAVRA nos autos — sem isso a válvula estourava em silêncio');
    ok(/cart[óo]rio/i.test(lavrado.titulo) && !/teor|conteúdo/i.test(lavrado.titulo), '14c: título genérico por tipo (SPEC §10), sem entregar o que aconteceu além disso');
  }

  console.log('\n15) Revogação de links públicos de processo encerrado (o vazamento que a Resposta 16 apontou)');
  // resolverTokenPublico nunca checava estado: link gerado ficava valendo pra sempre. Pior num
  // processo ARQUIVADO (não sentenciado), que a camada mantém fechado para sempre — o link cru
  // ignorava essa trava por completo.
  {
    const aberto = novoProcesso();
    const gAberto = pecas.gerar({
      processoTabela: 'processos', processoNumero: aberto.numero, tipo: 'peticao_incidental',
      autorId: ADV, autorPapel: 'Advogado', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
    });
    const rAberto = pecas.registrarPaginasPublicas(gAberto.peca.numero, 'Juiz', null, 2);
    const tokenAberto = rAberto.paginas[0].token;

    const encerrado = novoProcesso();
    const gEncerrado = pecas.gerar({
      processoTabela: 'processos', processoNumero: encerrado.numero, tipo: 'peticao_incidental',
      autorId: ADV, autorPapel: 'Advogado', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
    });
    const rEncerrado = pecas.registrarPaginasPublicas(gEncerrado.peca.numero, 'Juiz', null, 2);
    const tokenEncerrado = rEncerrado.paginas[0].token;

    ok(!!pecas.resolverTokenPublico(tokenEncerrado), '15a: antes de encerrar, o link ainda resolve');

    // Processo ARQUIVADO — não sentenciado, a camada mantém o teor fechado para sempre, e é
    // exatamente esse caso que o link cru ignorava.
    db.atualizar('processos', encerrado.numero, { status: 'Arquivado' });

    await emissao.verificarValvulaEEncerramento({}, { channels: { fetch: async () => null } });

    ok(pecas.resolverTokenPublico(tokenEncerrado) === null, '15b: depois de arquivado, o link do processo encerrado NÃO resolve mais (404 na prática)');
    ok(!!pecas.resolverTokenPublico(tokenAberto), '15c: ...enquanto o de um processo ainda ABERTO continua valendo — a varredura não revoga tudo, só o que encerrou');
  }

  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
