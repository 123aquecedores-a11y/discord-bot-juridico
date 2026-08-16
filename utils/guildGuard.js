// ISOLAMENTO ENTRE INSTALAÇÕES — trava de guild, fail-closed.
//
// O mesmo código roda em MAIS DE UMA instalação (servidor A e servidor B), cada uma com seu
// serviço, seu volume e seu banco (/data/dados.json). O banco NÃO é multi-guild: um registro
// não carrega o id do servidor onde nasceu. Então, se o bot atender uma interação vinda de
// outro servidor, ele escreve no banco da instalação errada e os dados de um servidor vazam
// pro outro — em qualquer direção, sem jeito fácil de desfazer.
//
// A regra aqui é uma só: o bot só opera no guild de GUILD_ID. Tudo o mais é recusado.
// FAIL-CLOSED de propósito: na dúvida (GUILD_ID vazia, guild nula, interação em DM, objeto
// sem id), a resposta é NÃO. Nunca "deixa passar porque provavelmente é o certo".
//
// Três camadas, porque uma só não cobre tudo:
//   1) boot        — exigirGuildConfigurada(): sem GUILD_ID válida o processo nem sobe.
//   2) borda       — guardarInteracao()/guardarEvento(): recusa interações e eventos do
//                    gateway (membros, mensagens/webhook) de fora do guild, sem tocar no banco.
//   3) profundidade— exigirGuild(): lança nos pontos onde uma guild vira ESCRITA de verdade
//                    (criar canal/categoria, auditoria, Diário Oficial). É a rede que pega
//                    caminho novo que alguém acrescentar amanhã sem lembrar da camada 2.
const config = require('../config');

// Erro dedicado pra dar pra distinguir "guild errada" de bug comum no catch de quem chamar.
class GuildForaDoEscopoError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'GuildForaDoEscopoError';
    this.guildForaDoEscopo = true;
  }
}

const MSG_RECUSA_INTERACAO = '⛔ Este bot está vinculado a **outro servidor** e não opera aqui. '
  + 'Nenhum dado foi lido ou gravado. Se você é da administração, verifique a variável `GUILD_ID` desta instalação.';

// Lê SEMPRE do config (e não de uma const de módulo) — assim os testes conseguem simular
// instalações diferentes trocando config.guildId, e um require adiantado não congela o valor.
function guildAlvo() {
  const id = String(config.guildId ?? '').trim();
  return id || null;
}

// Aceita guild, id cru, interaction, message, member... — qualquer coisa que carregue a origem.
// Objeto sem id nenhum devolve null, que o guildPermitida trata como "não permitido".
function idDeGuild(origem) {
  if (!origem) return null;
  if (typeof origem === 'string' || typeof origem === 'bigint') return String(origem).trim() || null;
  if (typeof origem !== 'object') return null;
  const bruto = origem.guildId ?? origem.guild?.id ?? origem.id ?? null;
  const id = bruto === null || bruto === undefined ? '' : String(bruto).trim();
  return id || null;
}

function guildPermitida(origem) {
  const alvo = guildAlvo();
  if (!alvo) return false; // sem GUILD_ID, NADA é permitido
  return idDeGuild(origem) === alvo;
}

// Validação de boot. Snowflake do Discord é numérico (17-20 dígitos hoje) — exigir isso pega o
// erro clássico de colar o NOME do servidor, um placeholder ou a URL do convite na variável, que
// senão só apareceria como "o bot ignora tudo" horas depois.
function motivoGuildConfiguradaInvalida() {
  const bruto = String(config.guildId ?? '').trim();
  if (!bruto) return 'GUILD_ID não está definida';
  if (!/^\d{15,25}$/.test(bruto)) return `GUILD_ID="${bruto}" não parece um ID de servidor do Discord (só dígitos, 15-25 caracteres)`;
  return null;
}

