# Usa uma imagem base do Node.js completa, que já tem as ferramentas de compilação
FROM node:18-slim

# Instala o FFmpeg e as bibliotecas essenciais para o Chromium
# O comando "--no-install-recommends" e a limpeza final ajudam a reduzir o tamanho da imagem.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Define a variável de ambiente que indica ao Puppeteer onde encontrar o Chromium do sistema
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de manifesto do npm e instala as dependências do Node.js
COPY package*.json ./
RUN npm install

# Copia todo o código fonte do seu bot para dentro do container
COPY . .

# Expõe a porta 3000 para o servidor HTTP de exibição do QR Code
EXPOSE 3000

# Comando padrão para iniciar o bot
CMD ["node", "index.js"]
