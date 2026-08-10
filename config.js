require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  staffRoleId: process.env.CARGO_STAFF_ID || null,
  oficiosChannelId: process.env.CANAL_OFICIOS_ID || null,

  // Categorias onde os canais-ticket são criados
  categoriaProcessosPenaisId: process.env.CATEGORIA_PROCESSOS_PENAIS_ID || null,
  categoriaProcessosCiveisId: process.env.CATEGORIA_PROCESSOS_CIVEIS_ID || null,
  categoriaMedidasId: process.env.CATEGORIA_MEDIDAS_ID || null,

  // Canal público onde a capa dos processos é postada/atualizada
  canalDiarioOficialId: process.env.CANAL_DIARIO_OFICIAL_ID || null,

  // Roles do Discord atribuídos automaticamente pelo /rh contratar
  roleDelegadoId: process.env.ROLE_DELEGADO_ID || null,
  rolePromotorId: process.env.ROLE_PROMOTOR_ID || null,
  roleJuizId: process.env.ROLE_JUIZ_ID || null,
  roleAdvogadoId: process.env.ROLE_ADVOGADO_ID || null,
  roleDesembargadorId: process.env.ROLE_DESEMBARGADOR_ID || null,
  roleProcuradorId: process.env.ROLE_PROCURADOR_ID || null,

  // Categoria dos canais de apelação + canal de log de auditoria
  categoriaApelacoesId: process.env.CATEGORIA_APELACOES_ID || null,
  canalAuditoriaId: process.env.CANAL_AUDITORIA_ID || null,

  // Categoria dos canais de petição administrativa
  categoriaPeticoesId: process.env.CATEGORIA_PETICOES_ID || null,

  // Canal onde fica o histórico de mudanças no bot
  canalChangelogId: process.env.CANAL_CHANGELOG_ID || null,

  // Canal com o /painel fixo (mensagem persistente, sempre a mesma, editada em vez de repostada)
  canalPainelId: process.env.CANAL_PAINEL_ID || null,

  // Categoria pra onde processos/medidas/apelações/petições concluídos são movidos ao arquivar
  categoriaArquivadosId: process.env.CATEGORIA_ARQUIVADOS_ID || null,

  // Categoria dos tickets de reconsideração (Delegado -> Procurador, quando o Promotor nega medida)
  categoriaReconsideracoesId: process.env.CATEGORIA_RECONSIDERACOES_ID || null,

  // Categoria dos tickets de consulta SISBAJUS (busca de ficha — Promotor pra cima)
  categoriaSisbajusId: process.env.CATEGORIA_SISBAJUS_ID || null,

  // Canal onde o bot da Polícia Civil posta requerimentos via webhook — vira medida provisória
  // automaticamente (ver utils/integracaoPoliciaCivil.js)
  canalRequerimentoPoliciaCivilId: process.env.CANAL_REQUERIMENTO_POLICIA_CIVIL_ID || null,

  // Webhook pra onde a decisão judicial de um mandado originado da Polícia Civil é devolvida
  // (ver utils/devolutivaPoliciaCivil.js)
  webhookDevolutivaPoliciaCivilUrl: process.env.WEBHOOK_DEVOLUTIVA_POLICIA_CIVIL_URL || null,

  // Cargo "Staff Salve" — override total, deliberado e restrito a quem tem essa role
  // especificamente (NÃO qualquer Administrator do Discord). Ver isSuperStaff em
  // utils/permissoes.js e o motivo dessa distinção lá.
  roleSuperStaffId: process.env.ROLE_SUPER_STAFF_ID || null,

  // Webhook pra onde vão os pedidos de certidão de antecedentes (Juiz/Promotor/Desembargador/
  // Procurador — ver utils/certidoes.js)
  webhookCertidoesUrl: process.env.WEBHOOK_CERTIDOES_URL || null,

  // Webhook do canal dedicado ao Ministério Público — requisição, recomendação e inquérito
  // civil (atribuições exclusivas do MP, art. 129 CF — ver utils/ministerioPublico.js)
  webhookMinisterioPublicoUrl: process.env.WEBHOOK_MINISTERIO_PUBLICO_URL || null,

  // Prazo de contestação no processo civil (dias corridos, contados da citação) — pontual e
  // específico desse trecho do fluxo, não é o prazo geral de julgamento (ver utils/prazos.js).
  prazoContestacaoDias: Number(process.env.PRAZO_CONTESTACAO_DIAS) || 15,
};
