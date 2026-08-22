/* eslint-disable */
// TRÊS FAMÍLIAS DE FALHA QUE PARARAM DE PASSAR DESPERCEBIDAS (21/08/2026). Rode com:
//   node scripts/testes-falha-que-aparece.js
//
// ITEM 3 — JANELA DE ENTREGA que não fecha no arquivamento/anulação.
//   Cinco pontos chamavam fecharJanelasDoProcesso e engoliam o erro num console.error. Janela
//   aberta em processo morto é PORTA: o destinatário ainda registra recebimento e abre o teor de um
//   ato arquivado ou anulado. Agora existe um invólucro único que grita, avisa a auditoria e
//   devolve o aviso para quem clicou.
//
// ITEM 4 — DIÁRIO OFICIAL que não publica e a tela diz que publicou.
//   Cinco pontos. O padrão certo já existia em commands/diarioOficial.js: flag de sucesso e frase
//   honesta. Aplicado aos cinco.
//
// ITEM 5 — LOG DE RH virou CONDIÇÃO (decisão do operador).
//   Antes: mexia no cargo e depois tentava logar. Agora: loga primeiro, e sem log a ação NÃO
//   acontece. Contratar, demitir e dar licença mudam quem pode o quê no tribunal inteiro — poder
//   que muda sem registro é poder que ninguém audita depois.
//
//   A ORDEM É O QUE DISPENSA ROLLBACK: gravando antes, não existe instante em que o cargo mudou e
//   o registro não. E o modo de falha real (a tabela `logRh` não declarada em database/db.js, que
//   de fato aconteceu) quebra só o log, nunca o `rh`.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-aparece-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const rh = require('../utils/rh');
const pecas = require('../utils/pecas');

// A contratação bem-sucedida emite a carteira, e emitir carteira sobe o Chromium: sem este stub o
// arquivo passa de segundos para MINUTOS, e a suíte inteira volta a ser o que era antes do conserto
// de 21/08 (689s -> 75s). Nada aqui testa carteira — ver scripts/README-testes.md.
require('../utils/carteirinha').emitirCarteirinha = async () => null;
const rhCmd = require('../commands/rh');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const SEM_COMENTARIO = (s) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const avisosAuditoria = [];
const guildFalsa = {
  id: 'guild1',
  channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { avisosAuditoria.push(p.content); } }) },
  // O caminho feliz da contratação busca o membro para mexer em role e apelido.
  members: { fetch: async () => { throw new Error('Unknown Member'); } },
  roles: { everyone: 'everyone' },
};
const config = require('../config');
config.canalAuditoriaId = 'canal-auditoria';

