/**
 * 🎴 Sticker Bot WhatsApp - com servidor HTTP para QR Code
 * 
 * - Envie qualquer imagem estática (JPG, PNG, WebP) → sticker estático
 * - Envie GIF animado → sticker animado
 * - Envie VÍDEO (MP4, MOV, AVI, etc.) → sticker animado (convertido para WebP)
 * - O autor da figurinha é automaticamente seu nome no WhatsApp
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

// ========== ARGUMENTOS AVANÇADOS DO PUPPETEER ==========
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
    '--use-mock-keychain',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let executablePath = undefined;
if (process.platform === 'linux') {
    if (fs.existsSync('/usr/bin/google-chrome-stable')) {
        executablePath = '/usr/bin/google-chrome-stable';
        console.log('✅ Usando Google Chrome do sistema');
    } else if (fs.existsSync('/usr/bin/chromium')) {
        executablePath = '/usr/bin/chromium';
        console.log('✅ Usando Chromium do sistema');
    }
}

// ========== CLIENTE WHATSAPP ==========
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        executablePath: executablePath,
        defaultViewport: { width: 1280, height: 720 }
    }
});

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado. Escaneie acessando a URL do serviço Railway.\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Envie qualquer imagem, GIF ou vídeo.\n');
});

// ========== OBTER NOME DO CONTATO ==========
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

// ========== CONVERTER GIF OU VÍDEO PARA WEBP ANIMADO ==========
async function converterVideoOuGifParaWebp(inputBuffer, entradaEhVideo) {
    const inputExt = entradaEhVideo ? 'mp4' : 'gif';
    const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.${inputExt}`);
    const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
    
    fs.writeFileSync(inputPath, inputBuffer);
    
    // Filtro para redimensionar, manter proporção e centralizar
    const scaleFilter = `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black`;
    
    // Comando ffmpeg: entrada -> codec webp, loop infinito, qualidade 80
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
    
    try {
        await execPromise(ffmpegCmd);
        const outputBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;
    } catch (err) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw new Error(`Falha na conversão: ${err.message}`);
    }
}

// ========== DETECTAR TIPO DE MÍDIA ==========
function isVideo(mimeType) {
    return mimeType.startsWith('video/');
}

function isGif(mimeType) {
    return mimeType === 'image/gif';
}

// ========== TRATAMENTO DE MENSAGENS ==========
client.on('message', async (msg) => {
    if (msg.body?.trim()?.startsWith('!')) return;
    if (!msg.hasMedia) return;

    try {
        const media = await msg.downloadMedia();
        if (!media || !media.data) throw new Error('Falha ao baixar');
        
        const bufferOriginal = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        const ehVideo = isVideo(mimeType);
        const ehGif = isGif(mimeType);
        
        let webpBuffer;
        if (ehVideo || ehGif) {
            console.log(`🎬 Convertendo ${ehVideo ? 'vídeo' : 'GIF'} para sticker animado...`);
            webpBuffer = await converterVideoOuGifParaWebp(bufferOriginal, ehVideo);
        } else {
            console.log('🖼️ Convertendo imagem estática...');
            webpBuffer = await converterImagemEstatica(bufferOriginal);
        }

        const nomeAutor = await obterNomeContato(msg);
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));

        await client.sendMessage(msg.from, sticker, {
            sendMediaAsSticker: true,
            stickerName: '',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Sticker enviado | Autor: ${nomeAutor} | Tipo: ${ehVideo ? 'vídeo' : ehGif ? 'GIF' : 'imagem'}`);
    } catch (err) {
        console.error('Erro:', err.message);
        await msg.reply('❌ Não foi possível converter essa mídia. Tente outro arquivo (imagem, GIF ou vídeo curto).');
    }
});

// ========== RECONEXÃO AUTOMÁTICA ==========
client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    setTimeout(() => client.initialize(), 10000);
});

client.on('error', (err) => {
    if (err.message && err.message.includes('libglib')) {
        console.error('❌ Faltam bibliotecas do sistema. Verifique o arquivo nixpacks.toml.');
    } else {
        console.error('Erro no cliente:', err);
    }
});

client.initialize();
console.log('🚀 Iniciando bot conversor de imagens, GIFs e vídeos...');
