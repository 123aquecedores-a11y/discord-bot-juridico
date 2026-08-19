/* eslint-disable */
// RESET DO TRIBUNAL — seletivo, preservando o RH. Rode com:
//   node scripts/reset-tribunal.js --conferir     (não escreve nada; mostra o que faria)
//   node scripts/reset-tribunal.js --executar
//
// POR QUE NÃO USAR `RESETAR_BANCO=1`: aquela env chama estruturaVazia(), que zera TODAS as tabelas
// — inclusive `rh`, `fichas`, `instituicoes` e `preferencias`. O tribunal perderia cargos,
// matrículas e fichas junto com os processos, que é exatamente o que NÃO se quer. Este script
// apaga só o que é CASO, e deixa o quadro de pessoal de pé.
//
// A numeração é responsabilidade separada: `REFUNDAR_NUMERACAO=1` no ambiente (ver index.js). São
// duas decisões diferentes de propósito — alguém pode limpar dados sem querer renumerar.

const fs = require('fs');
const path = require('path');

const CAMINHO = process.env.DADOS_JSON_PATH || path.join(__dirname, '..', 'dados.json');
const EXECUTAR = process.argv.includes('--executar');

// PRESERVADAS: tudo que é PESSOA e configuração do tribunal. O reset apaga casos, não gente.
const PRESERVAR = [
  'rh',                 // cargos e matrículas — o quadro de pessoal
  'fichas',             // ficha civil dos jogadores
  'instituicoes',       // cadastro institucional
  'preferencias',       // preferências pessoais (revisão automática etc.)
  'configGuild',        // interruptor do Modo Entrega In-Game — não pode voltar desligado
  'editais',            // processo seletivo em andamento
  'inscricoesEdital',
  'solicitacoesCargo',
  'estado',             // tratado à parte: contadores são zerados por REFUNDAR_NUMERACAO
];

// APAGADAS: tudo que é caso ou documento de caso.
const APAGAR = [
  'processos', 'medidas', 'mandados', 'oficios', 'apelacoes', 'peticoes',
  'pecas', 'andamentos', 'documentosAnexados', 'dossiesInquerito',
  'certidoes', 'atosMp', 'consultas',
];

function dirCache() {
  return path.join(path.dirname(CAMINHO), 'cache-pecas');
}

function main() {
  if (!fs.existsSync(CAMINHO)) { console.error(`Banco não encontrado: ${CAMINHO}`); process.exit(1); }
  const dados = JSON.parse(fs.readFileSync(CAMINHO, 'utf-8'));

  console.log(`\nBanco: ${CAMINHO}`);
  console.log(`Modo : ${EXECUTAR ? '*** EXECUTAR (escreve) ***' : 'conferência (não escreve nada)'}\n`);

  console.log('PRESERVADAS (o reset apaga casos, não gente):');
  for (const t of PRESERVAR) console.log(`  ${t.padEnd(22)} ${(dados[t] || []).length} registro(s)`);

  console.log('\nAPAGADAS:');
  let total = 0;
  for (const t of APAGAR) {
    const n = (dados[t] || []).length;
    total += n;
    console.log(`  ${t.padEnd(22)} ${n} registro(s)`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${total} registro(s)`);

  // CANAIS DO DISCORD: o reset é do BANCO. Os canais continuam existindo no servidor, órfãos —
  // ninguém os apaga automaticamente, e o bot não vai mais reconhecê-los. Precisam ser removidos à
  // mão (ou por categoria) DEPOIS do reset.
  const canais = [
    ...(dados.processos || []).filter(p => p.canalId),
    ...(dados.medidas || []).filter(m => m.canalId),
    ...(dados.peticoes || []).filter(p => p.canalId),
  ].length;
  console.log(`\nCANAIS DO DISCORD que ficarão órfãos: ${canais}`);
  console.log('  (o reset é do banco; os canais seguem no servidor e precisam ser apagados à mão)');

  // CACHE DAS PÁGINAS PÚBLICAS: processo apagado nunca é varrido pela revogação, então sem esta
  // limpeza os PNGs continuariam sendo servidos por /p/<token>.png a quem tivesse o link.
  const dir = dirCache();
  const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  console.log(`\nCACHE /p/<token>.png em ${dir}: ${arquivos.length} arquivo(s)`);

  if (!EXECUTAR) {
    console.log('\nNada foi escrito. Para executar de verdade: --executar');
    return;
  }

  // BACKUP ANTES DE QUALQUER ESCRITA, com carimbo de hora no nome para nunca sobrescrever outro.
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${CAMINHO}.pre-reset-${carimbo}`;
  fs.copyFileSync(CAMINHO, backup);
  const tam = fs.statSync(backup).size;
  console.log(`\n✅ BACKUP: ${backup} (${tam} bytes)`);
  if (tam !== fs.statSync(CAMINHO).size) {
    console.error('❌ ABORTADO: o backup não tem o mesmo tamanho do original.');
    process.exit(1);
  }

  for (const t of APAGAR) dados[t] = [];

  // Escrita atômica (tmp + rename), mesmo padrão do database/db.js.
  const tmp = `${CAMINHO}.tmp-reset`;
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
  fs.renameSync(tmp, CAMINHO);
  console.log('✅ Banco resetado (casos apagados, pessoas preservadas).');

  let apagados = 0;
  for (const f of arquivos) {
    try { fs.unlinkSync(path.join(dir, f)); apagados++; } catch (_) {}
  }
  console.log(`✅ Cache de páginas públicas: ${apagados} arquivo(s) apagado(s).`);

  console.log('\nPRÓXIMOS PASSOS (não são feitos por este script):');
  console.log('  1. REFUNDAR_NUMERACAO=1 no Railway → reinicia as séries em 0001. REMOVER depois.');
  console.log(`  2. Apagar à mão os ${canais} canais órfãos no Discord.`);
  console.log('  3. Conferir no boot: "[modo-entrega] ... LIGADO" (configGuild foi preservado).');
}

main();
