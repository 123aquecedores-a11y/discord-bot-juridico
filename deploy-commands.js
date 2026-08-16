const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');
const guildGuard = require('./utils/guildGuard');

// Mesma trava do boot do bot: registrar comandos é escrita no Discord e vai PARA UM GUILD.
// Sem GUILD_ID (ou com valor inválido) o deploy morre aqui com mensagem clara, em vez de mandar
// um request torto pra API — e, principalmente, em vez de registrar os comandos da instalação B
// no servidor da instalação A. Confira também CLIENT_ID: cada instalação tem o seu.
try {
  guildGuard.exigirGuildConfigurada();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!config.clientId) {
  console.error('[deploy] CLIENT_ID não está definida — é o Application ID da aplicação DESTA instalação. Abortado.');
  process.exit(1);
}
console.log(`[deploy] aplicação ${config.clientId} → servidor ${config.guildId}`);

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`Registrando ${commands.length} comando(s) de barra...`);
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands },
    );
    console.log('✅ Comandos registrados com sucesso no servidor configurado.');
  } catch (error) {
    console.error('Erro ao registrar comandos:', error);
  }
})();
