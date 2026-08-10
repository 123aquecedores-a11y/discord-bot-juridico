const db = require('../database/db');
const andamentos = require('./andamentos');
const { parseCriadoEm } = require('./data');

function paraData(str) {
  if (!str) return null;
  const data = str.includes('T') ? new Date(str) : parseCriadoEm(str);
  if (!data || isNaN(data.getTime())) return null;
  data.setMilliseconds(0);
  return data;
}

function formatarDataHora(str) {
  const data = paraData(str);
  if (!data) return null;
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function evento({ data, titulo, detalhe }) {
  return { data, dataFormatada: formatarDataHora(data), titulo, detalhe };
}

// Autos Digitais — historicoDoProcesso deixou de reconstruir a narrativa varrendo tabelas soltas
// (medidas, mandados, oficios, habilitacoes, apelacoes) toda vez que alguém clica. Agora é só uma
// leitura de andamentos.doProcesso(numero), que já vem gravado e ordenado no momento de cada ato.
function historicoDoProcesso(numeroProcesso) {
  const processo = db.buscarPorNumero('processos', numeroProcesso);
  if (!processo) return null;

  const eventos = andamentos.doProcesso(numeroProcesso).map(a => evento({ data: a.criadoEm, titulo: a.titulo, detalhe: a.detalhe }));

  return { processo, medidaOrigem: null, eventos };
}

module.exports = { historicoDoProcesso };
