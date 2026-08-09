// Posta uma entrada no canal de changelog do bot.
// Uso: node scripts/changelog.js "Título da mudança" "Descrição opcional, pode ter várias linhas"
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const [, , titulo, descricao] = process.argv;

if (!titulo) {
  console.error('Uso: node scripts/changelog.js "Título da mudança" "Descrição opcional"');
  process.exit(1);
}

(async () => {
  const canalId = process.env.CANAL_CHANGELOG_ID;
  if (!canalId) {
    console.error('CANAL_CHANGELOG_ID não configurado no .env.');
    process.exit(1);
  }

  const embed = {
    title: `🛠️ ${titulo}`,
    description: descricao || undefined,
    color: 0x3498db,
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(`https://discord.com/api/v10/channels/${canalId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (res.status === 200) {
    console.log('Changelog postado.');
  } else {
    console.error('Falha ao postar changelog:', res.status, await res.text());
    process.exit(1);
  }
})();
