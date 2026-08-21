/* eslint-disable */
// A ROLE SEGUE O RH (21/08/2026). Rode com:
//   node scripts/testes-reconciliacao-roles.js
//
// O PROBLEMA, achado em produção e não em teoria: utils/canais.js dá ViewChannel nos canais-ticket
// POR ROLE DO DISCORD (CARGOS_LEITURA_TICKET). Quem abre a porta dos autos é a role, não o RH.
// Enquanto isso, `membro.roles.remove()` na demissão vivia sob `.catch(() => {})`.
//
// A checagem de 21/08 encontrou um membro com a role de Promotor, NENHUM registro no RH — nem
// ativo, nem inativo — enxergando os 4 canais-ticket abertos do tribunal.
//
// Fazer o catch gritar avisa; não fecha a porta. O que fecha é a role passar a SEGUIR o RH. Com
// isso, roles.remove falhar deixa de ser VAZAMENTO e vira ATRASO: a próxima passada corrige.
//
// O que estes testes provam:
//   1) sobra role -> remove;  falta role -> adiciona;  bate -> não toca (idempotente)
//   2) LICENÇA MANTÉM A ROLE (o registro segue ativo; afastado não é demitido)
//   3) TRAVA DE MASSA: muita remoção de uma vez aborta TODAS as remoções e pede conferência humana
//   4) MUTAÇÃO: falha do Discord numa remoção não derruba a rodada nem esconde o erro
//   5) só toca role de CARGO — role de staff e qualquer outra do servidor ficam intactas
//   6) contratar/demitir chamam a reconciliação, e os três catches deixaram de ser mudos

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-roles-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild1';
// As roles de cargo precisam existir para o módulo ter o que reconciliar.
process.env.ROLE_JUIZ_ID = 'role-juiz';
process.env.ROLE_PROMOTOR_ID = 'role-promotor';
process.env.ROLE_DESEMBARGADOR_ID = 'role-des';
process.env.ROLE_PROCURADOR_ID = 'role-proc';
process.env.ROLE_ADVOGADO_ID = 'role-adv';
process.env.ROLE_DELEGADO_ID = 'role-del';
process.env.CARGO_STAFF_ID = 'role-staff';

const db = require('../database/db');
const rh = require('../utils/rh');
const reconc = require('../utils/reconciliacaoRoles');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const LER = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');
const SEM_COMENTARIO = (s) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// --- Guild falsa: membros com roles em memória, e um contador do que foi mexido.
function fazerGuild(pessoas, { falharEm = null } = {}) {
  const mexidas = { add: [], remove: [] };
  const membros = new Map();
  for (const p of pessoas) {
    const roles = new Set(p.roles || []);
    membros.set(p.id, {
      id: p.id,
      user: { tag: p.tag || `user${p.id}`, bot: !!p.bot },
      roles: {
        cache: { has: (r) => roles.has(r) },
        add: async (r) => { if (falharEm === `add:${p.id}:${r}`) throw new Error('Missing Permissions'); roles.add(r); mexidas.add.push(`${p.id}:${r}`); },
        remove: async (r) => { if (falharEm === `remove:${p.id}:${r}`) throw new Error('Missing Permissions'); roles.delete(r); mexidas.remove.push(`${p.id}:${r}`); },
      },
      _roles: roles,
    });
  }
  return {
    mexidas,
    membros,
    id: 'guild1',
    members: {
      fetch: async (id) => (id === undefined ? membros : (membros.get(String(id)) || Promise.reject(new Error('unknown')))),
    },
    channels: { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) },
  };
}
// members.fetch(id) precisa REJEITAR quando não acha, para o `.catch(() => null)` do módulo valer.
function guildCom(pessoas, opts) {
  const g = fazerGuild(pessoas, opts);
  const original = g.members.fetch;
  g.members.fetch = async (id) => {
    if (id === undefined) return g.membros;
    const m = g.membros.get(String(id));
    if (!m) throw new Error('Unknown Member');
    return m;
  };
  return g;
}

const config = require('../config');
config.canalAuditoriaId = 'canal-auditoria';

const JUIZ_OK = '100';       // tem cargo Juiz no RH e a role -> nada a fazer
const SEM_ROLE = '200';      // tem cargo Promotor no RH, sem a role -> ADICIONA
const SOBRANDO = '300';      // sem cargo nenhum, com a role de Promotor -> REMOVE (o caso real)
const DE_LICENCA = '400';    // cargo Juiz ativo com licenca -> MANTÉM a role

