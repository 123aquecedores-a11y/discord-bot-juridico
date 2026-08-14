// Job diário: prazo de 7 dias corridos pro Juiz julgar um processo em Instrução, contado a
// partir da distribuição (juizDesde). Não mexe em revelia — isso continua manual do Juiz.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const canais = require('./canais');
const rh = require('./rh');
const andamentos = require('./andamentos');
const { parseCriadoEm } = require('./data');
const processoCmd = require('../commands/processo');
const peticaoCmd = require('../commands/peticao');
const { distribuirJuizAoCaso } = require('./distribuicaoJuiz');

// Grace antes de avisar "sem Juiz disponível": um caso recém-aberto ganha ~1 ciclo do job (10min)
// pra ser distribuído normalmente antes de o bot anunciar que não há julgador — evita alarme falso.
const GRACE_SEM_JUIZ_MS = 9 * 60 * 1000;

// Aviso (uma única vez por caso) de que o sorteio não achou Juiz elegível — não deixa o caso mudo.
// Posta no canal do caso um recado claro + botão "Designar Juiz" (Supervisão/Staff) e cutuca a
// Supervisão por DM (no-op se DMs desligadas). Marca `avisoSemJuizEnviado` pra não repetir; o flag
// é limpo quando o caso finalmente recebe Juiz (ver distribuirJuizAoCaso).
async function avisarCasoSemJuiz(client, guild, { tabela, numero, canalId }) {
  const reg = db.buscarPorNumero(tabela, numero);
  if (!reg || reg.avisoSemJuizEnviado) return;
  const criado = parseCriadoEm(reg.criado_em);
  if (criado && Date.now() - criado.getTime() < GRACE_SEM_JUIZ_MS) return; // ainda no grace

  const canal = canalId ? await guild.channels.fetch(canalId).catch(() => null) : null;
  let enviado = false;
  if (canal) {
    enviado = await canal.send({
      content: '⚖️ **Comunicação do Tribunal** — não há Juiz disponível na lotação neste momento. O sorteio é retentado automaticamente a cada 10 (dez) minutos e, assim que houver Juiz elegível, o caso será distribuído. Se preferir agilizar, a **Supervisão** (Desembargador/Procurador) ou a **Staff** pode designar um Juiz agora.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`painel:acao:supervisao:designarjulgador:${numero}`).setLabel('⚖️ Designar Juiz').setStyle(ButtonStyle.Primary),
      )],
    }).then(() => true).catch(() => false);
  }
  // Só marca como avisado depois do envio ao canal ter dado certo (ou quando não há canal pra
  // avisar) — assim um envio que falhou é retentado no próximo ciclo em vez de o aviso sumir calado.
  if (enviado || !canal) db.atualizar(tabela, numero, { avisoSemJuizEnviado: true });

  const avisoSup = `⚖️ **Comunicação do Tribunal** — o caso ${numero} está sem Juiz disponível (sorteio sem cargo elegível). Você pode designar um Juiz pelo botão no canal do caso ou por \`/painel\` > Supervisão.`;
  for (const d of rh.listarPorCargo('Desembargador').filter(x => !x.licenca)) await dmSeguro(client, d.discordId, avisoSup);
  for (const pr of rh.listarPorCargo('Procurador').filter(x => !x.licenca)) await dmSeguro(client, pr.discordId, avisoSup);
}

const PRAZO_JULGAMENTO_DIAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const PRAZO_VINCULO_MS = HORA_MS; // 1h pro Advogado vincular o Discord do cliente
const AVISO_VINCULO_MS = 45 * 60 * 1000; // aviso aos 45min, faltando ~15min pro prazo
const PRAZO_DILIGENCIA_MS = 24 * HORA_MS; // 24h pro Advogado cumprir a diligência pedida pelo Juiz
const AVISO_DILIGENCIA_MS = 20 * HORA_MS; // aviso aos 20h, faltando ~4h
// Prazos de defesa PENAL (habilitação por código): 48h pro réu constituir advogado (senão o bot
// sorteia defensor dativo) e 24h pra apresentar defesa (senão avisa; se era dativo, re-sorteia).
const PRAZO_HABILITACAO_MS = 48 * HORA_MS;
const PRAZO_DEFESA_MS = 24 * HORA_MS;

