/* eslint-disable */
// BLOCO C — válvula por tipo de ato + métrica obrigatória da SPEC §7. Rode com:
//   node scripts/testes-valvula-por-tipo.js
//
// A válvula deixou de ser número único (24h para todos). As duas pontas não têm a mesma
// disponibilidade: juiz e promotor vivem no fórum e se telefonam dentro do jogo — para eles 24h era
// tempo de sobra para simplesmente ESPERAR a válvula em vez de se encontrar, o que faz da válvula o
// caminho barato (o oposto do desenho). Advogado, parte e cidadão são intermitentes; apertar ali
// puniria quem estava fazendo certo.
//
// A métrica existe porque a SPEC §7 a exige e ninguém media: é o número que decide se o desenho
// está estrangulando o servidor, e é o gatilho combinado para recuar (§11.2.2).

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-valvula-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';
delete process.env.VALVULA_FORUM_H;
delete process.env.VALVULA_EXTERNA_H;

const db = require('../database/db');
const pecas = require('../utils/pecas');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const H = 60 * 60 * 1000;

(async () => {
console.log('\n=== Bloco C: válvula por tipo de ato + métrica ===\n');

console.log('1) O prazo depende do PAPEL de quem recebe');
{
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) === 6 * H, '1a: Juiz → 6h (vive no fórum, encontro é barato)');
  ok(pecas.valvulaMsPara({ papel: 'Promotor' }) === 6 * H, '1b: Promotor → 6h');
  ok(pecas.valvulaMsPara({ papel: 'Advogado' }) === 48 * H, '1c: Advogado → 48h (disponibilidade intermitente)');
  ok(pecas.valvulaMsPara({ papel: 'Autor' }) === 48 * H, '1d: Autor (parte) → 48h');
  ok(pecas.valvulaMsPara(null) === 48 * H, '1e: sem destinatário cai no prazo LONGO — falha para o lado que não pune ninguém');
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) < pecas.valvulaMsPara({ papel: 'Advogado' }),
    '1f: a invariante do desenho — aperta onde o encontro é fácil, afrouxa onde é difícil');
}

console.log('\n2) Configurável, e env inválida NÃO desliga a válvula em silêncio');
{
  process.env.VALVULA_FORUM_H = '3';
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) === 3 * H, '2a: env válida vale');
  process.env.VALVULA_FORUM_H = '0';
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) === 6 * H, '2b: env fora da faixa (0) cai no padrão — não desliga a válvula');
  process.env.VALVULA_FORUM_H = 'abacaxi';
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) === 6 * H, '2c: env com lixo cai no padrão');
  process.env.VALVULA_FORUM_H = '9999';
  ok(pecas.valvulaMsPara({ papel: 'Juiz' }) === 6 * H, '2d: env absurda cai no padrão — não eterniza a pendência');
  delete process.env.VALVULA_FORUM_H;
}

console.log('\n3) A peça nasce com o prazo certo, POR DESTINATÁRIO');
{
  const p = db.inserir('processos', {
    numero: '5001CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'ingame',
    juiz: 'id_juiz', habilitacoes: [{ id: 1, advogadoId: 'id_adv', status: 'Aprovado' }],
  });
  const agora = Date.now();
  const g = pecas.gerar({
    processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
    autorId: 'id_juiz', autorPapel: 'Juiz', texto: 'teor',
    // Um ato com destinatários de disponibilidade DIFERENTE: é onde o número único falhava.
    destinatarios: [{ papel: 'Juiz' }, { papel: 'Advogado', habilitacaoId: 1 }],
    agora,
  });
  const dJuiz = g.peca.destinatarios.find(d => d.papel === 'Juiz');
  const dAdv = g.peca.destinatarios.find(d => d.papel === 'Advogado');
  const horas = (d) => Math.round((new Date(d.valvulaEm).getTime() - agora) / H);

  ok(horas(dJuiz) === 6, '3a: destinatário Juiz nasce com 6h', `${horas(dJuiz)}h`);
  ok(horas(dAdv) === 48, '3b: destinatário Advogado nasce com 48h', `${horas(dAdv)}h`);
  ok(dJuiz.valvulaEm !== dAdv.valvulaEm, '3c: prazos DIFERENTES no mesmo ato — o número único não conseguia isso');
}

console.log('\n4) A varredura destrava cada um no seu prazo');
{
  const base = Date.now();
  const antes8h = pecas.varrerValvula({ agora: base + 8 * H });
  const peca = db.buscarPorNumero('pecas', db.todos('pecas', x => x.processoNumero === '5001CV')[0].numero);
  const dJuiz = peca.destinatarios.find(d => d.papel === 'Juiz');
  const dAdv = peca.destinatarios.find(d => d.papel === 'Advogado');

  ok(!!dJuiz.recebidoEm && dJuiz.automatico === true, '4a: às 8h o destinatário do fórum JÁ caiu na válvula (prazo de 6h)');
  ok(!dAdv.recebidoEm, '4b: ...e o advogado continua pendente, porque o prazo dele é 48h');
  ok(antes8h.length === 1, '4c: a varredura reportou a peça destravada');

  pecas.varrerValvula({ agora: base + 50 * H });
  const depois = db.buscarPorNumero('pecas', peca.numero);
  ok(!!depois.destinatarios.find(d => d.papel === 'Advogado').recebidoEm, '4d: às 50h o advogado também cai');
}

