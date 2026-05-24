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

// 👇 COLOQUE AQUI O ID DO SEU CANAL (obtido via comando !listar_canais)
const ID_DO_CANAL = '000000000000000000@newsletter'; // SUBSTITUA PELO ID REAL

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

// ========== PERFIL EFÊMERO DO CHROMIUM ==========
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

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: puppeteerArgs, executablePath, defaultViewport: { width: 1280, height: 720 } }
});

client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('📱 QR Code gerado. Escaneie pela URL pública.');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ Bot ONLINE! Enviando figurinhas para o canal...');
    console.log(`📢 Canal configurado: ${ID_DO_CANAL}`);
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

async function converterVideoParaSticker(buffer) {
    const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.mp4`);
    const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
    fs.writeFileSync(inputPath, buffer);
    const scaleFilter = `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black`;
    const cmd = `ffmpeg -i "${inputPath}" -t 15 -r 15 -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
    try {
        await execPromise(cmd);
        const outputBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;
    } catch (err) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw new Error(`Falha na conversão do vídeo: ${err.message}`);
    }
}

function isVideo(mimeType) { return mimeType?.startsWith('video/'); }

// ========== COMANDO PARA LISTAR CANAIS (use uma única vez) ==========
client.on('message', async (msg) => {
    if (msg.body === '!listar_canais') {
        const chats = await client.getChats();
        let resposta = "📢 Canais encontrados:\n";
        for (const chat of chats) {
            if (chat.isChannel) {
                resposta += `- Nome: ${chat.name} | ID: ${chat.id._serialized}\n`;
            }
        }
        await msg.reply(resposta || "Nenhum canal encontrado.");
        return;
    }

    // Processa mídia enviada para o bot
    if (!msg.hasMedia) return;
    if (ID_DO_CANAL === '000000000000000000@newsletter') {
        await msg.reply('⚠️ Canal não configurado. Use !listar_canais para obter o ID e depois atualize o código.');
        return;
    }

    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Recebido: ${mimeType} (${buffer.length} bytes)`);

        let webpBuffer;
        if (isVideo(mimeType)) {
            console.log('🎬 Convertendo vídeo para sticker animado...');
            webpBuffer = await converterVideoParaSticker(buffer);
        } else {
            console.log('🖼️ Convertendo imagem...');
            webpBuffer = await converterImagemEstatica(buffer);
        }

        const nomeAutor = await obterNomeContato(msg);
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));
        console.log(`📦 Sticker gerado: ${(webpBuffer.length / 1024).toFixed(2)} KB`);

        await client.sendMessage(ID_DO_CANAL, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        await msg.reply(`✅ Sua figurinha foi publicada no canal! Autor: ${nomeAutor}`);
        console.log(`✅ Publicado no canal por ${nomeAutor}`);
    } catch (err) {
        console.error('❌ Erro:', err.message);
        await msg.reply('❌ Falha ao converter. Tente outro arquivo (curto, MP4).');
    }
});

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
