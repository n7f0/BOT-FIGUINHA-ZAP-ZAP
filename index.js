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

// ⚠️ SUBSTITUA PELOS IDs REAIS (obtenha com !listar_grupos e !listar_canais)
const GRUPO_ID = '000000000000000000@g.us';   // ID do grupo onde você enviará as imagens
const CANAL_ID = '000000000000000000@newsletter'; // ID do canal onde as figurinhas serão publicadas

// ========== SERVIDOR HTTP (QR CODE) ==========
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

// ========== PERFIL EFÊMERO DO CHROMIUM (EVITA LOCK) ==========
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
    console.log('📱 QR Code gerado. Escaneie pela URL pública.');
    qrcode.generate(qr, { small: true });
});

// ========== BOT PRONTO ==========
client.on('ready', async () => {
    console.log('✅ Bot ONLINE!');
    console.log(`👥 Grupo monitorado: ${GRUPO_ID}`);
    console.log(`📢 Canal de destino: ${CANAL_ID}`);
    console.log('⚠️ Verifique se o bot é ADMIN no grupo (para apagar mensagens) e no canal (para publicar).');
});

// ========== COMANDOS PARA OBTER IDs (use uma única vez, depois comente) ==========
client.on('message', async (msg) => {
    if (msg.body === '!listar_grupos') {
        const chats = await client.getChats();
        let resposta = "👥 Grupos que o bot participa:\n";
        for (const chat of chats) {
            if (chat.isGroup) resposta += `- ${chat.name} | ID: ${chat.id._serialized}\n`;
        }
        await msg.reply(resposta);
    }
    else if (msg.body === '!listar_canais') {
        const chats = await client.getChats();
        let resposta = "📢 Canais que o bot participa:\n";
        for (const chat of chats) {
            if (chat.isChannel) resposta += `- ${chat.name} | ID: ${chat.id._serialized}\n`;
        }
        await msg.reply(resposta);
    }
});

// ========== PROCESSAMENTO PRINCIPAL ==========
client.on('message', async (msg) => {
    // Só processa mensagens com mídia, no grupo específico
    if (!msg.hasMedia) return;
    if (msg.from !== GRUPO_ID) return; // ignora outros chats

    try {
        // 1. Baixar a mídia
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Mídia recebida no grupo: ${mimeType} (${buffer.length} bytes)`);

        // 2. Converter para sticker
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

        // 3. Obter nome do remetente
        const contato = await msg.getContact();
        const nomeAutor = contato.pushname || contato.name || 'Usuário';

        // 4. Enviar sticker para o canal
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));
        await client.sendMessage(CANAL_ID, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha de ${nomeAutor} enviada para o canal.`);

        // 5. Apagar a mensagem original do grupo (imagem ou vídeo)
        await msg.delete(true); // true = apagar para todos
        console.log(`🗑️ Mensagem original apagada do grupo (remetente: ${nomeAutor})`);

        // (Opcional) Enviar uma confirmação rápida que desaparece
        // const confirm = await client.sendMessage(GRUPO_ID, `✅ Figurinha de ${nomeAutor} publicada.`);
        // setTimeout(() => confirm.delete(true), 4000);
    } catch (err) {
        console.error('❌ Erro ao processar mídia:', err.message);
        // Em caso de erro, NÃO apaga a mensagem original para não perder o arquivo
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
