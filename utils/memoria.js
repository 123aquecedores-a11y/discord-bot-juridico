const fs = require('fs');

// Diagnóstico de memória. Existiu no index.js para investigar um crash suspeito de OOM e foi
// removido em c63da94 quando a investigação fechou. Volta com outro propósito: a paginação de PNG
// (SPEC §5.2) multiplica páginas por documento e a spec manda medir RSS antes e depois — sem isto
// não há linha de base para comparar.
//
// Medição de 18/08/2026, antes de existir paginação: limite do container 8 GB, cgroup em 155 MB,
// RSS do Node em ~107 MB (1,3% do teto). Memória NÃO é restrição de desenho neste serviço; a linha
// serve para detectar regressão, não para vigiar um teto apertado.

// O limite só existe dentro do container (cgroup v2, com fallback pro v1). Em dev/Windows os dois
// caminhos falham e o limite sai como 'desconhecido' — o RSS continua valendo.
function limiteContainer() {
  for (const caminho of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const bruto = fs.readFileSync(caminho, 'utf8').trim();
      if (/^\d+$/.test(bruto)) return `${Math.round(Number(bruto) / 1048576)} MB`;
      if (bruto) return bruto; // cgroup v2 escreve "max" quando não há limite
    } catch { /* caminho não existe fora de container */ }
  }
  return 'desconhecido';
}

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

// `momento` rotula a medição no log ('boot', 'antes da paginação', 'após gerar 5 páginas'...).
// Nunca lança: diagnóstico não pode derrubar o que está diagnosticando.
function logar(momento) {
  try {
    console.log(`[mem] ${momento} | limite do container: ${limiteContainer()} | RSS: ${rssMB()} MB`);
  } catch { /* nunca atrapalha o fluxo que está sendo medido */ }
}

module.exports = { logar, rssMB, limiteContainer };