// Medida "Aguardando MP" (Promotor decidir aprovar/negar) e "Aprovada - aguardando juiz"
// (Juiz referendar/negar) não tinham prazo nenhum — podiam ficar paradas pra sempre sem
// nenhum lembrete, diferente de petição/diligência/julgamento. Aviso ao responsável às 20h,
// escalonamento (visibilidade, não decisão automática — mérito não é decisão automatizável)
// às 48h pra quem pode agir em cima disso (Procurador/Desembargador).
const AVISO_MEDIDA_MP_MS = 20 * HORA_MS;
const ESCALONAMENTO_MEDIDA_MP_MS = 48 * HORA_MS;
const AVISO_MEDIDA_JUIZ_MS = 20 * HORA_MS;
const ESCALONAMENTO_MEDIDA_JUIZ_MS = 48 * HORA_MS;

// Mandado emitido e não cumprido também não tinha prazo — é operacional (não é decisão de
// mérito), então só lembra o Delegado, sem escalonamento.
const AVISO_MANDADO_MS = 40 * HORA_MS;

// Apelação "Aguardando decisão" também não tinha prazo — podia ficar parada indefinidamente
// com o Desembargador. Mesmo raciocínio de julgamento (dias corridos), aviso e depois
// visibilidade pra outros Desembargadores/Procurador (não decide automaticamente).
const AVISO_APELACAO_DIAS = 8;
const ESCALONAMENTO_APELACAO_DIAS = 15;

// Status que tiram um processo do prazo de julgamento (o caso já teve um desfecho).
const STATUS_TERMINAIS = ['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'];

function partesDoProcesso(p) {
  const ids = new Set();
  if (p.juiz) ids.add(p.juiz);
  if (p.autor) ids.add(p.autor);
  for (const r of p.reus || []) ids.add(r);
  for (const h of p.habilitacoes || []) if (h.status === 'Aprovado') ids.add(h.advogadoId);
  return [...ids];
}

async function dmSeguro(client, userId, content) {
  // Avisos de prazo por DM (privado) ficam DESLIGADOS por padrão — o operador pediu pra não
  // encher o privado sobre processos. Os mesmos avisos continuam aparecendo NO CANAL do
  // processo/medida (escalonamento público), então nada de informação se perde. Pra religar o
  // DM, defina AVISOS_POR_DM=1 no .env.
  if (!config.avisosPorDmLigado) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content });
  } catch (err) {
    console.error(`Não foi possível enviar DM pra ${userId}: ${err.message}`);
  }
}

// Pega qualquer processo (penal OU civil) com Juiz distribuído e ainda sem desfecho — não só
// status==='Instrução', porque processo civil nunca passa por esse status (fica em "Aguardando
// defesa"/"Aguardando sorteio de juiz" até Julgar/Arquivar), e o prazo vale pros dois tipos.
async function verificarPrazosJulgamento(client, guild) {
  const processos = db.todos('processos', p => p.juiz && p.juizDesde && !STATUS_TERMINAIS.includes(p.status));
  const agora = Date.now();

  for (const p of processos) {
    const dias = Math.floor((agora - new Date(p.juizDesde).getTime()) / DIA_MS);
    const restante = PRAZO_JULGAMENTO_DIAS - dias;

    if (restante > 0) {
      const aviso = `⏰ **Comunicação do Tribunal** — Processo ${p.numero}: restam ${restante} dia(s) para o prazo de julgamento (7 dias corridos, contados da distribuição por sorteio).`;
      for (const uid of partesDoProcesso(p)) await dmSeguro(client, uid, aviso);
      continue;
    }

    // Prazo estourado — arquiva sem julgamento de mérito
    db.atualizar('processos', p.numero, { status: 'Arquivado sem julgamento de mérito' });
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    if (canal) {
      await canais.arquivarCanal(canal);
      await canal.send({ content: '⏰ **Comunicação do Tribunal** — o prazo de 7 (sete) dias corridos para julgamento transcorreu sem prolação de sentença. Processo arquivado sem julgamento de mérito, nos termos regimentais.' });
    }

    const avisoSupervisao = `⏰ **Comunicação do Tribunal** — Processo ${p.numero} foi arquivado sem julgamento de mérito por decurso de prazo (7 dias). Para reabertura com novo julgador, utilize \`/painel\` > Supervisão > Trocar Juiz.`;
    const desembargadores = rh.listarPorCargo('Desembargador').filter(d => !d.licenca);
    const procuradores = rh.listarPorCargo('Procurador').filter(pr => !pr.licenca);
    for (const d of desembargadores) await dmSeguro(client, d.discordId, avisoSupervisao);
    for (const pr of procuradores) await dmSeguro(client, pr.discordId, avisoSupervisao);

    await processoCmd.postarOuAtualizarCapaPublica(guild, p.numero);
  }
}

