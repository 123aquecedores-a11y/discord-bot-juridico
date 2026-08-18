/* eslint-disable */
// FERRAMENTA DO TESTE DE ACEITAÇÃO DA RENDERIZAÇÃO.
//
// O critério de pronto desta etapa não é "o QR lê num arquivo local" — é o caminho real inteiro:
// Chromium renderiza -> Discord serve -> alguém exibe no jogo -> captura de tela -> upload ->
// decodifica. Só um humano pode rodar isso, e este comando é a ponta que ele usa.
//
//   Gerar um documento de teste com selo (sai em ./teste-selo/):
//     node scripts/conferir-selo.js --gerar
//     node scripts/conferir-selo.js --gerar --texto "cole aqui uma petição longa"
//
//   Conferir uma captura vinda do jogo:
//     node scripts/conferir-selo.js caminho/da/captura.png
//
// Na conferência ele responde se decodificou, qual token saiu, e se bate com o do documento gerado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAIDA = path.join(__dirname, '..', 'teste-selo');
const ARQ_TOKEN = path.join(SAIDA, 'token.txt');

const args = process.argv.slice(2);
const querGerar = args.includes('--gerar');
const alvo = args.find(a => !a.startsWith('--'));

// Texto padrão longo o bastante para forçar VÁRIAS páginas. Um documento de uma página só não
// testaria o que mais importa aqui: que qualquer página capturada decodifica igual. Também cobre o
// teste 12 da SPEC §15 (petição acima de 4.000 caracteres).
function textoPadrao() {
  const p = [
    'Trata-se de petição inicial ajuizada em face do requerido, pelos fatos e fundamentos a seguir expostos, na forma da legislação processual vigente.',
    'DOS FATOS. No dia dos acontecimentos, conforme apurado em sede policial e documentado nos autos do inquérito, o requerido praticou a conduta descrita na denúncia, causando os danos que aqui se pretende ver reparados. As circunstâncias foram registradas por testemunhas presenciais, cujos depoimentos seguem anexos.',
    'A prova documental acostada demonstra, de forma inequívoca, o nexo de causalidade entre a conduta e o resultado. Não há nos autos qualquer elemento que afaste a responsabilidade do requerido, tampouco causa excludente de ilicitude que mereça acolhida.',
    'DO DIREITO. A responsabilidade encontra-se amparada na legislação de regência, que impõe o dever de reparação a quem, por ação ou omissão voluntária, negligência ou imprudência, violar direito e causar dano a outrem, ainda que exclusivamente moral.',
    'A jurisprudência consolidada é firme no sentido de que a comprovação do dano, aliada à demonstração da conduta e do nexo causal, é suficiente para o reconhecimento do dever de indenizar, dispensando prova de culpa nas hipóteses de responsabilidade objetiva.',
    'Cumpre destacar que o requerido foi regularmente notificado na esfera administrativa e permaneceu inerte, deixando transcorrer in albis o prazo que lhe foi concedido para manifestação espontânea, o que reforça o descaso com a situação narrada.',
    'DOS PEDIDOS. Ante o exposto, requer-se: a) o recebimento da presente petição, com a autuação e o regular processamento do feito; b) a citação do requerido para, querendo, apresentar defesa no prazo legal, sob pena de revelia; c) a produção de todos os meios de prova em direito admitidos, notadamente a documental, a testemunhal e a pericial, se necessária.',
    'Requer-se, por fim, a total procedência dos pedidos, com a condenação do requerido ao pagamento das verbas indicadas, acrescidas de correção monetária e juros legais desde o evento danoso, além das custas processuais e honorários advocatícios na forma da lei.',
    'DA TEMPESTIVIDADE. A presente manifestação é tempestiva, considerando que o prazo legal teve início na data da juntada aos autos do comprovante de intimação, conforme certidão lavrada pela serventia, não havendo qualquer óbice ao seu conhecimento por este juízo.',
    'DA PROVA TESTEMUNHAL. Requer-se desde já a oitiva das testemunhas arroladas ao final desta peça, todas com endereço conhecido nos autos, comprometendo-se a parte a apresentá-las independentemente de intimação, na data que vier a ser designada para a audiência de instrução e julgamento.',
    'DA PROVA PERICIAL. Caso este juízo entenda necessária a produção de prova técnica, desde já se requer a nomeação de perito de confiança, com a formulação de quesitos no momento processual oportuno e a indicação de assistente técnico na forma da legislação de regência.',
    'DO VALOR DA CAUSA. Atribui-se à causa o valor correspondente ao proveito econômico pretendido, para os fins legais, sem prejuízo de eventual retificação no curso do processo caso os elementos probatórios apontem montante diverso do ora estimado.',
    'Nesses termos, pede deferimento.',
  ];
  return p.join('\n\n');
}

