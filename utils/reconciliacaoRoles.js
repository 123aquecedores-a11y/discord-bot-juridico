// RECONCILIAÇÃO DE ROLES CONTRA O RH (21/08/2026)
//
// POR QUE EXISTE, e por que não bastava consertar o catch:
//
// utils/canais.js dá `ViewChannel` nos canais-ticket POR ROLE DO DISCORD (CARGOS_LEITURA_TICKET).
// Quer dizer que quem abre a porta dos autos é a ROLE, não o RH. Enquanto isso, o `roles.remove()`
// da demissão vivia sob `.catch(() => {})`: falhava calado, e o demitido continuava lendo tudo.
//
// Não é hipótese. Em 21/08/2026 a checagem de produção achou um membro com a role de Promotor e
// NENHUM registro no RH — nem ativo, nem inativo — enxergando os 4 tickets abertos do tribunal.
//
// Fazer o catch gritar avisa; não fecha a porta. Fecha aqui: o RH é a fonte da verdade e a role
// passa a SEGUIR o RH. Com isto, `roles.remove` falhar deixa de ser VAZAMENTO e vira ATRASO — a
// próxima passada corrige sozinha.
//
// DIREÇÃO DA VERDADE, e é o oposto do que utils/responsaveis.js faz de propósito: lá a detecção de
// fantasma NÃO pode olhar a role (role errada geraria reatribuição destrutiva de ticket). Aqui a
// role é justamente o que está sendo corrigido, e o RH é quem manda. As duas decisões concordam:
// em nenhum caso a role é tratada como verdade.
const db = require('../database/db');
const config = require('../config');

// A ÚNICA definição de "que role corresponde a que cargo" no projeto. Estava em commands/rh.js e
// veio para cá porque agora dois lugares precisam dela — e regra de cargo copiada em dois arquivos
// é a receita para o terceiro nascer torto.
const CHAVE_ROLE_POR_CARGO = {
  Delegado: 'roleDelegadoId',
  Promotor: 'rolePromotorId',
  Juiz: 'roleJuizId',
  Advogado: 'roleAdvogadoId',
  Desembargador: 'roleDesembargadorId',
  Procurador: 'roleProcuradorId',
};

function roleIdPorCargo(cargo) {
  const chave = CHAVE_ROLE_POR_CARGO[cargo];
  return chave ? config[chave] : undefined;
}

// Todas as roles de cargo configuradas — o universo que esta reconciliação pode tocar. Role de
// staff, de super staff e qualquer outra do servidor estão FORA por construção: o RH não fala
// sobre elas, então a reconciliação não tem o que dizer a respeito.
function rolesDeCargoConfiguradas() {
  const m = new Map();
  for (const [cargo, chave] of Object.entries(CHAVE_ROLE_POR_CARGO)) {
    const id = config[chave];
    if (id) m.set(String(id), cargo);
  }
  return m;
}

// LICENÇA MANTÉM A ROLE. O registro continua `ativo: true` com `licenca: true` — a pessoa segue no
// quadro, apenas afastada. Tirar a role aqui equivaleria a demitir quem pediu férias.
function cargosAtivosDe(discordId) {
  return db.todos('rh', r => r && r.discordId === String(discordId) && r.ativo).map(r => r.cargo);
}

// TRAVA DE MASSA, no mesmo espírito do LIMITE_RECONCILIACAO_SEM_CARGO de utils/responsaveis.js:
// muitas remoções de uma vez tem cara de RH zerado ou banco recém-restaurado, não de demissão em
// massa. Acima do limite, NENHUMA remoção acontece e a rodada pede conferência humana.
//
// Adições NÃO entram na trava: dar a role a quem tem o cargo no RH não abre porta que o RH já não
// tenha aberto, e travar isso emperraria uma contratação legítima.
const LIMITE_REMOCOES = 5;

/**
 * Reconcilia UM membro. É o caminho de evento — chamado logo depois de contratar/demitir/promover,
 * quando já se sabe exatamente quem mudou e varrer o servidor inteiro seria desperdício.
 * Nunca lança: o chamador já executou a ação principal.
 */
async function reconciliarMembro(guild, discordId, { motivo = 'evento' } = {}) {
  const resultado = { removidas: [], adicionadas: [], falhas: [] };
  try {
    const membro = await guild.members.fetch(String(discordId)).catch(() => null);
    if (!membro) return resultado;
    const universo = rolesDeCargoConfiguradas();
    const cargos = new Set(cargosAtivosDe(discordId));

    for (const [roleId, cargo] of universo) {
      const tem = membro.roles.cache.has(roleId);
      const deveria = cargos.has(cargo);
      if (tem === deveria) continue;
      try {
        if (deveria) { await membro.roles.add(roleId); resultado.adicionadas.push({ discordId: membro.id, tag: membro.user?.tag, cargo }); }
        else { await membro.roles.remove(roleId); resultado.removidas.push({ discordId: membro.id, tag: membro.user?.tag, cargo }); }
      } catch (e) {
        // Hierarquia de role, permissão do bot, rate limit. Registrado, nunca engolido.
        resultado.falhas.push({ discordId: membro.id, cargo, erro: e.message });
        console.error(`[roles] falha ao ${deveria ? 'adicionar' : 'remover'} ${cargo} de ${membro.id}: ${e.message}`);
      }
    }
    logar(resultado, motivo);
  } catch (e) {
    console.error(`[roles] reconciliarMembro(${discordId}) falhou: ${e.message}`);
  }
  return resultado;
}

/**
 * Reconcilia o SERVIDOR INTEIRO. É o caminho de varredura — roda no boot, como rede de segurança
 * para o que os eventos perderam (bot fora do ar, role mexida na mão, `roles.remove` que falhou).
 * Nunca lança.
 */