// Renovação do porte de arma — mesma infra de job diário, 15 dias de validade, aviso 3 dias
// antes de vencer. Renovação em si é feita rodando /peticao porte-arma de novo.
async function verificarRenovacoesPorteArma(client) {
  const peticoes = db.todos('peticoes', p => p.tipo === 'PorteArma' && p.status === 'Deferido' && p.validadeAte);
  const agora = Date.now();

  for (const p of peticoes) {
    const restanteMs = new Date(p.validadeAte).getTime() - agora;
    const diasRestantes = Math.ceil(restanteMs / DIA_MS);

    if (diasRestantes === 3) {
      await dmSeguro(client, p.requerenteId, `🔫 **Comunicação do Tribunal** — a autorização de porte de arma (petição ${p.numero}) vence em 3 (três) dias. Para renovação, protocole novo pedido com \`/peticao porte-arma\`.`);
    }

    if (restanteMs <= 0) {
      db.atualizar('peticoes', p.numero, { status: 'Vencido' });
      await dmSeguro(client, p.requerenteId, `🔫 **Comunicação do Tribunal** — a autorização de porte de arma (petição ${p.numero}) **venceu**. Portar arma de fogo sem autorização válida constitui porte ilegal, nos termos do Código Penal.`);
    }
  }
}

// Processo civil sem Juiz disponível na abertura ficava em "Aguardando sorteio de juiz" pra
// sempre — nada nunca tentava sortear de novo. Roda junto do job frequente (10min): assim que
// algum Juiz fica disponível, o processo é distribuído automaticamente.
async function verificarProcessosSemJuiz(client, guild) {
  const processos = db.todos('processos', p => p.tipo === 'Civil' && p.status === 'Aguardando sorteio de juiz' && !p.juiz);

  for (const p of processos) {
    const juizId = rh.sortearJuiz({ excluirIds: [p.autor].filter(Boolean) });
    if (!juizId) { // sem Juiz elegível — não deixa o caso mudo, tenta de novo no próximo ciclo
      await avisarCasoSemJuiz(client, guild, { tabela: 'processos', numero: p.numero, canalId: p.canalId });
      continue;
    }
    await distribuirJuizAoCaso(guild, { tabela: 'processos', numero: p.numero }, juizId, { origem: 'sorteio' });
  }
}

// Processo PENAL cuja denúncia foi oferecida sem Juiz disponível ficava preso pra sempre (não
// havia retry como no civil). Roda no job frequente: assim que um Juiz elegível fica livre,
// distribui e leva o processo pra Instrução, postando o painel completo pro Juiz atuar.
async function verificarProcessosPenaisSemJuiz(client, guild) {
  const processos = db.todos('processos', p => p.tipo === 'Penal' && p.status === 'Denúncia oferecida - aguardando juiz' && !p.juiz);

  for (const p of processos) {
    const juizId = rh.sortearJuiz({ excluirIds: [p.delegado, p.promotor, ...(p.reus || [])].filter(Boolean) });
    if (!juizId) {
      await avisarCasoSemJuiz(client, guild, { tabela: 'processos', numero: p.numero, canalId: p.canalId });
      continue;
    }
    await distribuirJuizAoCaso(guild, { tabela: 'processos', numero: p.numero }, juizId, { origem: 'sorteio' });
  }
}

