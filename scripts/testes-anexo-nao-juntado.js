/* eslint-disable */
// ANEXO QUE NÃO ENTROU NOS AUTOS (21/08/2026). Rode com:
//   node scripts/testes-anexo-nao-juntado.js
//
// O DEFEITO: em utils/emissaoPeca.js, a juntada dos documentos opcionais rodava dentro de um
// `for` cujo catch só escrevia no console. Anexo que falhasse simplesmente não existia — a peça
// era emitida, a tela dizia "criada", e a prova sumia sem deixar rastro em lugar nenhum.
//
// A DECISÃO, e ela é estrutural: NÃO abortar a emissão. Quando a juntada roda, `finalizarPeca` já
// criou a peça, renderizou o PNG, mandou ao emissor, postou o card no canal e lavrou o andamento.
// Não há emissão a desfazer — há documento assinado e publicado a destruir. E `aplicarEfeitoNoProcesso`
// ainda não rodou: abortar deixaria o processo travado, que é o defeito de 19/08 já documentado.
// Então: emite, e lavra pendência VISÍVEL.
//
// O PERIGO DO CONSERTO, e é o que este arquivo mais vigia: o andamento fica nos autos, à vista de
// todas as partes. Nome de arquivo descreve conteúdo ("laudo-cadaverico-vitima.pdf"). Escrevê-lo
// ali abriria um caminho NOVO em volta do podeVerTeor, justamente numa peça gated — o mesmo
// ângulo cego que scripts/testes-teor-em-andamentos.js existe para cobrir.
//
// Regra: no ANDAMENTO, quantidade e posição. Na RESPOSTA EFÊMERA ao emissor, o nome.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-anexo-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const emissao = require('../utils/emissaoPeca');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const SEM_COMENTARIO = (s) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// Nomes que DESCREVEM o conteúdo — é exatamente o que não pode chegar aos autos.
const NOME_QUE_VAZA = 'laudo-cadaverico-vitima-degolada.pdf';
const OUTRO_NOME = 'confissao-gravada-do-reu.mp3';

const enviadosAuditoria = [];
const guildFalsa = {
  id: 'guild1',
  channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { enviadosAuditoria.push(p.content); } }) },
};
const interacaoFalsa = { guild: guildFalsa, user: { id: '999' } };
const config = require('../config');
config.canalAuditoriaId = 'canal-auditoria';

