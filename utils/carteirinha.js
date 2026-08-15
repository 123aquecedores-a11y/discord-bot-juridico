// Carteiras funcionais: OAB (Advogado) e carteira de cargo (Juiz/Desembargador/Promotor/
// Procurador). Ponto ÚNICO usado pela aprovação/promoção de cargo (contratarComRole), pelo
// backfill e pela edição global. Contadores e IDs ficam no storage `estado`.
const db = require('../database/db');
const estado = require('./estado');
const rh = require('./rh');
const { gerarCarteirinhaPNG, gerarCarteiraCargoPNG } = require('../services/gerarDocumentoPNG');

// Cargos que têm carteira de cargo → template + rótulo cheio (vai em {{CARGO}}, em MAIÚSCULAS).
const CARTEIRA_POR_CARGO = {
  Juiz:          { arquivo: 'carteira_juiz_template.html',          label: 'Juiz de Direito' },
  Desembargador: { arquivo: 'carteira_desembargador_template.html', label: 'Desembargador' },
  Promotor:      { arquivo: 'carteira_promotor_template.html',      label: 'Promotor de Justiça' },
  Procurador:    { arquivo: 'carteira_procurador_template.html',    label: 'Procurador de Justiça' },
};

// ---- OAB (Advogado) ----
function formatarOAB(n) {
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)}.${s.slice(3)}`;
}

function proximoOAB() {
  let atual = parseInt(estado.obter('contadorOAB'), 10);
  if (!Number.isFinite(atual)) {
    atual = db.todos('rh').reduce((max, r) => {
      const n = parseInt(String(r.oab || '').replace(/\D/g, ''), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
  }
  const prox = atual + 1;
  estado.definir('contadorOAB', String(prox));
  return formatarOAB(prox);
}

// ---- Matrícula funcional (Juiz/Desembargador/Promotor/Procurador) ----
function formatarMatricula(n) {
  return String(n).padStart(6, '0');
}

// Contador global de matrícula em estado.contadorMatricula. Inicializa (1ª vez) a partir da maior
// matrícula já gravada em rh, pra nunca reemitir um número já usado.
function proximoMatricula() {
  let atual = parseInt(estado.obter('contadorMatricula'), 10);
  if (!Number.isFinite(atual)) {
    atual = db.todos('rh').reduce((max, r) => {
      const n = parseInt(String(r.matricula || '').replace(/\D/g, ''), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
  }
  const prox = atual + 1;
  estado.definir('contadorMatricula', String(prox));
  return formatarMatricula(prox);
}

function hojeBR() { return new Date().toLocaleDateString('pt-BR'); }

function resolverDataInscricao(registro) {
  if (registro.oabDesde) return registro.oabDesde;
  if (registro.criado_em && registro.criado_em.includes('/')) return registro.criado_em.split(',')[0].trim();
  return hojeBR();
}

async function nomeDe(guild, discordId, registro) {
  const membro = await guild.members.fetch(discordId).catch(() => null);
  return { membro, nome: registro.nomePersonagem || (membro ? membro.displayName : 'Titular') };
}

/**
 * Emite a carteira CERTA conforme o cargo ATIVO da pessoa e envia na DM:
 *  - Advogado → carteirinha da OAB (número OAB).
 *  - Juiz/Desembargador/Promotor/Procurador → carteira funcional do cargo (matrícula).
 *  - outros cargos → nada (retorna { ok:false, erro:'sem_carteira' }).
 * DM fechada / falha de render: capturada e logada, NÃO lança.
 * @returns {Promise<{ok:boolean, tipo?:string, numero?:string, dmOk?:boolean, png?:Buffer, nome?:string, erro?:string}>}
 */
async function emitirCarteirinha(guild, discordId) {
  const registro = rh.getCargo(discordId);
  if (!registro) return { ok: false, erro: 'sem_cargo' };

  // ---- Advogado: OAB ----
  if (registro.cargo === 'Advogado') {
    const patch = {};
    let oab = registro.oab;
    if (!oab) { oab = proximoOAB(); patch.oab = oab; }
    const dataInscricao = resolverDataInscricao(registro);
    if (!registro.oabDesde) patch.oabDesde = dataInscricao;
    if (Object.keys(patch).length) rh.atualizarDados(discordId, patch);

    const { membro, nome } = await nomeDe(guild, discordId, registro);
    let png;
    try {
      png = await gerarCarteirinhaPNG({ nome, rg: registro.rg || '—', oab, data: dataInscricao });
    } catch (e) {
      console.error(`[carteirinha] falha ao renderizar OAB (${discordId}):`, e.message);
      return { ok: false, erro: 'render', numero: oab, nome };
    }
    let dmOk = false;
    if (membro) {
      try {
        await membro.send({ content: `🪪 Sua **carteira de identidade de advogado (OAB/SP)** — inscrição **${oab}**.`, files: [{ attachment: png, name: `carteira-oab-${oab.replace(/\D/g, '')}.png` }] });
        dmOk = true;
      } catch (e) { console.error(`[carteirinha] DM fechada/erro (OAB ${discordId}):`, e.message); }
    }
    return { ok: true, tipo: 'oab', numero: oab, dmOk, png, nome };
  }

  // ---- Juiz / Desembargador / Promotor / Procurador: carteira funcional ----
  const cfg = CARTEIRA_POR_CARGO[registro.cargo];
  if (!cfg) return { ok: false, erro: 'sem_carteira' };

  let matricula = registro.matricula;
  if (!matricula) { matricula = proximoMatricula(); rh.atualizarDados(discordId, { matricula }); }

  const { membro, nome } = await nomeDe(guild, discordId, registro);
  let png;
  try {
    png = await gerarCarteiraCargoPNG({ arquivo: cfg.arquivo, cargo: cfg.label.toUpperCase(), nome, rg: registro.rg || '—', numero: matricula });
  } catch (e) {
    console.error(`[carteirinha] falha ao renderizar carteira de ${registro.cargo} (${discordId}):`, e.message);
    return { ok: false, erro: 'render', numero: matricula, nome };
  }
  let dmOk = false;
  if (membro) {
    try {
      await membro.send({ content: `🪪 Sua **carteira funcional de ${cfg.label}** — matrícula **${matricula}**.`, files: [{ attachment: png, name: `carteira-${registro.cargo.toLowerCase()}-${matricula}.png` }] });
      dmOk = true;
    } catch (e) { console.error(`[carteirinha] DM fechada/erro (${registro.cargo} ${discordId}):`, e.message); }
  }
  return { ok: true, tipo: 'cargo', numero: matricula, dmOk, png, nome };
}

// Cargos que recebem alguma carteira (usado pelo backfill).
const CARGOS_COM_CARTEIRA = ['Advogado', ...Object.keys(CARTEIRA_POR_CARGO)];

module.exports = { formatarOAB, proximoOAB, formatarMatricula, proximoMatricula, emitirCarteirinha, CARGOS_COM_CARTEIRA };
