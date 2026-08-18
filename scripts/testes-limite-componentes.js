/* eslint-disable */
// Testes de regressão para a classe de erro DiscordAPIError[50035] "components[BASE_TYPE_MAX_LENGTH]
// must be 5 or fewer" — encontrada em produção em 18/08/2026 quando o botão do interruptor "Modo
// Entrega In-Game" virou a SEXTA ActionRow do painel principal (Discord aceita no máximo 5 ActionRow
// por mensagem — um limite SEPARADO do limite de 5 componentes DENTRO de cada linha).
//
// Este arquivo garante as DUAS invariantes do Discord para todo painel construído dinamicamente:
//   1. cada ActionRow tem no máximo 5 componentes;
//   2. o array `components` de uma mensagem tem no máximo 5 ActionRows.
// discord.js NÃO valida nenhuma das duas no lado do cliente (confirmado manualmente: addComponents
// aceita 6 botões numa linha sem lançar) — quem trava isso somos nós, aqui.
//
// Cobertura:
//   - commands/painel.js `botoesMenuPrincipal`: a função que quebrou. Sweep de TODAS as combinações
//     de staff × revisão-automática-ligada × modo-entrega-ligado (as únicas flags que mudam o
//     resultado), porque esse menu é escrito à mão (linha(...) fixas) — o risco existe de novo toda
//     vez que alguém adicionar um botão sem contar as linhas existentes.
//   - commands/processo.js `montarPainelAcoes`/`abrirHubProcesso` (sistema de hubs por cargo): aqui o
//     empacotamento é automático (empacotarBotoes corta de 5 em 5), então o risco não é "esqueceram
//     de contar" e sim "o catálogo de ações cresceu demais". Testado estruturalmente contra
//     HUBS_PROCESSO/ACOES_UNIVERSAIS_PAINEL, para pegar esse crescimento ANTES de precisar de 26
//     ações num hub só pra reproduzir em produção.
//
// Fora de escopo (checado manualmente hoje, não coberto por teste automatizado): os outros ~19
// arquivos que criam ActionRowBuilder (medida.js, oficio.js, ficha.js, peticao.js, supervisao.js
// etc.) — cada um espalha suas linhas por VÁRIAS mensagens/telas diferentes, não uma única lista
// editada à mão como botoesMenuPrincipal. Se um novo painel nesse mesmo formato (lista fixa de
// linha(...) que cresce por edição manual) for criado, replique o padrão de sweep usado aqui.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-limite-componentes-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';

const db = require('../database/db');
const modoEntrega = require('../utils/modoEntrega');
const painel = require('../commands/painel');
const processoCmd = require('../commands/processo');
const { ButtonBuilder, ButtonStyle } = require('discord.js');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

// Confere as duas invariantes do Discord num array de ActionRowBuilder já pronto para virar
// `components:` numa mensagem.
function checarLimites(rows, nome) {
  const okLinhas = rows.length <= 5;
  ok(okLinhas, `${nome}: no máximo 5 ActionRow (tinha ${rows.length})`, okLinhas ? '' : 'estourou o limite de 5 linhas por mensagem — exatamente o bug de produção de 18/08');

  let piorLinha = 0;
  for (const row of rows) {
    const n = (row.components || []).length;
    piorLinha = Math.max(piorLinha, n);
  }
  const okComponentes = piorLinha <= 5;
  ok(okComponentes, `${nome}: no máximo 5 componentes por linha (pior linha tinha ${piorLinha})`, okComponentes ? '' : 'linha com mais de 5 botões');
}

function fakeInteraction({ staff, ehDelegado = false, ehPromotor = false, ehJuiz = false, userId = 'id_1' }) {
  return {
    guild: { id: 'guild1' },
    user: { id: userId },
    member: {
      permissions: { has: () => !!staff },
      roles: { cache: { has: () => false } },
    },
    _cargos: { Delegado: ehDelegado, Promotor: ehPromotor, Juiz: ehJuiz },
  };
}

