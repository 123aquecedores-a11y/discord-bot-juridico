// Job diário: prazo de 7 dias corridos pro Juiz julgar um processo em Instrução, contado a
// partir da distribuição (juizDesde). Não mexe em revelia — isso continua manual do Juiz.
const db = require('../database/db');
const canais = require('./canais');
const rh = require('./rh');
const { parseCriadoEm } = require('./data');
const processoCmd = require('../commands/processo');
const peticaoCmd = require('../commands/peticao');

const PRAZO_JULGAMENTO_DIAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const PRAZO_VINCULO_MS = HORA_MS; // 1h pro Advogado vincular o Discord do cliente
const AVISO_VINCULO_MS = 45 * 60 * 1000; // aviso aos 45min, faltando ~15min pro prazo
const PRAZO_DILIGENCIA_MS = 24 * HORA_MS; // 24h pro Advogado cumprir a diligência pedida pelo Juiz
const AVISO_DILIGENCIA_MS = 20 * HORA_MS; // aviso aos 20h, faltando ~4h

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

    await processoCmd.postarOuAtualizarDiario(guild, p.numero);
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

// Job frequente (não diário — roda a cada ~10min, ver index.js): o Advogado tem 1h pra
// vincular o Discord do cliente depois de abrir uma petição, senão ela nunca chega a ser
// protocolada de verdade (nem Juiz é sorteado). Sem isso, uma petição esquecida ficava presa
// pra sempre num canal que ninguém decide. Avisa aos 45min e cancela aos 60min.
async function verificarVinculosPendentes(client, guild) {
  const pendentes = db.todos('peticoes', p => p.status === 'Aguardando vínculo' && !p.discordIdCliente);
  const agora = Date.now();

  for (const p of pendentes) {
    const criado = parseCriadoEm(p.criado_em);
    if (!criado) continue;
    const decorrido = agora - criado.getTime();

    if (decorrido >= PRAZO_VINCULO_MS) {
      db.atualizar('peticoes', p.numero, { status: 'Cancelada — prazo de vínculo expirado' });
      const canal = await guild.channels.fetch(p.canalId).catch(() => null);
      if (canal) {
        await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${p.requerenteId}>, o prazo de 1 (uma) hora para vinculação do cliente a esta petição transcorreu in albis. Esta petição **não foi protocolada** e o presente canal será arquivado. Protocole nova petição quando dispuser dos dados completos.` });
        await canais.arquivarCanal(canal);
      }
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} foi cancelada por decurso de prazo: a vinculação do cliente não foi realizada dentro de 1 (uma) hora.`);
      continue;
    }

    if (decorrido >= AVISO_VINCULO_MS && !p.lembreteVinculoEnviado) {
      db.atualizar('peticoes', p.numero, { lembreteVinculoEnviado: true });
      const canal = await guild.channels.fetch(p.canalId).catch(() => null);
      if (canal) await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${p.requerenteId}>, restam aproximadamente 15 (quinze) minutos para vinculação do cliente a esta petição, sob pena de cancelamento.` });
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} será cancelada em aproximadamente 15 (quinze) minutos, caso o cliente não seja vinculado.`);
    }
  }
}

// Processo civil sem Juiz disponível na abertura ficava em "Aguardando sorteio de juiz" pra
// sempre — nada nunca tentava sortear de novo. Roda junto do job frequente (10min): assim que
// algum Juiz fica disponível, o processo é distribuído automaticamente.
async function verificarProcessosSemJuiz(guild) {
  const processos = db.todos('processos', p => p.tipo === 'Civil' && p.status === 'Aguardando sorteio de juiz' && !p.juiz);

  for (const p of processos) {
    const juizId = rh.sortearJuiz({ excluirIds: [p.autor].filter(Boolean) });
    if (!juizId) continue; // ainda ninguém disponível, tenta de novo no próximo ciclo

    db.atualizar('processos', p.numero, { status: 'Aguardando defesa', juiz: juizId, juizDesde: new Date().toISOString() });
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    if (canal) {
      await canais.adicionarMembro(canal, juizId);
      const processoAtualizado = db.buscarPorNumero('processos', p.numero);
      const msgPainel = await canal.send({
        content: `⚖️ **Comunicação do Tribunal** — <@${juizId}>, Vossa Senhoria foi distribuído(a), por sorteio, para este processo (que aguardava julgador disponível desde a abertura).`,
        embeds: [processoCmd.embedProcesso(processoAtualizado)],
        components: processoCmd.montarPainelAcoes(processoAtualizado),
      });
      db.atualizar('processos', p.numero, { painelMsgId: msgPainel.id });
    }
    await processoCmd.postarOuAtualizarDiario(guild, p.numero);
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
      await peticaoCmd.finalizarDecisao(guild, p.numero, 'Indeferido', {
        motivo: 'Diligência (documento/comprovação solicitada pelo Juízo) não foi cumprida dentro do prazo de 24h — pedido não sustentado por falta de prova.',
      }, null);
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} foi **indeferida** por decurso de prazo: a diligência determinada não foi cumprida dentro de 24 (vinte e quatro) horas.`);
      continue;
    }

    if (decorrido >= AVISO_DILIGENCIA_MS && !p.lembreteDiligenciaEnviado) {
      db.atualizar('peticoes', p.numero, { lembreteDiligenciaEnviado: true });
      const canal = await guild.channels.fetch(p.canalId).catch(() => null);
      if (canal) {
        await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${p.requerenteId}>, restam aproximadamente 4 (quatro) horas para cumprimento da diligência determinada. Junte o documento solicitado e comunique <@${p.juiz}>, sob pena de indeferimento.` });
      }
      await dmSeguro(client, p.requerenteId, `⏰ **Comunicação do Tribunal** — a petição ${p.numero} será indeferida em aproximadamente 4 (quatro) horas, caso a diligência determinada não seja cumprida.`);
    }
  }
}

