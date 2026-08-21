// LOG DE RH — contratação, demissão e licença, com motivo, consultável (21/08/2026).
//
// POR QUE UMA TABELA, e não só a auditoria que já existia: `utils/auditoria.js` POSTA num canal do
// Discord e não guarda nada. Serve para acompanhar ao vivo, não para responder "quem demitiu o
// Fulano em março, e por quê" — para isso alguém teria que rolar meses de canal, e mensagem de
// canal se apaga.
//
// Estas três ações mudam QUEM PODE O QUÊ no tribunal inteiro. Desde 21/08/2026 elas também podem
// ser praticadas por Desembargador e Procurador, não só pela staff — o que aumenta o número de
// mãos e, com ele, a necessidade de o registro ser consultável e não some.
//
// A auditoria no canal CONTINUA: são coisas diferentes. O canal é o aviso; isto é o arquivo.
const db = require('../database/db');

const ACOES = ['contratar', 'demitir', 'licenca'];
const ROTULO = { contratar: '🟢 Contratação', demitir: '🔴 Demissão', licenca: '🟡 Licença' };

/**
 * Texto de resgate: o que precisa ser lançado à mão porque a gravação falhou.
 *
 * Repete TUDO — a linha tem que bastar sozinha, copiada e colada, sem depender de quem leu lembrar
 * do resto. É justamente quando o registro automático falha que a memória humana vira a única
 * cópia, e memória humana não guarda ID do Discord.
 */
function avisoDeFalha(dados, erro, { agora = Date.now() } = {}) {
  const d = dados || {};
  const quando = Math.floor(agora / 1000);
  const motivo = String(d.motivo || '').trim() || '(sem motivo informado)';
  const alvo = d.cargoAlvo ? '<@' + d.alvoId + '> (' + d.cargoAlvo + ')' : '<@' + d.alvoId + '>';
  const detalhe = erro && erro.message ? erro.message : String(erro);
  return [
    '⚠️ **A ação valeu, mas o log de RH NÃO foi gravado.**',
    'O cargo já mudou — nada foi desfeito. O que falhou foi só o registro no arquivo consultável.',
    '**Anote e lance à mão:**',
    '• Ação: **' + (ROTULO[d.acao] || d.acao) + '**',
    '• Alvo: ' + alvo,
    '• Executor: <@' + d.executorId + '> *(' + (d.cargoExecutor || 'Staff/Administração') + ')*',
    '• Motivo: ' + motivo,
    '• Quando: <t:' + quando + ':f>',
    '• Erro técnico: `' + detalhe + '`',
  ].join('\n');
}

/**
 * Grava uma linha do log. Nunca lança: perder o registro é ruim, mas derrubar a demissão no meio
 * é pior — o cargo já foi mexido quando isto roda.
 *
 * MAS NÃO É MAIS MUDO (21/08/2026). Até aqui o catch engolia a falha e devolvia null, e nenhum dos
 * quatro chamadores olhava o retorno: a demissão acontecia, o log não, e ninguém ficava sabendo. O
 * caso não é hipotético — foi exatamente assim que a tabela `logRh` faltando em database/db.js
 * passou despercebida, até um teste tropeçar nela por acaso.
 *
 * O retorno virou { ok, registro, erro, aviso } para que quem clicou possa VER a falha e ter em
 * mãos o que lançar manualmente. O contrato é mantido no que importa: continua sem lançar, e
 * continua não bloqueando nem desfazendo nada.
 *
 * `motivo` é obrigatório por contrato do chamador (o modal exige o campo). Aqui ele é apenas
 * NORMALIZADO: string vazia vira o marcador explícito, para o log nunca mentir dizendo que houve
 * motivo quando não houve.
 */
function registrar({ acao, executorId, cargoExecutor, alvoId, cargoAlvo = null, motivo, guildId = null }) {
  const dados = { acao, executorId, cargoExecutor, alvoId, cargoAlvo, motivo, guildId };
  try {
    const registro = db.inserir('logRh', {
      acao,
      executorId: String(executorId || ''),
      // O cargo de QUEM EXECUTOU fica congelado na linha. Sem isso, ler o log meses depois diria
      // só "Fulano demitiu" — e Fulano pode não ser mais Procurador. O que importa para auditar é
      // com que poder ele agiu NAQUELE momento.
      cargoExecutor: cargoExecutor || 'Staff/Administração',
      alvoId: String(alvoId || ''),
      cargoAlvo: cargoAlvo || null,
      motivo: String(motivo || '').trim() || '(sem motivo informado)',
      guildId,
      criadoEm: new Date().toISOString(),
    });
    return { ok: true, registro, erro: null, aviso: null };
  } catch (e) {
    console.error('[logRh] falha ao gravar ' + acao + ' de ' + alvoId + ': ' + e.message);
    return { ok: false, registro: null, erro: e.message, aviso: avisoDeFalha(dados, e) };
  }
}

/**
 * Últimas linhas, mais recentes primeiro. `filtro` aceita { acao, executorId, alvoId }.
 * `limite` existe porque isto vai para um embed do Discord, que tem teto de 4.096 caracteres.
 */
function consultar({ acao = null, executorId = null, alvoId = null, limite = 15 } = {}) {
  return db.todos('logRh', r => r
    && (!acao || r.acao === acao)
    && (!executorId || r.executorId === String(executorId))
    && (!alvoId || r.alvoId === String(alvoId)))
    .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm))
    .slice(0, limite);
}

// Uma linha legível por registro. Data em <t:...> (timestamp do Discord) para cada um ver no
// próprio fuso — o servidor é de RP e as pessoas não estão todas no mesmo lugar.
function formatar(r) {
  const quando = Math.floor(new Date(r.criadoEm).getTime() / 1000);
  const alvo = r.cargoAlvo ? `<@${r.alvoId}> (${r.cargoAlvo})` : `<@${r.alvoId}>`;
  return `${ROTULO[r.acao] || r.acao} — ${alvo}\n`
    + `por <@${r.executorId}> *(${r.cargoExecutor})* · <t:${quando}:f>\n`
    + `Motivo: ${r.motivo}`;
}

module.exports = { ACOES, registrar, consultar, formatar, avisoDeFalha, ROTULO };