// Diligência (Juiz pede documento/comprovação extra numa petição) não tinha prazo — se o
// Advogado nunca anexasse, ficava parada pra sempre. 24h pra cumprir, aviso às 20h, indeferimento
// automático se estourar (mesma lógica de "não cumpriu o exigido = pedido não sustentado").
async function verificarDiligenciasPendentes(client, guild) {
  const pendentes = db.todos('peticoes', p => p.status === 'Diligência' && p.diligenciaDesde);
  const agora = Date.now();

  for (const p of pendentes) {
    const desde = new Date(p.diligenciaDesde).getTime();
    const decorrido = agora - desde;

    if (decorrido >= PRAZO_DILIGENCIA_MS) {
      // Marca a origem do indeferimento ANTES de finalizar, pra o botão "Reabrir" (Frente 1.2) só
      // valer pra indeferimento AUTOMÁTICO por diligência — nunca pra um indeferimento de mérito do Juiz.
      db.atualizar('peticoes', p.numero, { indeferidoPorDiligencia: true });
      await peticaoCmd.finalizarDecisao(guild, p.numero, 'Indeferido', {
        motivo: 'Diligência (documento/comprovação solicitada pelo Juízo) não foi cumprida dentro do prazo de 24h — pedido não sustentado por falta de prova.',
      }, null);
      const canal = await guild.channels.fetch(p.canalId).catch(() => null);
      if (canal) {
        await canal.send({
          content: '⏰ Indeferimento por decurso de prazo da diligência. A **Supervisão** ou a **Staff** pode reabrir a petição se a diligência ainda puder ser cumprida.',
          components: [new ActionRowBuilder().addComponents(peticaoCmd.botaoReabrirCaso(p.numero))],
        });
      }
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} foi **indeferida** por decurso de prazo: a diligência determinada não foi cumprida dentro de 24 (vinte e quatro) horas.`);
      continue;
    }

    if (decorrido >= AVISO_DILIGENCIA_MS && !p.lembreteDiligenciaEnviado) {
      const canal = await guild.channels.fetch(p.canalId).catch(() => null);
      const enviado = canal
        ? await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${p.requerenteId}>, restam aproximadamente 4 (quatro) horas para cumprimento da diligência determinada. Junte o documento solicitado e comunique <@${p.juiz}>, sob pena de indeferimento.` }).then(() => true).catch(() => false)
        : false;
      // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
      if (enviado || !canal) db.atualizar('peticoes', p.numero, { lembreteDiligenciaEnviado: true });
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} será indeferida em aproximadamente 4 (quatro) horas, caso a diligência determinada não seja cumprida.`);
    }
  }
}

// Petição sem Juiz ativo no momento do protocolo ficava presa pra sempre em "Aguardando
// sorteio de juiz" — a própria mensagem que o Advogado recebia (ver protocolarPeticao, em
// peticao.js) prometia sorteio automático assim que houvesse Juiz disponível, mas nada nunca
// tentava de novo. Mesmo defeito já corrigido pra processo civil (verificarProcessosSemJuiz),
// replicado aqui. Roda junto do job frequente (10min, ver index.js).
async function verificarPeticoesSemJuiz(client, guild) {
  const peticoes = db.todos('peticoes', p => p.status === 'Aguardando sorteio de juiz' && !p.juiz);

  for (const p of peticoes) {
    const juizId = rh.sortearJuiz({ excluirIds: [p.requerenteId, p.discordIdCliente].filter(Boolean) });
    if (!juizId) { // sem Juiz elegível — avisa e tenta de novo no próximo ciclo
      await avisarCasoSemJuiz(client, guild, { tabela: 'peticoes', numero: p.numero, canalId: p.canalId });
      continue;
    }
    await distribuirJuizAoCaso(guild, { tabela: 'peticoes', numero: p.numero }, juizId, { origem: 'sorteio' });
  }
}

// Medida parada com o Promotor (Aguardando MP): aviso ao próprio Promotor às 20h; se passar de
// 48h sem decisão, avisa os Procuradores (só visibilidade — decisão de mérito continua manual).
async function verificarMedidasAguardandoMP(client, guild) {
  const medidas = db.todos('medidas', m => m.status === 'Aguardando MP' && m.aguardandoMpDesde);
  const agora = Date.now();

  for (const m of medidas) {
    const decorrido = agora - new Date(m.aguardandoMpDesde).getTime();

    if (decorrido >= AVISO_MEDIDA_MP_MS && !m.lembreteMpEnviado) {
      const canal = await guild.channels.fetch(m.canalId).catch(() => null);
      const enviado = canal ? await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${m.promotor}>, a medida ${m.numero} aguarda manifestação do Ministério Público (aprovar/negar) há mais de 20 (vinte) horas.` }).then(() => true).catch(() => false) : false;
      // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
      if (enviado || !canal) db.atualizar('medidas', m.numero, { lembreteMpEnviado: true });
      await dmSeguro(client, m.promotor, `⏰ **Comunicação do Tribunal** — a medida ${m.numero} aguarda sua manifestação há mais de 20 (vinte) horas.`);
    }

    if (decorrido >= ESCALONAMENTO_MEDIDA_MP_MS && !m.escalonamentoMpEnviado) {
      db.atualizar('medidas', m.numero, { escalonamentoMpEnviado: true });
      const aviso = `⏰ **Comunicação do Tribunal** — a medida ${m.numero} aguarda manifestação do Ministério Público (<@${m.promotor}>) há mais de 48 (quarenta e oito) horas, sem decisão.`;
      for (const p of rh.listarPorCargo('Procurador').filter(x => !x.licenca)) await dmSeguro(client, p.discordId, aviso);
    }
  }
}

