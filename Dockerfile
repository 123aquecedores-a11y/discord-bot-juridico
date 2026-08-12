# Imagem de produção pro Railway. O builder Nixpacks padrão NÃO traz as bibliotecas de sistema
# que o Chromium headless precisa, então a geração de PNG (sentença, ofício, mandado, intimação)
# falharia com "Failed to launch the browser process". Aqui o Chromium vem do apt (que resolve
# TODAS as dependências de sistema sozinho) e o Puppeteer é apontado pra ele — sem baixar um
# segundo Chromium no npm install.
FROM node:22-slim

# chromium + fontes (inclui emoji, usado em alguns documentos). O apt puxa as libs do Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Não baixar o Chromium do Puppeteer (usamos o do apt) e dizer ao código onde ele está.
# services/gerarDocumentoPNG.js lê PUPPETEER_EXECUTABLE_PATH ao subir o browser.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Instala as dependências primeiro (camada cacheável). package-lock.json existe → npm ci.
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o resto do código (o .dockerignore exclui node_modules, .env, dados.json, .git).
COPY . .

# O banco vive no volume persistente do Railway (DADOS_JSON_PATH=/data/dados.json) — ver runbook.
CMD ["node", "index.js"]
