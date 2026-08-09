const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const config = require('./config');
const { verificarPrazosJulgamento, verificarRenovacoesPorteArma, DIA_MS } = require('./utils/prazos');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error('Não foi possível carregar o servidor configurado (GUILD_ID) — job diário de prazos não vai rodar.');
    return;
  }

  const rodarChecagens = () => {
    verificarPrazosJulgamento(client, guild).catch(err => console.error('Erro na checagem diária de prazos:', err));
    verificarRenovacoesPorteArma(client).catch(err => console.error('Erro na checagem diária de porte de arma:', err));
  };
  rodarChecagens();
  setInterval(rodarChecagens, DIA_MS);

  const painel = client.commands.get('painel');
  if (painel?.postarPainelFixo) await painel.postarPainelFixo(guild, client).catch(err => console.error('Erro ao postar painel fixo:', err));
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

    // Botões: customId no formato "modulo:acao:numero"
    if (interaction.isButton()) {
      const [modulo, acao, numero] = interaction.customId.split(':');
      const comando = client.commands.get(modulo);
      const mapa = {
        medida: { aprovar: 'aprovar', negar: 'negar', recorrer: 'recorrer', referendar: 'referendar', cumprir: 'cumprirMandado', abrirprocesso: 'abrirProcesso' },
        processo: { oferecer: 'oferecer', arquivar: 'arquivar', habilitar: 'habilitar', julgar: 'julgar' },
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
      if (modulo === 'processo' && acao === 'sentenca' && comando?.salvarSentenca) {
        await comando.salvarSentenca(interaction, numero);
      }
      if (modulo === 'medida' && acao === 'processomodal' && comando?.criarProcessoModal) {
        await comando.criarProcessoModal(interaction, numero);
      }
      return;
    }
  } catch (err) {
    await responderErro(interaction, err);
  }
});

client.login(config.token);
