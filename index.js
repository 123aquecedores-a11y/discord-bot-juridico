const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const config = require('./config');
const {
  verificarPrazosJulgamento, verificarRenovacoesPorteArma,
  verificarProcessosSemJuiz, verificarProcessosPenaisSemJuiz, verificarDiligenciasPendentes, verificarPeticoesSemJuiz,
  verificarMedidasAguardandoMP, verificarMedidasAguardandoJuiz, verificarMandadosPendentes,
  verificarApelacoesPendentes, verificarPrazosContestacao,
  verificarPrazoHabilitacao, verificarPrazoDefesa, DIA_MS,
} = require('./utils/prazos');
const ficha = require('./utils/ficha');
const integracaoPoliciaCivil = require('./utils/integracaoPoliciaCivil');
const { garantirCanais } = require('./utils/garantirCanais');
const guildGuard = require('./utils/guildGuard');
const modoManutencao = require('./utils/modoManutencao');

// ISOLAMENTO ENTRE INSTALAÇÕES — o mesmo código roda em mais de um servidor, cada instalação com
// seu token, seu volume e seu banco. Sem GUILD_ID o bot atenderia qualquer servidor onde a
// aplicação estiver e misturaria os bancos, então o boot morre aqui mesmo (antes do login) em vez
// de subir "meio funcionando". Ver utils/guildGuard.js.
try {
  console.log(`[guard] instalação vinculada ao servidor ${guildGuard.exigirGuildConfigurada()} — só esse guild é atendido.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Rede de segurança: no Node moderno, uma promessa rejeitada sem .catch DERRUBA o processo
// inteiro (unhandledRejection → exit). Num handler solto (ex: um canal.send que falha, uma
// chamada de API que rejeita) isso reiniciava o bot em loop e o motivo se perdia no buffer.
// Aqui a gente LOGA o motivo e NÃO deixa o processo morrer — o bot continua de pé.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? err.stack : err);
});

// Linha de base de memória antes de a paginação de PNG existir — ver utils/memoria.js.
require('./utils/memoria').logar('boot');

const DEZ_MIN_MS = 10 * 60 * 1000;

// GuildMembers é intent privilegiada — precisa estar habilitada em "Server Members Intent"
// no Discord Developer Portal (Bot > Privileged Gateway Intents) antes de adicionar aqui,
// senão o login falha com "Used disallowed intents" e o bot fica offline. Enquanto não
// habilitar, o guildMemberAdd abaixo fica registrado mas nunca dispara (inofensivo).
// GuildMessages não é privilegiada (não precisa de toggle no Developer Portal) — só é
// necessária pra receber o evento messageCreate (auto-limpeza do canal do painel).
// MessageContent também é privilegiada (mesmo toggle "Message Content Intent" no Developer
// Portal) — sem ela, o Discord manda embeds/conteúdo VAZIOS em mensagens que o bot não
// escreveu, o que quebra a leitura do webhook da Polícia Civil (utils/integracaoPoliciaCivil.js).
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(require('./utils/versao').linhaStartup());

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error('Não foi possível carregar o servidor configurado (GUILD_ID) — job diário de prazos não vai rodar.');
    return;
  }
  // Confirma que o que o Discord devolveu é MESMO o guild configurado antes de qualquer escrita
  // do boot (garantirCanais cria canal, retroatividade grava no banco). Redundante por construção,
  // mas é o tipo de redundância que custa uma linha e evita gravar no servidor errado.
  if (!guildGuard.guardarEvento('ready', guild, 'boot abortado por segurança')) return;

  // MODO MANUTENÇÃO (SKIP_BOOT_TASKS=1): sai daqui e o `ready` acaba — daqui pra baixo é TUDO
  // escrita automática (canais, backfill, varreduras, checagens de prazo, painel fixo), e depois
  // de uma parada longa isso viraria uma avalanche de atos irreversíveis no primeiro boot.
  // Ver utils/modoManutencao.js. Só o valor exato "1" liga; qualquer outro mantém o normal.
  if (modoManutencao.ativo()) {
    console.warn(modoManutencao.AVISO);
    return;
  }

  // Em que modo este servidor está? Registro perdido tem que ser visível na primeira linha do log,
  // não descoberto uma semana depois por um jogador reclamando — ver utils/modoEntrega.js.
  require('./utils/modoEntrega').logarNoBoot(guild.id);

  // Auto-cria os canais de publicação (📜│diário-oficial e 📢│editais) se faltarem — idempotente,
  // não duplica, e não derruba o boot se faltar permissão (ver utils/garantirCanais.js).
  await garantirCanais(guild);

  // Parte 4: faz o que é novo valer pros tickets que já existiam — backfill de uso único do
  // sorteioPromotorEm (trava das 24h do MP) + relatório de quantos casos abertos há por tipo.
  require('./utils/retroatividade').aplicarRetroatividade();

  // Simulador de alto fluxo (só quando SIMULAR=1) — cria tickets ao vivo pra teste. Ver
  // scripts/simulador.js. Roda em paralelo, sem travar o bot (que segue respondendo normalmente).
  if (process.env.SIMULAR === '1') {
    require('./scripts/simulador').run(client, guild).catch(err => console.error('[simulador] erro:', err));
  }
  // Demo completa ponta a ponta (só quando SIMULAR_DEMO=1) — encena ~40 cenários fazendo o papel de
  // cada cargo, pro operador assistir sozinho. Ver scripts/simuladorDemo.js. Arquiva tudo no fim.
  if (process.env.SIMULAR_DEMO === '1') {
    require('./scripts/simuladorDemo').run(client, guild).catch(err => console.error('[simuladorDemo] erro:', err));
  }

  const rodarChecagens = () => {
    // Tarefa agendada também passa pelo guard: ela escreve no banco e manda mensagem sem ninguém
    // ter clicado em nada. É o caminho que mais silenciosamente escreveria no servidor errado.
    if (!guildGuard.guardarEvento('checagens-diarias', guild)) return;
    verificarPrazosJulgamento(client, guild).catch(err => console.error('Erro na checagem diária de prazos:', err));
    verificarRenovacoesPorteArma(client).catch(err => console.error('Erro na checagem diária de porte de arma:', err));
    // Parte 3: reconcilia rh + reatribui tickets com responsável fantasma (saiu do servidor / perdeu
    // o cargo). Passada A (rh) antes da B (tickets), dentro da própria função. Sem cron novo.
    require('./utils/responsaveis').varrerResponsaveisFantasma(guild).catch(err => console.error('Erro na varredura de responsável fantasma:', err));
    // Diário: backfill retroativo dos atos decisórios não publicados. Em silêncio (sem @everyone).
    // Idempotente. NÃO publica mandado não cumprido (escape do Nível 2 desligado por política).
    require('./utils/diarioAtos').varrerDiario(guild).catch(err => console.error('Erro na varredura do Diário:', err));
  };
  rodarChecagens();
  setInterval(rodarChecagens, DIA_MS);

  const painel = client.commands.get('painel');

  // Prazos curtos (1h, 24h), retentativas e limpeza do canal do painel não esperam o job
  // diário — rodam a cada 10min.
  const rodarChecagensFrequentes = () => {
    if (!guildGuard.guardarEvento('checagens-10min', guild)) return;
    verificarProcessosSemJuiz(client, guild).catch(err => console.error('Erro na retentativa de sorteio de Juiz (civil):', err));
    verificarProcessosPenaisSemJuiz(client, guild).catch(err => console.error('Erro na retentativa de sorteio de Juiz (penal):', err));
    verificarPeticoesSemJuiz(client, guild).catch(err => console.error('Erro na retentativa de sorteio de Juiz (petição):', err));
    verificarDiligenciasPendentes(client, guild).catch(err => console.error('Erro na checagem de diligências pendentes:', err));
    verificarMedidasAguardandoMP(client, guild).catch(err => console.error('Erro na checagem de medidas aguardando MP:', err));
    verificarMedidasAguardandoJuiz(client, guild).catch(err => console.error('Erro na checagem de medidas aguardando Juiz:', err));
    verificarMandadosPendentes(client, guild).catch(err => console.error('Erro na checagem de mandados pendentes:', err));
    verificarApelacoesPendentes(client, guild).catch(err => console.error('Erro na checagem de apelações pendentes:', err));
    verificarPrazosContestacao(client, guild).catch(err => console.error('Erro na checagem de prazos de contestação:', err));
    verificarPrazoHabilitacao(client, guild).catch(err => console.error('Erro na checagem de prazo de habilitação (48h):', err));
    verificarPrazoDefesa(client, guild).catch(err => console.error('Erro na checagem de prazo de defesa (24h):', err));
  };
  rodarChecagensFrequentes();
  setInterval(rodarChecagensFrequentes, DEZ_MIN_MS);

  if (painel?.postarPainelFixo) await painel.postarPainelFixo(guild, client).catch(err => console.error('Erro ao postar painel fixo:', err));
});

// Alguém vinculado por ID (cliente/réu que ainda não estava no servidor no momento do vínculo)
// entrou agora — aplica o apelido automaticamente, sem precisar de nenhuma ação manual.
client.on('guildMemberAdd', async member => {
  if (!guildGuard.guardarEvento('guildMemberAdd', member.guild, `membro ${member.id}`)) return;
  const sincronizado = await ficha.sincronizarNovoMembro(member).catch(err => {
    console.error(`Erro ao sincronizar novo membro ${member.id}:`, err);
    return null;
  });
  if (sincronizado) console.log(`Apelido sincronizado automaticamente pra ${member.id} ao entrar no servidor.`);
});

// Parte 3 (evento — reação imediata; a varredura diária é a rede de segurança). Quem SAI do servidor
// deixa de ser responsável válido: demite no rh e reatribui os tickets abertos onde estava marcado.
// Só reage a SAÍDA (guildMemberRemove, presença) — reagir a remoção de role foi removido porque
// gerava reatribuição indevida (o próprio swap de cargo do bot removia/readicionava a role).
client.on('guildMemberRemove', async member => {
  // Já filtrava por guild na mão; agora passa pelo guard central (fail-closed também quando
  // member.guild vem sem id) e o motivo da recusa fica no log.
  if (!guildGuard.guardarEvento('guildMemberRemove', member.guild, `membro ${member.id}`)) return;
  try {
    const tratados = await require('./utils/responsaveis').tratarResponsavelInvalido(member.guild, member.id, 'ausente');
    if (tratados.length) console.log(`♻️ [fantasma/evento] Saída de ${member.id}: ${tratados.length} ticket(s) reatribuído(s).`);
  } catch (err) { console.error('Erro ao tratar saída de membro (responsável):', err); }
});

// Só a integração com a Polícia Civil continua ouvindo mensagens novas — a auto-limpeza do canal
// do painel foi removida a pedido do operador. A única faxina que sobrou é a dedup de painéis
// duplicados do próprio bot, que roda quando o painel fixo é postado/editado (postarPainelFixo).
client.on('messageCreate', message => {
  // Ordem importa: o filtro por canal vem primeiro pra não logar recusa a cada mensagem de
  // qualquer canal de qualquer servidor. Depois dele, o guard fecha a porta do webhook —
  // requerimento da Polícia Civil vindo de fora do guild configurado não vira medida cautelar.
  if (message.channelId !== config.canalRequerimentoPoliciaCivilId) return;
  if (!guildGuard.guardarEvento('webhook/policia-civil', message.guildId ?? message.guild, `mensagem ${message.id}`)) return;
  integracaoPoliciaCivil.processarRequerimento(message).catch(err => console.error('Erro na integração com a Polícia Civil:', err));
});

// A aplicação nova foi convidada pra um servidor que não é o dela. Não faz nada (não sai do
// servidor sozinho — isso é decisão do operador), só grita no log: sintoma de token/convite
// trocado entre as instalações, que é justamente o que o isolamento precisa deixar visível.
client.on('guildCreate', guild => {
  if (guildGuard.guildPermitida(guild)) return;
  console.warn(`[guard] ⚠️ bot ADICIONADO a um servidor fora do escopo: ${guild.name} (${guild.id}). GUILD_ID desta instalação é ${guildGuard.guildAlvo()}. O bot NÃO vai operar ali; remova o convite ou revise o token/GUILD_ID.`);
});

async function responderErro(interaction, err) {
  console.error(err);
  const resposta = { content: `Ocorreu um erro ao processar isso: \`${err.message || err}\``, ephemeral: true };
  if (interaction.replied || interaction.deferred) await interaction.followUp(resposta).catch(() => {});
  else await interaction.reply(resposta).catch(() => {});
}

