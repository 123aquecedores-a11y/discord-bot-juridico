/* eslint-disable */
// DIAGNÓSTICO SOMENTE-LEITURA do quadro (rh) x responsáveis de tickets abertos.
// NÃO escreve nada, NÃO conecta no Discord, NÃO altera o banco — só lê o JSON e imprime.
// Responde à pergunta: no primeiro boot depois do deploy, a reconciliação por cargo vai
// reatribuir alguém? A trava de massa vai abortar?
//
// Uso:
//   node scripts/diagnostico-rh.js                      (usa DADOS_JSON_PATH ou ./dados.json)
//   node scripts/diagnostico-rh.js /caminho/dados.json  (usa o arquivo indicado)
//   railway ssh --service discord-bot-juridico "node /app/scripts/diagnostico-rh.js /data/dados.json"
const fs = require('fs');
const path = require('path');

const alvo = process.argv[2] || process.env.DADOS_JSON_PATH || path.join(__dirname, '..', 'dados.json');
if (!fs.existsSync(alvo)) { console.error(`Banco não encontrado: ${alvo}`); process.exit(1); }
const dados = JSON.parse(fs.readFileSync(alvo, 'utf8'));

// Espelha TABELAS_TICKET de utils/responsaveis.js. Duplicado de propósito: este script não carrega
// nenhum módulo do bot, pra não haver risco de efeito colateral ao rodar contra produção.
const TABELAS = {
  processos: { aberto: (r) => !['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'].includes(r.status), papeis: { Juiz: 'juiz', Promotor: 'promotor', Delegado: 'delegado' } },
  medidas:   { aberto: (r) => !['Deferida', 'Negada', 'Indeferida pelo Juiz', 'Arquivada'].includes(r.status), papeis: { Juiz: 'juiz', Promotor: 'promotor', Delegado: 'delegado' } },
  peticoes:  { aberto: (r) => !['Deferido', 'Indeferido', 'Vencido', 'Arquivada', 'Cancelada — prazo de vínculo expirado'].includes(r.status), papeis: { Juiz: 'juiz', Promotor: 'promotor' } },
  apelacoes: { aberto: (r) => r.status === 'Aguardando decisão', papeis: { Desembargador: 'desembargadorId' } },
};
// Papéis que a reconciliação NÃO confere no rh (EXIGE_CARGO_RH em utils/responsaveis.js).
const FORA_DA_RECONCILIACAO = new Set(['Delegado']);
const LIMITE = 5; // LIMITE_RECONCILIACAO_SEM_CARGO

const rh = (dados.rh || []);
const ativos = rh.filter(r => r.ativo);
const temCargo = (id, cargo) => ativos.some(r => r.discordId === id && r.cargo === cargo);

console.log(`\n===== DIAGNÓSTICO RH x RESPONSÁVEIS — ${alvo} =====\n`);

// ---- 1) Quadro atual ----
const porCargo = {};
for (const r of ativos) porCargo[r.cargo] = (porCargo[r.cargo] || 0) + 1;
console.log('QUADRO ATIVO NO RH:');
if (!ativos.length) console.log('  ⚠️ NENHUM registro ativo no rh.');
for (const [cargo, n] of Object.entries(porCargo).sort()) console.log(`  ${cargo}: ${n}`);
const semRg = ativos.filter(r => !r.rg);
console.log(`  (registros ativos sem RG preenchido: ${semRg.length}/${ativos.length}${semRg.length ? ` — ${semRg.map(r => `${r.cargo}:${r.discordId}`).join(', ')}` : ''})`);
console.log('  NOTA: a reconciliação NÃO usa RG — só discordId + cargo + ativo. RG faltando não a afeta.\n');

// ---- 2) Responsáveis de tickets abertos que NÃO constam no rh ----
const forasteiros = [];   // vão ser reatribuídos (papel confere rh)
const isentos = [];       // papel fora da reconciliação (Delegado)
let abertosTotal = 0, responsaveisTotal = 0;

for (const [tabela, cfg] of Object.entries(TABELAS)) {
  const abertos = (dados[tabela] || []).filter(r => cfg.aberto(r) && !r.arquivadoManual);
  abertosTotal += abertos.length;
  for (const reg of abertos) {
    for (const [papel, campo] of Object.entries(cfg.papeis)) {
      const id = reg[campo];
      if (!id) continue;
      responsaveisTotal++;
      if (temCargo(id, papel)) continue;
      const item = { tabela, numero: reg.numero, papel, id, cargoNoRh: (ativos.find(r => r.discordId === id) || {}).cargo || '—' };
      (FORA_DA_RECONCILIACAO.has(papel) ? isentos : forasteiros).push(item);
    }
  }
}

console.log(`TICKETS ABERTOS: ${abertosTotal} (com ${responsaveisTotal} responsável(is) marcado(s))\n`);

console.log('RESPONSÁVEIS FORA DO RH — por papel:');
if (!forasteiros.length) console.log('  ✅ nenhum. A reconciliação por cargo não vai mexer em ninguém.');
const agrupado = {};
for (const f of forasteiros) (agrupado[f.papel] = agrupado[f.papel] || []).push(f);
for (const [papel, itens] of Object.entries(agrupado)) {
  console.log(`  ${papel} (${itens.length}):`);
  for (const i of itens) console.log(`    - ${i.tabela}/${i.numero} → ${i.id} (cargo no rh hoje: ${i.cargoNoRh})`);
}
if (isentos.length) {
  console.log(`\n  Isentos (papel não confere rh — integração da Polícia Civil): ${isentos.length}`);
  for (const i of isentos) console.log(`    - ${i.tabela}/${i.numero} ${i.papel} → ${i.id}`);
}

// ---- 3) Veredito da trava ----
console.log('\nVEREDITO:');
console.log(`  candidatos "sem cargo": ${forasteiros.length} | limite da trava: ${LIMITE}`);
if (forasteiros.length > LIMITE) {
  console.log(`  🛑 A TRAVA VAI ABORTAR a reconciliação por cargo no primeiro boot (${forasteiros.length} > ${LIMITE}).`);
  console.log('     Nada será reatribuído por perda de cargo; a correção por AUSÊNCIA do servidor segue valendo.');
} else if (forasteiros.length > 0) {
  console.log(`  ⚠️ A reconciliação VAI REATRIBUIR ${forasteiros.length} responsável(is) no primeiro boot (abaixo do limite).`);
  console.log('     Confira a lista acima: se algum deles é responsável legítimo, contrate-o no /rh ANTES do deploy.');
} else {
  console.log('  ✅ Nada a reconciliar por cargo.');
}
console.log('\n(Este script não escreveu nada.)\n');