(async () => {
  console.log('\n== Falhas que agora aparecem ==');

  // =========================================================================
  console.log('\n1) ITEM 3 — janela de entrega que não fecha:');
  {
    const r = await pecas.fecharJanelasEAvisar(guildFalsa, 'processos', '0001PN', { contexto: 'arquivamento' });
    ok(r.ok === true && r.aviso === null, '1a: sem peças, fecha zero janelas e não inventa aviso', JSON.stringify(r.ok));

    // Quebra a escrita: é o modo de falha real (banco cheio, tabela sumida).
    const original = db.atualizar;
    db.inserir('pecas', {
      numero: 'P-0001', processoTabela: 'processos', processoNumero: '0002PN', gated: true,
      janela: { abertaEm: new Date().toISOString(), encerradaEm: null },
    });
    db.atualizar = () => { throw new Error('disco cheio'); };
    const antes = avisosAuditoria.length;
    let estourou = false; let r2 = null;
    try { r2 = await pecas.fecharJanelasEAvisar(guildFalsa, 'processos', '0002PN', { contexto: 'anulação da sentença' }); } catch (_) { estourou = true; }
    db.atualizar = original;

    ok(estourou === false, '1b: MUTAÇÃO — a falha NÃO derruba o arquivamento/anulação em curso');
    ok(r2 && r2.ok === false, '1c: mas o retorno diz que falhou', JSON.stringify(r2 && r2.ok));
    ok(r2 && typeof r2.aviso === 'string' && r2.aviso.length > 0, '1d: e traz aviso pronto para quem clicou');
    ok(avisosAuditoria.length === antes + 1, '1e: e a auditoria foi avisada sem o chamador precisar lembrar', `${avisosAuditoria.length - antes}`);

    const a = r2.aviso;
    ok(/0002PN/.test(a), '1f: o aviso diz QUAL processo');
    ok(/anulação da sentença/.test(a), '1g: e em que contexto aconteceu');
    ok(/ABERTA|aberta/.test(a) && /recebimento/.test(a), '1h: explica o RISCO — janela aberta em processo morto é porta');
    ok(/disco cheio/.test(a), '1i: e traz o erro real');
    // Não pode prometer botão que não existe: "Destravar entregas pendentes" faz o OPOSTO (abre).
    ok(!/Destravar entregas/.test(a),
      '1j: e NÃO manda usar "Destravar entregas pendentes" — esse botão ABRE janela, faria o contrário');
    ok(/[Rr]epita/.test(a) && /staff/i.test(a), '1k: manda repetir a ação, que é idempotente, e chamar a staff se não der');
  }

  console.log('\n2) ITEM 3 — os cinco pontos usam o invólucro:');
  {
    const proc = SEM_COMENTARIO(LER('commands', 'processo.js'));
    const painel = SEM_COMENTARIO(LER('commands', 'painel.js'));
    ok(proc.length > 50000, '2a: CANÁRIO — commands/processo.js foi lido inteiro', `${proc.length} chars`);

    const crus = (proc.match(/fecharJanelasDoProcesso\(/g) || []).length + (painel.match(/fecharJanelasDoProcesso\(/g) || []).length;
    ok(crus === 0, '2b: NENHUM ponto chama mais a função crua (ela engolia o erro)', `crus=${crus}`);
    const comInvolucro = (proc.match(/fecharJanelasEAvisar\(/g) || []).length + (painel.match(/fecharJanelasEAvisar\(/g) || []).length;
    ok(comInvolucro === 5, '2c: os CINCO passaram a usar o invólucro', `achados=${comInvolucro}`);
    ok(/janelasParecer\.aviso/.test(proc) && /janelasArquivo\.aviso/.test(proc) && /avisosDeJanela/.test(proc),
      '2d: e os avisos chegam à resposta de quem arquivou/anulou');
    ok(/janelas\.aviso/.test(painel), '2e: idem no arquivamento manual pelo painel');
  }

  // =========================================================================
  console.log('\n3) ITEM 4 — a tela não diz "publicado" quando não publicou:');
  {
    // Conta o RESULTADO, não a grafia: quatro dos cinco usam flag + emenda na resposta; a sentença
    // usa followUp, porque o editReply dela já saiu antes da publicação. A garantia é a mesma —
    // quem praticou o ato fica sabendo — e testar `let publicouNoDiario` puniria a diferença certa.
    const alvos = [
      ['commands/processo.js', 2],   // acórdão + sentença
      ['commands/rh.js', 1],         // nomeação (frase única, AVISO_DIARIO_NOMEACAO)
      ['commands/edital.js', 2],     // abertura + encerramento
    ];
    let total = 0;
    for (const [arq, esperado] of alvos) {
      const src = SEM_COMENTARIO(LER(...arq.split('/')));
      // "no Diário" é obrigatório na regex: processo.js tem um aviso preexistente de "não consegui
      // publicar NO CANAL", que é outra coisa e não pode entrar nesta conta.
      const n = (src.match(/N[ãa]o consegui publicar [^`'"]*?no Di[áa]rio/g) || []).length;
      total += n;
      ok(n === esperado, `3-${arq}: ${esperado} aviso(s) honesto(s) de falha do Diário`, `achados=${n}`);
    }
    ok(total === 5, '3z: CANÁRIO — os cinco pontos do item 4 foram cobertos', `total=${total}`);

    const proc = SEM_COMENTARIO(LER('commands', 'processo.js'));
    ok(/N[ãa]o consegui publicar o ac[óo]rd[ãa]o no Di[áa]rio/.test(proc), '3a: acórdão avisa quando não publica');
    ok(/N[ãa]o consegui publicar a senten[çc]a no Di[áa]rio/.test(proc), '3b: sentença também');
    ok(/followUp/.test(proc), '3c: a da sentença usa followUp — o editReply dela já saiu antes da publicação');
    const edital = SEM_COMENTARIO(LER('commands', 'edital.js'));
    ok(/N[ãa]o consegui publicar o edital no Di[áa]rio/.test(edital), '3d: abertura de edital avisa');
    ok(/N[ãa]o consegui publicar o encerramento no Di[áa]rio/.test(edital), '3e: encerramento também');
    const rhSrc = SEM_COMENTARIO(LER('commands', 'rh.js'));
    ok(/AVISO_DIARIO_NOMEACAO/.test(rhSrc), '3f: nomeação avisa, por frase única reusada nos caminhos de contratação');

    // Nenhum deles pode ter voltado a dizer "(ignorado)" e seguir calado.
    const ignorados = (proc + rhSrc + edital).match(/Di[áa]rio falhou \(ignorado\)/g) || [];
    ok(ignorados.length === 0, '3g: nenhum "falhou (ignorado)" sobrou nos cinco', `sobraram=${ignorados.length}`);
  }

  // =========================================================================
  console.log('\n4) ITEM 5 — sem log de RH, a ação NÃO acontece:');
  {
    const ALVO = '5001';
    rh.contratar(ALVO, 'Juiz', 'Juiz Teste', null);
    ok(!!rh.getCargo(ALVO), '4a: CANÁRIO — cenário montado, a pessoa está no quadro');

    // Quebra só o logRh, que é exatamente o modo de falha real (tabela não declarada).
    const inserirOriginal = db.inserir;
    db.inserir = (tabela, ...resto) => {
      if (tabela === 'logRh') throw new Error("tabela 'logRh' não existe");
      return inserirOriginal(tabela, ...resto);
    };

    // --- DEMISSÃO
    const saiu = await rhCmd.demitirComRole(guildFalsa, ALVO, '9999', 'Inatividade.');
    ok(saiu && typeof saiu.recusa === 'string', '4b: a demissão é RECUSADA com mensagem', JSON.stringify(saiu && Object.keys(saiu)));
    ok(!!rh.getCargo(ALVO), '4c: e o cargo CONTINUA — nada foi alterado no RH');
    ok(rh.getCargo(ALVO).cargo === 'Juiz', '4d: exatamente o mesmo cargo de antes');
    ok(/N[ÃA]O foi executada/.test(saiu.recusa), '4e: a mensagem diz claramente que a ação não aconteceu');
    ok(/Nada foi alterado/i.test(saiu.recusa), '4f: e que nada mudou');
    ok(/logRh|log de RH/i.test(saiu.recusa), '4g: e por quê');

    // A recusa NÃO pode ser confundida com "não tinha cargo", que é `null`.
    ok(saiu !== null, '4h: recusa é objeto com `recusa`, nunca null — null já significa "não tinha cargo"');

    // --- CONTRATAÇÃO
    const NOVO = '5002';
    const r = await rhCmd.contratarComRole(guildFalsa, NOVO, 'Promotor', '9999', 'Promotor Teste', null, 'Aprovado em edital.');
    ok(r.ok === false && typeof r.recusa === 'string', '4i: a contratação é RECUSADA', JSON.stringify(r.ok));
    ok(!rh.getCargo(NOVO), '4j: e a pessoa NÃO entrou no quadro');

    db.inserir = inserirOriginal;

    // --- E com o log funcionando, tudo passa normalmente.
    const r2 = await rhCmd.contratarComRole(guildFalsa, NOVO, 'Promotor', '9999', 'Promotor Teste', null, 'Aprovado em edital.');
    ok(r2.ok === true, '4k: com o log gravando, a contratação acontece', JSON.stringify(r2.ok));
    ok(!!rh.getCargo(NOVO) && rh.getCargo(NOVO).cargo === 'Promotor', '4l: e o cargo está no quadro');
    const linhas = db.todos('logRh', l => l.alvoId === NOVO);
    ok(linhas.length === 1, '4m: com exatamente uma linha no log', `linhas=${linhas.length}`);
    ok(linhas[0].motivo === 'Aprovado em edital.', '4n: com o motivo informado');
  }

  console.log('\n5) ITEM 5 — a ordem é o que dispensa rollback:');
  {
    const src = SEM_COMENTARIO(LER('commands', 'rh.js'));
    // O ponto estrutural: o exigirLogRh tem que vir ANTES da escrita no rh, nas duas funções.
    const contratar = src.slice(src.indexOf('async function contratarComRole'));
    const posLogC = contratar.indexOf('exigirLogRh(');
    const posEscritaC = contratar.indexOf('rh.contratar(');
    ok(posLogC > -1 && posEscritaC > -1 && posLogC < posEscritaC,
      '5a: em contratarComRole o log vem ANTES de rh.contratar', `log=${posLogC} escrita=${posEscritaC}`);

    const demitir = src.slice(src.indexOf('async function demitirComRole'));
    const posLogD = demitir.indexOf('exigirLogRh(');
    const posEscritaD = demitir.indexOf('rh.demitir(');
    ok(posLogD > -1 && posEscritaD > -1 && posLogD < posEscritaD,
      '5b: em demitirComRole o log vem ANTES de rh.demitir', `log=${posLogD} escrita=${posEscritaD}`);

    const painel = SEM_COMENTARIO(LER('commands', 'painel.js'));
    const licencaPainel = painel.slice(painel.indexOf("modulo === 'rh' && acao === 'licenca'"));
    const posLogL = licencaPainel.indexOf('exigirLogRh(');
    const posEscritaL = licencaPainel.indexOf('rh.setLicenca(');
    ok(posLogL > -1 && posEscritaL > -1 && posLogL < posEscritaL,
      '5c: e na licença pelo painel o log vem ANTES de rh.setLicenca', `log=${posLogL} escrita=${posEscritaL}`);

    const licencaSlash = src.slice(src.indexOf("sub === 'licenca'"));
    const posLogS = licencaSlash.indexOf('exigirLogRh(');
    const posEscritaS = licencaSlash.indexOf('rh.setLicenca(');
    ok(posLogS > -1 && posEscritaS > -1 && posLogS < posEscritaS,
      '5d: idem na licença pelo slash', `log=${posLogS} escrita=${posEscritaS}`);

    // As TRÊS ações estão cobertas, e por uma trava só.
    const usos = (src.match(/exigirLogRh\(/g) || []).length + (painel.match(/rhCmd\.exigirLogRh\(/g) || []).length;
    ok(usos === 5, '5e: a trava é aplicada nos 5 pontos (contratar, demitir, licença slash+painel, e a definição)', `usos=${usos}`);
    ok(!/logRh\.registrar\(/.test(painel), '5f: o painel não chama mais o logRh direto — passa pela trava');

    // executorId nulo é caminho de sistema: não há log a exigir, e travar ali emperraria automação.
    const corpo = src.slice(src.indexOf('function exigirLogRh'), src.indexOf('async function contratarComRole'));
    ok(/if \(!dados\.executorId\) return \{ ok: true/.test(corpo),
      '5g: sem executor humano não há log a exigir — automação não é travada por regra de ato de gente');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); process.exit(1); }
})();
