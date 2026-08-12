// Demo ao vivo (~40 cenários ponta a ponta) — cria tickets DE VERDADE e faz o papel de cada
// cargo, pra o operador assistir tudo acontecer no Discord estando sozinho. Roda dentro do bot
// (index.js chama quando SIMULAR_DEMO=1). Semeia cargos temporários (marcados _sim) pro sorteio;
// no fim ARQUIVA os canais criados (não apaga) e desativa os cargos temporários.
//
// A interação "falsa" roteia reply/editReply/followUp NÃO-efêmeros pro canal real — assim atos
// que a função publica via interaction (ex.: sentença) aparecem no canal; confirmações efêmeras
// ("publicado") são descartadas pra não poluir.
const db = require('../database/db');
const rh = require('../utils/rh');

module.exports.run = async function run(client, guild) {
  const processoCmd = require('../commands/processo');
  const medidaCmd = require('../commands/medida');
  const oficioCmd = require('../commands/oficio');
  const peticaoCmd = require('../commands/peticao');
  const ministerioPublico = require('../utils/ministerioPublico');
  const supervisao = require('../utils/supervisao');
  const analiseDocumento = require('../utils/analiseDocumento');
  const canais = require('../utils/canais');

  const CRIME = '121-c-c-14-tentativa-de-homicidio';
  const OPERADOR = process.env.SIMULAR_USER || '400438471631699978';
  const PASSO = process.env.SIM_PASSO_MS !== undefined ? Number(process.env.SIM_PASSO_MS) : 3500;      // entre passos de um cenário
  const CENARIO = process.env.SIM_CENARIO_MS !== undefined ? Number(process.env.SIM_CENARIO_MS) : 9000; // entre cenários
  const PDF_DEMO = process.env.SIM_PDF_URL || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
  const t0 = Date.now();
  const log = (m) => console.log(`[DEMO +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const nomes = ['Carlos Silva', 'Ana Souza', 'Pedro Lima', 'Marina Costa', 'João Alves', 'Beatriz Rocha', 'Rafael Dias', 'Larissa Melo', 'Tiago Nunes', 'Sofia Ramos'];

  // ---- cargos temporários pro sorteio (fakes; só são mencionados/sorteados) ----
  const seeded = [];
  const seed = (cargo, n) => { const ids = []; for (let i = 0; i < n; i++) { const id = `88${(Date.now() % 100000)}${cargo.length}${i}${Math.floor(Math.random() * 90 + 10)}`; db.inserir('rh', { discordId: id, cargo, ativo: true, licenca: false, nomePersonagem: `${cargo} Demo ${i}`, _sim: true }); seeded.push(id); ids.push(id); } return ids; };
  const juizes = seed('Juiz', 3); seed('Promotor', 2); seed('Delegado', 2); const advogados = seed('Advogado', 3); const desembs = seed('Desembargador', 2); const procs = seed('Procurador', 2);
  log(`Semeados ${seeded.length} cargos temporários pro sorteio (assista os canais nascerem!).`);

  // ---- interação falsa que roteia saída pública pro canal real ----
  const clean = (p) => { if (!p || typeof p !== 'object') return p; const { ephemeral, flags, ...rest } = p; return rest; };
  const fakeMsg = () => ({ id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, edit: async () => {}, delete: async () => {}, attachments: { first: () => null }, embeds: [{}], components: [] });
  const fi = (uid, fields = {}, channel = null) => {
    const post = async (p) => { if (channel && p && !p.ephemeral) { try { await channel.send(clean(p)); } catch (e) { /* ignora */ } } return fakeMsg(); };
    return {
      guild, user: { id: uid, tag: 'demo' }, member: null, channel,
      message: { edit: async () => {}, components: [], embeds: [{}] },
      fields: { getTextInputValue: (k) => (k in fields ? fields[k] : '') },
      isModalSubmit: () => true, isButton: () => false,
      reply: post, editReply: post, followUp: post, deferReply: async () => {}, deferUpdate: async () => {}, update: async () => {}, showModal: async () => {},
      replied: false, deferred: false,
    };
  };

  const criados = [];
  const track = (canal) => { if (canal && canal.id) criados.push(canal.id); return canal; };
  const canalDe = async (numero, tabela = 'processos') => { const r = db.buscarPorNumero(tabela, numero); return r && r.canalId ? await guild.channels.fetch(r.canalId).catch(() => null) : null; };

  // ============ Cenários ============
  async function penalCompleto(i, resultado) {
    const r = await processoCmd.criarProcessoPenal({ guild, delegadoId: OPERADOR, promotorId: null, crimesTexto: CRIME, motivo: `Investigação ${i} — indícios apurados pela autoridade policial contra ${nomes[i % nomes.length]}.`, reusTexto: '', medidaNumero: null, atoMpNumero: null });
    if (!r || !r.numero) { log(`⚠️ penal ${i} não abriu: ${r && r.erro}`); return; }
    track(r.canal); const num = r.numero; log(`⚖️ PENAL ${num} aberto`);
    await wait(PASSO);
    const prom = db.buscarPorNumero('processos', num).promotor;
    const canal = r.canal;
    await processoCmd.confirmarParecerMp(fi(prom, { parecer: 'Presentes a materialidade e os indícios de autoria, com justa causa, o Ministério Público OFERECE DENÚNCIA.' }, canal), `${num}#oferecer`);
    await processoCmd.publicarParecer(fi(prom, {}, canal), num);
    log(`   ↳ denúncia oferecida (MP), juiz sorteado`);
    await wait(PASSO);
    const juiz = db.buscarPorNumero('processos', num).juiz;
    if (!juiz) { log(`   ↳ sem juiz (fila) — ok`); return; }
    const fields = resultado === 'Condenado'
      ? { texto: 'Fundamento: provas dos autos demonstram autoria e materialidade. Decido pela condenação.', pena: '6 anos de reclusão', regime: 'semiaberto' }
      : { texto: 'Fundamento: prova insuficiente para a condenação. Aplica-se o in dubio pro reo.' };
    await processoCmd.salvarSentenca(fi(juiz, fields, canal), num, resultado);
    await processoCmd.publicarSentenca(fi(juiz, {}, canal), num);
    log(`   ↳ SENTENÇA publicada (${resultado})`);
  }

  async function penalArquivar(i) {
    const r = await processoCmd.criarProcessoPenal({ guild, delegadoId: OPERADOR, promotorId: null, crimesTexto: CRIME, motivo: `Notícia de fato ${i} sem lastro probatório mínimo.`, reusTexto: '', medidaNumero: null, atoMpNumero: null });
    if (!r || !r.numero) return; track(r.canal); const num = r.numero; log(`⚖️ PENAL ${num} aberto (rumo ao arquivamento)`);
    await wait(PASSO);
    const prom = db.buscarPorNumero('processos', num).promotor;
    await processoCmd.confirmarParecerMp(fi(prom, { parecer: 'Ausente justa causa; promovo o ARQUIVAMENTO do procedimento.' }, r.canal), `${num}#arquivar`);
    await processoCmd.publicarParecer(fi(prom, {}, r.canal), num);
    log(`   ↳ arquivado pelo MP`);
  }

  async function civilCompleto(i, resultado) {
    const r = await processoCmd.criarProcessoCivil({ guild, advogadoId: OPERADOR, nomeAcao: `Ação de indenização por danos ${i}`, autorNome: nomes[i % nomes.length], autorDiscordId: OPERADOR, reuNome: nomes[(i + 1) % nomes.length], reuDiscordId: null });
    if (!r || !r.numero) { log(`⚠️ civil ${i} não abriu: ${r && r.erro}`); return; }
    track(r.canal); const num = r.numero; log(`📁 CIVIL ${num} aberto`);
    await wait(PASSO);
    const juiz = db.buscarPorNumero('processos', num).juiz;
    if (!juiz) { log(`   ↳ civil ${num} sem juiz (fila) — ok`); return num; }
    await processoCmd.salvarSentenca(fi(juiz, { texto: resultado === 'Procedente' ? 'Comprovado o dano e o nexo causal, JULGO PROCEDENTE o pedido.' : 'Ausente prova do dano, JULGO IMPROCEDENTE o pedido.' }, r.canal), num, resultado);
    await processoCmd.publicarSentenca(fi(juiz, {}, r.canal), num);
    log(`   ↳ SENTENÇA cível publicada (${resultado})`);
    return num;
  }

  async function civilComApelacao(i) {
    // autor (OPERADOR) perde (Improcedente) e recorre → acórdão
    const num = await civilCompleto(i, 'Improcedente');
    if (!num) return;
    const proc = db.buscarPorNumero('processos', num);
    if (proc.status !== 'Encerrado') return;
    await wait(PASSO);
    const canal = await canalDe(num);
    await processoCmd.confirmarRazoes(fi(OPERADOR, { razoes: 'A sentença desconsiderou as provas dos autos. Requer-se a reforma para julgar procedente o pedido.' }, canal), num);
    await processoCmd.publicarRazoes(fi(OPERADOR, {}, canal), num);
    const apNum = db.buscarPorNumero('processos', num).apelacaoNumero;
    if (!apNum) { log(`   ↳ recurso não abriu`); return; }
    const ap = db.buscarPorNumero('apelacoes', apNum); track(await guild.channels.fetch(ap.canalId).catch(() => null));
    log(`⚖️ APELAÇÃO ${apNum} interposta`);
    await wait(PASSO);
    const canalAp = await guild.channels.fetch(ap.canalId).catch(() => null);
    await processoCmd.confirmarAcordao(fi(ap.desembargadorId, { fundamentacao: 'Mantida a análise probatória de origem, NEGA-SE PROVIMENTO ao recurso.' }, canalAp), apNum, 'manter', {});
    await processoCmd.publicarAcordao(fi(ap.desembargadorId, {}, canalAp), apNum);
    log(`   ↳ ACÓRDÃO publicado (sentença mantida)`);
  }

  async function medidaCompleta(i, referenda) {
    const tipo = (medidaCmd.TIPOS_MEDIDA && medidaCmd.TIPOS_MEDIDA[i % medidaCmd.TIPOS_MEDIDA.length]) || 'Outra';
    const r = await medidaCmd.solicitarMedida({ guild, delegadoId: OPERADOR, promotorId: null, tipo, alvo: nomes[i % nomes.length], alvoDiscordId: null, motivo: `Representação ${i} — ${tipo}.`, semIndicios: true });
    if (!r || !r.numero) { log(`⚠️ medida ${i} não abriu: ${r && r.erro}`); return; }
    track(r.canal); const num = r.numero; log(`📋 MEDIDA ${num} solicitada (${tipo})`);
    await wait(PASSO);
    const med = db.buscarPorNumero('medidas', num);
    const prom = med.promotor;
    if (!prom) { log(`   ↳ medida ${num} sem promotor (fila) — ok`); return; }
    // MP aprova (modal fundamentação)
    await medidaCmd.processarAprovacaoMP(fi(prom, { fundamentacao: 'Presentes fumus boni iuris e periculum in mora, o MP OPINA FAVORAVELMENTE.' }, r.canal), num);
    log(`   ↳ MP aprovou, juiz sorteado`);
    await wait(PASSO);
    const juiz = db.buscarPorNumero('medidas', num).juiz;
    if (!juiz) { log(`   ↳ medida ${num} sem juiz (fila) — ok`); return; }
    const canal = await canalDe(num, 'medidas');
    if (referenda) {
      await medidaCmd.confirmarDecisaoMedida(fi(juiz, { fundamentacao: 'Presentes os requisitos legais, REFERENDO a medida e determino a expedição do mandado.' }, canal), num, 'referendo');
      await medidaCmd.executarDecisaoMedida(fi(juiz, {}, canal), `${num}#referendo`, false);
      log(`   ↳ REFERENDADA — mandado emitido`);
    } else {
      await medidaCmd.confirmarDecisaoMedida(fi(juiz, { fundamentacao: 'Ausentes os requisitos, NEGO PROVIMENTO ao pedido.' }, canal), num, 'negativa');
      await medidaCmd.executarDecisaoMedida(fi(juiz, {}, canal), `${num}#negativa`, false);
      log(`   ↳ NEGADA pelo juiz`);
    }
  }

  async function peticaoDemo(i, decisao) {
    const rg = `RG${10000 + i}`;
    const r = await peticaoCmd.criarPeticaoPorteArma({ guild, requerenteId: OPERADOR, rgCliente: rg, nomeCliente: nomes[i % nomes.length], enderecoCliente: `Rua ${i}, Centro` });
    if (!r || !r.numero) { log(`⚠️ petição ${i} não abriu`); return; }
    track(r.canal); const num = r.numero; log(`📄 PETIÇÃO ${num} (porte de arma) protocolada`);
    // simula o vínculo do cliente (que normalmente é UserSelect) e protocola
    db.atualizar('peticoes', num, { discordIdCliente: OPERADOR });
    await peticaoCmd.protocolarPeticao(guild, num);
    log(`   ↳ cliente vinculado, juiz sorteado`);
    await wait(PASSO);
    const pet = db.buscarPorNumero('peticoes', num);
    const juiz = pet.juiz; if (!juiz) { log(`   ↳ petição ${num} sem juiz (fila) — ok`); return; }
    const canal = await canalDe(num, 'peticoes');
    if (decisao === 'Deferido') {
      await peticaoCmd.finalizarDecisao(guild, num, 'Deferido', { motivo: 'Preenchidos os requisitos, DEFIRO o porte.' }, juiz);
      log(`   ↳ DEFERIDA`);
    } else {
      await peticaoCmd.finalizarDecisao(guild, num, 'Indeferido', { motivo: 'Ausentes requisitos, INDEFIRO.' }, juiz);
      log(`   ↳ INDEFERIDA`);
    }
  }

  async function oficioDemo(i, avulso) {
    const r = await oficioCmd.criarOficio({ guild, processoNumero: avulso ? null : null, destinatario: 'Instituto de Criminalística', assunto: `Requisição de laudo ${i}`, conteudo: `Solicita-se, com urgência, laudo pericial referente ao caso ${i}.`, emitidoPorId: OPERADOR, emitidoPorTag: 'operador-demo', instituicao: null, aguardaRetorno: false });
    if (r && r.numero) { track(r.canal); log(`✉️ OFÍCIO ${r.numero} expedido (${avulso ? 'avulso' : 'avulso'})`); }
  }

  async function designarDemo(i) {
    // processo civil que ficou SEM juiz — Supervisão designa
    const r = await processoCmd.criarProcessoCivil({ guild, advogadoId: OPERADOR, nomeAcao: `Ação sem julgador ${i}`, autorNome: nomes[i % nomes.length], autorDiscordId: OPERADOR, reuNome: nomes[(i + 1) % nomes.length], reuDiscordId: null });
    if (!r || !r.numero) return; track(r.canal); const num = r.numero;
    // força "sem juiz": tira o juiz que foi sorteado
    db.atualizar('processos', num, { juiz: null, status: 'Aguardando sorteio de juiz' });
    const canal = r.canal;
    if (canal) await canal.send({ content: '⚖️ **Comunicação do Tribunal** — não há Juiz disponível na lotação. A **Supervisão** ou a **Staff** pode designar um Juiz agora.', components: [] });
    log(`⚖️ DESIGNAR: processo ${num} ficou sem juiz`);
    await wait(PASSO);
    const juiz = juizes[0];
    await supervisao.designarJulgador(fi(desembs[0], { novo: `<@${juiz}>` }, canal), num);
    log(`   ↳ Desembargador DESIGNOU o Juiz — caso destravado`);
  }

  async function reabrirDemo(i) {
    const rg = `RG${20000 + i}`;
    const r = await peticaoCmd.criarPeticaoLimpezaFicha({ guild, requerenteId: OPERADOR, rgCliente: rg, nomeCliente: nomes[i % nomes.length], enderecoCliente: `Av ${i}`, jaTeveAntes: false });
    if (!r || !r.numero) return; track(r.canal); const num = r.numero;
    db.atualizar('peticoes', num, { status: 'Cancelada — prazo de vínculo expirado' });
    const canal = r.canal;
    if (canal) await canal.send({ content: '⏰ Petição cancelada por decurso de prazo de vínculo — Supervisão/Staff pode reabrir.', components: [new (require('discord.js').ActionRowBuilder)().addComponents(peticaoCmd.botaoReabrirCaso(num))] });
    log(`♻️ REABRIR: petição ${num} cancelada`);
    await wait(PASSO);
    await peticaoCmd.reabrirCaso(fi(desembs[0], {}, canal), num);
    log(`   ↳ Supervisão REABRIU (novo prazo de vínculo)`);
  }

  async function analisePdfDemo(i) {
    // demonstra a análise estruturada por IA num canal de processo
    const r = await processoCmd.criarProcessoPenal({ guild, delegadoId: OPERADOR, promotorId: null, crimesTexto: CRIME, motivo: `Inquérito ${i} com relatório para análise da IA.`, reusTexto: '', medidaNumero: null, atoMpNumero: null });
    if (!r || !r.numero) return; track(r.canal); const canal = r.canal;
    log(`🤖 ANÁLISE IA: gerando despacho estruturado de um PDF...`);
    const embed = await analiseDocumento.gerarAnaliseEmbed({ tipoDocumento: 'relatorio_inquerito', pdfUrl: PDF_DEMO }).catch(() => null);
    if (canal) {
      if (embed) { await canal.send({ content: '📎 Relatório de inquérito juntado — análise automática do Cartório (IA):', embeds: [embed] }); log(`   ↳ embed de análise postado`); }
      else { await canal.send({ content: '🤖 (IA indisponível ou PDF de exemplo sem texto útil — em produção, o embed de análise apareceria aqui.)' }); log(`   ↳ IA off/sem retorno (fallback)`); }
    }
  }

  async function mpAtoDemo(i) {
    const r = await ministerioPublico.abrirRequisicao({ guild, destinatario: 'Secretaria de Segurança', fundamentacao: `Requisita-se informação ${i} para instruir procedimento do MP.`, prazo: '10 dias', executorId: procs[0] });
    if (r && r.canal) { track(r.canal); log(`🏛️ MP: Requisição ${r.numero || ''} aberta`); }
  }

  // ---- roteiro (~40 cenários) ----
  const roteiro = [];
  for (let i = 0; i < 6; i++) roteiro.push(() => penalCompleto(i, i % 2 ? 'Absolvido' : 'Condenado'));
  roteiro.push(() => penalArquivar(100), () => penalArquivar(101));
  for (let i = 0; i < 5; i++) roteiro.push(() => civilCompleto(200 + i, i % 2 ? 'Improcedente' : 'Procedente'));
  for (let i = 0; i < 3; i++) roteiro.push(() => civilComApelacao(300 + i));
  for (let i = 0; i < 6; i++) roteiro.push(() => medidaCompleta(400 + i, i % 3 !== 0));
  for (let i = 0; i < 4; i++) roteiro.push(() => peticaoDemo(500 + i, i % 2 ? 'Indeferido' : 'Deferido'));
  for (let i = 0; i < 3; i++) roteiro.push(() => oficioDemo(600 + i, true));
  for (let i = 0; i < 2; i++) roteiro.push(() => designarDemo(700 + i));
  roteiro.push(() => reabrirDemo(800), () => reabrirDemo(801));
  for (let i = 0; i < 2; i++) roteiro.push(() => analisePdfDemo(900 + i));
  roteiro.push(() => mpAtoDemo(1000), () => mpAtoDemo(1001));

  log(`▶️ Iniciando DEMO: ${roteiro.length} cenários. Assista os canais nascerem e se preencherem!`);
  for (let i = 0; i < roteiro.length; i++) {
    try { await roteiro[i](); } catch (e) { log(`❌ cenário ${i} falhou: ${e.message}`); }
    if (i < roteiro.length - 1) await wait(CENARIO);
  }

  // ---- limpeza: arquiva os canais criados, desativa cargos temporários ----
  log(`🧹 Arquivando ${criados.length} canais da demo (não apaga)...`);
  for (const id of criados) {
    const c = await guild.channels.fetch(id).catch(() => null);
    if (c) await canais.arquivarCanal(c).catch(() => {});
  }
  for (const id of seeded) db.atualizarPorFiltro('rh', r => r.discordId === id, { ativo: false });
  log(`✅ DEMO concluída — ${roteiro.length} cenários, ${criados.length} canais arquivados, cargos temporários desativados.`);
};
