// Simulador de alto fluxo — cria tickets DE VERDADE espaçados no tempo, pra assistir ao vivo.
// Roda dentro do próprio bot (index.js chama isto quando SIMULAR=1), então o bot continua
// respondendo normalmente. NÃO apaga nada; ao final, só desativa os cargos temporários que
// semeou pro sorteio (não some do banco, só não é mais sorteado). Cada ação é isolada.
const db = require('../database/db');

module.exports.run = async function run(client, guild) {
  const processoCmd = require('../commands/processo');
  const medidaCmd = require('../commands/medida');
  const oficioCmd = require('../commands/oficio');

  const USER = process.env.SIMULAR_USER || '400438471631699978'; // conta real do operador
  const CRIME = '121-c-c-14-tentativa-de-homicidio';
  const t0 = Date.now();
  const log = (m) => console.log(`[SIM +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const ACOES = Number(process.env.SIMULAR_ACOES) || 24;
  const INTERVALO = Number(process.env.SIMULAR_INTERVALO_MS) || 35000; // 35s → 24 ações ≈ 14 min

  // Semeia cargos temporários (marcados _sim) pra o sorteio ter quem escolher.
  const seeded = [];
  const seed = (cargo, n) => {
    for (let i = 0; i < n; i++) {
      const id = `70${(Date.now() % 1000000)}${cargo.length}${i}`;
      db.inserir('rh', { discordId: id, cargo, ativo: true, licenca: false, nomePersonagem: `${cargo} Sim ${i}`, _sim: true });
      seeded.push(id);
    }
  };
  seed('Juiz', 3); seed('Promotor', 2); seed('Delegado', 2); seed('Advogado', 3);
  log(`Semeados ${seeded.length} cargos temporários pra sorteio.`);

  const nomes = ['Carlos Silva', 'Ana Souza', 'Pedro Lima', 'Marina Costa', 'João Alves', 'Beatriz Rocha', 'Rafael Dias', 'Larissa Melo'];
  const nome = (i) => nomes[i % nomes.length];
  const tipoMed = (medidaCmd.TIPOS_MEDIDA && medidaCmd.TIPOS_MEDIDA[0]) || 'Outra';

  const fazer = async (i) => {
    const tipo = i % 4;
    if (tipo === 0) {
      const r = await processoCmd.criarProcessoPenal({ guild, delegadoId: USER, promotorId: null, crimesTexto: CRIME, motivo: `Investigação ${i} — indícios apurados pela autoridade policial.`, reusTexto: '', medidaNumero: null, atoMpNumero: null });
      log(`⚖️ Processo PENAL ${(r && r.numero) || '?'} aberto${r && r.erro ? ` (erro: ${r.erro})` : ''}`);
    } else if (tipo === 1) {
      const r = await processoCmd.criarProcessoCivil({ guild, advogadoId: USER, nomeAcao: `Ação indenizatória por danos ${i}`, autorNome: nome(i), autorDiscordId: null, reuNome: nome(i + 1), reuDiscordId: null });
      log(`📁 Processo CIVIL ${(r && r.numero) || '?'} aberto (autor/réu só por nome, sem Discord)`);
    } else if (tipo === 2) {
      const r = await medidaCmd.solicitarMedida({ guild, delegadoId: USER, promotorId: null, tipo: tipoMed, alvo: nome(i), alvoDiscordId: null, motivo: `Medida ${i} — representação da autoridade policial.`, semIndicios: true });
      log(`📋 MEDIDA ${(r && r.numero) || '?'} solicitada${r && r.erro ? ` (erro: ${r.erro})` : ''}`);
    } else {
      const r = await oficioCmd.criarOficio({ guild, processoNumero: null, destinatario: 'Instituto de Criminalística', assunto: `Requisição de laudo ${i}`, conteudo: `Solicito, com urgência, informações e laudo referentes ao caso nº ${i}.`, emitidoPorId: USER, emitidoPorTag: 'operador-sim', instituicao: null, aguardaRetorno: false });
      log(`✉️ OFÍCIO ${(r && r.numero) || '?'} expedido${r && r.erro ? ` (erro: ${r.erro})` : ''}`);
    }
  };

  log(`▶️ Iniciando simulação: ${ACOES} ações, uma a cada ${INTERVALO / 1000}s (~${Math.round(ACOES * INTERVALO / 60000)} min). Assista os canais nascerem!`);
  for (let i = 0; i < ACOES; i++) {
    try { await fazer(i); } catch (e) { log(`❌ ação ${i} falhou: ${e.message}`); }
    if (i < ACOES - 1) await wait(INTERVALO);
  }

  for (const id of seeded) db.atualizarPorFiltro('rh', r => r.discordId === id, { ativo: false });
  log(`✅ Simulação concluída. Cargos temporários desativados (tickets preservados, nada apagado).`);
};
