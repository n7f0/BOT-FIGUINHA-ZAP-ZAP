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

// ========== SERVIDOR HTTP PARA QR CODE (OBRIGATÓRIO NA RAILWAY) ==========
let ultimoQRCode = null;
const app = express();

app.get('/', (req, res) => {
    if (ultimoQRCode) {
        const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr_svg);
    } else {
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>🎴 FigurinhaBot</h2>
                <p>Bot já está conectado! Nenhum QR Code pendente.</p>
                <p>Se precisar reconectar, apague a pasta <code>.wwebjs_auth</code> e reinicie.</p>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL EFÊMERO DO CHROMIUM ==========
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
const chromiumPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    process.env.PUPPETEER_EXECUTABLE_PATH
].filter(Boolean);

for (const p of chromiumPaths) {
    if (fs.existsSync(p)) {
        executablePath = p;
        console.log(`✅ Usando Chromium: ${p}`);
        break;
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        executablePath,
        defaultViewport: { width: 1280, height: 720 }
    }
});

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado! Acesse a URL pública da Railway para escanear.\n');
    qrcode.generate(qr, { small: true });
});

// ========== BOT PRONTO ==========
client.on('ready', async () => {
    ultimoQRCode = null; // Limpa o QR code após conectar
    console.log('\n✅ Bot ONLINE! Funcionando em TODOS os grupos e conversas.');
    console.log('🎴 Envie uma imagem, gif ou vídeo para qualquer chat e vire figurinha!\n');

    // Lista grupos para referência
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    console.log(`📋 Grupos que o bot participa (${grupos.length}):`);
    for (const g of grupos) {
        console.log(`   👥 ${g.name} — ${g.id._serialized}`);
    }
    console.log('');
});

// ========== FUNÇÃO DE CONVERSÃO ==========
async function converterParaSticker(buffer, mimeType) {
    console.log(`🔄 Convertendo mídia: ${mimeType} (${(buffer.length / 1024).toFixed(1)} KB)`);

    if (mimeType.startsWith('video/') || mimeType === 'image/gif') {
        // Vídeo ou GIF animado → WebP animado
        const inputExt  = mimeType === 'image/gif' ? 'gif' : 'mp4';
        const inputPath  = path.join(PASTA_TEMP, `input_${Date.now()}.${inputExt}`);
        const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);

        fs.writeFileSync(inputPath, buffer);

        const scaleFilter = [
            `scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}`,
            'force_original_aspect_ratio=decrease',
            `pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:0x00000000`
        ].join(':');

        const cmd = `ffmpeg -i "${inputPath}" -t 10 -r 15 -vf "${scaleFilter}" -c:v libwebp -q:v 80 -loop 0 -vsync 0 "${outputPath}" -y 2>&1`;

        try {
            await execPromise(cmd);
        } catch (ffmpegErr) {
            console.error('❌ Erro ffmpeg:', ffmpegErr.message?.substring(0, 200));
            throw new Error('Falha na conversão de vídeo/gif com ffmpeg');
        }

        const outputBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;

    } else {
        // Imagem estática → WebP
        return await sharp(buffer)
            .resize(TAMANHO_STICKER, TAMANHO_STICKER, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .webp({ quality: 80 })
            .toBuffer();
    }
}

// ========== PROCESSAMENTO DE MENSAGENS ==========
// Controle de mensagens em processamento (evita duplicatas)
const emProcessamento = new Set();

client.on('message_create', async (msg) => {
    // Ignora mensagens do próprio bot
    if (msg.fromMe) return;

    // Ignora se não tiver mídia
    if (!msg.hasMedia) return;

    // Evita processar a mesma mensagem duas vezes
    const msgId = msg.id._serialized;
    if (emProcessamento.has(msgId)) return;
    emProcessamento.add(msgId);

    // Limpa o controle após 30s
    setTimeout(() => emProcessamento.delete(msgId), 30000);

    const chatId = msg.from;
    console.log(`\n🔔 Nova mídia recebida de: ${chatId}`);
    console.log(`   ID: ${msgId}`);

    try {
        // 1. Baixar a mídia
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia — dados vazios');

        const buffer   = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype || 'image/jpeg';

        // Verifica se é um tipo de mídia suportado
        const suportado = mimeType.startsWith('image/') || mimeType.startsWith('video/');
        if (!suportado) {
            console.log(`⏭️ Tipo não suportado para sticker: ${mimeType}`);
            emProcessamento.delete(msgId);
            return;
        }

        // 2. Converter para sticker
        const webpBuffer = await converterParaSticker(buffer, mimeType);
        console.log(`📦 Sticker gerado: ${(webpBuffer.length / 1024).toFixed(2)} KB`);

        // 3. Nome do autor
        let nomeAutor = 'FigurinhaBot';
        try {
            const contato = await msg.getContact();
            nomeAutor = contato.pushname || contato.name || contato.number || 'FigurinhaBot';
        } catch (_) {}

        // 4. Montar e enviar o sticker no mesmo chat
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));

        await client.sendMessage(chatId, sticker, {
            sendMediaAsSticker: true,
            stickerName: '🎴',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha de "${nomeAutor}" enviada para ${chatId}`);

        // 5. Apagar a mensagem original
        // Nota: só é possível apagar para todos se o bot for admin no grupo
        // ou se a mensagem for do próprio bot. Em chats privados, só apaga para si.
        try {
            await msg.delete(true);
            console.log(`🗑️ Mensagem original apagada.`);
        } catch (delErr) {
            console.warn(`⚠️ Não foi possível apagar a mensagem original: ${delErr.message}`);
            // Tenta apagar só para o bot
            try {
                await msg.delete(false);
                console.log(`🗑️ Mensagem apagada apenas para o bot.`);
            } catch (_) {}
        }

    } catch (err) {
        console.error(`❌ Erro ao processar mídia: ${err.message}`);
    } finally {
        emProcessamento.delete(msgId);
    }
});

// ========== RECONEXÃO AUTOMÁTICA ==========
client.on('disconnected', (reason) => {
    console.log(`\n🔌 Bot desconectado: ${reason}`);
    console.log('🔄 Reconectando em 15 segundos...\n');
    setTimeout(() => client.initialize(), 15000);
});

client.on('auth_failure', (msg) => {
    console.error('🔐 Falha de autenticação:', msg);
    console.log('💡 Dica: apague a pasta .wwebjs_auth e reinicie para gerar novo QR Code.');
});

client.on('error', (err) => console.error('❌ Erro no cliente:', err));

// Limpeza do perfil temporário ao encerrar
process.on('SIGINT',  () => limpar());
process.on('SIGTERM', () => limpar());
process.on('exit',    () => limpar());

function limpar() {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

// ========== INICIAR ==========
client.initialize();
console.log('🚀 FigurinhaBot iniciando... Aguarde o QR Code ou a reconexão automática.');
