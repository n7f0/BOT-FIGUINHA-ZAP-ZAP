/**
 * 🎴 Sticker Bot WhatsApp - Converte imagens, GIFs e VÍDEOS em figurinhas
 * 
 * - Envie qualquer imagem (JPG, PNG) → sticker estático
 * - Envie GIF animado → sticker animado
 * - Envie VÍDEO (MP4, MOV, etc.) → sticker animado (WebP)
 * - Autor da figurinha é automaticamente seu nome no WhatsApp
 * - Acesse a URL pública para escanear QR Code
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
const { execSync } = require('child_process');

// ========== CONFIGURAÇÕES ==========
const TAMANHO_STICKER = 512;
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// ========== SERVIDOR HTTP PARA QR CODE ==========
let ultimoQRCode = null;
const app = express();
app.get('/', (req, res) => {
    if (ultimoQRCode) {
        const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr_svg);
    } else {
        res.send('📱 QR Code ainda não gerado. Aguarde alguns segundos...');
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP rodando na porta ${PORT}`));

// ========== CRIA UM DIRETÓRIO DE PERFIL ÚNICO PARA ESTA EXECUÇÃO ==========
const uniqueProfileDir = path.join('/tmp', `chrome-profile-${Date.now()}`);
console.log(`📁 Criando perfil Chromium em: ${uniqueProfileDir}`);
fs.mkdirSync(uniqueProfileDir, { recursive: true });

// ========== ARGUMENTOS DO PUPPETEER ==========
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
    `--user-data-dir=${uniqueProfileDir}`,
    '--profile-directory=Default',
    '--disable-session-crashed-bubble',
    '--disable-features=LockProfileCookieDatabase',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-web-security',
    '--disable-features=ChromeWhatsNewUI'
];

let executablePath = undefined;
if (process.platform === 'linux') {
    if (fs.existsSync('/usr/bin/chromium')) {
        executablePath = '/usr/bin/chromium';
        console.log('✅ Usando Chromium do sistema');
    } else {
        console.log('⚠️ Chromium não encontrado, Puppeteer usará o baixado');
    }
}

// Verifica ffmpeg
try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    console.log('✅ ffmpeg encontrado');
} catch {
    console.warn('⚠️ ffmpeg não encontrado. Vídeos e GIFs podem falhar.');
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

// ========== EVENTOS ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado. Escaneie acessando a URL pública do Railway.\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Envie imagens, GIFs ou vídeos.\n');
});

// ========== FUNÇÕES AUXILIARES ==========
async function obterNomeContato(msg) {
    try {
        const contato = await msg.getContact();
        return contato.pushname || contato.name || contato.number || msg.from.replace('@c.us', '');
    } catch {
        return msg.from.replace('@c.us', '');
    }
}

async function converterImagemEstatica(buffer) {
    return await sharp(buffer)
        .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 })
        .toBuffer();
}

async function converterMidiaAnimada(inputBuffer, isVideo) {
    const ext = isVideo ? 'mp4' : 'gif';
    const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.${ext}`);
    const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
    fs.writeFileSync(inputPath, inputBuffer);

    const scaleFilter = `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black`;
    let cmd = `ffmpeg -i "${inputPath}" -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
    if (isVideo) {
        cmd = `ffmpeg -i "${inputPath}" -t 15 -r 15 -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
    }
    try {
        await execPromise(cmd);
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

function isVideo(mimeType) { return mimeType?.startsWith('video/'); }
function isGif(mimeType) { return mimeType === 'image/gif'; }

// ========== MENSAGENS ==========
client.on('message', async (msg) => {
    if (msg.body?.trim()?.startsWith('!')) return;
    if (!msg.hasMedia) return;
    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Arquivo recebido: ${mimeType}`);

        let webpBuffer;
        if (isVideo(mimeType)) {
            console.log('🎬 Convertendo vídeo...');
            webpBuffer = await converterMidiaAnimada(buffer, true);
        } else if (isGif(mimeType)) {
            console.log('🎞️ Convertendo GIF...');
            webpBuffer = await converterMidiaAnimada(buffer, false);
        } else {
            console.log('🖼️ Convertendo imagem...');
            webpBuffer = await converterImagemEstatica(buffer);
        }

        const nomeAutor = await obterNomeContato(msg);
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));
        await client.sendMessage(msg.from, sticker, {
            sendMediaAsSticker: true,
            stickerName: '',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Sticker enviado | Autor: ${nomeAutor} | Tipo: ${isVideo(mimeType) ? 'vídeo' : isGif(mimeType) ? 'GIF' : 'imagem'}`);
    } catch (err) {
        console.error('❌ Erro:', err.message);
        await msg.reply('❌ Não foi possível converter. Tente outro arquivo (imagem, GIF ou vídeo curto).');
    }
});

client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    setTimeout(() => client.initialize(), 10000);
});

client.on('error', (err) => console.error('Erro no cliente:', err));

client.initialize();
console.log('🚀 Iniciando bot conversor de figurinhas...');
