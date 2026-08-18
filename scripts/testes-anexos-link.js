/* eslint-disable */
// Testes do vínculo permanente de anexo. Rode com:
//   node scripts/testes-anexos-link.js
//
// Defeito que estes testes impedem de voltar: as URLs do CDN do Discord são links ASSINADOS e
// expiram em 24h. Medido em produção em 18/08/2026 — 29 dos 34 anexos gravados retornavam HTTP 404,
// incluindo 11 provas em processos que ainda aguardavam defesa. O juiz abria o dossiê para julgar
// e as provas não abriam.
//
// A correção é apontar para a MENSAGEM, não para o anexo: link de mensagem do Discord não expira,
// custa zero chamada de API e a permissão passa a ser a do próprio canal.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_TESTE = path.join(os.tmpdir(), `dados-teste-anexos-${process.pid}.json`);
try { fs.unlinkSync(DB_TESTE); } catch (_) {}
process.env.DADOS_JSON_PATH = DB_TESTE;
process.env.RESETAR_BANCO = '';
process.env.GUILD_ID = 'guild123';

const anexos = require('../utils/anexos');

let passes = 0; const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passes++; console.log(`  ✅ ${nome}`); }
  else { falhas.push({ nome, detalhe }); console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

console.log('\n=== Vínculo permanente de anexo ===\n');

console.log('1) O par canal+mensagem é persistido');
{
  const doc = anexos.criarDocumento({
    tipo: 'prova', url: 'https://cdn.discordapp.com/attachments/1/2/x.png?ex=6a7f2a48&is=...&hm=...',
    canalId: '111', mensagemId: '222', nomeArquivo: 'x.png', autorId: 'autor1', protocoloVinculado: '0001CV',
  });
  ok(doc.canalId === '111' && doc.mensagemId === '222', '1a: canalId e mensagemId gravados');
  ok(!!doc.url, '1b: a url continua gravada como atalho de curta duração');
}

console.log('\n2) O link exibido é o da MENSAGEM, nunca o do anexo');
{
  const doc = { canalId: '111', mensagemId: '222', nomeArquivo: 'prova.png', url: 'https://cdn.discordapp.com/attachments/1/2/x.png?ex=abc' };
  const link = anexos.linkMensagem(doc);
  ok(link === 'https://discord.com/channels/guild123/111/222', '2a: monta o link permanente da mensagem', link);
  ok(!/cdn\.discordapp/.test(link), '2b: não é o link do CDN');
  ok(!/[?&]ex=/.test(link), '2c: e não carrega parâmetro de expiração');

  const rotulo = anexos.rotuloComLink(doc);
  ok(rotulo === '[prova.png](https://discord.com/channels/guild123/111/222)', '2d: o rótulo dos autos usa esse link', rotulo);
  ok(anexos.rotuloComLink(doc, 'Mandado').startsWith('[Mandado]'), '2e: aceita rótulo customizado (o dossiê usa o tipo)');
}

console.log('\n3) Registro ANTIGO, sem o par, não exibe link morto');
// Os 29 documentos que já existem não têm canalId/mensagemId. O pior comportamento possível seria
// continuar mostrando a URL do CDN: o usuário clica, toma 404 e desconfia do sistema.
{
  const antigo = { nomeArquivo: 'image.png', url: 'https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc' };
  ok(anexos.linkMensagem(antigo) === null, '3a: sem o par, não há link a oferecer');
  const rotulo = anexos.rotuloComLink(antigo);
  ok(!/http/.test(rotulo), '3b: o rótulo NÃO cai de volta na url do CDN');
  ok(/indispon[íi]vel/i.test(rotulo), '3c: e diz por que não há link, em vez de fingir que está tudo bem');
}

console.log('\n4) Nenhum consumidor volta a exibir a url do anexo');
// Regressão barata de acontecer: basta alguém escrever `](${anexo.url})` num embed novo.
{
  const RAIZ = path.join(__dirname, '..');
  const CONSUMIDORES = ['utils/dossieJulgamento.js', 'commands/oficio.js', 'commands/medida.js'];
  const infratores = [];
  for (const f of CONSUMIDORES) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    // `](${...url})` é a assinatura de um link markdown apontando para a url do anexo.
    if (/\]\(\$\{[^}]*\.url[^}]*\}\)/.test(src)) infratores.push(f);
  }
  ok(infratores.length === 0, '4a: nenhum dos três pontos de consumo monta link com .url', infratores.join('; '));
  // CANÁRIO: se um desses arquivos for renomeado, readFileSync lança e o teste falha alto — mas se
  // a LISTA um dia for montada dinamicamente e vier vazia, o laço aprovaria sem ler nada. Teste
  // vazio dá confiança falsa, é pior que teste ausente.
  ok(CONSUMIDORES.length >= 3, '4z: a varredura tinha arquivos para varrer', `lista com ${CONSUMIDORES.length}`);

  const anexoPdf = fs.readFileSync(path.join(RAIZ, 'utils/anexoPdf.js'), 'utf-8');
  ok(/canalId/.test(anexoPdf) && /mensagemId/.test(anexoPdf), '4b: a coleta de anexo grava o par (a fábrica parou de produzir o defeito)');
  const contaPar = (anexoPdf.match(/mensagemId/g) || []).length;
  ok(contaPar >= 3, '4c: ...nos três caminhos de coleta (PDF, lote e coletarAnexoPdf)', `achei ${contaPar}`);
}

try { fs.unlinkSync(DB_TESTE); } catch (_) {}
try { fs.unlinkSync(`${DB_TESTE}.bak`); } catch (_) {}
console.log(`\n== Resumo: ${passes} passaram, ${falhas.length} falharam ==`);
if (falhas.length) { for (const f of falhas) console.log(`   ❌ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ''}`); process.exit(1); }
