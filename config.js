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
};
