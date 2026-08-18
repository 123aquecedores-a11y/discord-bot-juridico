/* eslint-disable */
// ETAPA 1 DA RECUPERAÇÃO — RELATÓRIO, NÃO ESCREVE NADA. Rode com:
//   node scripts/recuperar-anexos-relatorio.js
//
// Os documentos gravados antes de 18/08/2026 guardaram só a URL do CDN, que expira em 24h, e não o
// par canalId+mensagemId. As mensagens de upload continuam nos canais — a regra do projeto é nunca
// apagá-las — então dá para reconstruir o vínculo procurando, no canal do processo, a mensagem que
// tem um anexo com aquele nome.
//
// Este script SÓ LÊ. Ele não grava uma linha no banco. A aplicação é a Etapa 2, separada, e só
// depois que este relatório for conferido.
//
// Usa a API REST, NÃO o gateway: abrir uma sessão de gateway com o mesmo token derrubaria o bot
// que está em produção. REST é só requisição, não disputa sessão.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const db = require('../database/db');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN não configurado.'); process.exit(1); }

const TERMINAIS = {
  processos: ['Encerrado', 'Arquivado', 'Arquivado sem julgamento de mérito'],
  peticoes: ['Deferido', 'Indeferido', 'Vencido', 'Arquivada'],
  medidas: ['Deferida', 'Negada', 'Indeferida pelo Juiz', 'Arquivada'],
  mandados: ['Cumprido', 'Arquivado'],
  oficios: ['Cumprido', 'Arquivado'],
};

function acharRegistro(protocolo) {
  for (const tabela of Object.keys(TERMINAIS)) {
    const r = db.buscarPorNumero(tabela, protocolo);
    if (r) return { tabela, r, aberto: !TERMINAIS[tabela].includes(r.status) };
  }
  return null;
}

const expirado = (url) => {
  const m = String(url || '').match(/[?&]ex=([0-9a-f]+)/);
  return m ? parseInt(m[1], 16) * 1000 < Date.now() : false;
};

const rest = new REST({ version: '10' }).setToken(TOKEN);

// Histórico completo do canal, paginado de 100 em 100. Só leitura.
async function lerCanal(canalId, cache) {
  if (cache.has(canalId)) return cache.get(canalId);
  const todas = [];
  let antes = null;
  try {
    for (let pagina = 0; pagina < 40; pagina++) { // teto de 4000 mensagens por canal
      const lote = await rest.get(Routes.channelMessages(canalId), {
        query: new URLSearchParams({ limit: '100', ...(antes ? { before: antes } : {}) }),
      });
      if (!lote.length) break;
      todas.push(...lote);
      antes = lote[lote.length - 1].id;
      if (lote.length < 100) break;
    }
  } catch (e) {
    cache.set(canalId, { erro: e.message, mensagens: [] });
    return cache.get(canalId);
  }
  const resultado = { erro: null, mensagens: todas };
  cache.set(canalId, resultado);
  return resultado;
}

(async () => {
  const docs = db.todos('documentosAnexados').filter(d => d.url && !d.canalId);
  const mortos = docs.filter(d => expirado(d.url));
  console.log(`documentos sem o par canal+mensagem: ${docs.length}  |  com link já morto: ${mortos.length}\n`);

  const cache = new Map();
  const linhas = [];

  for (const doc of mortos) {
    const achado = acharRegistro(doc.protocoloVinculado);
    const canalId = achado && achado.r.canalId;
    const base = {
      id: doc.id, tipo: doc.tipo, nome: doc.nomeArquivo, protocolo: doc.protocoloVinculado,
      caso: achado ? `${achado.tabela}/${achado.r.numero}` : '(não encontrado)',
      aberto: achado ? achado.aberto : false,
      enviadoEm: doc.dataEnvio, autorId: doc.autorId,
    };
    if (!canalId) { linhas.push({ ...base, veredito: 'SEM CANAL', candidatos: [] }); continue; }

    const { erro, mensagens } = await lerCanal(canalId, cache);
    if (erro) { linhas.push({ ...base, veredito: 'ERRO AO LER', detalhe: erro, candidatos: [] }); continue; }

    // Candidata = mensagem com anexo de mesmo nome.
    let candidatos = mensagens
      .filter(m => (m.attachments || []).some(a => a.filename === doc.nomeArquivo))
      .map(m => ({ id: m.id, autor: m.author && m.author.id, em: m.timestamp }));

    // Desempate por autor e proximidade de data — é o que separa os seis `image.png`.
    if (candidatos.length > 1 && doc.autorId) {
      const doAutor = candidatos.filter(c => c.autor === doc.autorId);
      if (doAutor.length) candidatos = doAutor;
    }
    if (candidatos.length > 1 && doc.dataEnvio) {
      const alvo = new Date(doc.dataEnvio).getTime();
      candidatos = candidatos.slice().sort((a, b) => Math.abs(new Date(a.em) - alvo) - Math.abs(new Date(b.em) - alvo));
      const maisProximo = Math.abs(new Date(candidatos[0].em) - alvo);
      // Menos de 2 minutos de diferença e o segundo bem mais longe: é o mesmo upload.
      if (maisProximo < 120000 && Math.abs(new Date(candidatos[1].em) - alvo) > 600000) candidatos = [candidatos[0]];
    }

    const veredito = candidatos.length === 0 ? 'NAO ENCONTRADO' : (candidatos.length === 1 ? 'unico' : 'AMBIGUO');
    linhas.push({ ...base, veredito, candidatos });
  }

  const larg = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
  console.log(larg('veredito', 16) + larg('caso', 18) + larg('aberto', 8) + larg('tipo', 20) + 'arquivo');
  console.log('-'.repeat(110));
  const ordem = { 'AMBIGUO': 0, 'NAO ENCONTRADO': 1, 'SEM CANAL': 2, 'ERRO AO LER': 3, 'unico': 4 };
  for (const l of linhas.slice().sort((a, b) => (a.aberto === b.aberto ? 0 : a.aberto ? -1 : 1) || ordem[a.veredito] - ordem[b.veredito])) {
    console.log(larg(l.veredito, 16) + larg(l.caso, 18) + larg(l.aberto ? 'ABERTO' : 'fechado', 8) + larg(l.tipo, 20) + l.nome);
    if (l.veredito === 'AMBIGUO') {
      for (const c of l.candidatos) console.log(`${' '.repeat(16)}candidato: msg ${c.id} | autor ${c.autor} | ${c.em}`);
    }
  }

  const cont = linhas.reduce((a, l) => { a[l.veredito] = (a[l.veredito] || 0) + 1; return a; }, {});
  console.log('\nresumo:', Object.entries(cont).map(([k, v]) => `${k}=${v}`).join('  '));
  const emAberto = linhas.filter(l => l.aberto);
  console.log(`em caso aberto: ${emAberto.length} | destes, recuperáveis sem decisão humana: ${emAberto.filter(l => l.veredito === 'unico').length}`);

  const saida = path.join(__dirname, '..', 'recuperacao-anexos.json');
  fs.writeFileSync(saida, JSON.stringify(linhas, null, 2));
  console.log(`\nrelatório completo em ${saida}`);
  console.log('NADA foi gravado no banco. A aplicação é a Etapa 2, depois deste relatório ser aprovado.');
})();
