const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'dados.json');
const TABELAS = ['processos', 'medidas', 'mandados', 'oficios', 'rh', 'apelacoes', 'peticoes', 'identidades'];

function carregar() {
  if (!fs.existsSync(DB_PATH)) {
    const inicial = Object.fromEntries(TABELAS.map(t => [t, []]));
    fs.writeFileSync(DB_PATH, JSON.stringify(inicial, null, 2));
    return inicial;
  }
  const dados = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  // garante que tabelas novas existam em bancos antigos
  for (const t of TABELAS) if (!dados[t]) dados[t] = [];
  return dados;
}

function salvar(dados) {
  fs.writeFileSync(DB_PATH, JSON.stringify(dados, null, 2));
}

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
