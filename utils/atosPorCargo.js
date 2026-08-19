// ATOS POR CARGO, NÃO POR TITULARIDADE — decisão do operador, 19/08/2026.
//
// O PROBLEMA QUE ISSO RESOLVE: o bot exigia que o ato fosse praticado pelo titular DAQUELE caso
// ("só o Juiz deste processo pode julgá-lo"). Com poucos magistrados online, um documento endereçado
// ao Juiz simplesmente não tinha quem recebesse, e o processo parava — não por regra, por ausência.
//
// A REGRA NOVA: quem TEM o cargo pode praticar o ato, no caso de qualquer colega. Um juiz cobre o
// outro, como cobertura de plantão.
//
// ESCOPO FECHADO — só magistratura e MP. Advogado e público NÃO entram, e isso é o que impede a
// mudança de virar vazamento: quem defende continua preso à própria habilitação, e o sigilo para o
// público não muda em nada.
const rh = require('./rh');

const PAPEIS_COMPARTILHADOS = ['Juiz', 'Promotor', 'Desembargador', 'Procurador'];

// Mapa campo-do-registro -> cargo exigido. É a tradução entre "onde o titular está gravado" e "qual
// cargo pode agir". Campos FORA deste mapa (delegado, autor, requerenteId, advogadoId, emitidoPor)
// seguem valendo por IDENTIDADE, de propósito — não são magistratura nem MP.
const CARGO_DO_CAMPO = {
  juiz: 'Juiz',
  promotor: 'Promotor',
  desembargadorId: 'Desembargador',
};

const ehCargoCompartilhado = (cargo) => PAPEIS_COMPARTILHADOS.includes(cargo);

// Pode praticar um ato reservado a `cargo`? Três caminhos, nesta ordem:
//   1. é o TITULAR gravado no caso (continua valendo — e é o caminho mais barato);
//   2. TEM o cargo no RH (a abertura);
//   3. é staff/supervisão (como sempre foi).
// `ehStaff` entra por parâmetro porque este módulo não importa discord.js — quem chama resolve.
function podeAtuar({ usuarioId, cargo, titularId = null, ehStaff = false }) {
  if (!usuarioId) return false;
  if (ehStaff) return true;
  if (titularId && titularId === usuarioId) return true;
  if (!ehCargoCompartilhado(cargo)) return false;
  if (rh.temCargo(usuarioId, cargo)) return true;

  // Procurador é a chefia do MP e Desembargador a da magistratura: onde um Promotor pode agir, o
  // Procurador também pode, e o mesmo para Juiz/Desembargador. Isso já valia na supervisão; aqui só
  // fica explícito para os atos ordinários.
  if (cargo === 'Promotor' && rh.temCargo(usuarioId, 'Procurador')) return true;
  if (cargo === 'Juiz' && rh.temCargo(usuarioId, 'Desembargador')) return true;
  return false;
}

// Mensagem de recusa que DIZ O QUE FAZER — recusa sem saída é beco disfarçado.
function recusa(cargo, ato = 'praticar este ato') {
  const artigo = cargo === 'Juiz' ? 'um(a) Juiz(a)' : `um(a) ${cargo}`;
  return `Só ${artigo} pode ${ato}. Se você tem o cargo e mesmo assim está vendo isto, confira seu registro no **/rh** — o cargo precisa estar ativo lá.`;
}

// ---------------------------------------------------------------------------
// GUARDA DE COLISÃO — obrigatória, porque abrir o "decidir" abre a corrida
// ---------------------------------------------------------------------------
// Enquanto só o titular decidia, dois cliques simultâneos eram improváveis. Com qualquer juiz
// podendo julgar, dois magistrados podem clicar no mesmo instante — e sem trava o ato seria
// executado duas vezes (duas sentenças, dois deferimentos, dois andamentos).
//
// A trava é por ESTADO JÁ GRAVADO, não por lock em memória: o bot reinicia, e lock em memória morre
// junto (mesma razão de todo prazo ser persistido, SPEC §12). Se o campo que marca a execução já
// está preenchido, o ato já aconteceu — e quem chegou depois recebe o nome de quem fez.
//
// `campos` é a lista de marcadores que provam execução (o primeiro preenchido decide).
function jaExecutado(registro, campos = []) {
  if (!registro) return null;
  for (const campo of campos) {
    if (registro[campo]) {
      return {
        campo,
        porId: registro.executadoPorId || registro[`${campo}PorId`] || null,
        em: typeof registro[campo] === 'string' ? registro[campo] : null,
      };
    }
  }
  return null;
}

// Mensagem do segundo clique. Nomeia quem fez — é isso que transforma "nada aconteceu" em
// informação útil para quem chegou depois.
function mensagemJaFeito(descricaoDoAto, execucao) {
  const quem = execucao && execucao.porId ? `<@${execucao.porId}>` : 'outro(a) magistrado(a)';
  const quando = execucao && execucao.em ? ` em <t:${Math.floor(new Date(execucao.em).getTime() / 1000)}:f>` : '';
  return `⚠️ **${descricaoDoAto} já foi feito** por ${quem}${quando}. Nada foi refeito — recarregue o painel para ver o estado atual.`;
}

// AÇÃO ÚNICA para o ponto de commit de um ato decisório. Devolve a mensagem de recusa se o ato já
// aconteceu, ou `null` para seguir.
//
// O registro deve ser RELIDO DO BANCO imediatamente antes de chamar isto. É o que fecha a janela
// entre "verifiquei na entrada" e "gravei": entre o clique e o commit existe um `await` (modal,
// render do PNG, chamada de IA), e é exatamente nessa janela que o segundo magistrado clica.
//
// `campos` são os marcadores que provam execução — o horário da decisão, o status terminal já
// gravado. Estado no banco, nunca lock em memória: o bot reinicia e lock em memória morre junto.
function bloqueioPorJaExecutado(registro, campos, descricaoDoAto) {
  const exec = jaExecutado(registro, campos);
  return exec ? mensagemJaFeito(descricaoDoAto, exec) : null;
}

// Variante para atos cujo marcador é o STATUS ter saído de um conjunto "ainda decidível".
// Petição em "Diligência" é o caso que obriga isto a existir: ela JÁ foi decidida uma vez e ainda
// pode ser decidida de novo, então um marcador de horário sozinho bloquearia o que é legítimo.
function bloqueioPorStatusDecidido(registro, statusAindaAbertos, descricaoDoAto) {
  if (!registro || statusAindaAbertos.includes(registro.status)) return null;
  return mensagemJaFeito(descricaoDoAto, {
    porId: registro.executadoPorId || null,
    em: registro.decisaoJuizEm || registro.decididoEm || registro.sentencaEm || null,
  });
}

// Campos de auditoria de QUEM REALMENTE praticou o ato. O titular continua gravado no caso (dono
// para notificação e organização); isto registra o executor, que pode ser outro.
//
// Sem isso, o histórico diria "o juiz do caso julgou" quando quem julgou foi um colega cobrindo —
// e a auditoria ficaria mentindo.
function carimboDeExecucao(usuarioId, { agora = Date.now() } = {}) {
  return { executadoPorId: usuarioId, executadoEm: new Date(agora).toISOString() };
}

module.exports = {
  PAPEIS_COMPARTILHADOS, CARGO_DO_CAMPO, ehCargoCompartilhado,
  podeAtuar, recusa, jaExecutado, mensagemJaFeito, carimboDeExecucao,
  bloqueioPorJaExecutado, bloqueioPorStatusDecidido,
};