console.log('\n5) MÉTRICA da SPEC §7 — quantos destravam pela válvula, por tipo');
{
  // Um ato recebido PESSOALMENTE, para a métrica ter os dois lados.
  const p2 = db.inserir('processos', {
    numero: '5002CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'ingame',
    juiz: 'id_juiz2', habilitacoes: [{ id: 1, advogadoId: 'id_adv2', status: 'Aprovado' }],
  });
  const g2 = pecas.gerar({
    processoTabela: 'processos', processoNumero: p2.numero, tipo: 'peticao_incidental',
    autorId: 'id_adv2', autorPapel: 'Advogado', texto: 'teor', destinatarios: [{ papel: 'Juiz' }],
  });
  pecas.abrirEntrega(g2.peca.numero, 'id_adv2');
  const r = pecas.receber(g2.peca.numero, 'id_juiz2', { tokenLido: db.buscarPorNumero('pecas', g2.peca.numero).destinatarios[0].token });
  ok(r.ok, '5-setup: um ato recebido em cena, para a métrica ter os dois lados');

  const rel = pecas.relatorioValvula();
  ok(rel.total === 3, '5a: conta todos os recebimentos do período', `total ${rel.total}`);
  ok(rel.valvula === 2 && rel.pessoal === 1, '5b: separa válvula de entrega pessoal pelo FATO registrado', `v=${rel.valvula} p=${rel.pessoal}`);
  ok(Math.abs(rel.proporcaoValvula - 2 / 3) < 0.001, '5c: a proporção é o número que a SPEC manda olhar');

  ok(rel.porTipo.intimacao_juiz.valvula === 2, '5d: quebrado POR TIPO — a intimação caiu 2x na válvula');
  ok(rel.porTipo.peticao_incidental.pessoal === 1, '5e: ...e a petição foi entregue em cena');
  ok(rel.porTipo.intimacao_juiz.porPapel.Juiz.valvula === 1
    && rel.porTipo.intimacao_juiz.porPapel.Advogado.valvula === 1,
    '5f: e por PAPEL dentro do tipo — é o que diz ONDE o encontro não acontece');

  // Sem atos no período, proporção é null e não 0: zero pareceria "está tudo ótimo".
  const vazio = pecas.relatorioValvula({ desde: '2020-01-01T00:00:00.000Z', ate: '2020-01-02T00:00:00.000Z' });
  ok(vazio.total === 0 && vazio.proporcaoValvula === null,
    '5g: período sem atos devolve proporção null, não 0 (0 mentiria dizendo "tudo ótimo")');
}

console.log('\n5h) DIMENSÃO DE HORÁRIO — distingue "ninguém se encontra" de "madrugada comeu o prazo"');
{
  // Sem esta dimensão o número engana: o relógio de 6h corre de madrugada, quando não há ninguém no
  // fórum. Um ato emitido no fim da sessão da noite estoura sem que ninguém tenha falhado — e a
  // leitura ingênua ("proporção alta = as pessoas não se encontram") levaria ao ajuste errado.
  const rel = pecas.relatorioValvula();
  ok(Array.isArray(rel.disparosPorHora) && rel.disparosPorHora.length === 24, '5h-a: histograma de 24 horas dos disparos');
  ok(Array.isArray(rel.emissoesPorHora) && rel.emissoesPorHora.length === 24,
    '5h-b: e das EMISSÕES — só a hora do disparo não distingue "emitido de madrugada" de "emitido de tarde e ignorado"');
  ok(rel.disparosPorHora.reduce((a, b) => a + b, 0) === rel.valvula, '5h-c: o histograma soma exatamente os disparos contados');

  // Fuso: o container roda em UTC e os jogadores vivem em BRT. Histograma em UTC apontaria a faixa
  // errada por 3 horas — e apontar a faixa errada com confiança é pior que não ter a faixa.
  ok(rel.fusoUsado === -3, '5h-d: histograma em horário LOCAL (padrão BRT), não UTC', `fuso ${rel.fusoUsado}`);
  process.env.FUSO_HORARIO_H = '99';
  ok(pecas.relatorioValvula().fusoUsado === -3, '5h-e: fuso absurdo cai no padrão em vez de valer');
  delete process.env.FUSO_HORARIO_H;

  // Concentração só é calculada com amostra: abaixo de 5 disparos qualquer pico é ruído, e apontar
  // "faixa crítica" com 2 eventos seria inventar diagnóstico.
  ok(rel.faixaCritica === null, '5h-f: com menos de 5 disparos NÃO aponta faixa crítica (2 eventos não são padrão)');
}