(async () => {
  console.log('\n== A role segue o RH ==');

  rh.contratar(JUIZ_OK, 'Juiz', 'Juiz Um', null);
  rh.contratar(SEM_ROLE, 'Promotor', 'Promotor Dois', null);
  rh.contratar(DE_LICENCA, 'Juiz', 'Juiz Quatro', null);
  rh.setLicenca(DE_LICENCA, true);

  // -------------------------------------------------------------------------
  console.log('\n1) As três direções, numa passada só:');
  {
    const g = guildCom([
      { id: JUIZ_OK, roles: ['role-juiz'] },
      { id: SEM_ROLE, roles: [] },
      { id: SOBRANDO, roles: ['role-promotor'], tag: 'devilhelsing' },
      { id: DE_LICENCA, roles: ['role-juiz'] },
    ]);
    const r = await reconc.reconciliarTodos(g, { motivo: 'teste' });

    ok(r.removidas.length === 1 && r.removidas[0].discordId === SOBRANDO,
      '1a: SOBRA role sem cargo no RH -> REMOVE (é o caso achado em produção)', JSON.stringify(r.removidas));
    ok(r.removidas[0] && r.removidas[0].cargo === 'Promotor', '1b: e diz QUAL cargo foi removido');
    ok(r.adicionadas.length === 1 && r.adicionadas[0].discordId === SEM_ROLE,
      '1c: FALTA role com cargo no RH -> ADICIONA', JSON.stringify(r.adicionadas));
    ok(!g.membros.get(SOBRANDO)._roles.has('role-promotor'), '1d: a role saiu de verdade do membro');
    ok(g.membros.get(SEM_ROLE)._roles.has('role-promotor'), '1e: e entrou de verdade em quem tinha o cargo');
    ok(r.falhas.length === 0, '1f: sem falhas no caminho feliz');
    ok(g.mexidas.add.length === 1 && g.mexidas.remove.length === 1,
      '1g: mexeu em EXATAMENTE dois membros — não saiu tocando o servidor inteiro',
      `add=${g.mexidas.add.length} remove=${g.mexidas.remove.length}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n2) Licença mantém a role (afastado não é demitido):');
  {
    const g = guildCom([{ id: DE_LICENCA, roles: ['role-juiz'] }]);
    const r = await reconc.reconciliarTodos(g, { motivo: 'teste' });
    ok(r.removidas.length === 0, '2a: quem está DE LICENÇA não perde a role', JSON.stringify(r.removidas));
    ok(g.membros.get(DE_LICENCA)._roles.has('role-juiz'), '2b: a role continua lá');
    ok(rh.getCargo(DE_LICENCA) && rh.getCargo(DE_LICENCA).licenca === true, '2c: (cenário conferido: ele está mesmo de licença)');
  }

  // -------------------------------------------------------------------------
  console.log('\n3) Idempotência — rodar de novo não faz nada:');
  {
    const g = guildCom([
      { id: JUIZ_OK, roles: ['role-juiz'] },
      { id: SEM_ROLE, roles: ['role-promotor'] },
      { id: DE_LICENCA, roles: ['role-juiz'] },
    ]);
    const r = await reconc.reconciliarTodos(g, { motivo: 'teste' });
    ok(r.removidas.length === 0 && r.adicionadas.length === 0,
      '3a: com tudo batendo, NENHUMA chamada ao Discord', `rem=${r.removidas.length} add=${r.adicionadas.length}`);
    ok(g.mexidas.add.length === 0 && g.mexidas.remove.length === 0, '3b: rodar todo boot não custa chamada à toa');
    ok(r.examinados === 3, '3c: CANÁRIO — ela examinou os 3 membros (não passou vazia)', `examinados=${r.examinados}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n4) TRAVA DE MASSA — RH zerado não vira expurgo:');
  {
    const muitos = [];
    for (let i = 0; i < 8; i++) muitos.push({ id: `9${i}0`, roles: ['role-juiz'] }); // 8 sobrando, limite 5
    const g = guildCom(muitos);
    const r = await reconc.reconciliarTodos(g, { motivo: 'teste' });
    ok(r.abortouRemocoes === true, '4a: 8 roles sobrando de uma vez ABORTA as remoções (limite 5)');
    ok(r.removidas.length === 0, '4b: e NENHUMA foi removida — nem as primeiras', `removidas=${r.removidas.length}`);
    ok(g.mexidas.remove.length === 0, '4c: MUTAÇÃO — a trava decide ANTES de executar, não no meio da execução');
    for (const m of muitos) ok(g.membros.get(m.id)._roles.has('role-juiz') === true, `4d-${m.id}: a role continua intacta`);
  }
  {
    // Adição NÃO entra na trava: dar role a quem tem o cargo não abre porta que o RH já não abrisse.
    for (let i = 0; i < 8; i++) rh.contratar(`8${i}0`, 'Juiz', null, null);
    const g = guildCom(Array.from({ length: 8 }, (_, i) => ({ id: `8${i}0`, roles: [] })));
    const r = await reconc.reconciliarTodos(g, { motivo: 'teste' });
    ok(r.adicionadas.length === 8 && r.abortouRemocoes === false,
      '4e: 8 ADIÇÕES passam — a trava é só para remoção', `add=${r.adicionadas.length}`);
    for (let i = 0; i < 8; i++) rh.demitir(`8${i}0`);
  }

  // -------------------------------------------------------------------------
  console.log('\n5) Falha do Discord não derruba nem some:');
  {
    const g = guildCom([{ id: SOBRANDO, roles: ['role-promotor'] }], { falharEm: `remove:${SOBRANDO}:role-promotor` });
    let estourou = false; let r = null;
    try { r = await reconc.reconciliarTodos(g, { motivo: 'teste' }); } catch (_) { estourou = true; }
    ok(estourou === false, '5a: MUTAÇÃO — Missing Permissions na remoção NÃO derruba a rodada');
    ok(r && r.falhas.length === 1, '5b: a falha é REGISTRADA, não engolida', JSON.stringify(r && r.falhas));
    ok(r && r.falhas[0].erro === 'Missing Permissions', '5c: com o erro real do Discord junto');
    ok(r && r.removidas.length === 0, '5d: e não conta como removida o que não foi removido');
  }

  // -------------------------------------------------------------------------
  console.log('\n6) Só mexe em role de CARGO:');
  {
    const g = guildCom([{ id: SOBRANDO, roles: ['role-promotor', 'role-staff', 'role-qualquer'] }]);
    await reconc.reconciliarTodos(g, { motivo: 'teste' });
    const rs = g.membros.get(SOBRANDO)._roles;
    ok(!rs.has('role-promotor'), '6a: a role de cargo sai');
    ok(rs.has('role-staff'), '6b: a role de STAFF fica — o RH não fala sobre ela');
    ok(rs.has('role-qualquer'), '6c: e qualquer outra role do servidor fica intacta');
  }

  // -------------------------------------------------------------------------
  console.log('\n7) Caminho de evento (um membro só):');
  {
    const g = guildCom([{ id: SOBRANDO, roles: ['role-promotor'] }]);
    const r = await reconc.reconciliarMembro(g, SOBRANDO, { motivo: 'teste' });
    ok(r.removidas.length === 1, '7a: reconciliarMembro corrige quem acabou de mudar');
    const g2 = guildCom([{ id: SOBRANDO, roles: [] }]);
    let estourou = false;
    try { await reconc.reconciliarMembro(g2, 'nao-existe', { motivo: 'teste' }); } catch (_) { estourou = true; }
    ok(estourou === false, '7b: MUTAÇÃO — membro que saiu do servidor não derruba a demissão em curso');
  }

  // -------------------------------------------------------------------------
  console.log('\n8) O código de RH está ligado nela, e sem catch mudo:');
  {
    const rhSrc = SEM_COMENTARIO(LER('commands', 'rh.js'));
    ok(rhSrc.length > 5000, '8a: CANÁRIO — commands/rh.js foi lido inteiro', `${rhSrc.length} chars`);

    const mudos = (rhSrc.match(/roles\.(add|remove)\([^)]*\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/g) || []).length;
    ok(mudos === 0, '8b: nenhum roles.add/remove com .catch(() => {}) mudo sobrou', `mudos=${mudos}`);

    const comLog = (rhSrc.match(/roles\.(add|remove)\([\s\S]{0,120}?console\.error/g) || []).length;
    ok(comLog === 3, '8c: os TRÊS pontos de role logam o erro com contexto', `comLog=${comLog}`);

    const chamadas = (rhSrc.match(/reconciliacaoRoles\.reconciliarMembro\(/g) || []).length;
    ok(chamadas === 2, '8d: contratar e demitir chamam a reconciliação', `chamadas=${chamadas}`);
    ok(/reconciliarMembro\(guild, usuarioId, \{ motivo: 'demissão' \}\)/.test(rhSrc),
      '8e: a da demissão roda MESMO sem registro no RH — é o caso do produção');

    const idx = SEM_COMENTARIO(LER('index.js'));
    ok(/reconciliarTodos\(guild/.test(idx), '8f: o boot roda a varredura completa');
    const posGate = idx.indexOf('modoManutencao.ativo()');
    ok(posGate > -1 && idx.indexOf('reconciliarTodos(guild') > posGate,
      '8g: e DEPOIS do gate — SKIP_BOOT_TASKS=1 continua parando tudo');

    const skip = LER('scripts', 'testes-skip-boot.js');
    ok(/'reconciliarTodos'/.test(skip), '8h: e o teste do kill-switch vigia a tarefa nova');

    const rec = SEM_COMENTARIO(LER('utils', 'reconciliacaoRoles.js'));
    ok(!/catch\s*\{\s*\}/.test(rec) && !/catch\s*\([^)]*\)\s*\{\s*\}/.test(rec),
      '8i: a própria reconciliação não tem catch mudo (regra do projeto)');
  }

  console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
  try { fs.unlinkSync(DB_TESTE); } catch (_) {}
  try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
  if (falhas.length) { falhas.forEach(f => console.log(`  ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`)); process.exit(1); }
})();
