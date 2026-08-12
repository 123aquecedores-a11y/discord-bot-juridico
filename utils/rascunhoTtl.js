// Map com expiração real — usado pelos rascunhos de fundamentação do fluxo "revisão-in-flow"
// (sentença, parecer, acórdão, razões, medida). O usuário pode submeter o modal e abandonar sem
// clicar em publicar/enviar; sem TTL, essas entradas ficariam para sempre em memória e a mensagem
// "a prévia expirou" seria mentira. A expiração é preguiçosa (checada no get), sem timer de fundo.
// API compatível com Map no que os chamadores usam: set/get/delete/has.
const TTL_PADRAO_MS = 20 * 60 * 1000; // 20 min — folga sobre a janela de 15 min do token da interação

class RascunhoTTL {
  constructor(ttlMs = TTL_PADRAO_MS) {
    this.ttl = ttlMs;
    this.map = new Map();
  }

  set(chave, valor) {
    this.map.set(chave, { valor, exp: Date.now() + this.ttl });
    return this;
  }

  get(chave) {
    const entrada = this.map.get(chave);
    if (!entrada) return undefined;
    if (Date.now() > entrada.exp) { this.map.delete(chave); return undefined; }
    return entrada.valor;
  }

  delete(chave) {
    return this.map.delete(chave);
  }

  has(chave) {
    return this.get(chave) !== undefined;
  }
}

module.exports = { RascunhoTTL };
