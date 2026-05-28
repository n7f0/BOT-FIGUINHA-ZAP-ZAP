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

// ========== SERVIDOR HTTP PARA QR CODE ==========
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
                <p style="color:#666;font-size:14px">Todas as figurinhas serão 512x512 pixels (cortadas para preencher).</p>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL EFÊMERO DO CHROMIUM - GARANTIR UNICIDADE ==========
// Usamos timestamp + PID + random para evitar qualquer conflito de lock
const uniqueId = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(2, 8)}`;
const profileDir = `/tmp/chrome-profile-${uniqueId}`;

// Limpa qualquer diretório antigo que possa ter lock (segurança)
try {
    if (fs.existsSync('/tmp/chrome-profile-*')) {
        const oldProfiles = fs.readdirSync('/tmp').filter(f => f.startsWith('chrome-profile-'));
        for (const old of oldProfiles) {
            try {
                fs.rmSync(path.join('/tmp', old), { recursive: true, force: true });
                console.log(`🧹 Limpo perfil antigo: ${old}`);
            } catch (e) {}
        }
    }
} catch (_) {}

fs.mkdirSync(profileDir, { recursive: true });
console.log(`📁 Perfil Chromium único: ${profileDir}`);

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
    '--disable-features=LockProfileCookieDatabase',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-logging',
    '--log-level=3',          // reduz verbosidade
    '--silent',
    '--remote-debugging-port=0'  // evita conflitos de porta
];

// Detecta Chromium no Railway
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
        dataPath: '/app/.wwebjs_auth'  // caminho fixo para sessão, mas sem conflito com Chromium
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

// ========== FUNÇÕES DE CONVERSÃO (idênticas à versão anterior, mas vou manter) ==========
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
        console.log('📸 Primeiro frame extraído, convertendo...');
        return await converterEstatico(frameBuffer);
    } catch (err) {
        console.error('❌ Falha ao extrair frame:', err.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
        throw new Error('Não foi possível processar o vídeo/GIF');
    }
}

async function converterAnimado(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `input_${timestamp}.${inputExt}`);
    const outputPath = path.join(PASTA_TEMP, `output_${timestamp}.webp`);

    try {
        fs.writeFileSync(inputPath, buffer);
        console.log(`📁 Animado salvo: ${inputPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

        const filterComplex = `scale=iw*min(${TAMANHO_STICKER}/iw\\,${TAMANHO_STICKER}/ih):ih*min(${TAMANHO_STICKER}/iw\\,${TAMANHO_STICKER}/ih),crop=${TAMANHO_STICKER}:${TAMANHO_STICKER}`;

        let qualidade = 80;
        let tentativas = 0;
        let sucesso = false;
        let outputBuffer = null;

        while (!sucesso && tentativas < 3) {
            tentativas++;
            const cmd = `ffmpeg -y -i "${inputPath}" -t ${MAX_DURACAO} -r ${FPS_PADRAO} -vf "${filterComplex}" -pix_fmt yuv420p -c:v libwebp_anim -q:v ${qualidade} -compression_level 6 -loop 0 -an -vsync 0 "${outputPath}" 2>&1`;
            
            console.log(`🎬 Tentativa ${tentativas} - qualidade ${qualidade}`);
            try {
                await execPromise(cmd);
                if (!fs.existsSync(outputPath)) throw new Error('Arquivo não gerado');
                outputBuffer = fs.readFileSync(outputPath);
                const sizeKB = (outputBuffer.length / 1024).toFixed(1);
                console.log(`📦 Gerado: ${sizeKB} KB`);
                if (outputBuffer.length <= MAX_STICKER_SIZE) {
                    sucesso = true;
                } else {
                    console.warn(`⚠️ Tamanho ${sizeKB}KB > 500KB, reduzindo qualidade...`);
                    qualidade -= 20;
                    fs.unlinkSync(outputPath);
                }
            } catch (ffmpegErr) {
                console.error(`❌ Erro ffmpeg tentativa ${tentativas}:`, ffmpegErr.message?.substring(0, 200));
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            }
        }

        fs.unlinkSync(inputPath);
        if (sucesso && outputBuffer) {
            fs.unlinkSync(outputPath);
            console.log(`✅ Sticker animado criado!`);
            return outputBuffer;
        }

        console.warn('⚠️ Falha no animado, criando estático...');
        return await extrairPrimeiroFrame(buffer, mimeType);

    } catch (err) {
        console.error('❌ Erro geral conversão animada:', err.message);
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
    if (isAnimado) {
        return await converterAnimado(buffer, mimeType);
    } else {
        return await converterEstatico(buffer);
    }
}

// ========== PROCESSAMENTO DE MENSAGENS ==========
const emProcessamento = new Set();

client.on('message_create', async (msg) => {
    if (msg.fromMe) return;
    if (!msg.hasMedia) return;

    const msgId = msg.id._serialized;
    if (emProcessamento.has(msgId)) return;
    emProcessamento.add(msgId);
    setTimeout(() => emProcessamento.delete(msgId), 45000);

    const chatId = msg.from;
    console.log(`\n🔔 Nova mídia de: ${chatId}`);

    try {
        console.log('📥 Baixando mídia...');
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');

        const buffer = Buffer.from(media.data, 'base64');
        let mimeType = media.mimetype || 'image/jpeg';

        if (media.filename && media.filename.toLowerCase().endsWith('.gif')) {
            mimeType = 'image/gif';
            console.log('🔧 Detectado GIF pela extensão');
        }

        const suportado = mimeType.startsWith('image/') || mimeType.startsWith('video/');
        if (!suportado) {
            console.log(`⏭️ Tipo não suportado: ${mimeType}`);
            return;
        }

        const webpBuffer = await converterParaSticker(buffer, mimeType);

        let nomeAutor = 'Bot';
        try {
            const contato = await msg.getContact();
            nomeAutor = contato.pushname || contato.name || contato.number || 'Bot';
        } catch (_) {}

        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'), 'sticker.webp');
        await client.sendMessage(chatId, sticker, {
            sendMediaAsSticker: true,
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha enviada (autor: ${nomeAutor})`);

        try {
            await msg.delete(true);
            console.log(`🗑️ Original apagada`);
        } catch (delErr) {
            console.warn(`⚠️ Não foi possível apagar: ${delErr.message}`);
        }

    } catch (err) {
        console.error(`❌ Erro no processamento: ${err.message}`);
        try {
            await client.sendMessage(chatId, `❌ Não foi possível criar figurinha. Motivo: ${err.message.slice(0, 100)}`);
        } catch (_) {}
    } finally {
        emProcessamento.delete(msgId);
    }
});

// ========== EVENTOS ==========
client.on('disconnected', (reason) => {
    console.log(`\n🔌 Desconectado: ${reason}`);
    console.log('🔄 Reconectando em 20s...');
    setTimeout(() => client.initialize(), 20000);
});
client.on('auth_failure', (msg) => {
    console.error('🔐 Falha de autenticação:', msg);
});
client.on('error', (err) => console.error('❌ Erro geral:', err));

// ========== LIMPEZA NA SAÍDA ==========
process.on('SIGINT', limpar);
process.on('SIGTERM', limpar);
function limpar() {
    console.log('🧹 Limpando perfis temporários...');
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

// ========== INICIAR ==========
client.initialize();
console.log('🚀 FigurinhaBot iniciando... (512x512 com corte central)');