// Medida parada com o Juiz (Aprovada - aguardando juiz): mesmo raciocínio, aviso ao Juiz,
// escalonamento pros Desembargadores (que podem trocar o Juiz via /painel > Supervisão).
async function verificarMedidasAguardandoJuiz(client, guild) {
  const medidas = db.todos('medidas', m => m.status === 'Aprovada - aguardando juiz' && m.aguardandoJuizDesde);
  const agora = Date.now();

  for (const m of medidas) {
    const decorrido = agora - new Date(m.aguardandoJuizDesde).getTime();

    if (decorrido >= AVISO_MEDIDA_JUIZ_MS && !m.lembreteJuizEnviado) {
      const canal = await guild.channels.fetch(m.canalId).catch(() => null);
      const enviado = canal ? await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${m.juiz}>, a medida ${m.numero} aguarda deliberação judicial (referendar/negar provimento) há mais de 20 (vinte) horas.` }).then(() => true).catch(() => false) : false;
      // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
      if (enviado || !canal) db.atualizar('medidas', m.numero, { lembreteJuizEnviado: true });
      await dmSeguro(client, m.juiz, `⏰ **Comunicação do Tribunal** — a medida ${m.numero} aguarda sua deliberação há mais de 20 (vinte) horas.`);
    }

    if (decorrido >= ESCALONAMENTO_MEDIDA_JUIZ_MS && !m.escalonamentoJuizEnviado) {
      db.atualizar('medidas', m.numero, { escalonamentoJuizEnviado: true });
      const aviso = `⏰ **Comunicação do Tribunal** — a medida ${m.numero} aguarda deliberação do Juiz <@${m.juiz}> há mais de 48 (quarenta e oito) horas, sem decisão. Considere \`/painel\` > Supervisão > Trocar Juiz.`;
      for (const d of rh.listarPorCargo('Desembargador').filter(x => !x.licenca)) await dmSeguro(client, d.discordId, aviso);
    }
  }
}

