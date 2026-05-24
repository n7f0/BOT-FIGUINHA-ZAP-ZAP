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

// ⚠️ Configure abaixo o ID do seu canal (será preenchido automaticamente ou manualmente)
let CHANNEL_ID = null;

// ========== SERVIDOR HTTP PARA QR CODE (opcional, mas útil) ==========
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

// ========== PERFIL EFÊMERO DO CHROMIUM (RESOLVE O LOCK) ==========
const profileDir = `/tmp/chrome-profile-${Date.now()}`;
fs.mkdirSync(profileDir, { recursive: true });
console.log(`📁 Perfil Chromium: ${profileDir}`);

const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    `--user-data-dir=${profileDir}`,
    '--disable-session-crashed-bubble',
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

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('📱 QR Code gerado. Escaneie pela URL pública ou no terminal.');
    qrcode.generate(qr, { small: true });
});

// ========== BOT PRONTO ==========
client.on('ready', async () => {
    console.log('✅ Bot ONLINE! Aguardando mídias para enviar ao canal...');

    // Tenta obter o ID do canal automaticamente (caso o bot já participe do canal)
    const chats = await client.getChats();
    for (const chat of chats) {
        if (chat.isChannel && chat.name && chat.name.toLowerCase().includes('figurinha')) {
            CHANNEL_ID = chat.id._serialized;
            console.log(`📢 Canal encontrado automaticamente: ${chat.name} -> ID: ${CHANNEL_ID}`);
            break;
        }
    }
    if (!CHANNEL_ID) {
        console.log('⚠️ Canal não identificado automaticamente. Use o comando !listar_canais para obter o ID.');
    }
});

// ========== COMANDO PARA LISTAR CANAIS (USE UMA ÚNICA VEZ) ==========
client.on('message', async (msg) => {
    if (msg.body === '!listar_canais') {
        const chats = await client.getChats();
        let resposta = "📢 Canais disponíveis:\n";
        for (const chat of chats) {
            if (chat.isChannel) {
                resposta += `- Nome: ${chat.name} | ID: ${chat.id._serialized}\n`;
            }
        }
        await msg.reply(resposta || "Nenhum canal encontrado.");
        return;
    }

    // Ignora comandos e mensagens sem mídia
    if (msg.body?.startsWith('!')) return;
    if (!msg.hasMedia) return;

    if (!CHANNEL_ID) {
        await msg.reply('⚠️ Canal não configurado. Use o comando !listar_canais e depois atualize o código com o ID correto.');
        return;
    }

    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Recebido: ${mimeType} (${buffer.length} bytes)`);

        let webpBuffer;
        if (mimeType.startsWith('video/')) {
            console.log('🎬 Convertendo vídeo para sticker animado...');
            const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.mp4`);
            const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
            fs.writeFileSync(inputPath, buffer);
            const scaleFilter = `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black`;
            const cmd = `ffmpeg -i "${inputPath}" -t 15 -r 15 -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
            await execPromise(cmd);
            webpBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        } else {
            console.log('🖼️ Convertendo imagem estática...');
            webpBuffer = await sharp(buffer)
                .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
                .webp({ quality: 80 })
                .toBuffer();
        }

        const nomeAutor = (await msg.getContact()).pushname || 'Usuário';
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));
        console.log(`📦 Sticker gerado: ${(webpBuffer.length / 1024).toFixed(2)} KB`);

        await client.sendMessage(CHANNEL_ID, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        await msg.reply(`✅ Sua figurinha foi publicada no canal!\nAutor: ${nomeAutor}`);
        console.log(`✅ Publicado no canal por ${nomeAutor}`);
    } catch (err) {
        console.error('❌ Erro:', err.message);
        await msg.reply('❌ Falha ao converter. Tente outro arquivo (imagem ou vídeo curto).');
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
