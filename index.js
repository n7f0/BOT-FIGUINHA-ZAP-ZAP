/**
 * 🎴 Sticker Bot WhatsApp - com servidor HTTP para QR Code
 * 
 * - Envie qualquer imagem ou GIF → receba sticker com autor = seu nome no WhatsApp
 * - Acesse a URL gerada pela Railway para escanear o QR Code e autenticar
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const express = require('express');
const qrImage = require('qr-image');

const execPromise = util.promisify(exec);

// ========== CONFIGURAÇÕES ==========
const TAMANHO_STICKER = 512;
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// ========== VARIÁVEL PARA ARMAZENAR O QR CODE ==========
let ultimoQRCode = null;

// ========== SERVIDOR HTTP PARA EXIBIR QR CODE ==========
const app = express();
app.get('/', (req, res) => {
    if (ultimoQRCode) {
        const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr_svg);
    } else {
        res.send('📱 Ainda não há QR Code. Aguarde o bot iniciar...');
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP rodando na porta ${PORT}`));

// ========== CONFIGURAÇÃO DO PUPPETEER (MAIS ROBUSTA) ==========
const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain'
];

// Tenta usar Chromium do sistema se disponível (para Railway com nixpacks)
let executablePath = undefined;
if (process.platform === 'linux' && fs.existsSync('/usr/bin/google-chrome-stable')) {
    executablePath = '/usr/bin/google-chrome-stable';
    console.log('✅ Usando Chrome do sistema');
} else if (process.platform === 'linux' && fs.existsSync('/usr/bin/chromium')) {
    executablePath = '/usr/bin/chromium';
    console.log('✅ Usando Chromium do sistema');
} else {
    console.log('⚠️ Usando Chromium baixado pelo Puppeteer');
}

// ========== INICIALIZAÇÃO DO CLIENTE WHATSAPP ==========
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        executablePath: executablePath
    }
});

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado. Escaneie acessando a URL do seu serviço Railway.\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Envie qualquer imagem ou GIF.\n');
});

// ========== FUNÇÃO PARA OBTER NOME DO CONTATO ==========
async function obterNomeContato(msg) {
    try {
        const contato = await msg.getContact();
        return contato.pushname || contato.name || contato.number || msg.from.replace('@c.us', '');
    } catch {
        return msg.from.replace('@c.us', '');
    }
}

// ========== CONVERTER IMAGEM ESTÁTICA ==========
async function converterImagemEstatica(bufferImagem) {
    let imagem = sharp(bufferImagem);
    const metadata = await imagem.metadata().catch(() => null);
    if (!metadata) throw new Error('Formato não reconhecido');
    return await imagem
        .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 })
        .toBuffer();
}

// ========== CONVERTER GIF ==========
async function converterGifParaWebp(bufferGif) {
    const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.gif`);
    const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
    fs.writeFileSync(inputPath, bufferGif);
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libwebp -q:v 80 -vf "scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black" -loop 0 -vsync 0 "${outputPath}" -y`;
    try {
        await execPromise(ffmpegCmd);
        const outputBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;
    } catch (err) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw new Error(`Falha no ffmpeg: ${err.message}`);
    }
}

// ========== TRATAMENTO DE MENSAGENS ==========
client.on('message', async (msg) => {
    if (msg.body?.trim()?.startsWith('!')) return;
    if (!msg.hasMedia) return;

    try {
        const media = await msg.downloadMedia();
        if (!media || !media.data) throw new Error('Falha ao baixar');
        const bufferOriginal = Buffer.from(media.data, 'base64');
        const ehGif = media.mimetype === 'image/gif';

        const webpBuffer = ehGif
            ? await converterGifParaWebp(bufferOriginal)
            : await converterImagemEstatica(bufferOriginal);

        const nomeAutor = await obterNomeContato(msg);
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));

        await client.sendMessage(msg.from, sticker, {
            sendMediaAsSticker: true,
            stickerName: '',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Sticker enviado | Autor: ${nomeAutor} | GIF: ${ehGif}`);
    } catch (err) {
        console.error('Erro:', err.message);
        await msg.reply('❌ Não foi possível converter. Tente outra imagem ou GIF.');
    }
});

// ========== RECONEXÃO AUTOMÁTICA ==========
client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    setTimeout(() => client.initialize(), 10000);
});

// ========== TRATAMENTO DE ERRO DE BIBLIOTECAS ==========
client.on('error', (err) => {
    if (err.message && err.message.includes('libglib')) {
        console.error('❌ Faltam bibliotecas do sistema no Railway.');
        console.error('   Solução: crie um arquivo "nixpacks.toml" no repositório com as dependências necessárias.');
        console.error('   Consulte: https://docs.railway.app/guides/nixpacks');
    } else {
        console.error('Erro no cliente:', err);
    }
});

// ========== INICIAR ==========
client.initialize();