// Mandado emitido e não cumprido: só lembra o Delegado responsável (mandado.emitidoPor é o
// Juiz, o Delegado responsável é quem consta na medida de origem) — é ato operacional, não
// decisão de mérito, então não escalona pra ninguém.
async function verificarMandadosPendentes(client, guild) {
  const mandados = db.todos('mandados', m => m.status === 'Emitido' && m.criado_em);
  const agora = Date.now();

  for (const m of mandados) {
    if (m.lembreteMandadoEnviado) continue;
    const criado = parseCriadoEm(m.criado_em);
    if (!criado || agora - criado.getTime() < AVISO_MANDADO_MS) continue;

    const medida = m.medidaNumero ? db.buscarPorNumero('medidas', m.medidaNumero) : null;
    const delegadoId = medida?.delegado;
    // Sem delegado responsável não há pra quem avisar — marca assim mesmo pra não reprocessar todo
    // ciclo (era o efeito do flag antigo, que era gravado logo de cara).
    if (!delegadoId) { db.atualizar('mandados', m.numero, { lembreteMandadoEnviado: true }); continue; }

    const canal = medida.canalId ? await guild.channels.fetch(medida.canalId).catch(() => null) : null;
    const enviado = canal ? await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${delegadoId}>, o mandado ${m.numero} ainda não foi cumprido.` }).then(() => true).catch(() => false) : false;
    // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
    if (enviado || !canal) db.atualizar('mandados', m.numero, { lembreteMandadoEnviado: true });
    await dmSeguro(client, delegadoId, `⏰ **Comunicação do Tribunal** — o mandado ${m.numero} ainda não foi cumprido.`);
  }
}

// Apelação sem decisão: aviso ao Desembargador relator, escalonamento (visibilidade) pra
// outros Desembargadores e Procuradores — que podem trocar o relator via /painel > Supervisão.
async function verificarApelacoesPendentes(client, guild) {
  const apelacoes = db.todos('apelacoes', a => a.status === 'Aguardando decisão');
  const agora = Date.now();

  for (const a of apelacoes) {
    const criado = parseCriadoEm(a.criado_em);
    if (!criado) continue;
    const dias = Math.floor((agora - criado.getTime()) / DIA_MS);

    if (dias >= AVISO_APELACAO_DIAS && !a.lembreteApelacaoEnviado) {
      const canal = await guild.channels.fetch(a.canalId).catch(() => null);
      const enviado = canal ? await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${a.desembargadorId}>, a apelação ${a.numero} aguarda decisão há ${dias} dia(s).` }).then(() => true).catch(() => false) : false;
      // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
      if (enviado || !canal) db.atualizar('apelacoes', a.numero, { lembreteApelacaoEnviado: true });
      await dmSeguro(client, a.desembargadorId, `⏰ **Comunicação do Tribunal** — a apelação ${a.numero} aguarda sua decisão há ${dias} dia(s).`);
    }

    if (dias >= ESCALONAMENTO_APELACAO_DIAS && !a.escalonamentoApelacaoEnviado) {
      db.atualizar('apelacoes', a.numero, { escalonamentoApelacaoEnviado: true });
      const aviso = `⏰ **Comunicação do Tribunal** — a apelação ${a.numero} está sem decisão há mais de ${ESCALONAMENTO_APELACAO_DIAS} dias (relator: <@${a.desembargadorId}>). Considere \`/painel\` > Supervisão > Trocar relator.`;
      const outrosDesembargadores = rh.listarPorCargo('Desembargador').filter(d => !d.licenca && d.discordId !== a.desembargadorId);
      for (const d of outrosDesembargadores) await dmSeguro(client, d.discordId, aviso);
      for (const p of rh.listarPorCargo('Procurador').filter(x => !x.licenca)) await dmSeguro(client, p.discordId, aviso);
    }
  }
}

// Prazo de contestação (processo civil, seção 3 da spec de anexo/vínculo processual) — some do
// ciclo de 10min desde a citação. Diferente dos outros jobs que decidem sozinhos quando o
// prazo estoura, este só avisa (vira ponto de atenção na fila do Juiz) — a decisão de mérito
// por revelia continua manual, via botão "Decretar revelia" em commands/processo.js.
async function verificarPrazosContestacao(client, guild) {
  const pendentes = db.todos('processos', p =>
    p.tipo === 'Civil' && p.status === 'Aguardando contestação' && p.prazoContestacaoAte && !p.avisoPrazoContestacaoEnviado);
  const agora = Date.now();

  for (const p of pendentes) {
    if (agora < new Date(p.prazoContestacaoAte).getTime()) continue;

    const aviso = `⏰ **Comunicação do Tribunal** — Processo ${p.numero}: o prazo de contestação venceu sem manifestação da defesa. Ponto de atenção — decida manualmente (a contestação ainda pode chegar, ou utilize "Decretar revelia" no canal do processo).`;
    if (p.juiz) await dmSeguro(client, p.juiz, aviso);
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    const enviado = canal ? await canal.send({ content: `${p.juiz ? `<@${p.juiz}> ` : ''}${aviso}` }).then(() => true).catch(() => false) : false;
    // Flag só depois do envio (ou sem canal) — envio falho é retentado, o aviso não se perde.
    if (enviado || !canal) db.atualizar('processos', p.numero, { avisoPrazoContestacaoEnviado: true });
  }
}

