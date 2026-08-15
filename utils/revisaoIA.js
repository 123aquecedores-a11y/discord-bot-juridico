// Telas compartilhadas do fluxo "revisão-in-flow" (sentença, parecer, acórdão, razões, medida).
// Antes, cada um dos 5 fluxos montava à mão o mesmo trio de telas (prévia+escolha, fallback da IA,
// antes→depois), mudando só o prefixo do customId e o verbo — ~40 linhas copiadas 5x, com risco de
// uma cópia divergir das outras. Aqui fica a fonte única; cada fluxo só passa sua config + textos.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { truncar } = require('./texto');

// Config por fluxo. customId = painel:acao:<modulo>:<acao>:<extra>. `verbo` no infinitivo alimenta
// tanto o texto ("antes de publicar?") quanto o rótulo do botão ("Publicar assim").
const FLUXOS = {
  sentenca:  { modulo: 'sentenca',  acaoRevisar: 'revisar',     acaoPublicar: 'publicar',     acaoUsarRevisado: 'usarrevisado',     verbo: 'publicar' },
  parecermp: { modulo: 'parecermp', acaoRevisar: 'revisar',     acaoPublicar: 'enviar',       acaoUsarRevisado: 'usarrevisado',     verbo: 'enviar' },
  acordao:   { modulo: 'acordao',   acaoRevisar: 'revisar',     acaoPublicar: 'publicar',     acaoUsarRevisado: 'usarrevisado',     verbo: 'publicar' },
  razoes:    { modulo: 'razoes',    acaoRevisar: 'revisar',     acaoPublicar: 'enviar',       acaoUsarRevisado: 'usarrevisado',     verbo: 'protocolar' },
  medida:    { modulo: 'medida',    acaoRevisar: 'revisarfund', acaoPublicar: 'publicarfund', acaoUsarRevisado: 'usarrevisadofund', verbo: 'publicar' },
  // Manifestação do MP em petição administrativa: mesmo trio de telas, roteado pelo módulo 'peticao'.
  manifestacaomp: { modulo: 'peticao', acaoRevisar: 'revisarmanif', acaoPublicar: 'enviarmanif', acaoUsarRevisado: 'usarrevisadomanif', verbo: 'registrar' },
};

const capitaliza = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const cid = (f, acao, extra) => `painel:acao:${f.modulo}:${acao}:${extra}`;
const botaoPublicar = (f, extra, label, estilo = ButtonStyle.Success) =>
  new ButtonBuilder().setCustomId(cid(f, f.acaoPublicar, extra)).setLabel(label).setStyle(estilo);
const citar = (texto, max) => truncar(texto, max).replace(/\n/g, '\n> ');

// Tela 1: prévia + escolha (Revisar com IA / Publicar). Payload de reply efêmero.
// `rotulo` opcional entra dentro do parêntese: *(<rotulo>, prévia)*.
function telaEscolha(fluxo, { extra, titulo, rotulo = null, texto }) {
  const f = FLUXOS[fluxo];
  const meta = rotulo ? `${rotulo}, prévia` : 'prévia';
  return {
    content: `📝 **${titulo}** *(${meta})*:\n> ${citar(texto, 850)}\n\nQuer que a **IA revise a redação** (gramática/clareza, **sem mudar o sentido**) antes de ${f.verbo}? Você decide.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(f, f.acaoRevisar, extra)).setLabel('✨ Revisar com IA').setStyle(ButtonStyle.Primary),
      botaoPublicar(f, extra, `✅ ${capitaliza(f.verbo)} assim`),
    )],
    ephemeral: true,
  };
}

// Tela 2a: IA indisponível — só o botão de publicar com o original. Payload de editReply.
function telaFallbackIA(fluxo, extra) {
  const f = FLUXOS[fluxo];
  return {
    content: `⚠️ A revisão por IA não está disponível agora. Pode ${f.verbo} com o texto original.`,
    components: [new ActionRowBuilder().addComponents(botaoPublicar(f, extra, `✅ ${capitaliza(f.verbo)} assim`))],
  };
}

// Tela 2b: antes→depois (Usar revisado / Manter original). Payload de editReply.
function telaAntesDepois(fluxo, { extra, textoOriginal, textoRevisado }) {
  const f = FLUXOS[fluxo];
  return {
    content: `**📄 Original:**\n> ${citar(textoOriginal, 650)}\n\n**✨ Revisado pela IA:**\n> ${citar(textoRevisado, 650)}`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(f, f.acaoUsarRevisado, extra)).setLabel('Usar revisado').setStyle(ButtonStyle.Success),
      botaoPublicar(f, extra, 'Manter original', ButtonStyle.Secondary),
    )],
  };
}

module.exports = { telaEscolha, telaFallbackIA, telaAntesDepois };
