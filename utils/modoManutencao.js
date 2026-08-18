// MODO MANUTENÇÃO (SKIP_BOOT_TASKS=1) — sobe o bot SEM nenhuma tarefa automática.
//
// Por que existe: o bot calcula prazo por relógio, não por uptime. Quando o serviço fica parado
// (migração, manutenção, troca de host), os prazos correm mesmo assim — e no PRIMEIRO boot depois
// disso o `ready` despeja todo o atraso de uma vez, sem ninguém revisar: petições indeferidas por
// decurso de diligência, defensores dativos nomeados, responsáveis reatribuídos, e o Diário
// publicando os atos atrasados no canal público. Nada disso tem desfazer.
//
// Com SKIP_BOOT_TASKS=1 o bot conecta, loga que está em manutenção e PARA por aí: não cria canal,
// não faz backfill, não roda checagem nenhuma e não agenda os setInterval. Você confere o estado
// com calma, remove a variável e reinicia — aí sim as tarefas voltam ao normal.
//
// O QUE A FLAG **NÃO** DESLIGA: interação de gente. Slash, botão, select e modal continuam
// atendidos normalmente — quem clica está pedindo aquela escrita, e é o guard de guild
// (utils/guildGuard.js) que decide de qual servidor o bot aceita trabalho. A flag existe contra a
// avalanche AUTOMÁTICA do boot, não contra o uso do sistema.
//
// FAIL-SAFE: só o valor exato "1" liga o modo. Qualquer outra coisa — vazia, "0", "true", "sim",
// "yes", lixo — mantém o comportamento normal. O default de quem esquecer a variável, ou digitar
// errado, é o bot FUNCIONANDO; a manutenção é sempre uma escolha explícita.

const NOME_FLAG = 'SKIP_BOOT_TASKS';

function ativo() {
  return String(process.env[NOME_FLAG] ?? '').trim() === '1';
}

const AVISO = `[manutencao] ⚠️ ${NOME_FLAG}=1 — MODO MANUTENÇÃO. O bot conectou, mas NENHUMA tarefa automática vai rodar:\n`
  + '             sem auto-criação de canais, sem backfill de retroatividade, sem varredura de responsável\n'
  + '             fantasma, sem varredura do Diário, sem checagens de prazo (diária e de 10 min) e sem painel fixo.\n'
  + `             Interações de usuário CONTINUAM sendo atendidas. Confira o estado e, quando estiver satisfeito,\n`
  + `             REMOVA a variável ${NOME_FLAG} e reinicie o serviço pra religar as tarefas.`;

module.exports = { NOME_FLAG, ativo, AVISO };
