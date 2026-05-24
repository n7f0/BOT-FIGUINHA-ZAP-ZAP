/**
 * 🎴 Sticker Bot WhatsApp - Envio automático para canal
 * 
 * - Envie qualquer imagem, GIF ou vídeo para o bot
 * - Ele converte em figurinha (sticker) e publica no canal
 * - Autor da figurinha = nome da pessoa no WhatsApp
 * - Acesse a URL pública para escanear o QR Code
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

// ========== ID DO CANAL (preenchido automaticamente ou manualmente) ==========
let channelId = null;
const CANAL_INVITE_CODE = '0029VbCavfI4yltXyM8WUF1W'; // código do link fornecido

// ========== SERVIDOR HTTP ==========
let ultimoQRCode = null;
const app = express();
app.get('/', (req, res) => {
    if (ultimoQRCode) {
        const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr_svg);
    } else {
        res.send('📱 QR Code ainda não gerado. Aguarde...');
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL EFÊMERO DO CHROMIUM (evita lock) ==========
const profileDir = `/tmp/chrome-profile-${Date.now()}`;
fs.mkdirSync(profileDir, { recursive: true });
console.log(`📁 Perfil Chromium: ${profileDir}`);

const puppeteerArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--hide-scrollbars',
    '--no-default-browser-check', '--password-store=basic',
    `--user-data-dir=${profileDir}`, '--disable-session-crashed-bubble',
    '--disable-features=LockProfileCookieDatabase'
];

let executablePath = undefined;
if (process.platform === 'linux' && fs.existsSync('/usr/bin/chromium')) {
    executablePath = '/usr/bin/chromium';
    console.log('✅ Usando Chromium do sistema');
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
    puppeteer: { headless: true, args: puppeteerArgs, executablePath, defaultViewport: { width: 1280, height: 720 } }
});

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('📱 QR Code gerado. Escaneie pela URL pública.');
    qrcode.generate(qr, { small: true });
});

// ========== EVENTO DE PRONTO ==========
client.on('ready', async () => {
    console.log('✅ Bot ONLINE! Aguardando mídias para enviar ao canal...');
    
    // Tenta obter o ID do canal automaticamente
    if (!channelId) {
        console.log('🔍 Obtendo ID do canal a partir do código de convite...');
        try {
            const channel = await client.getChannelByInviteCode(CANAL_INVITE_CODE);
            if (channel && channel.id) {
                channelId = channel.id._serialized;
                console.log(`✅ Canal encontrado! ID: ${channelId}`);
                console.log(`📢 Nome do canal: ${channel.name || 'não informado'}`);
            } else {
                console.error('❌ Não foi possível encontrar o canal. Verifique se o bot está inscrito.');
            }
        } catch (err) {
            console.error('❌ Erro ao obter canal:', err.message);
        }
    }
});

// ========== FUNÇÕES DE CONVERSÃO ==========
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
    console.log(`🔧 ffmpeg: ${cmd}`);
    try {
        const { stderr } = await execPromise(cmd);
        if (stderr) console.log('📢 ffmpeg stderr:', stderr.substring(0, 300));
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

// ========== TRATAMENTO DE MENSAGENS ==========
client.on('message', async (msg) => {
    // Ignora comandos
    if (msg.body?.trim()?.startsWith('!')) return;
    if (!msg.hasMedia) return;
    if (!channelId) {
        console.warn('⚠️ Canal ainda não identificado. Aguarde o bot obter o ID.');
        return;
    }

    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Recebido: ${mimeType} (${buffer.length} bytes)`);

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
        console.log(`📦 Sticker gerado: ${(webpBuffer.length / 1024).toFixed(2)} KB`);

        // Envia para o canal
        await client.sendMessage(channelId, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        
        // Confirma para o remetente
        await msg.reply(`✅ Sua figurinha foi enviada para o canal! Autor: ${nomeAutor}`);
        console.log(`✅ Sticker de "${nomeAutor}" publicado no canal.`);
    } catch (err) {
        console.error('❌ Erro:', err.message);
        await msg.reply('❌ Não foi possível converter. Tente outro arquivo (vídeo curto, MP4).');
    }
});

// ========== RECONEXÃO ==========
client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    setTimeout(() => client.initialize(), 10000);
});

client.on('error', (err) => console.error('Erro no cliente:', err));

process.on('exit', () => {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
});

client.initialize();
console.log('🚀 Bot iniciado. Aguarde o QR Code...');