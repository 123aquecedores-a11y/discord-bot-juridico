const fs = require('fs');
const path = require('path');

// Em produção (Railway/Render/etc), o disco do container é efêmero — DADOS_JSON_PATH aponta
// pro volume persistente montado (ex: /data/dados.json), senão o banco inteiro some a cada
// redeploy/restart. Sem essa variável definida, continua usando o arquivo local de sempre.
const DB_PATH = process.env.DADOS_JSON_PATH || path.join(__dirname, '..', 'dados.json');
const TABELAS = ['processos', 'medidas', 'mandados', 'oficios', 'rh', 'apelacoes', 'peticoes', 'fichas', 'consultas', 'estado', 'certidoes', 'atosMp', 'documentosAnexados', 'dossiesInquerito', 'instituicoes', 'andamentos', 'solicitacoesCargo', 'preferencias'];

// Semente inicial do cadastro de instituições (spec-atualizacoes-bot-juridico.md, seção 6) —
// só entra na PRIMEIRA vez que a tabela aparece (banco novo, ou banco antigo ganhando a tabela
// pela primeira vez). Nunca reaplicada depois disso, mesmo que o staff apague tudo de propósito.
const INSTITUICOES_SEMENTE = [
  { id: 1, slug: 'pm_comando_geral', nome: 'Comando Geral da Polícia Militar', pai: null },
  { id: 2, slug: 'pm_baep', nome: 'BAEP - Batalhão de Ações Especiais de Polícia', pai: 'pm_comando_geral' },
  { id: 3, slug: 'pm_choque', nome: 'Batalhão de Choque', pai: 'pm_comando_geral' },
  { id: 4, slug: 'pm_radio_patrulha', nome: 'Rádio Patrulha', pai: 'pm_comando_geral' },
  { id: 5, slug: 'pm_bprv', nome: 'BPRV - Batalhão de Polícia Rodoviária', pai: 'pm_comando_geral' },
  { id: 6, slug: 'detran', nome: 'DETRAN', pai: null },
  { id: 7, slug: 'cet', nome: 'CET - Companhia de Engenharia de Tráfego', pai: 'detran' },
  { id: 8, slug: 'oab', nome: 'OAB - Ordem dos Advogados do Brasil', pai: null },
  { id: 9, slug: 'prf', nome: 'PRF - Polícia Rodoviária Federal', pai: null },
  { id: 10, slug: 'gcm_sp', nome: 'GCM-SP - Guarda Civil Metropolitana de São Paulo', pai: null },
];

function tabelaVazia(tabela) {
  return tabela === 'instituicoes' ? INSTITUICOES_SEMENTE.map(i => ({ ...i })) : [];
}

function carregar() {
  if (!fs.existsSync(DB_PATH)) {
    const inicial = Object.fromEntries(TABELAS.map(t => [t, tabelaVazia(t)]));
    fs.writeFileSync(DB_PATH, JSON.stringify(inicial, null, 2));
    return inicial;
  }
  const dados = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  // garante que tabelas novas existam em bancos antigos (com semente, se a tabela tiver uma)
  for (const t of TABELAS) if (!dados[t]) dados[t] = tabelaVazia(t);
  return dados;
}

function salvar(dados) {
  fs.writeFileSync(DB_PATH, JSON.stringify(dados, null, 2));
}

// Estrutura de um banco NOVO: todas as tabelas vazias, com a semente de instituições (a única
// tabela que nasce populada). É o mesmo que carregar() cria quando o arquivo não existe.
function estruturaVazia() {
  return Object.fromEntries(TABELAS.map(t => [t, tabelaVazia(t)]));
}

// Reset controlado do banco (produção/Railway). Roda UMA vez, no carregamento do módulo (antes de
// qualquer leitura), quando RESETAR_BANCO está ligada. Serve pra "subir limpo" no volume persistente
// sem acesso manual ao arquivo: sobrescreve o banco com a estrutura vazia e guarda o anterior em
// <arquivo>.bak-reset. ATENÇÃO: enquanto a flag estiver ligada, TODO redeploy zera de novo — depois
// de subir limpo, REMOVA/ZERE a variável RESETAR_BANCO no Railway.
function resetarSeConfigurado() {
  const flag = String(process.env.RESETAR_BANCO || '').trim().toLowerCase();
  if (flag !== '1' && flag !== 'true' && flag !== 'sim') return;
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_PATH + '.bak-reset');
  } catch (e) {
    console.error('[db] RESETAR_BANCO: falha ao salvar backup .bak-reset:', e.message);
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(estruturaVazia(), null, 2));
  console.warn(`[db] ⚠️ RESETAR_BANCO ATIVO — banco ZERADO em ${DB_PATH} (backup em ${DB_PATH}.bak-reset). REMOVA a variável RESETAR_BANCO no Railway pra não zerar de novo no próximo deploy.`);
}
resetarSeConfigurado();

function gerarId(dados) {
  const todosRegistros = TABELAS.flatMap(t => dados[t]);
  const maiorId = todosRegistros.reduce((max, r) => Math.max(max, r.id || 0), 0);
  return maiorId + 1;
}

function todos(tabela, filtro = null) {
  const dados = carregar();
  let lista = dados[tabela] || [];
  if (filtro) lista = lista.filter(filtro);
  return [...lista].sort((a, b) => b.id - a.id);
}

function buscarPorNumero(tabela, numero) {
  const dados = carregar();
  return (dados[tabela] || []).find(r => r.numero === numero) || null;
}

function buscarUm(tabela, filtro) {
  const dados = carregar();
  return (dados[tabela] || []).find(filtro) || null;
}

function inserir(tabela, registro) {
  const dados = carregar();
  const novo = { id: gerarId(dados), criado_em: new Date().toLocaleString('pt-BR'), ...registro };
  dados[tabela].push(novo);
  salvar(dados);
  return novo;
}

function atualizar(tabela, numero, campos) {
  const dados = carregar();
  const idx = (dados[tabela] || []).findIndex(r => r.numero === numero);
  if (idx === -1) return null;
  dados[tabela][idx] = { ...dados[tabela][idx], ...campos };
  salvar(dados);
  return dados[tabela][idx];
}

function atualizarPorFiltro(tabela, filtro, campos) {
  const dados = carregar();
  const idx = (dados[tabela] || []).findIndex(filtro);
  if (idx === -1) return null;
  dados[tabela][idx] = { ...dados[tabela][idx], ...campos };
  salvar(dados);
  return dados[tabela][idx];
}

function contar(tabela) {
  const dados = carregar();
  return (dados[tabela] || []).length;
}

module.exports = { todos, buscarPorNumero, buscarUm, inserir, atualizar, atualizarPorFiltro, contar };
