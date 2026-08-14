// Carteirinha da OAB (identidade de advogado): contador global de OAB, geração do número
// sequencial e emissão/reenvio do PNG na DM. Ponto ÚNICO usado pela aprovação de cargo
// (commands/rh.js), pelo backfill (/gerar-carteirinhas) e pela edição global (Gerenciar dados),
// pra não duplicar a lógica de OAB/render/DM em cada lugar.
const db = require('../database/db');
const estado = require('./estado');
const rh = require('./rh');
const { gerarCarteirinhaPNG } = require('../services/gerarDocumentoPNG');

// Formata o inteiro sequencial no padrão pedido: 000.000 (6 dígitos, ponto no meio). 1 -> "000.001".
function formatarOAB(n) {
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)}.${s.slice(3)}`;
}

// Contador global de OAB, persistido em `estado` (chave 'contadorOAB'). Na primeira vez (chave
// ausente) inicializa a partir do MAIOR número de OAB já gravado em rh — assim nunca reemite um
// número que já exista, mesmo que a coluna oab tenha nascido preenchida em algum registro.
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

function hojeBR() {
  return new Date().toLocaleDateString('pt-BR'); // dd/mm/aaaa
}

// Data de inscrição estável: usa a já gravada (oabDesde); senão a data de criação do cadastro rh
// (criado_em vem como "dd/mm/aaaa, hh:mm:ss"); senão hoje. Persiste pra não mudar a cada reemissão.
function resolverDataInscricao(registro) {
  if (registro.oabDesde) return registro.oabDesde;
  if (registro.criado_em && registro.criado_em.includes('/')) return registro.criado_em.split(',')[0].trim();
  return hojeBR();
}

/**
 * Gera (ou regenera) a carteirinha do advogado e envia na DM dele.
 * - Gera OAB sequencial se o advogado ainda não tiver.
 * - Erro de DM fechada é capturado e apenas logado (não quebra o fluxo).
 * @param {import('discord.js').Guild} guild
 * @param {string} discordId
 * @returns {Promise<{ok:boolean, erro?:string, oab?:string, dmOk?:boolean, png?:Buffer, nome?:string}>}
 */
async function emitirCarteirinha(guild, discordId) {
  const registro = rh.getCargo(discordId);
  if (!registro || registro.cargo !== 'Advogado') return { ok: false, erro: 'nao_advogado' };

  // Garante OAB e data de inscrição, persistindo no cadastro.
  const patch = {};
  let oab = registro.oab;
  if (!oab) { oab = proximoOAB(); patch.oab = oab; }
  const dataInscricao = resolverDataInscricao(registro);
  if (!registro.oabDesde) patch.oabDesde = dataInscricao;
  if (Object.keys(patch).length) rh.atualizarDados(discordId, patch);

  const membro = await guild.members.fetch(discordId).catch(() => null);
  const nome = registro.nomePersonagem || (membro ? membro.displayName : 'Advogado(a)');

  let png;
  try {
    png = await gerarCarteirinhaPNG({ nome, rg: registro.rg || '—', oab, data: dataInscricao });
  } catch (e) {
    console.error(`[carteirinha] falha ao renderizar (advogado ${discordId}):`, e.message);
    return { ok: false, erro: 'render', oab, nome };
  }

  let dmOk = false;
  if (membro) {
    try {
      await membro.send({
        content: `🪪 Sua **carteira de identidade de advogado (OAB/SP)** — inscrição **${oab}**.`,
        files: [{ attachment: png, name: `carteira-oab-${oab.replace(/\D/g, '')}.png` }],
      });
      dmOk = true;
    } catch (e) {
      console.error(`[carteirinha] DM fechada/erro ao enviar para ${discordId}:`, e.message);
    }
  }
  return { ok: true, oab, dmOk, png, nome };
}

module.exports = { formatarOAB, proximoOAB, emitirCarteirinha };
