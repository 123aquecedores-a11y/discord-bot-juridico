// Reset controlado do banco, disparado só quando a env RESETAR_BANCO=1 (ver index.js).
// Faz BACKUP do dados.json atual antes de apagar (reversível), loga o tamanho de cada tabela
// pra diagnóstico, e então remove o arquivo — o database/db.js recria vazio (com as sementes)
// no primeiro uso. Motivo: um banco inchado (dezenas de MB) faz a rajada de leituras do
// ready handler estourar a memória do container (OOM) e derrubar o bot em loop.
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DADOS_JSON_PATH || path.join(__dirname, '..', 'dados.json');

module.exports = function resetDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('[reset-db] Nenhum banco encontrado em', DB_PATH, '— nada a resetar.');
    return;
  }

  const stat = fs.statSync(DB_PATH);
  console.log(`[reset-db] Banco atual: ${(stat.size / 1048576).toFixed(2)} MB em ${DB_PATH}`);

  // Diagnóstico: tamanho e nº de registros por tabela (ajuda a achar o que inchou).
  try {
    const dados = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    for (const k of Object.keys(dados)) {
      const n = Array.isArray(dados[k]) ? `${dados[k].length} regs` : 'obj';
      const mb = (JSON.stringify(dados[k]).length / 1048576).toFixed(2);
      console.log(`[reset-db]   ${k}: ${n}, ${mb} MB`);
    }
  } catch (e) {
    console.log('[reset-db] Não consegui inspecionar as tabelas:', e.message);
  }

  // Backup antes de apagar — reversível.
  const backup = `${DB_PATH}.bak-${Date.now()}`;
  fs.copyFileSync(DB_PATH, backup);
  console.log('[reset-db] Backup salvo em', backup);

  // Apaga — o db.js recria vazio (com sementes de instituições) no primeiro acesso.
  fs.unlinkSync(DB_PATH);
  console.log('[reset-db] Banco apagado. Será recriado vazio no primeiro uso. ✅');
};