client.on('interactionCreate', async interaction => {
  try {
    // PRIMEIRA coisa, antes de qualquer roteamento: interação de outro servidor (ou de DM) é
    // recusada em efêmero e não chega em comando nenhum — nenhuma leitura, nenhuma escrita.
    if (!await guildGuard.guardarInteracao(interaction)) return;

    // Slash commands
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (command) await command.execute(interaction);
      return;
    }

    // Autocomplete (ex: /crime buscar)
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }

    // Painel interativo: qualquer botão/select/modal cujo customId comece com "painel:"
    if (interaction.customId && interaction.customId.startsWith('painel:')) {
      const painel = client.commands.get('painel');
      if (painel?.router) await painel.router(interaction);
      return;
    }

    // Peças com entrega in-game: botões/modais com prefixo "peca:" → router de utils/emissaoPeca.
    // Só o lado da emissão está ligado; o recebimento entra depois do teste in-game do selo.
    if (interaction.customId && interaction.customId.startsWith('peca:')) {
      await require('./utils/emissaoPeca').router(interaction);
      return;
    }

    // Edital (processo seletivo): botões/modais com prefixo "edital:" → router do /abrir-edital.
    if (interaction.customId && interaction.customId.startsWith('edital:')) {
      const edital = client.commands.get('abrir-edital');
      if (edital?.router) await edital.router(interaction);
      return;
    }

    // Botões: customId no formato "modulo:acao:numero"
    if (interaction.isButton()) {
      const [modulo, acao, numero] = interaction.customId.split(':');
      const comando = client.commands.get(modulo);
      const mapa = {
        medida: { aprovar: 'aprovar', negar: 'negar', recorrer: 'recorrer', referendar: 'referendar', cumprir: 'cumprirMandado', abrirprocesso: 'abrirProcesso', anexarindicios: 'anexarIndicios' },
        processo: { oferecer: 'oferecer', arquivar: 'arquivar', julgar: 'julgar' },
      };
      const nomeHandler = mapa[modulo]?.[acao];
      if (comando && nomeHandler && comando[nomeHandler]) {
        await comando[nomeHandler](interaction, numero);
      }
      return;
    }

    // Modais: customId no formato "modulo:acao:numero"
    if (interaction.isModalSubmit()) {
      const [modulo, acao, numero] = interaction.customId.split(':');
      const comando = client.commands.get(modulo);
      // Obs.: o modal de sentença é emitido com prefixo `painel:` (modalSentenca em processo.js),
      // então é tratado por tratarModal no painel.js — não há modal `processo:sentenca` "nu".
      if (modulo === 'medida' && acao === 'processomodal' && comando?.criarProcessoModal) {
        await comando.criarProcessoModal(interaction, numero);
      }
      return;
    }
  } catch (err) {
    await responderErro(interaction, err);
  }
});

client.on('error', (err) => console.error('[client error]', err instanceof Error ? err.message : err));
client.on('shardError', (err) => console.error('[shardError]', err instanceof Error ? err.message : err));
client.on('shardDisconnect', (event, id) => console.error(`[shardDisconnect] shard ${id} fechou: code=${event?.code} reason=${event?.reason}`));

client.login(config.token)
  .catch((err) => console.error('[login FALHOU]', err instanceof Error ? err.stack : err));
