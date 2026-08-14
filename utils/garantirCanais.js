// Auto-criação dos canais de publicação no boot (evento ready). Idempotente: se o ID já está no
// `estado` e o canal ainda existe, não faz nada; se falta (nunca criado) ou o canal foi apagado,
// cria de novo, salva o ID e loga. Requer "Gerenciar Canais" — sem ela, só loga aviso e segue
// (NÃO derruba o bot). Os comandos /criar-diario-oficial e /criar-canal-editais continuam como
// fallback manual. NÃO toca na env legada CANAL_DIARIO_OFICIAL_ID (canal de pegar-casos).
const estado = require('./estado');
const diario = require('./diarioOficial');
const { criarCanalReadonly } = require('./canalReadonly');

async function garantirUmCanal(guild, { getId, setId, nome, topic, rotulo, aoCriar }) {
  const idAtual = getId();
  if (idAtual) {
    const existente = await guild.channels.fetch(idAtual).catch(() => null);
    if (existente) return; // idempotente — já existe, não duplica
    console.warn(`[garantirCanais] ${rotulo}: ID ${idAtual} salvo mas o canal sumiu — recriando.`);
  }
  const { canal, erroMsg } = await criarCanalReadonly(guild, guild.client.user.id, { nome, topic });
  if (erroMsg) { console.warn(`[garantirCanais] ${rotulo}: ${erroMsg}`); return; }
  setId(canal.id);
  console.log(`[garantirCanais] ${rotulo} criado automaticamente: #${canal.name} (${canal.id}).`);
  if (aoCriar) await aoCriar(canal).catch(() => {});
}

// Garante os dois canais. Blindada: qualquer erro é logado e engolido (não interrompe o boot).
async function garantirCanais(guild) {
  if (!guild) return;
  try {
    await garantirUmCanal(guild, {
      getId: () => diario.getCanalId(),
      setId: (id) => diario.setCanalId(id),
      nome: '📜│diário-oficial',
      topic: 'Diário Oficial Eletrônico — publicações automáticas de atos oficiais (somente leitura).',
      rotulo: 'Diário Oficial',
      aoCriar: () => diario.publicarNoDiario(guild, 'default', { texto: 'Diário Oficial Eletrônico instituído. Os atos oficiais são publicados automaticamente aqui.' }),
    });
    await garantirUmCanal(guild, {
      getId: () => estado.obter('canalEditaisId'),
      setId: (id) => estado.definir('canalEditaisId', id),
      nome: '📢│editais',
      topic: 'Editais de processo seletivo — inscrições pelos botões abaixo de cada edital (somente leitura).',
      rotulo: 'Canal de editais',
    });
  } catch (e) {
    console.error('[garantirCanais] erro inesperado (ignorado, não derruba o bot):', e.message);
  }
}

module.exports = { garantirCanais };
