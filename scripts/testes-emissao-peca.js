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
    ok(!i.rec.modais.length && /fluxo antigo/i.test(textoDe(i.rec.replies[0])), '3a: processo legado recusa e explica por quê');
    ok(/não muda no meio dos autos/i.test(textoDe(i.rec.replies[0])), '3b: ...deixando claro que o rito não muda no meio');
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
    const i = fakeInteraction(JUIZ, 'modal', { tese: 'Intime-se.' });
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

  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
