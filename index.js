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

const MAX_STICKER_SIZE = 500 * 1024;
const MAX_DURACAO = 6;
const FPS_PADRAO = 15;

// ========== SERVIDOR HTTP ==========
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
                <p>✅ Bot conectado e funcionando!</p>
                <p style="color:#666;font-size:14px">Envie imagens, GIFs ou vídeos em qualquer conversa.</p>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL DO CHROMIUM (SEM PERSISTÊNCIA DE LOCKS) ==========
// Usa /dev/shm (RAM) para garantir que não haja locks residuais entre execuções
const uniqueId = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(2, 8)}`;
const profileDir = `/dev/shm/chrome-profile-${uniqueId}`;

// Limpa qualquer lock residual (caso exista)
const lockFile = path.join(profileDir, 'SingletonLock');
const cookieLock = path.join(profileDir, 'LOCK');

fs.mkdirSync(profileDir, { recursive: true });
if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
if (fs.existsSync(cookieLock)) fs.unlinkSync(cookieLock);

console.log(`📁 Perfil Chromium em RAM: ${profileDir}`);

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
    '--disable-features=LockProfileCookieDatabase,OptimizationGuideModelDownloading',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-logging',
    '--log-level=3',
    '--silent',
    '--remote-debugging-port=0',
    '--no-singleton-check'   // 🔥 Crucial para Railway
];

// Detecta Chromium
let executablePath = undefined;
const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'chromium'
].filter(Boolean);

for (const p of possiblePaths) {
    if (p === 'chromium') {
        try {
            const which = require('child_process').execSync('which chromium', { encoding: 'utf8', stdio: 'pipe' });
            if (which.trim()) {
                executablePath = which.trim();
                console.log(`✅ Chromium no PATH: ${executablePath}`);
                break;
            }
        } catch (_) {}
    } else if (fs.existsSync(p)) {
        executablePath = p;
        console.log(`✅ Chromium encontrado: ${p}`);
        break;
    }
}

if (!executablePath) {
    console.warn('⚠️ Chromium não encontrado. O Puppeteer tentará baixar (pode falhar).');
}

// ========== CLIENTE WHATSAPP ==========
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '/app/.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        executablePath,
        defaultViewport: { width: 1280, height: 720 }
    }
});

// ========== VERIFICAR FFMPEG ==========
async function verificarFFmpeg() {
    try {
        const { stdout } = await execPromise('ffmpeg -version 2>&1 | head -n1');
        console.log(`✅ FFmpeg encontrado: ${stdout.trim()}`);
        return true;
    } catch (err) {
        console.error('❌ FFmpeg não encontrado! Stickers animados não funcionarão.');
        return false;
    }
}

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado! Escaneie no WhatsApp.\n');
    qrcode.generate(qr, { small: true });
});

// ========== BOT PRONTO ==========
client.on('ready', async () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Funcionando em TODOS os grupos e conversas.\n');
    await verificarFFmpeg();
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    console.log(`📋 Participando de ${grupos.length} grupos:`);
    grupos.slice(0, 5).forEach(g => console.log(`   👥 ${g.name}`));
    if (grupos.length > 5) console.log(`   ... e mais ${grupos.length - 5}`);
    console.log('');
});

// ========== FUNÇÕES DE CONVERSÃO (mesmas de antes, vou encurtar) ==========
async function converterEstatico(buffer) {
    try {
        const webp = await sharp(buffer)
            .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
            .webp({ quality: 90 })
            .toBuffer();
        console.log(`✅ Sticker estático: ${(webp.length / 1024).toFixed(1)} KB`);
        return webp;
    } catch (err) {
        console.error('❌ Erro sharp:', err.message);
        throw err;
    }
}

async function extrairPrimeiroFrame(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `frame_${timestamp}.${inputExt}`);
    const framePath = path.join(PASTA_TEMP, `frame_${timestamp}.png`);
    try {
        fs.writeFileSync(inputPath, buffer);
        await execPromise(`ffmpeg -y -i "${inputPath}" -vframes 1 "${framePath}" 2>&1`);
        const frameBuffer = fs.readFileSync(framePath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(framePath);
        return await converterEstatico(frameBuffer);
    } catch (err) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
        throw err;
    }
}

async function converterAnimado(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `input_${timestamp}.${inputExt}`);
    const outputPath = path.join(PASTA_TEMP, `output_${timestamp}.webp`);
    try {
        fs.writeFileSync(inputPath, buffer);
        const filterComplex = `scale=iw*min(${TAMANHO_STICKER}/iw\\,${TAMANHO_STICKER}/ih):ih*min(${TAMANHO_STICKER}/iw\\,${TAMANHO_STICKER}/ih),crop=${TAMANHO_STICKER}:${TAMANHO_STICKER}`;
        let qualidade = 80;
        for (let tentativas = 0; tentativas < 3; tentativas++) {
            const cmd = `ffmpeg -y -i "${inputPath}" -t ${MAX_DURACAO} -r ${FPS_PADRAO} -vf "${filterComplex}" -pix_fmt yuv420p -c:v libwebp_anim -q:v ${qualidade} -compression_level 6 -loop 0 -an -vsync 0 "${outputPath}" 2>&1`;
            await execPromise(cmd);
            if (fs.existsSync(outputPath)) {
                const bufferOut = fs.readFileSync(outputPath);
                if (bufferOut.length <= MAX_STICKER_SIZE) {
                    fs.unlinkSync(inputPath);
                    fs.unlinkSync(outputPath);
                    return bufferOut;
                }
                qualidade -= 20;
                fs.unlinkSync(outputPath);
            }
        }
        fs.unlinkSync(inputPath);
        return await extrairPrimeiroFrame(buffer, mimeType);
    } catch (err) {
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (_) {}
        throw err;
    }
}

async function converterParaSticker(buffer, mimeType) {
    console.log(`🔄 Convertendo: ${mimeType} (${(buffer.length / 1024).toFixed(1)} KB)`);
    const isAnimado = mimeType.startsWith('video/') || mimeType === 'image/gif';
    return isAnimado ? converterAnimado(buffer, mimeType) : converterEstatico(buffer);
}

// ========== PROCESSAMENTO DE MENSAGENS ==========
const emProcessamento = new Set();

client.on('message_create', async (msg) => {
    if (msg.fromMe || !msg.hasMedia) return;
    const msgId = msg.id._serialized;
    if (emProcessamento.has(msgId)) return;
    emProcessamento.add(msgId);
    setTimeout(() => emProcessamento.delete(msgId), 45000);

    const chatId = msg.from;
    console.log(`\n🔔 Nova mídia de: ${chatId}`);

    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        let mimeType = media.mimetype || 'image/jpeg';
        if (media.filename && media.filename.toLowerCase().endsWith('.gif')) mimeType = 'image/gif';

        if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) return;

        const webpBuffer = await converterParaSticker(buffer, mimeType);
        let nomeAutor = 'Bot';
        try {
            const contato = await msg.getContact();
            nomeAutor = contato.pushname || contato.name || contato.number || 'Bot';
        } catch (_) {}

        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'), 'sticker.webp');
        await client.sendMessage(chatId, sticker, { sendMediaAsSticker: true, stickerAuthor: nomeAutor });
        console.log(`✅ Figurinha enviada (autor: ${nomeAutor})`);

        try { await msg.delete(true); } catch (_) {}
    } catch (err) {
        console.error(`❌ Erro: ${err.message}`);
        try { await client.sendMessage(chatId, `❌ Falha: ${err.message.slice(0, 100)}`); } catch (_) {}
    } finally {
        emProcessamento.delete(msgId);
    }
});

// ========== EVENTOS ==========
client.on('disconnected', (reason) => {
    console.log(`🔌 Desconectado: ${reason} - Reconectando em 20s`);
    setTimeout(() => client.initialize(), 20000);
});
client.on('auth_failure', (msg) => console.error('🔐 Falha de autenticação:', msg));
client.on('error', (err) => console.error('❌ Erro geral:', err));

// ========== LIMPEZA ==========
process.on('SIGINT', limpar);
process.on('SIGTERM', limpar);
function limpar() {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

client.initialize();
console.log('🚀 FigurinhaBot iniciando... (512x512 corte central)');
