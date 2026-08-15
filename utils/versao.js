// Identidade do build em execução — pra Staff nunca mais adivinhar "qual commit está no ar?".
// Fonte do SHA, em ordem: RAILWAY_GIT_COMMIT_SHA (o Railway injeta essa env no deploy; o .git NÃO
// vai no container Docker) → GIT_COMMIT_SHA (fallback manual) → git local (dev). Calculado UMA vez
// no load do módulo (SHA/branch não mudam em runtime); startupEm marca quando o processo subiu.
const { execSync } = require('child_process');

function gitLocal(args) {
  try { return execSync(`git ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch { return null; }
}

function resolverSha() {
  return process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || gitLocal('rev-parse HEAD');
}
function resolverBranch() {
  return process.env.RAILWAY_GIT_BRANCH || gitLocal('rev-parse --abbrev-ref HEAD');
}
function versaoPkg() {
  try { return require('../package.json').version || null; } catch { return null; }
}

const sha = resolverSha();
const INFO = {
  versao: versaoPkg(),
  sha,
  shaCurto: sha ? sha.slice(0, 8) : null,
  branch: resolverBranch(),
  mensagemCommit: process.env.RAILWAY_GIT_COMMIT_MESSAGE || null,
  startupEm: new Date().toISOString(),
};

function infoVersao() { return INFO; }

// Linha única pro log de startup.
function linhaStartup() {
  return `🔖 Versão ${INFO.versao || '—'} | commit ${INFO.shaCurto || 'desconhecido'}${INFO.branch ? ` (${INFO.branch})` : ''} | online desde ${INFO.startupEm}`;
}

// Bloco pro /versao (Staff).
function textoVersao() {
  return [
    `**Versão (package.json):** ${INFO.versao || '—'}`,
    `**Commit:** \`${INFO.shaCurto || 'desconhecido'}\`${INFO.branch ? ` — branch \`${INFO.branch}\`` : ''}`,
    INFO.mensagemCommit ? `**Mensagem do commit:** ${INFO.mensagemCommit}` : null,
    `**Online desde:** ${INFO.startupEm}`,
    INFO.sha ? null : '⚠️ SHA não detectado — em produção, garanta que o Railway injeta `RAILWAY_GIT_COMMIT_SHA` (ou defina `GIT_COMMIT_SHA`).',
  ].filter(Boolean).join('\n');
}

module.exports = { infoVersao, linhaStartup, textoVersao };
