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

// ========== CONFIGURAÇÕES (SUBSTITUA PELOS IDs REAIS) ==========
const TAMANHO_STICKER = 512;
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// ⚠️ VOCÊ DEVE PREENCHER ESTES IDs (obtenha pelos logs do bot na primeira execução)
const GRUPO_ID = '120363428035302666@g.us';    // ID do grupo onde as imagens serão enviadas
const CANAL_ID = '000000000000000000@newsletter'; // ID do canal público

// ========== SERVIDOR HTTP PARA QR CODE (OBRIGATÓRIO NA RAILWAY) ==========
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

// ========== PERFIL EFÊMERO DO CHROMIUM (EVITA "PROFILE LOCK") ==========
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

// ========== BOT PRONTO – LISTA GRUPOS E CANAIS NOS LOGS ==========
client.on('ready', async () => {
    console.log('\n✅ Bot ONLINE!');
    console.log('📋 Listando todos os grupos e canais que o bot participa:\n');
    const chats = await client.getChats();
    for (const chat of chats) {
        if (chat.isGroup) {
            console.log(`👥 GRUPO -> Nome: ${chat.name} | ID: ${chat.id._serialized}`);
        } else if (chat.isChannel) {
            console.log(`📢 CANAL -> Nome: ${chat.name} | ID: ${chat.id._serialized}`);
        }
    }
    console.log('\n⚠️ Copie os IDs acima e cole no código (GRUPO_ID e CANAL_ID)');
    console.log(`👥 Grupo configurado: ${GRUPO_ID}`);
    console.log(`📢 Canal configurado: ${CANAL_ID}`);
});

// ========== FUNÇÃO DE CONVERSÃO (IMAGEM OU VÍDEO) ==========
async function converterParaSticker(buffer, mimeType) {
    if (mimeType.startsWith('video/')) {
        const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.mp4`);
        const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
        fs.writeFileSync(inputPath, buffer);
        const scaleFilter = `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black`;
        const cmd = `ffmpeg -i "${inputPath}" -t 15 -r 15 -c:v libwebp -q:v 80 -vf "${scaleFilter}" -loop 0 -vsync 0 "${outputPath}" -y`;
        await execPromise(cmd);
        const outputBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;
    } else {
        return await sharp(buffer)
            .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
            .webp({ quality: 80 })
            .toBuffer();
    }
}

// ========== PROCESSAMENTO DE MENSAGENS NO GRUPO ==========
client.on('message', async (msg) => {
    // Ignora mensagens enviadas pelo próprio bot (evita loop)
    if (msg.fromMe) return;
    // Só processa se for no grupo específico
    if (msg.from !== GRUPO_ID) return;
    // Só processa se tiver mídia
    if (!msg.hasMedia) return;

    console.log(`🔔 Nova mídia no grupo: ${msg.id._serialized} - ${msg.author || 'alguém'}`);

    try {
        // 1. Baixar a mídia
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        console.log(`📁 Arquivo: ${mimeType} (${buffer.length} bytes)`);

        // 2. Converter para sticker
        const webpBuffer = await converterParaSticker(buffer, mimeType);
        console.log(`📦 Sticker gerado: ${(webpBuffer.length / 1024).toFixed(2)} KB`);

        // 3. Obter nome do autor
        const contato = await msg.getContact();
        const nomeAutor = contato.pushname || contato.name || contato.number || 'Usuário';

        // 4. Criar objeto sticker
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));

        // 5. Enviar sticker para o canal público
        if (CANAL_ID && CANAL_ID !== '000000000000000000@newsletter') {
            await client.sendMessage(CANAL_ID, sticker, {
                sendMediaAsSticker: true,
                stickerName: '🎴',
                stickerAuthor: nomeAutor
            });
            console.log(`✅ Figurinha de ${nomeAutor} publicada no canal.`);
        } else {
            console.warn('⚠️ Canal não configurado. Figurinha não enviada.');
        }

        // 6. Enviar sticker para o grupo (no lugar da imagem original)
        await client.sendMessage(GRUPO_ID, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha de ${nomeAutor} publicada no grupo.`);

        // 7. Apagar a mensagem original (a imagem/vídeo enviada)
        await msg.delete(true);
        console.log(`🗑️ Mensagem original apagada do grupo.`);

    } catch (err) {
        console.error('❌ Erro no processamento:', err.message);
        // Em caso de erro, não apaga a mensagem original
    }
});

// ========== RECONEXÃO AUTOMÁTICA ==========
client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    setTimeout(() => client.initialize(), 10000);
});

client.on('error', (err) => console.error('Erro no cliente:', err));

// Limpeza do perfil temporário ao encerrar
process.on('exit', () => {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
});

client.initialize();
console.log('🚀 Bot iniciado. Aguarde o QR Code...');
