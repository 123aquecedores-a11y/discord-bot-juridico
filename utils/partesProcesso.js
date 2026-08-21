// Registro unificado de "Partes do Processo" (spec-atualizacoes-bot-juridico.md, seção 0) —
// base pra mandado/intimação oferecerem "escolha entre quem já está no processo" (seções 3/4)
// e pra testemunha existir como conceito de dados pela primeira vez. NÃO substitui
// processo.reus/reuNome/autorNome (continuam existindo como sempre) — só espelha esses mesmos
// dados num formato único, e é onde testemunha/terceiro passam a morar.
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const db = require('../database/db');

const PAPEIS_TESTEMUNHA = ['testemunha_acusacao', 'testemunha_defesa'];
const ROTULO_PAPEL = { reu: 'Réu', autor: 'Autor', testemunha_acusacao: 'Test. Acusação', testemunha_defesa: 'Test. Defesa', terceiro: 'Terceiro' };

function proximoIdParte(processo) {
  const maxAtual = (processo.partes || []).reduce((max, p) => {
    const n = parseInt(String(p.id).replace(/^p/, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `p${maxAtual + 1}`;
}

// Usado depois que o processo já existe no banco (parte tardia, mandado pra "pessoa fora do
// processo") — gera o próprio id sequencial a partir do que já está salvo.
function adicionarParte(numero, { papel, nome = null, discordId = null, rg = null, origem, adicionadoPor }) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return null;
  const parte = {
    id: proximoIdParte(processo), papel, nome, discordId, rg, origem,
    adicionadoEm: new Date().toISOString(), adicionadoPor,
  };
  db.atualizar('processos', numero, { partes: [...(processo.partes || []), parte] });
  return parte;
}

// Usado só na abertura do processo — o registro ainda não existe no banco nesse momento (quem
// chama isso monta a lista e passa direto no payload do db.inserir), então os ids nascem
// sequenciais a partir de uma lista vazia, sem precisar consultar nada.
function espelharPartesDaAbertura({ reus = [], reuNome = null, reuRg = null, autorId = null, autorNome = null, autorRg = null, adicionadoPor }) {
  const agora = new Date().toISOString();
  const partes = [];
  for (const discordId of reus) {
    partes.push({ papel: 'reu', nome: reuNome, discordId, rg: reuRg, origem: 'abertura', adicionadoEm: agora, adicionadoPor });
  }
  // Réu só por nome/RG (sem Discord — Parte 2): mesmo sem id no array `reus`, ele precisa virar
  // parte pra aparecer na lista de destinatários de intimação/mandado (igual ao autor abaixo).
  if (reus.length === 0 && (reuNome || reuRg)) {
    partes.push({ papel: 'reu', nome: reuNome, discordId: null, rg: reuRg, origem: 'abertura', adicionadoEm: agora, adicionadoPor });
  }
  if (autorId || autorNome || autorRg) {
    partes.push({ papel: 'autor', nome: autorNome, discordId: autorId || null, rg: autorRg, origem: 'abertura', adicionadoEm: agora, adicionadoPor });
  }
  return partes.map((p, i) => ({ id: `p${i + 1}`, ...p }));
}

function listarPartes(processo, filtroPapel = null) {
  const partes = processo.partes || [];
  if (!filtroPapel) return partes;
  const papeis = Array.isArray(filtroPapel) ? filtroPapel : [filtroPapel];
  return partes.filter(p => papeis.includes(p.papel));
}

function listarTestemunhas(processo) {
  return listarPartes(processo, PAPEIS_TESTEMUNHA);
}

// Testemunha pode ter mais de um depoimento (ex: um no inquérito com o Delegado, outro em
// instrução com o Juiz) — histórico completo, nunca sobrescreve o anterior.
function registrarDepoimento(numero, { parteId, colhidoPor, papelDeQuemColheu, texto }) {
  const processo = db.buscarPorNumero('processos', numero);
  if (!processo) return null;
  const depoimento = { parteId, colhidoPor, papelDeQuemColheu, texto, dataHora: new Date().toISOString() };
  db.atualizar('processos', numero, { depoimentos: [...(processo.depoimentos || []), depoimento] });
  return depoimento;
}

// Select de destinatário (spec-atualizacoes-bot-juridico.md, seção 3/4) — compartilhado entre
// mandado e intimação. Discord limita select a 25 opções; corta em 24 partes + a opção fixa
// "Pessoa fora do processo" pra nunca estourar (paginar/agrupar fica pra quando isso virar
// problema de verdade — nenhum processo real chegou perto disso até hoje).
// `incluirAdvogados` só é ligado pela INTIMAÇÃO (18/08/2026). Mandado e medida continuam sem, de
// propósito: mandado se dirige a um alvo a ser preso/buscado, não ao defensor dele.
//
// Antes desta mudança o seletor listava só `partes[]` — réu, autor, testemunhas, terceiros — e o
// advogado NÃO aparecia em lugar nenhum. Como o ato gated `intimacao_juiz` é dirigido justamente ao
// Advogado, o único destinatário que o mecanismo sabe tratar era o único que a UI não oferecia.
function selectDestinatario(customId, processo, { incluirAdvogados = false } = {}) {
  const opcoes = [];
  if (incluirAdvogados) {
    for (const h of (processo.habilitacoes || [])) {
      if (h.status !== 'Aprovado' || !h.advogadoId) continue;
      opcoes.push({
        label: `[Advogado] ${h.advogadoNome || h.advogadoId}`.slice(0, 100),
        value: `hab:${h.id}`,
      });
    }
  }
  opcoes.push(...(processo.partes || []).slice(0, 24 - opcoes.length).map(p => ({
    label: `[${ROTULO_PAPEL[p.papel] || p.papel}] ${p.nome || p.discordId || 'sem identificação'}`.slice(0, 100),
    value: p.id,
  })));
  opcoes.push({ label: 'Pessoa fora do processo', value: 'fora' });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Quem é o destinatário?').addOptions(opcoes),
  );
}

// "ID" do modal de "pessoa fora do processo" é texto livre que pode ser RG ou Discord ID —
// heurística simples: só dígitos no tamanho de um snowflake do Discord (17-20) vira discordId,
// resto vira rg (ou qualquer outro identificador que a pessoa tenha digitado).
function classificarIdLivre(idTexto) {
  const limpo = (idTexto || '').trim();
  if (/^\d{17,20}$/.test(limpo)) return { discordId: limpo, rg: null };
  return { discordId: null, rg: limpo || null };
}

// QUEM NÃO PODE LER O PRÓPRIO CASO (20/08/2026).
//
// Existe desde sempre como regra de negócio — réu não julga a si mesmo, alvo não acompanha a
// diligência contra ele. Virou também uma regra de PERMISSÃO DE CANAL quando os quatro cargos de
// magistratura e MP passaram a ver todo ticket: sem isto, um Promotor que é RÉU num processo
// enxergaria, pelo cargo, o canal onde se decide sobre ele.
//
// Pega o alvo por TODA porta em que ele pode estar gravado, e não só por `partes[]`: o mesmo
// impedimento tem que valer no processo (reus/autorDiscordId), na medida (alvoDiscordId) e nas
// partes tardias. Esquecer uma porta é deixar o buraco aberto justamente no caso raro.
const PAPEIS_IMPEDIDOS = ['reu', 'autor', 'testemunha_acusacao', 'testemunha_defesa'];

function idsImpedidos(registro) {
  if (!registro) return [];
  const ids = [
    ...(registro.reus || []),
    registro.autorDiscordId,
    registro.alvoDiscordId,
    ...(registro.partes || []).filter(p => PAPEIS_IMPEDIDOS.includes(p.papel)).map(p => p.discordId),
  ];
  return [...new Set(ids.filter(Boolean).map(String))];
}

module.exports = {
  PAPEIS_TESTEMUNHA, adicionarParte, espelharPartesDaAbertura, listarPartes, listarTestemunhas, registrarDepoimento,
  selectDestinatario, classificarIdLivre, idsImpedidos, PAPEIS_IMPEDIDOS,
};