// ---- Prazos de defesa PENAL (habilitação por código + defensor dativo) ----
// PENAL não tem revelia (ampla defesa obrigatória, ninguém julgado sem advogado): se o réu não
// constitui advogado, o Juízo nomeia defensor dativo e o processo segue COM defesa. "Revelia" é
// só do cível (fluxo de contestação, não tocado aqui).

function advogadosOcupados(p) {
  return new Set([
    p.delegado, p.promotor, p.juiz, p.autor,
    ...(p.reus || []),
    ...(p.habilitacoes || []).map(h => h.advogadoId),
  ].filter(Boolean));
}

// Sorteia um Advogado disponível (cargo Advogado, sem licença) que NÃO atue no processo (evita
// conflito). `excluirExtra` tira também um defensor específico (ex.: o dativo que falhou).
function sortearDefensorDativo(p, excluirExtra = []) {
  const ocupados = advogadosOcupados(p);
  for (const e of excluirExtra) ocupados.add(e);
  const disponiveis = rh.listarPorCargo('Advogado').filter(a => !a.licenca && !ocupados.has(a.discordId));
  if (disponiveis.length === 0) return null;
  return disponiveis[Math.floor(Math.random() * disponiveis.length)].discordId;
}

// Habilita um defensor dativo (Aprovado direto, SEM código) e grava aprovadoEm (base do prazo 24h).
async function nomearDefensorDativo(guild, p, advId) {
  const habs = p.habilitacoes || [];
  const novoId = habs.reduce((max, h) => Math.max(max, h.id || 0), 0) + 1;
  const agora = new Date().toISOString();
  const hab = {
    id: novoId, reuId: (p.reus || [])[0] || null, reuNome: p.reuNome || null, advogadoId: advId,
    nomeCliente: p.reuNome || null, rgCliente: p.reuRg || null, status: 'Aprovado', dativo: true,
    criadoEm: agora, aprovadoEm: agora,
  };
  db.atualizar('processos', p.numero, { habilitacoes: [...habs, hab] });
  const canal = await guild.channels.fetch(p.canalId).catch(() => null);
  if (canal) await canais.adicionarMembro(canal, advId).catch(() => {});
  return canal;
}

// (1) 48h pro réu constituir advogado — a partir da intimação marcada como cumprida.
async function verificarPrazoHabilitacao(client, guild) {
  const pendentes = db.todos('processos', p =>
    p.tipo === 'Penal' && p.intimacaoReuCumpridaEm && !p.avisoPrazoHabilitacaoEnviado
    && !STATUS_TERMINAIS.includes(p.status)
    && !(p.habilitacoes || []).some(h => h.status === 'Aprovado'));
  const agora = Date.now();
  for (const p of pendentes) {
    if (agora < new Date(p.intimacaoReuCumpridaEm).getTime() + PRAZO_HABILITACAO_MS) continue;
    db.atualizar('processos', p.numero, { avisoPrazoHabilitacaoEnviado: true });

    const dativo = sortearDefensorDativo(p);
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    const ping = p.juiz ? `<@${p.juiz}> ` : '';
    if (!dativo) {
      if (canal) await canal.send({ content: `${ping}⏰ **Comunicação do Tribunal** — Processo ${p.numero}: 48h sem advogado constituído e **não há advogado disponível** para nomear defensor dativo. Providencie manualmente — o réu não pode ficar sem defesa.` });
      await andamentos.registrar(guild, p.numero, { tipo: 'prazo_habilitacao_vencido', titulo: '⏰ 48h sem advogado (sem dativo disponível)', detalhe: '48h sem advogado constituído e sem advogado disponível para defensor dativo.', executorId: null });
      continue;
    }
    await nomearDefensorDativo(guild, p, dativo);
    if (canal) await canal.send({ content: `${ping}⏰ **Comunicação do Tribunal** — Processo ${p.numero}: 48h sem advogado constituído. Nomeado **defensor dativo** <@${dativo}>, habilitado automaticamente. O processo segue COM defesa — 24h para apresentá-la.\n<@${dativo}> — você foi nomeado **defensor dativo** neste processo.` });
    await andamentos.registrar(guild, p.numero, { tipo: 'defensor_dativo_nomeado', titulo: '⚖️ Defensor dativo nomeado', detalhe: `48h sem advogado constituído — defensor dativo <@${dativo}> nomeado e habilitado automaticamente.`, executorId: null, metadata: { advogadoId: dativo } });
  }
}

