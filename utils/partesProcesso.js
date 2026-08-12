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
function espelharPartesDaAbertura({ reus = [], reuNome = null, autorId = null, autorNome = null, adicionadoPor }) {
  const agora = new Date().toISOString();
  const partes = [];
  for (const discordId of reus) {
    partes.push({ papel: 'reu', nome: reuNome, discordId, rg: null, origem: 'abertura', adicionadoEm: agora, adicionadoPor });
  }
  if (autorId || autorNome) {
    partes.push({ papel: 'autor', nome: autorNome, discordId: autorId || null, rg: null, origem: 'abertura', adicionadoEm: agora, adicionadoPor });
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
function selectDestinatario(customId, processo) {
  const opcoes = (processo.partes || []).slice(0, 24).map(p => ({
    label: `[${ROTULO_PAPEL[p.papel] || p.papel}] ${p.nome || p.discordId || 'sem identificação'}`.slice(0, 100),
    value: p.id,
  }));
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

module.exports = {
  PAPEIS_TESTEMUNHA, adicionarParte, espelharPartesDaAbertura, listarPartes, listarTestemunhas, registrarDepoimento,
  selectDestinatario, classificarIdLivre,
};
