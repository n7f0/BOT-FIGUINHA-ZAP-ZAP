FROM node:18-slim

# Instala ffmpeg e Chromium
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Define o caminho do Chromium para o Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copia package.json e instala dependências
COPY package*.json ./
RUN npm install

# Copia o resto do código
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
