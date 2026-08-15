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

  // Auto-cria os canais de publicação (📜│diário-oficial e 📢│editais) se faltarem — idempotente,
  // não duplica, e não derruba o boot se faltar permissão (ver utils/garantirCanais.js).
  await garantirCanais(guild);

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
    verificarPrazosJulgamento(client, guild).catch(err => console.error('Erro na checagem diária de prazos:', err));
    verificarRenovacoesPorteArma(client).catch(err => console.error('Erro na checagem diária de porte de arma:', err));
    // Parte 3: reconcilia rh + reatribui tickets com responsável fantasma (saiu do servidor / perdeu
    // o cargo). Passada A (rh) antes da B (tickets), dentro da própria função. Sem cron novo.
    require('./utils/responsaveis').varrerResponsaveisFantasma(guild).catch(err => console.error('Erro na varredura de responsável fantasma:', err));
  };
  rodarChecagens();
  setInterval(rodarChecagens, DIA_MS);

  const painel = client.commands.get('painel');

  // Prazos curtos (1h, 24h), retentativas e limpeza do canal do painel não esperam o job
  // diário — rodam a cada 10min.
  const rodarChecagensFrequentes = () => {
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
  const sincronizado = await ficha.sincronizarNovoMembro(member).catch(err => {
    console.error(`Erro ao sincronizar novo membro ${member.id}:`, err);
    return null;
  });
  if (sincronizado) console.log(`Apelido sincronizado automaticamente pra ${member.id} ao entrar no servidor.`);
});

// Parte 3 (evento — reação imediata; a varredura diária é a rede de segurança). Quem sai do servidor
// deixa de ser responsável válido: demite no rh e reatribui os tickets abertos onde estava marcado.
// Sem isso, o fantasma persistiria por até 24h (até a próxima varredura).
client.on('guildMemberRemove', async member => {
  if (config.guildId && member.guild && member.guild.id !== config.guildId) return;
  try {
    const tratados = await require('./utils/responsaveis').tratarResponsavelInvalido(member.guild, member.id, 'ausente');
    if (tratados.length) console.log(`♻️ [fantasma/evento] Saída de ${member.id}: ${tratados.length} ticket(s) reatribuído(s).`);
  } catch (err) { console.error('Erro ao tratar saída de membro (responsável):', err); }
});

// Perdeu o cargo (role removida) mas continua no servidor — mesmo tratamento. cargoSemRole filtra:
// só age se o membro tinha cargo ativo no rh e não tem mais a role (ignora nickname etc., que
// também disparam guildMemberUpdate).
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (config.guildId && newMember.guild && newMember.guild.id !== config.guildId) return;
  try {
    const resp = require('./utils/responsaveis');
    if (!resp.cargoSemRole(newMember)) return;
    const tratados = await resp.tratarResponsavelInvalido(newMember.guild, newMember.id, 'sem_cargo');
    if (tratados.length) console.log(`♻️ [fantasma/evento] ${newMember.id} perdeu o cargo: ${tratados.length} ticket(s) reatribuído(s).`);
  } catch (err) { console.error('Erro ao tratar perda de cargo (responsável):', err); }
});

// Só a integração com a Polícia Civil continua ouvindo mensagens novas — a auto-limpeza do canal
// do painel foi removida a pedido do operador. A única faxina que sobrou é a dedup de painéis
// duplicados do próprio bot, que roda quando o painel fixo é postado/editado (postarPainelFixo).
client.on('messageCreate', message => {
  if (message.channelId !== config.canalRequerimentoPoliciaCivilId) return;
  integracaoPoliciaCivil.processarRequerimento(message).catch(err => console.error('Erro na integração com a Polícia Civil:', err));
});

async function responderErro(interaction, err) {
  console.error(err);
  const resposta = { content: `Ocorreu um erro ao processar isso: \`${err.message || err}\``, ephemeral: true };
  if (interaction.replied || interaction.deferred) await interaction.followUp(resposta).catch(() => {});
  else await interaction.reply(resposta).catch(() => {});
}

client.on('interactionCreate', async interaction => {
  try {
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