// Chamada no boot (index.js). Lança com mensagem clara — quem chama decide morrer (process.exit).
// Sem GUILD_ID o bot não pode subir "meio funcionando": ele responderia em qualquer servidor onde
// a aplicação estiver, que é exatamente o vazamento que essa trava existe pra impedir.
function exigirGuildConfigurada() {
  const motivo = motivoGuildConfiguradaInvalida();
  if (!motivo) return guildAlvo();
  throw new Error(
    `[guard] BOOT ABORTADO — ${motivo}.\n`
    + '        Esta instalação precisa saber a QUAL servidor ela pertence: cada instalação tem seu próprio\n'
    + '        GUILD_ID, token e volume, e sem isso o bot atenderia qualquer servidor e misturaria os bancos.\n'
    + '        Defina GUILD_ID (Configurações do Discord → Avançado → Modo desenvolvedor → clicar com o botão\n'
    + '        direito no servidor → Copiar ID) nas variáveis do serviço e suba de novo.'
  );
}

// Camada 3: usar onde uma guild vira escrita. Lança de propósito — silenciar aqui seria pior,
// porque a chamada continuaria e escreveria no lugar errado.
function exigirGuild(origem, contexto = 'operação') {
  if (guildPermitida(origem)) return true;
  const alvo = guildAlvo();
  const encontrado = idDeGuild(origem);
  throw new GuildForaDoEscopoError(
    `[guard] ${contexto} recusada — guild ${encontrado || '(desconhecida)'} ≠ GUILD_ID ${alvo || '(não definida)'}. Nada foi gravado.`
  );
}

// Camada 2 (eventos do gateway, tarefas agendadas, webhook). Não lança: devolve false pra quem
// chamou simplesmente parar. Sempre loga — evento recusado em silêncio vira "o bot não funciona"
// sem pista nenhuma.
function guardarEvento(nomeEvento, origem, detalhe = '') {
  if (guildPermitida(origem)) return true;
  const alvo = guildAlvo();
  const encontrado = idDeGuild(origem);
  console.warn(
    `[guard] evento "${nomeEvento}" IGNORADO — guild ${encontrado || '(desconhecida)'} ≠ GUILD_ID ${alvo || '(NÃO DEFINIDA)'}`
    + `${detalhe ? ` (${detalhe})` : ''}. Nenhuma leitura ou escrita no banco.`
  );
  return false;
}

// Camada 2 (interações: slash, botão, select, modal, autocomplete). Recusa EFÊMERA (só quem
// clicou vê) + log, e devolve false. Nunca toca no banco.
// Autocomplete não aceita reply de texto — o jeito de "recusar" é devolver lista vazia.
// DM (guildId nulo) também é recusada: o bot não tem fluxo por DM, e deixar passar seria um
// caminho sem guild nenhuma escrevendo no banco.
async function guardarInteracao(interaction) {
  if (!interaction) return false;
  if (guildPermitida(interaction.guildId ?? interaction.guild)) return true;

  const alvo = guildAlvo();
  const encontrado = idDeGuild(interaction.guildId ?? interaction.guild);
  const tipo = interaction.isChatInputCommand?.() ? `/${interaction.commandName}`
    : interaction.isAutocomplete?.() ? `autocomplete /${interaction.commandName}`
      : interaction.customId || 'interação';
  console.warn(
    `[guard] interação RECUSADA — ${tipo} de <@${interaction.user?.id || '?'}> veio da guild `
    + `${encontrado || '(DM/desconhecida)'} ≠ GUILD_ID ${alvo || '(NÃO DEFINIDA)'}. Nada foi lido nem gravado.`
  );

  try {
    if (interaction.isAutocomplete?.()) {
      await interaction.respond([]).catch(() => {});
      return false;
    }
    const resposta = { content: MSG_RECUSA_INTERACAO, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(resposta).catch(() => {});
    else await interaction.reply(resposta).catch(() => {});
  } catch (_) { /* recusar nunca pode derrubar o processo */ }
  return false;
}

module.exports = {
  GuildForaDoEscopoError,
  MSG_RECUSA_INTERACAO,
  guildAlvo,
  idDeGuild,
  guildPermitida,
  motivoGuildConfiguradaInvalida,
  exigirGuildConfigurada,
  exigirGuild,
  guardarEvento,
  guardarInteracao,
};
