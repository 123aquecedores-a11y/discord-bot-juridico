// INTERRUPTOR GERAL — "Modo Entrega In-Game" (SPEC §11.2).
//
// É o kill switch da feature, e a única coisa que ele faz é decidir qual `modoEntrega` vai ser
// CARIMBADO no processo na abertura. Processo que já está correndo nunca muda de modo: rito misto
// no meio dos autos é pior que rito antigo, e o jogador que abriu o caso de um jeito não pode ser
// surpreendido no meio.
//
// Por isso este módulo não tem nenhuma função de "aplicar retroativamente". Destravar pendências em
// emergência é ação SEPARADA e explícita (pecas.destravarTodasPendencias) — ação de emergência não
// pode acontecer como efeito colateral de um botão de rotina.
const db = require('../database/db');

// POR GUILD, NUNCA GLOBAL (SPEC §11.2.1). O bot atende o servidor do cliente pagante; uma flag
// global desligaria a feature dele junto.
//
// Tabela própria, e não `estado` nem `preferencias`:
//   - `estado` é chave/valor DERIVADO e regenerável — hoje guarda IDs de canal/categoria que o bot
//     descobre ou cria (painelMensagemId, categoriaCertidoesId) e contadores. Configuração de
//     política definida por gente não pertence ao mesmo balde do que o bot reconstrói sozinho.
//   - `preferencias` é POR PESSOA: o esquema é { discordId, ... }. Esta flag é por GUILD, e enfiar
//     duas entidades diferentes na mesma coleção só adia o problema.
const TABELA = 'configGuild';

const registro = (guildId) => db.buscarUm(TABELA, r => r.guildId === guildId);

// AUSÊNCIA DE REGISTRO = DESLIGADO. A primeira ativação é ato explícito da staff.
//
// As duas falhas não são simétricas, e é isso que decide o padrão: ligado por acidente faz
// processos novos nascerem `ingame` e trava jogadores sem ninguém entender por quê; desligado por
// acidente faz nascerem `aberto` — o RP perde graça, mas nada quebra. Erra-se para o lado que não
// trava ninguém.
function ligado(guildId) {
  const r = registro(guildId);
  return !!(r && r.modoEntregaInGame === true);
}

// O modo carimbado num processo que nasce AGORA. `legado` nunca sai daqui: nenhum processo novo
// nasce legado, nunca mais (SPEC §11.2.2).
const modoParaNovoProcesso = (guildId) => (ligado(guildId) ? 'ingame' : 'aberto');

// Log de quem ligou e desligou, com horário — visível nos autos dos processos afetados (SPEC §11.2.3).
function alternar(guildId, ligar, quemId, { agora = Date.now() } = {}) {
  const atual = registro(guildId);
  const jaEstava = !!(atual && atual.modoEntregaInGame === true);
  if (jaEstava === !!ligar) {
    return { ok: false, jaEstava, razao: `o Modo Entrega In-Game já está ${ligar ? 'ligado' : 'desligado'}` };
  }
  const evento = { ligado: !!ligar, porId: quemId, em: new Date(agora).toISOString() };
  const historico = [...((atual && atual.historico) || []), evento];

  if (atual) db.atualizarPorFiltro(TABELA, r => r.guildId === guildId, { modoEntregaInGame: !!ligar, historico });
  else db.inserir(TABELA, { guildId, modoEntregaInGame: !!ligar, historico });

  return { ok: true, ligado: !!ligar, evento, historico };
}

const ligar = (guildId, quemId, opcoes) => alternar(guildId, true, quemId, opcoes);
const desligar = (guildId, quemId, opcoes) => alternar(guildId, false, quemId, opcoes);

const historico = (guildId) => ((registro(guildId) || {}).historico || []);

// Registro perdido tem que ser visível na PRIMEIRA linha do log, não descoberto uma semana depois
// por um jogador reclamando. Chamado no boot.
function logarNoBoot(guildId) {
  const r = registro(guildId);
  if (!r) {
    console.warn(`[modo-entrega] guild ${guildId}: SEM REGISTRO — Modo Entrega In-Game DESLIGADO (padrão). Processos novos nascem 'aberto'. Se isso não era o esperado, o registro se perdeu e a staff precisa religar pelo painel.`);
    return { ligado: false, semRegistro: true };
  }
  const ultimo = (r.historico || [])[r.historico.length - 1];
  const quando = ultimo ? ` (último ajuste por ${ultimo.porId} em ${ultimo.em})` : '';
  console.log(`[modo-entrega] guild ${guildId}: Modo Entrega In-Game ${r.modoEntregaInGame ? 'LIGADO — processos novos nascem ingame' : 'DESLIGADO — processos novos nascem aberto'}${quando}`);
  return { ligado: !!r.modoEntregaInGame, semRegistro: false };
}

// Rótulo sem ambiguidade (SPEC §11.2.4): "modo metagame" não diz se ligado é permitir ou combater,
// e a staff erraria o clique.
const ROTULO = 'Modo Entrega In-Game';
const descricao = (estaLigado) => (estaLigado
  ? 'LIGADO — processos novos exigem entrega in-game (selo, janela e recebimento).'
  : 'DESLIGADO — processos novos geram o documento igual, visível às partes desde a criação.');

module.exports = { TABELA, ROTULO, ligado, modoParaNovoProcesso, ligar, desligar, historico, logarNoBoot, descricao };
