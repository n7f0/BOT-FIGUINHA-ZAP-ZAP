FROM node:18-slim

# Instala dependências do sistema: ffmpeg e bibliotecas do Chromium
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Define o caminho do Chromium para o Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copia os arquivos de dependências e instala
COPY package*.json ./
RUN npm install

# Copia o resto do código
COPY . .

# Expõe a porta do servidor HTTP (usada pelo Railway)
EXPOSE 3000

# Comando para iniciar o bot
CMD ["node", "index.js"]