// Petição sem Juiz ativo no momento do protocolo ficava presa pra sempre em "Aguardando
// sorteio de juiz" — a própria mensagem que o Advogado recebia (ver protocolarPeticao, em
// peticao.js) prometia sorteio automático assim que houvesse Juiz disponível, mas nada nunca
// tentava de novo. Mesmo defeito já corrigido pra processo civil (verificarProcessosSemJuiz),
// replicado aqui. Roda junto do job frequente (10min, ver index.js).
async function verificarPeticoesSemJuiz(guild) {
  const peticoes = db.todos('peticoes', p => p.status === 'Aguardando sorteio de juiz' && !p.juiz);

  for (const p of peticoes) {
    const juizId = rh.sortearJuiz({ excluirIds: [p.requerenteId, p.discordIdCliente].filter(Boolean) });
    if (!juizId) continue; // ainda ninguém disponível, tenta de novo no próximo ciclo

    db.atualizar('peticoes', p.numero, { status: 'Pendente', juiz: juizId });
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    if (canal) {
      await canais.adicionarMembro(canal, juizId);
      await canal.send({
        content: `⚖️ **Comunicação do Tribunal** — <@${juizId}>, Vossa Senhoria foi distribuído(a), por sorteio, para esta petição (que aguardava julgador disponível desde o protocolo).`,
        embeds: [peticaoCmd.embedPeticao(db.buscarPorNumero('peticoes', p.numero))],
        components: [peticaoCmd.botoesDecisao(p.numero)],
      });
    }
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
      db.atualizar('medidas', m.numero, { lembreteMpEnviado: true });
      const canal = await guild.channels.fetch(m.canalId).catch(() => null);
      if (canal) await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${m.promotor}>, a medida ${m.numero} aguarda manifestação do Ministério Público (aprovar/negar) há mais de 20 (vinte) horas.` });
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
      db.atualizar('medidas', m.numero, { lembreteJuizEnviado: true });
      const canal = await guild.channels.fetch(m.canalId).catch(() => null);
      if (canal) await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${m.juiz}>, a medida ${m.numero} aguarda deliberação judicial (referendar/negar provimento) há mais de 20 (vinte) horas.` });
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

    db.atualizar('mandados', m.numero, { lembreteMandadoEnviado: true });
    const medida = m.medidaNumero ? db.buscarPorNumero('medidas', m.medidaNumero) : null;
    const delegadoId = medida?.delegado;
    if (!delegadoId) continue;

    const canal = medida.canalId ? await guild.channels.fetch(medida.canalId).catch(() => null) : null;
    if (canal) await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${delegadoId}>, o mandado ${m.numero} ainda não foi cumprido.` });
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
      db.atualizar('apelacoes', a.numero, { lembreteApelacaoEnviado: true });
      const canal = await guild.channels.fetch(a.canalId).catch(() => null);
      if (canal) await canal.send({ content: `⏰ **Comunicação do Tribunal** — <@${a.desembargadorId}>, a apelação ${a.numero} aguarda decisão há ${dias} dia(s).` });
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

    db.atualizar('processos', p.numero, { avisoPrazoContestacaoEnviado: true });
    const aviso = `⏰ **Comunicação do Tribunal** — Processo ${p.numero}: o prazo de contestação venceu sem manifestação da defesa. Ponto de atenção — decida manualmente (a contestação ainda pode chegar, ou utilize "Decretar revelia" no canal do processo).`;
    if (p.juiz) await dmSeguro(client, p.juiz, aviso);
    const canal = await guild.channels.fetch(p.canalId).catch(() => null);
    if (canal) await canal.send({ content: `${p.juiz ? `<@${p.juiz}> ` : ''}${aviso}` });
  }
}

module.exports = {
  verificarPrazosJulgamento, verificarRenovacoesPorteArma, verificarVinculosPendentes,
  verificarProcessosSemJuiz, verificarDiligenciasPendentes, verificarPeticoesSemJuiz,
  verificarMedidasAguardandoMP, verificarMedidasAguardandoJuiz, verificarMandadosPendentes,
  verificarApelacoesPendentes, verificarPrazosContestacao,
  PRAZO_JULGAMENTO_DIAS, DIA_MS, HORA_MS, dmSeguro,
};
