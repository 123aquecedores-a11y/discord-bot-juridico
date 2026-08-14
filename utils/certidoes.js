// Pedido de certidão de antecedentes/não constar como investigado — o mesmo documento que já
// era exigido informalmente em porte de arma, troca de nome e limpeza de ficha
// (DOCUMENTOS_NECESSARIOS, peticao.js), agora com um jeito formal de requisitar de verdade,
// via webhook, pra quem emite certidão de fato. Juiz e Desembargador pedem em nome do
// Judiciário; Promotor e Procurador em nome do Ministério Público — cabeçalho do documento
// muda conforme quem pede (são instituições diferentes).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const documentos = require('./documentos');
const auditoria = require('./auditoria');
const canais = require('./canais');
const { proximoNumeroClassico } = require('./numeracao');
const { temCargo } = require('./permissoes');
const ministerioPublico = require('./ministerioPublico');

const CATEGORIA_CERTIDOES_CHAVE = 'categoriaCertidoesId';
const CATEGORIA_CERTIDOES_NOME = '📄 Certidões';

function podeSolicitarCertidao(interaction) {
  // Frente 4a.4 — reusa ehMembroDoMP (isAdmin || Promotor || Procurador) no lugar do reinline.
  return ministerioPublico.ehMembroDoMP(interaction) || temCargo(interaction, 'Juiz') || temCargo(interaction, 'Desembargador');
}

function botaoArquivarCertidao(numero) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`painel:acao:certidao:arquivarmanual:${numero}`).setLabel('📦 Arquivar').setStyle(ButtonStyle.Secondary),
  );
}

async function solicitarCertidao({ guild, rg, nomeCliente, finalidade, executorId, instituicao }) {
  const numero = proximoNumeroClassico(db, 'certidoes', 'CERT');
  const texto = documentos.textoRequisicaoCertidao({ numero, rg, nomeCliente, finalidade, autorId: executorId, instituicao });

  // Mesmo padrão de ticket por instrumento já usado em ofício e nos atos do MP — quem pediu
  // acompanha a certidão isolada num canal próprio, em vez de só um webhook solto.
  const categoriaId = await canais.obterOuCriarCategoria(guild, CATEGORIA_CERTIDOES_CHAVE, CATEGORIA_CERTIDOES_NOME);
  const canal = await canais.criarCanalTicket(guild, { categoriaId, prefixo: 'certidao', numero, membros: [executorId] });
  await canal.send({ content: `<@${executorId}>\n\n${texto}`, components: [botaoArquivarCertidao(numero)] });

  db.inserir('certidoes', { numero, rg, nomeCliente, finalidade, executorId, instituicao, canalId: canal.id });

  if (config.webhookCertidoesUrl) {
    await fetch(config.webhookCertidoesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `${instituicao} — Sistema Integrado`, content: texto }),
    }).catch(err => console.error('Falha ao enviar requisição de certidão:', err.message));
  }

  await auditoria.registrar(guild, {
    acao: 'Certidão de antecedentes requisitada', executorId,
    referencia: `${numero}: RG ${rg} (${nomeCliente}) — ${finalidade}`,
  });

  return { numero, texto, canal };
}

module.exports = { podeSolicitarCertidao, solicitarCertidao };