// (2) 24h pra apresentar defesa — a partir da habilitação (constituída OU por sorteio).
async function verificarPrazoDefesa(client, guild) {
  const agora = Date.now();
  const processos = db.todos('processos', p =>
    p.tipo === 'Penal' && !p.defesaApresentadaEm && !STATUS_TERMINAIS.includes(p.status)
    && (p.habilitacoes || []).some(h => h.status === 'Aprovado' && h.aprovadoEm && !h.avisoDefesaEnviado));
  for (const p of processos) {
    const hab = (p.habilitacoes || [])
      .filter(h => h.status === 'Aprovado' && h.aprovadoEm && !h.avisoDefesaEnviado)
      .sort((a, b) => new Date(b.aprovadoEm) - new Date(a.aprovadoEm))[0];
    if (!hab) continue;
    if (agora < new Date(hab.aprovadoEm).getTime() + PRAZO_DEFESA_MS) continue;

    db.atualizar('processos', p.numero, { habilitacoes: p.habilitacoes.map(h => h.id === hab.id ? { ...h, avisoDefesaEnviado: true } : h) });
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    const ping = p.juiz ? `<@${p.juiz}> ` : '';

    if (hab.dativo) {
      // Dativo que não atuou → re-sorteia outro (nunca deixa o réu sem defesa).
      const novo = sortearDefensorDativo(p, [hab.advogadoId]);
      if (novo) {
        await nomearDefensorDativo(guild, p, novo);
        if (canal) await canal.send({ content: `${ping}⏰ Processo ${p.numero}: o defensor dativo <@${hab.advogadoId}> não apresentou defesa em 24h. **Re-sorteado** o defensor dativo <@${novo}>.\n<@${novo}> — você foi nomeado **defensor dativo** (24h para a defesa).` });
        await andamentos.registrar(guild, p.numero, { tipo: 'defensor_dativo_ressorteado', titulo: '⚖️ Defensor dativo re-sorteado', detalhe: `Defensor dativo <@${hab.advogadoId}> não apresentou defesa em 24h — re-sorteado <@${novo}>.`, executorId: null, metadata: { anterior: hab.advogadoId, novo } });
      } else if (canal) {
        await canal.send({ content: `${ping}⏰ Processo ${p.numero}: defensor dativo não apresentou defesa em 24h e **não há outro advogado** para re-sorteio. Providencie manualmente.` });
        await andamentos.registrar(guild, p.numero, { tipo: 'prazo_defesa_vencido', titulo: '⏰ Defesa não apresentada (sem re-sorteio)', detalhe: 'Defensor dativo não apresentou defesa em 24h e não há advogado para re-sorteio.', executorId: null });
      }
    } else {
      // Advogado constituído → avisa o advogado (está no Discord) + Juiz ciente.
      if (canal) await canal.send({ content: `<@${hab.advogadoId}> ⏰ **Comunicação do Tribunal** — Processo ${p.numero}: o prazo de 24h para apresentar a defesa venceu. Apresente a defesa o quanto antes.${p.juiz ? ` (Juiz <@${p.juiz}> ciente.)` : ''}` });
      await andamentos.registrar(guild, p.numero, { tipo: 'prazo_defesa_vencido', titulo: '⏰ Prazo de defesa vencido', detalhe: `Advogado constituído <@${hab.advogadoId}> não apresentou defesa em 24h.`, executorId: null, metadata: { advogadoId: hab.advogadoId } });
    }
  }
}

module.exports = {
  verificarPrazosJulgamento, verificarRenovacoesPorteArma,
  verificarProcessosSemJuiz, verificarProcessosPenaisSemJuiz, verificarDiligenciasPendentes, verificarPeticoesSemJuiz,
  verificarMedidasAguardandoMP, verificarMedidasAguardandoJuiz, verificarMandadosPendentes,
  verificarApelacoesPendentes, verificarPrazosContestacao,
  verificarPrazoHabilitacao, verificarPrazoDefesa,
  PRAZO_JULGAMENTO_DIAS, DIA_MS, HORA_MS, dmSeguro,
};
