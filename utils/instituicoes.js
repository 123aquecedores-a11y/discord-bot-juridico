// Cadastro de instituições — destinatários de ofício da Promotoria (spec-atualizacoes-bot-
// juridico.md, seção 6). Separado do processo (reutilizável por qualquer ofício).
//
// Campo `slug` é o "ID" que a spec descreve — não usamos o nome `id` pra isso porque toda
// tabela deste banco usa `id` como número auto-incremental global (utils/numeracao.js e
// gerarId em database/db.js escaneiam `.id` esperando número; um `id` string quebraria isso
// pra TODAS as tabelas, não só instituições).
const db = require('../database/db');

function listar() {
  return db.todos('instituicoes');
}

function buscarPorSlug(slug) {
  return db.buscarUm('instituicoes', i => i.slug === slug);
}

function adicionar({ nome, slug, paiSlug }) {
  if (!nome || !slug) return { erro: 'Nome e ID são obrigatórios.' };
  if (buscarPorSlug(slug)) return { erro: `Já existe uma instituição cadastrada com o ID "${slug}".` };
  if (paiSlug && !buscarPorSlug(paiSlug)) {
    return { erro: `Órgão superior "${paiSlug}" não encontrado no cadastro. Deixe em branco (ou digite "nenhum") se for um órgão raiz.` };
  }
  const registro = db.inserir('instituicoes', { slug, nome, pai: paiSlug || null });
  return { instituicao: registro };
}

module.exports = { listar, buscarPorSlug, adicionar };