async function gerar() {
  const { gerarPecaPNG } = require('../services/gerarPecaPNG');
  const token = `tk_${crypto.randomBytes(16).toString('hex')}`;
  const digitos = Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');
  const iTexto = args.indexOf('--texto');
  const texto = iTexto !== -1 && args[iTexto + 1] ? args[iTexto + 1] : textoPadrao();

  fs.mkdirSync(SAIDA, { recursive: true });
  console.log('Gerando documento de teste...');
  const paginas = await gerarPecaPNG({
    gated: true, token, digitos,
    numeroPeca: '0001PN-P1', numeroProcesso: '0001PN',
    titulo: 'PETIÇÃO INICIAL', orgao: 'PODER JUDICIÁRIO',
    unidade: 'Comarca de São Paulo — Vara Criminal',
    data: new Date().toLocaleDateString('pt-BR'),
    texto, assinante: 'Dr. Fulano de Tal', cargoAssinante: 'Advogado — OAB 000.001',
  });

  paginas.forEach((buf, i) => {
    const arq = path.join(SAIDA, `pagina-${i + 1}.png`);
    fs.writeFileSync(arq, buf);
    console.log(`  ${arq}  (${buf.length} bytes)`);
  });
  fs.writeFileSync(ARQ_TOKEN, token);

  console.log(`\n${paginas.length} página(s). Token gravado em ${ARQ_TOKEN}`);
  console.log('\nO teste de verdade agora é com humano:');
  console.log('  1. mande UMA dessas páginas para o Discord (qualquer uma — o selo está em todas);');
  console.log('  2. abra no jogo, na tela em que o documento aparece para o outro jogador;');
  console.log('  3. tire print da tela;');
  console.log('  4. rode:  node scripts/conferir-selo.js caminho/do/print.png');
  console.log('\nSe a página 2 ou 3 decodificar igual à 1, o QR em todas as páginas fez o trabalho.');

  // Sanidade local: cada página tem que decodificar para o mesmo token, antes de envolver humano.
  const { lerToken } = require('../utils/lerSelo');
  console.log('\nConferência local (antes do teste no jogo):');
  let todasOk = true;
  paginas.forEach((buf, i) => {
    const r = lerToken(buf);
    const bate = r.ok && r.token === token;
    if (!bate) todasOk = false;
    console.log(`  página ${i + 1}: ${bate ? 'OK — token confere' : `FALHOU (${r.motivo || 'token diferente'})`}`);
  });
  console.log(todasOk ? '\nTodas as páginas decodificam para o mesmo token.' : '\nATENÇÃO: alguma página não decodificou — não leve ao jogo assim.');
  process.exit(todasOk ? 0 : 1);
}

function conferir(caminho) {
  const { lerToken, mensagemDeFalha } = require('../utils/lerSelo');
  if (!fs.existsSync(caminho)) { console.error(`Arquivo não encontrado: ${caminho}`); process.exit(1); }

  const buf = fs.readFileSync(caminho);
  console.log(`Arquivo : ${caminho}`);
  console.log(`Tamanho : ${(buf.length / 1024).toFixed(1)} KB`);

  const inicio = Date.now();
  const r = lerToken(buf);
  console.log(`Tempo   : ${Date.now() - inicio} ms\n`);

  if (!r.ok) {
    console.log(`NÃO DECODIFICOU (${r.motivo})`);
    console.log(`  detalhe    : ${r.detalhe}`);
    console.log(`  o jogador veria: "${mensagemDeFalha(r.motivo)}"`);
    console.log('\nIsto conta como falha TÉCNICA: não trava o selo, o destinatário tenta outra captura.');
    process.exit(1);
  }

  console.log(`DECODIFICOU`);
  console.log(`  dimensões : ${r.dimensoes}`);
  console.log(`  token     : ${r.token}`);

  if (fs.existsSync(ARQ_TOKEN)) {
    const esperado = fs.readFileSync(ARQ_TOKEN, 'utf-8').trim();
    const bate = r.token === esperado;
    console.log(`  esperado  : ${esperado}`);
    console.log(`\n${bate ? 'BATE com o documento gerado — o caminho inteiro fechou.' : 'NÃO BATE — o token lido é de outro documento.'}`);
    process.exit(bate ? 0 : 1);
  }
  console.log('\n(sem token de referência gravado — rode --gerar antes para comparar)');
}

if (querGerar) gerar().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
else if (alvo) conferir(alvo);
else {
  console.log('Uso:');
  console.log('  node scripts/conferir-selo.js --gerar              gera documento de teste com selo');
  console.log('  node scripts/conferir-selo.js <imagem>             confere uma captura');
  process.exit(1);
}