(async () => {
  console.log('\n== Anexo que não entrou nos autos ==');

  // -------------------------------------------------------------------------
  console.log('\n1) O andamento é lavrado, e NÃO leva o nome do arquivo:');
  {
    await emissao.lavrarPendenciaDeAnexo(interacaoFalsa, { numero: '0001PN-P1', processoNumero: '0001PN' }, [
      { posicao: 1, nomeArquivo: NOME_QUE_VAZA },
      { posicao: 3, nomeArquivo: OUTRO_NOME },
    ]);

    const linhas = db.todos('andamentos', a => a.processoNumero === '0001PN');
    ok(linhas.length === 1, '1a: CANÁRIO — o andamento foi mesmo gravado (não passou vazio)', `linhas=${linhas.length}`);
    const a = linhas[0];
    ok(a.tipo === 'anexo_nao_juntado', '1b: com o tipo próprio', a.tipo);

    // O CORAÇÃO DO TESTE. Cada campo é conferido separado porque vazar por UM já basta.
    const tudo = JSON.stringify(a);
    ok(!tudo.includes(NOME_QUE_VAZA), '1c: o nome do arquivo NÃO está em nenhum campo do andamento');
    ok(!tudo.includes(OUTRO_NOME), '1d: nem o do segundo arquivo');
    ok(!tudo.includes('laudo') && !tudo.includes('cadaver') && !tudo.includes('confissao'),
      '1e: nem pedaço do nome — o teste falha em qualquer vazamento parcial');
    ok(!/\.(pdf|png|jpe?g|mp3|mp4|docx?|zip)/i.test(tudo),
      '1f: nem sequer uma EXTENSÃO de arquivo sobrou no registro', tudo.slice(0, 120));

    // E o que ele PRECISA dizer, senão a pendência não serve para nada.
    ok(/2 anexo/.test(a.titulo), '1g: mas diz a QUANTIDADE', a.titulo);
    ok(/posição 1, 3/.test(a.detalhe), '1h: e a POSIÇÃO de cada um — dá para saber o que procurar');
    ok(/0001PN-P1/.test(a.titulo) || /0001PN-P1/.test(a.detalhe) || a.metadata.peca === '0001PN-P1',
      '1i: e a que peça pertencem');
    ok(a.metadata && a.metadata.quantidade === 2 && Array.isArray(a.metadata.posicoes),
      '1j: o metadado é número, nunca nome', JSON.stringify(a.metadata));
    ok(/vale e está nos autos/.test(a.detalhe),
      '1k: deixa explícito que a PEÇA vale — senão quem lê acha que o ato caiu');
    ok(/Anexar prova/.test(a.detalhe), '1l: e aponta o caminho de conserto que existe hoje');
  }

  // -------------------------------------------------------------------------
  console.log('\n2) O espelho na auditoria também não vaza:');
  {
    ok(enviadosAuditoria.length === 1, '2a: CANÁRIO — a auditoria recebeu o espelho', `n=${enviadosAuditoria.length}`);
    const t = enviadosAuditoria[0] || '';
    ok(!t.includes(NOME_QUE_VAZA) && !t.includes(OUTRO_NOME),
      '2b: e o canal de auditoria não recebeu nome de arquivo nenhum', t.slice(0, 80));
  }

  // -------------------------------------------------------------------------
  console.log('\n3) MUTAÇÃO — a pendência falhando não derruba a emissão:');
  {
    const andamentos = require('../utils/andamentos');
    const original = andamentos.registrar;
    andamentos.registrar = async () => { throw new Error('banco indisponível'); };
    let estourou = false;
    try {
      await emissao.lavrarPendenciaDeAnexo(interacaoFalsa, { numero: '0002PN-P1', processoNumero: '0002PN' }, [{ posicao: 1, nomeArquivo: 'x.pdf' }]);
    } catch (_) { estourou = true; }
    andamentos.registrar = original;
    ok(estourou === false, '3a: se nem o andamento pode ser gravado, a emissão AINDA assim não cai');
  }

  // -------------------------------------------------------------------------
  console.log('\n4) O loop e a resposta ao emissor:');
  {
    const src = SEM_COMENTARIO(LER('utils', 'emissaoPeca.js'));
    ok(src.length > 20000, '4a: CANÁRIO — utils/emissaoPeca.js foi lido inteiro', `${src.length} chars`);

    // O loop não pode parar no primeiro erro: um anexo ruim não derruba os outros.
    ok(/anexosFalhos\.push\(/.test(src) && !/for \(const \[i, a\] of[\s\S]{0,400}?\breturn\b/.test(src),
      '4b: o loop COLETA a falha e segue — um anexo ruim não impede os outros');
    ok(/catch \(e\) \{[\s\S]{0,200}?console\.error\(`\[pecas\] falha ao juntar o anexo/.test(src),
      '4c: e a falha de cada anexo é logada com a posição (regra do projeto: catch nunca mudo)');

    // O nome do arquivo SÓ pode aparecer no ramo da resposta efêmera.
    ok(/avisoAnexo[\s\S]{0,400}?nomeArquivo/.test(src),
      '4d: a resposta ao EMISSOR nomeia os arquivos (é efêmera, só ele lê)');
    const corpoPendencia = src.slice(src.indexOf('async function lavrarPendenciaDeAnexo'));
    const fim = corpoPendencia.indexOf('\n}\n');
    ok(fim > 50, '4e: CANÁRIO — o corpo de lavrarPendenciaDeAnexo foi RECORTADO (nem vazio, nem o arquivo todo)', `fim=${fim}`);
    ok(!/nomeArquivo/.test(corpoPendencia.slice(0, fim)),
      '4f: e a função que grava nos autos não menciona nomeArquivo em lugar nenhum');

    ok(/Anexar prova/.test(src), '4g: a resposta cita o caminho de conserto pelo nome do botão');
    ok(/n[aã]o preso a esta pe[çc]a|n[aã]o preso [àa] pe[çc]a/.test(src),
      '4h: e é honesta: o conserto junta ao PROCESSO, não à peça — não promete restauração igual');

    const baseline = LER('scripts', 'testes-teor-em-andamentos.js');
    ok(/'utils\/emissaoPeca\.js': 7/.test(baseline),
      '4i: o baseline da varredura anti-vazamento foi atualizado conscientemente');
    ok(/anexo_nao_juntado/.test(baseline), '4j: com a declaração do ato novo e o porquê');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); process.exit(1); }
})();