(async () => {
console.log('\n=== Limite de componentes por painel (regressão do DiscordAPIError 50035) ===\n');

console.log('1) commands/painel.js — botoesMenuPrincipal: sweep de todas as combinações de flags');
{
  // temCargo/isAdmin/isSuperStaff/podeEmitirOficio/fichaCmd.podeConsultar/ministerioPublico.ehMembroDoMP/
  // supervisao.podeSupervisionar todos aceitam `staff` (isAdmin) como caminho de "true" — então o
  // pior caso de verdade (todo botão condicional visível ao mesmo tempo) é simplesmente staff=true.
  // As únicas flags que o próprio botoesMenuPrincipal lê fora de `staff` são a preferência pessoal
  // de revisão automática e o estado do interruptor — por isso o sweep é só destas três.
  const preferencias = require('../utils/preferencias');

  let combinacoes = 0;
  for (const staff of [true, false]) {
    for (const revAuto of [true, false]) {
      for (const modoLigado of [true, false]) {
        combinacoes++;
        const userId = `id_sweep_${combinacoes}`;
        // usuário novo nasce com revisaoAutomaticaLigada() === false; alternar() uma vez, se
        // precisar de true, é o único jeito de setar sem função dedicada de "definir".
        if (revAuto) preferencias.alternarRevisaoAutomatica(userId);
        if (modoLigado) modoEntrega.ligar('guild1', userId); else modoEntrega.desligar('guild1', userId);

        const i = fakeInteraction({ staff, userId });
        const rows = painel.botoesMenuPrincipal(i);
        checarLimites(rows, `botoesMenuPrincipal(staff=${staff}, revAuto=${revAuto}, modoLigado=${modoLigado})`);
      }
    }
  }
  ok(combinacoes === 8, '1z: sweep cobriu as 8 combinações esperadas (2×2×2)', `cobriu ${combinacoes}`);
}

console.log('\n2) commands/processo.js — catálogo de hubs não pode crescer a ponto de estourar 5 linhas');
{
  const { HUBS_PROCESSO, ACOES_UNIVERSAIS_PAINEL, empacotarBotoes } = processoCmd;

  const botaoFalso = (id) => new ButtonBuilder().setCustomId(`x:${id}`).setLabel(id.slice(0, 80)).setStyle(ButtonStyle.Secondary);

  // Pior caso do painel principal do processo: TODOS os hubs visíveis ao mesmo tempo (mesmo que
  // hoje hubjuiz/hubdelegado sejam mutuamente exclusivos por regra de negócio — testar o teto
  // estrutural, não o alcançável hoje, é o que protege contra uma mudança de regra futura) + todas
  // as ações universais.
  const totalBotoesPainel = HUBS_PROCESSO.length + ACOES_UNIVERSAIS_PAINEL.length;
  const rowsPainel = empacotarBotoes(Array.from({ length: totalBotoesPainel }, (_, i) => botaoFalso(`painel${i}`)));
  checarLimites(rowsPainel, `montarPainelAcoes (pior caso: ${totalBotoesPainel} botões possíveis)`);

  // Pior caso de CADA hub: todas as ações declaradas no catálogo daquele hub visíveis ao mesmo tempo.
  for (const hub of HUBS_PROCESSO) {
    const rowsHub = empacotarBotoes(hub.acoes.map((id) => botaoFalso(id)));
    checarLimites(rowsHub, `hub "${hub.id}" (pior caso: ${hub.acoes.length} ações no catálogo)`);
  }

  ok(HUBS_PROCESSO.length + ACOES_UNIVERSAIS_PAINEL.length <= 25,
    '2z: total de botões possíveis no painel do processo deixa folga antes de precisar de mais de 5 linhas',
    `${HUBS_PROCESSO.length} hubs + ${ACOES_UNIVERSAIS_PAINEL.length} universais`);
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
})();
