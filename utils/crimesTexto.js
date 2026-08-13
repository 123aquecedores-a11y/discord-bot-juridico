// Formatação compartilhada do novo schema de crimes.json (codigo_artigo, pena_min_meses/
// pena_max_meses, apuracao) — usada em /crime, no crimePicker, no /painel e nos textos de
// documentos (processo.js, supervisao.js) pra não duplicar a mesma lógica de exibição em cada um.
function penaTexto(crime) {
  if (crime.apuracao === 'corregedoria') return 'A cargo do órgão corregedor';
  if (crime.sem_custodia) return 'Sem custódia';
  return `${crime.pena_min_meses} a ${crime.pena_max_meses} meses`;
}

function crimeLabel(crime) {
  return `${crime.nome} (Art. ${crime.codigo_artigo})`;
}

// Busca de crime por nome/artigo/id — mesma regra usada no autocomplete de /crime, no modal de
// busca do /painel e no crimePicker. Estava copiada em 3 lugares (Frente 4a.2); agora é fonte
// única. Retorna a lista (até `limite`) dos crimes que casam com o termo.
const crimes = require('../data/crimes.json');
function buscarCrimes(termo, limite = 25) {
  const t = (termo || '').toLowerCase();
  return crimes
    .filter(c => c.nome.toLowerCase().includes(t) || c.codigo_artigo.toLowerCase().includes(t) || c.id.includes(t))
    .slice(0, limite);
}

// Baixa caixa + tira acento — pra "Homicídio" casar com "homicidio", "Difamação" com "difamacao".
function normalizarCrime(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Resolve uma LISTA de crimes a partir de texto livre — fonte única usada tanto pela abertura
// manual (/processo penal, picker do painel) quanto pela integração da Polícia Civil
// (encerramento de inquérito, ver utils/integracaoPoliciaCivil.js). Cada item vem separado por
// vírgula, ponto-e-vírgula ou quebra de linha e é casado, NESTA ordem de prioridade, contra:
//   1) o id interno exato — ex.: "121-homicidio-consumado" (formato copiado de /crime buscar);
//   2) o código do artigo exato — ex.: "121", "147-A", "Lei 11.343, art. 33" (com ou sem "Art.");
//   3) o nome do crime exato — ex.: "Homicídio Consumado" (sem acento, sem caixa).
// Só casamento EXATO (nunca "contém"), porque artigo/nome parciais são ambíguos — "121" sozinho
// bate no homicídio consumado, mas "121 c/c 14" (tentativa) é outro crime. Retorna crimes únicos
// preservando a ordem em que apareceram; itens que não batem com nenhum crime conhecido são
// silenciosamente ignorados (o chamador decide o que fazer com lista vazia).
function casarUmCrime(item) {
  const s = (item || '').trim();
  if (!s) return null;
  const alvo = normalizarCrime(s);
  // Tira um "Art."/"Artigo" inicial pra "Art. 121" casar com codigo_artigo "121".
  const alvoArtigo = normalizarCrime(s.replace(/^art(?:igo)?\.?\s*/i, ''));
  return crimes.find(c => c.id === s)
    || crimes.find(c => normalizarCrime(c.codigo_artigo) === alvo || normalizarCrime(c.codigo_artigo) === alvoArtigo)
    || crimes.find(c => normalizarCrime(c.nome) === alvo)
    || null;
}

function resolverCrimesTexto(texto) {
  if (!texto) return [];
  const achados = [];
  const vistos = new Set();
  const adicionar = (crime) => {
    if (crime && !vistos.has(crime.id)) { vistos.add(crime.id); achados.push(crime); }
  };
  // Quebra primeiro por quebra de linha e ponto-e-vírgula — separadores sem ambiguidade. A
  // vírgula é tratada por último de propósito: vários codigo_artigo de lei especial TÊM vírgula
  // ("Lei 11.343, art. 33", "CTB, art. 306"), então tentamos casar a LINHA INTEIRA antes de
  // partir por vírgula — assim "Lei 11.343, art. 33" numa linha sozinha casa como um só crime,
  // mas "Homicídio, Furto" cai no split e vira dois.
  for (const linha of texto.split(/[;\n]+/)) {
    const direto = casarUmCrime(linha);
    if (direto) { adicionar(direto); continue; }
    for (const parte of linha.split(',')) adicionar(casarUmCrime(parte));
  }
  return achados;
}

// Extrai crimes de um texto em PROSA — o "Relatório Final" do inquérito que a Polícia Civil
// manda, onde a tipificação vem escrita à mão (ex.: "INCIDÊNCIA PENAL: Art. 121 c/c 14, II
// (Tentativa de Homicídio); Art. 146 (Constrangimento Ilegal); ..."), NÃO num campo estruturado.
// Duas fontes de sinal, combinadas e deduplicadas, item a item (itens separados por ";"/quebra):
//   1) o NOME entre parênteses — "(Peculato)", "(Tentativa de Homicídio)" — casado contra o nome
//      do crime na base; é o sinal mais forte, porque nome é único por crime;
//   2) o ARTIGO solto — "Art. 288-A", "Art. 146" — casado contra codigo_artigo, só quando o nome
//      não pegou. Casamento sempre EXATO (ver casarUmCrime/normalizarCrime), nunca "contém".
// Recorta a seção de tipificação (de "INCIDÊNCIA PENAL"/"TIPIFICAÇÃO" até "DOS FATOS") quando os
// marcadores existem, pra reduzir ruído; sem eles, varre o texto todo (o casamento exato já evita
// falso positivo — um "(fls. 12)" solto no relatório não vira crime).
// Retorna { crimes, naoReconhecidos }: quem chama abre o processo com o que reconheceu e AVISA os
// rótulos não reconhecidos pra inclusão manual — o caso nunca deixa de abrir por causa de 1 crime
// que a base não tem, e nenhum crime sai silenciosamente da conta.
function extrairCrimesDeRelatorio(texto) {
  if (!texto) return { crimes: [], naoReconhecidos: [] };
  const t = String(texto);
  const ini = t.search(/incid[êe]ncia\s+penal|tipifica[çc]|capitula[çc]/i);
  const fim = t.search(/\bdos\s+fatos\b/i);
  const trecho = ini >= 0 ? t.slice(ini, fim > ini ? fim : undefined) : t;

  const achados = [];
  const vistos = new Set();
  const naoReconhecidos = [];
  for (const item of trecho.split(/[;\n]+/)) {
    const nome = (item.match(/\(([^)]{3,80})\)/) || [])[1];
    let crime = nome ? crimes.find(c => normalizarCrime(c.nome) === normalizarCrime(nome)) : null;
    if (!crime) {
      const art = (item.match(/\barts?\.?\s*(\d{1,3}(?:-[A-Za-z])?)\b/i) || [])[1];
      if (art) crime = crimes.find(c => normalizarCrime(c.codigo_artigo) === normalizarCrime(art));
    }
    if (crime) {
      if (!vistos.has(crime.id)) { vistos.add(crime.id); achados.push(crime); }
    } else if (nome) {
      // Só reporta como "não reconhecido" o que PARECIA crime (tinha rótulo entre parênteses),
      // pra não encher a lista com texto solto do relatório.
      naoReconhecidos.push(nome.trim());
    }
  }
  return { crimes: achados, naoReconhecidos };
}

module.exports = {
  penaTexto, crimeLabel, buscarCrimes, normalizarCrime, casarUmCrime,
  resolverCrimesTexto, extrairCrimesDeRelatorio,
};
