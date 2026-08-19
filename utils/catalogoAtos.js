// RÓTULOS DOS ATOS — fonte única, SEM discord.js.
//
// POR QUE ESTE ARQUIVO EXISTE (19/08/2026, achado da auditoria):
// utils/emissaoPeca.js tinha o catálogo completo, mas services/servidorPecas.js mantinha uma CÓPIA
// própria com apenas 2 dos 7 tipos — porque não pode importar emissaoPeca (que puxa discord.js, e
// o servidor HTTP precisa responder sem o bot). A cópia divergiu, como toda cópia diverge:
//
//   - os 5 tipos acrescentados nos Blocos D e E (denúncia, manifestação do MP, contestação,
//     relatório de inquérito, sentença) caíam num TITULO_PADRAO genérico: a página impressa no jogo
//     dizia "DOCUMENTO", sem título nem unidade, enquanto o PNG enviado por DM dizia "SENTENÇA";
//   - a unidade estava fixa em "Vara Criminal" nos dois tipos, o mesmo defeito já corrigido no
//     outro lado — petição cível impressa saía com a vara errada.
//
// Agora os dois lados leem daqui. Este módulo NÃO importa discord.js de propósito: é o que permite
// o servidor HTTP usá-lo. Quem precisa de emissor/destinatário/flag de ativação continua em
// emissaoPeca.TIPOS, que estende estes rótulos.

// A unidade NÃO mora aqui: ela é do PROCESSO, não do ato (SPEC — o catálogo descreve o ato; a vara
// vem do rito). Ver unidadeDoProcesso, abaixo.
const ROTULOS = {
  peticao_incidental:    { titulo: 'PETIÇÃO',                                  orgao: 'PODER JUDICIÁRIO' },
  intimacao_juiz:        { titulo: 'INTIMAÇÃO',                                orgao: 'PODER JUDICIÁRIO' },
  denuncia_mp:           { titulo: 'DENÚNCIA',                                 orgao: 'MINISTÉRIO PÚBLICO' },
  manifestacao_mp_gated: { titulo: 'MANIFESTAÇÃO DO MINISTÉRIO PÚBLICO',       orgao: 'MINISTÉRIO PÚBLICO' },
  contestacao:           { titulo: 'CONTESTAÇÃO',                              orgao: 'PODER JUDICIÁRIO' },
  relatorio_inquerito:   { titulo: 'RELATÓRIO DE INQUÉRITO',                   orgao: 'POLÍCIA CIVIL' },
  sentenca:              { titulo: 'SENTENÇA',                                 orgao: 'PODER JUDICIÁRIO' },
  peticao_administrativa: { titulo: 'PETIÇÃO',                                 orgao: 'PODER JUDICIÁRIO' },
  peticao_inicial_civel: { titulo: 'PETIÇÃO INICIAL',                          orgao: 'PODER JUDICIÁRIO' },
};

// Fallback declarado: tipo desconhecido não pode quebrar a renderização de um documento que já
// existe nos autos. Mas "DOCUMENTO" genérico é sinal de que alguém acrescentou tipo sem rótulo —
// o teste de cobertura do catálogo (scripts/testes-catalogo-rotulos.js) falha nesse caso.
const ROTULO_PADRAO = { titulo: 'DOCUMENTO', orgao: 'PODER JUDICIÁRIO' };

const rotuloDoAto = (tipo) => ROTULOS[tipo] || ROTULO_PADRAO;

// A vara vem do PROCESSO, nunca fixa no catálogo do ato — uma petição incidental roda tanto em
// processo penal quanto cível, e o catálogo não sabe em qual.
//
// NOTA PARA A FAIXA 2 (administrativo): quando entrar o terceiro rito, isto vira TABELA por tipo,
// não um terceiro `if`. Dois ramos ainda se lê; três empilhados viram o lugar onde alguém esquece
// um caso.
function unidadeDoProcesso(processo) {
  return processo && processo.tipo === 'Penal'
    ? 'Comarca de São Paulo — Vara Criminal'
    : 'Comarca de São Paulo — Vara Cível';
}

module.exports = { ROTULOS, ROTULO_PADRAO, rotuloDoAto, unidadeDoProcesso };