console.log('\n5i) Concentração detectada quando existe de verdade');
{
  // Fabrica 10 disparos concentrados numa faixa para exercitar a detecção.
  const p = db.inserir('processos', { numero: '5010CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'ingame' });
  const base = new Date('2026-08-10T09:00:00.000Z').getTime(); // 06:00 BRT
  for (let i = 0; i < 10; i++) {
    const g = pecas.gerar({
      processoTabela: 'processos', processoNumero: p.numero, tipo: 'intimacao_juiz',
      autorId: 'j', autorPapel: 'Juiz', texto: 't', destinatarios: [{ papel: 'Juiz' }],
      agora: base + i * 60000,
    });
    // Marca como disparo de válvula na mesma faixa horária.
    const peca = db.buscarPorNumero('pecas', g.peca.numero);
    db.atualizar('pecas', peca.numero, {
      destinatarios: peca.destinatarios.map(d => ({
        ...d, recebidoEm: new Date(base + i * 60000).toISOString(), automatico: true,
      })),
    });
  }
  const rel = pecas.relatorioValvula();
  ok(rel.faixaCritica !== null, '5i-a: com amostra suficiente, a faixa crítica é calculada');
  ok(rel.faixaCritica.concentrado === true, '5i-b: detecta a concentração (>=50% numa faixa de 6h)');
  ok(rel.faixaCritica.inicio >= 1 && rel.faixaCritica.inicio <= 6,
    '5i-c: e aponta a faixa da MADRUGADA/manhã em horário local, não em UTC', `inicio ${rel.faixaCritica.inicio}h`);
}

console.log('\n6) Troca de responsável reinicia com o prazo DO PAPEL, não 24h fixo');
{
  const p3 = db.inserir('processos', {
    numero: '5003CV', tipo: 'Civil', status: 'Instrução', modoEntrega: 'ingame', juiz: 'id_j3',
  });
  const agora = Date.now();
  const g3 = pecas.gerar({
    processoTabela: 'processos', processoNumero: p3.numero, tipo: 'peticao_incidental',
    autorId: 'id_a3', autorPapel: 'Advogado', texto: 't', destinatarios: [{ papel: 'Juiz' }], agora,
  });
  const depois = agora + 100 * H;
  pecas.reiniciarValvulaPorTroca('processos', p3.numero, 'Juiz', { agora: depois });
  const d = db.buscarPorNumero('pecas', g3.peca.numero).destinatarios[0];
  const horas = Math.round((new Date(d.valvulaEm).getTime() - depois) / H);
  ok(horas === 6, '6a: o substituto herda o relógio do PAPEL (6h para Juiz), não um 24h genérico', `${horas}h`);
}


console.log('\n7) MECANISMO DE CONSULTA — a métrica é EMPURRADA, não fica esperando quem souber dela');
{
  // Métrica que só existe para quem sabe que existe é código órfão de outro tipo: construída,
  // testada e nunca acionada. Já aconteceu cinco vezes neste projeto. Por isso o relatório é
  // publicado sozinho, e este teste prova que existe caminho de produção até ele.
  const emissao = require('../utils/emissaoPeca');
  const estado = require('../utils/estado');
  const enviados = [];
  const guildFake = { channels: { fetch: async () => ({ isTextBased: () => true, send: async (o) => { enviados.push(o); } }) } };

  const CHAVE = 'valvulaRelatorioSemanalEm';
  estado.definir(CHAVE, null);

  const t0 = Date.now();
  await emissao.publicarRelatorioSemanal(guildFake, { agora: t0 });
  ok(enviados.length === 0, '7a: na PRIMEIRA execução não publica — seria um relatório de "desde o começo dos tempos", não de uma semana');
  ok(!!estado.obter(CHAVE), '7b: ...mas marca o início da contagem');

  await emissao.publicarRelatorioSemanal(guildFake, { agora: t0 + 60000 });
  ok(enviados.length === 0, '7c: um minuto depois NÃO republica (sem spam — spam é como a staff para de ler)');

  await emissao.publicarRelatorioSemanal(guildFake, { agora: t0 + 8 * 24 * 60 * 60 * 1000 });
  ok(enviados.length === 1, '7d: passada a semana, publica sozinho');
  const txt = (enviados[0] && enviados[0].content) || '';
  ok(/relat[óo]rio semanal/i.test(txt), '7e: a mensagem se identifica');
  ok(/v[áa]lvula/i.test(txt), '7f: e traz o número que a SPEC §7 manda olhar');
  ok(/SPEC/.test(txt), '7g: ...citando a origem da exigência, para quem lê saber por que aquilo existe');

  // O marcador é PERSISTIDO: sem isso o relatório sairia de novo a cada boot do bot.
  const marcado = estado.obter(CHAVE);
  await emissao.publicarRelatorioSemanal(guildFake, { agora: t0 + 8 * 24 * 60 * 60 * 1000 + 60000 });
  ok(enviados.length === 1, '7h: logo após publicar, não republica — o marcador persistido segura');
  ok(estado.obter(CHAVE) === marcado, '7i: e o marcador não foi reescrito à toa');
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
