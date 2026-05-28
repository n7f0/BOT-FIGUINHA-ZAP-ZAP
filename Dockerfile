FROM node:18-slim

# Instala as dependências do sistema: ffmpeg e chromium (necessário para o whatsapp-web.js)
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    chromium \
    && apt-get clean

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos do projeto e instala as dependências Node.js
COPY package*.json ./
RUN npm install

# Copia o resto do código
COPY . .

# Comando para iniciar o bot
CMD ["node", "bot.js"]
