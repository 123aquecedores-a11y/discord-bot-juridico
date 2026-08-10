// Caminho de volta da integração com a Polícia Civil: tudo que nasce de um requerimento externo
// deles (medida.codigoExterno preenchido por utils/integracaoPoliciaCivil.js) devolve pra lá via
// webhook — mandado (deferimento/indeferimento), ofício expedido por Delegado (a própria
// delegacia, sempre, independente de codigoExterno — é correspondência da instituição deles) e
// sentença de processo penal que nasceu daquela medida. Sem isso, o sistema deles nunca saberia
// o desfecho do que pediram.
// Módulo separado de integracaoPoliciaCivil.js de propósito: aquele precisa de commands/medida.js
// (pra criar a medida), e medida.js precisa deste aqui (pra mandar a devolutiva) — juntar os dois
// num módulo só criaria uma dependência circular entre medida.js e integracaoPoliciaCivil.js.
const config = require('../config');
const documentos = require('./documentos');
const db = require('../database/db');

// Webhook do Discord não aceita anexo de arquivo em corpo JSON puro — precisa ser
// multipart/form-data, com o JSON da mensagem no campo `payload_json` e o arquivo em `files[0]`.
// Sem PNG, mantém o POST simples de sempre.
async function postarNoWebhookPC({ username, embed, pngBuffer, pngNome }) {
  if (!config.webhookDevolutivaPoliciaCivilUrl) return;

  try {
    let res;
    if (pngBuffer) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ username, embeds: [embed] }));
      form.append('files[0]', new Blob([pngBuffer], { type: 'image/png' }), pngNome || 'documento.png');
      res = await fetch(config.webhookDevolutivaPoliciaCivilUrl, { method: 'POST', body: form });
    } else {
      res = await fetch(config.webhookDevolutivaPoliciaCivilUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, embeds: [embed] }),
      });
    }
    if (!res.ok) {
      console.error(`Envio pra Polícia Civil recusado pelo Discord: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error('Falha ao enviar pra Polícia Civil:', err.message);
  }
}

async function enviarDevolutivaMandado(medida, { decisao, fundamentacao, juizId, numeroMandado, pngBuffer }) {
  if (!medida.codigoExterno) return; // só devolve pra quem de fato pediu por ali

  // A descrição carrega o texto formal da sentença (mesmo padrão de qualquer outra decisão do
  // bot) — os campos abaixo só resumem o essencial pra leitura/parse rápido do lado deles.
  const embed = {
    title: '⚖️ Devolutiva — Decisão Judicial',
    color: decisao === 'Deferido' ? 0x2ecc71 : 0xe74c3c,
    description: documentos.textoSentencaMandado({
      medida, decisao, fundamentacao, numeroMandado, juizId, codigoExterno: medida.codigoExterno,
    }),
    fields: [
      { name: 'Protocolo de origem (PC)', value: medida.codigoExterno, inline: true },
      { name: 'Medida', value: medida.numero, inline: true },
      { name: 'Mandado', value: numeroMandado || '—', inline: true },
      { name: 'Decisão', value: decisao, inline: true },
    ],
    footer: { text: 'Tribunal — devolutiva automática' },
    timestamp: new Date().toISOString(),
  };

  await postarNoWebhookPC({ username: 'Tribunal — Devolutiva', embed, pngBuffer, pngNome: numeroMandado ? `Mandado-${numeroMandado}.png` : undefined });
}

// Ofício expedido por Delegado é correspondência da própria Polícia Civil — vai sempre pro
// webhook deles, independente de a medida/processo ter codigoExterno ou não (diferente da
// devolutiva de mandado, que só faz sentido devolver pra quem pediu por ali).
async function enviarOficioPoliciaCivil({ numero, destinatario, assunto, texto, pngBuffer }) {
  const embed = {
    title: `✉️ Ofício expedido — ${numero}`,
    color: 0x9b59b6,
    description: texto,
    fields: [
      { name: 'Destinatário', value: destinatario, inline: true },
      { name: 'Assunto', value: assunto, inline: true },
    ],
    footer: { text: 'Delegacia — cópia automática' },
    timestamp: new Date().toISOString(),
  };
  await postarNoWebhookPC({ username: 'Delegacia — Ofício', embed, pngBuffer, pngNome: `Oficio-${numero}.png` });
}

// Sentença de processo penal que nasceu de uma medida pedida pela Polícia Civil — fecha o ciclo
// (mandado → ofícios ao longo da instrução → desfecho do caso). Se o processo não vier de uma
// medida com codigoExterno, não há pra quem devolver, e a função só sai sem fazer nada.
async function enviarSentencaPoliciaCivil({ processo, texto, pngBuffer }) {
  if (!processo.medidaVinculada) return;
  const medida = db.buscarPorNumero('medidas', processo.medidaVinculada);
  if (!medida || !medida.codigoExterno) return;

  const embed = {
    title: `⚖️ Sentença — Processo ${processo.numero}`,
    color: 0x2c3e50,
    description: texto,
    fields: [
      { name: 'Protocolo de origem (PC)', value: medida.codigoExterno, inline: true },
      { name: 'Medida de origem', value: medida.numero, inline: true },
      { name: 'Resultado', value: processo.resultado || '—', inline: true },
    ],
    footer: { text: 'Tribunal — devolutiva automática' },
    timestamp: new Date().toISOString(),
  };
  await postarNoWebhookPC({ username: 'Tribunal — Sentença', embed, pngBuffer, pngNome: `Sentenca-${processo.numero}.png` });
}

module.exports = { enviarDevolutivaMandado, enviarOficioPoliciaCivil, enviarSentencaPoliciaCivil };