async function reconciliarTodos(guild, { limiteRemocoes = LIMITE_REMOCOES, motivo = 'boot' } = {}) {
  const resultado = { removidas: [], adicionadas: [], falhas: [], abortouRemocoes: false, examinados: 0 };
  try {
    const universo = rolesDeCargoConfiguradas();
    if (!universo.size) {
      console.warn('[roles] nenhuma role de cargo configurada — reconciliação não tem o que fazer.');
      return resultado;
    }
    const membros = await guild.members.fetch();

    // Duas passadas: a primeira só DECIDE, a segunda executa. Sem isso a trava de massa não teria
    // como existir — as primeiras remoções já teriam acontecido quando a conta estourasse.
    const planoRemover = []; const planoAdicionar = [];
    for (const membro of membros.values()) {
      if (membro.user?.bot) continue;
      resultado.examinados++;
      const cargos = new Set(cargosAtivosDe(membro.id));
      for (const [roleId, cargo] of universo) {
        const tem = membro.roles.cache.has(roleId);
        const deveria = cargos.has(cargo);
        if (tem === deveria) continue;
        (deveria ? planoAdicionar : planoRemover).push({ membro, roleId, cargo });
      }
    }

    if (planoRemover.length > limiteRemocoes) {
      resultado.abortouRemocoes = true;
      console.warn(
        `⚠️ [roles] ${planoRemover.length} roles sobrando de uma vez (limite ${limiteRemocoes}) — `
        + 'isso tem cara de RH zerado ou banco restaurado, não de demissão em massa. NENHUMA remoção '
        + 'foi feita nesta rodada; confira o quadro no /rh. As adições seguiram normalmente.',
      );
      for (const p of planoRemover) console.warn(`   sobrando: ${p.membro.user?.tag} (${p.membro.id}) tem ${p.cargo} sem o cargo no RH`);
    } else {
      for (const p of planoRemover) {
        try {
          await p.membro.roles.remove(p.roleId);
          resultado.removidas.push({ discordId: p.membro.id, tag: p.membro.user?.tag, cargo: p.cargo });
        } catch (e) {
          resultado.falhas.push({ discordId: p.membro.id, cargo: p.cargo, erro: e.message });
          console.error(`[roles] falha ao remover ${p.cargo} de ${p.membro.id}: ${e.message}`);
        }
      }
    }

    for (const p of planoAdicionar) {
      try {
        await p.membro.roles.add(p.roleId);
        resultado.adicionadas.push({ discordId: p.membro.id, tag: p.membro.user?.tag, cargo: p.cargo });
      } catch (e) {
        resultado.falhas.push({ discordId: p.membro.id, cargo: p.cargo, erro: e.message });
        console.error(`[roles] falha ao adicionar ${p.cargo} a ${p.membro.id}: ${e.message}`);
      }
    }

    logar(resultado, motivo);
    await avisarSeCorrigiu(guild, resultado, motivo);
  } catch (e) {
    console.error(`[roles] reconciliarTodos falhou: ${e.message}`);
  }
  return resultado;
}

// SE ELA CORRIGIU ALGO, ALGUÉM ERROU ANTES. O log existe para isso: silêncio significa que estava
// tudo certo, e qualquer linha aqui é um defeito que aconteceu em algum lugar.
function logar(r, motivo) {
  if (!r.removidas.length && !r.adicionadas.length && !r.falhas.length) return;
  for (const x of r.removidas) console.warn(`[roles] REMOVIDA ${x.cargo} de ${x.tag || x.discordId} — não tem o cargo no RH (${motivo})`);
  for (const x of r.adicionadas) console.warn(`[roles] ADICIONADA ${x.cargo} a ${x.tag || x.discordId} — tem o cargo no RH e estava sem a role (${motivo})`);
  for (const x of r.falhas) console.error(`[roles] FALHA em ${x.discordId} (${x.cargo}): ${x.erro}`);
}

async function avisarSeCorrigiu(guild, r, motivo) {
  const houve = r.removidas.length || r.adicionadas.length || r.falhas.length || r.abortouRemocoes;
  if (!houve) return;
  const linhas = ['🔧 **Reconciliação de cargos (roles × RH)** — ' + motivo];
  if (r.abortouRemocoes) {
    linhas.push('', '⚠️ **Remoções ABORTADAS**: sobrou role demais de uma vez, o que tem cara de RH zerado. Confira o quadro no `/rh` antes de qualquer coisa.');
  }
  for (const x of r.removidas) linhas.push(`• ➖ **${x.cargo}** removido de <@${x.discordId}> — sem o cargo no RH`);
  for (const x of r.adicionadas) linhas.push(`• ➕ **${x.cargo}** dado a <@${x.discordId}> — tem o cargo no RH e estava sem a role`);
  for (const x of r.falhas) linhas.push(`• ❌ não consegui mexer em <@${x.discordId}> (${x.cargo}): \`${x.erro}\``);
  linhas.push('', '*A role do Discord abre os canais-ticket. Se apareceu linha aqui, alguém esteve com acesso que o RH não dava.*');
  // require tardio: utils/auditoria.js já requer database/db, e o ciclo com este módulo não
  // acontece hoje — mas amarrar no topo criaria a chance de acontecer depois.
  await require('./auditoria').avisar(guild, linhas.join('\n'));
}

module.exports = {
  CHAVE_ROLE_POR_CARGO, LIMITE_REMOCOES,
  roleIdPorCargo, rolesDeCargoConfiguradas,
  reconciliarMembro, reconciliarTodos,
};
