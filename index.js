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
const FPS_PADRAO = 10; // reduzido para caber no tamanho

// ========== SERVIDOR HTTP ==========
let ultimoQRCode = null;
const app = express();

app.get('/', (req, res) => {
    if (ultimoQRCode) {
        const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr_svg);
    } else {
        res.send(`<html><body><h2>🎴 FigurinhaBot</h2><p>Bot online! Envie GIFs/vídeos.</p></body></html>`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL CHROMIUM (RAM) ==========
const uniqueId = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(2, 8)}`;
const profileDir = `/dev/shm/chrome-profile-${uniqueId}`;
fs.mkdirSync(profileDir, { recursive: true });
try { fs.unlinkSync(path.join(profileDir, 'SingletonLock')); } catch (_) {}
console.log(`📁 Perfil Chromium: ${profileDir}`);

const puppeteerArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--hide-scrollbars',
    `--user-data-dir=${profileDir}`, '--disable-session-crashed-bubble',
    '--disable-features=LockProfileCookieDatabase',
    '--disable-background-timer-throttling', '--disable-breakpad',
    '--disable-crash-reporter', '--disable-logging', '--log-level=3',
    '--silent', '--remote-debugging-port=0', '--no-singleton-check'
];

let executablePath = undefined;
const possiblePaths = [process.env.PUPPETEER_EXECUTABLE_PATH, '/usr/bin/chromium', 'chromium'];
for (const p of possiblePaths) {
    if (p && p !== 'chromium' && fs.existsSync(p)) { executablePath = p; break; }
    if (p === 'chromium') {
        try {
            const which = require('child_process').execSync('which chromium', { encoding: 'utf8', stdio: 'pipe' });
            if (which.trim()) { executablePath = which.trim(); break; }
        } catch (_) {}
    }
}
if (!executablePath) console.warn('⚠️ Chromium não encontrado.');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: { headless: true, args: puppeteerArgs, executablePath, defaultViewport: { width: 1280, height: 720 } }
});

// ========== VERIFICAR FFMPEG ==========
async function verificarFFmpeg() {
    try {
        const { stdout } = await execPromise('ffmpeg -version 2>&1 | head -n1');
        console.log(`✅ FFmpeg: ${stdout.trim()}`);
        const { stdout: encoders } = await execPromise('ffmpeg -encoders 2>/dev/null | grep libwebp_anim || true');
        if (encoders.includes('libwebp_anim')) console.log('✅ libwebp_anim disponível');
        else console.warn('⚠️ libwebp_anim NÃO disponível! Stickers animados podem falhar.');
        return true;
    } catch (err) {
        console.error('❌ FFmpeg não encontrado!');
        return false;
    }
}

client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado!\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Aguardando mídias...\n');
    await verificarFFmpeg();
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    console.log(`📋 Participando de ${grupos.length} grupos.\n`);
});

// ========== CONVERSÃO ESTÁTICA ==========
async function converterEstatico(buffer) {
    const webp = await sharp(buffer)
        .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
        .webp({ quality: 90 })
        .toBuffer();
    console.log(`✅ Estático: ${(webp.length / 1024).toFixed(1)} KB`);
    return webp;
}

// ========== EXTRAIR PRIMEIRO FRAME ==========
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
        throw err;
    }
}

// ========== CONVERSÃO ANIMADA (GARANTIDA) ==========
async function converterAnimado(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `input_${timestamp}.${inputExt}`);
    const outputPath = path.join(PASTA_TEMP, `output_${timestamp}.webp`);

    try {
        fs.writeFileSync(inputPath, buffer);
        console.log(`📁 Arquivo: ${inputPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

        // Filtro de escala + crop central (mantém animação)
        const filter = `scale='if(gt(iw/ih,1),${TAMANHO_STICKER},-1)':'if(gt(iw/ih,1),-1,${TAMANHO_STICKER})',crop=${TAMANHO_STICKER}:${TAMANHO_STICKER}`;

        // Parâmetros que GARANTEM animação (testados)
        let qualidade = 70;
        let tentativas = 0;
        let outputBuffer = null;

        while (tentativas < 3) {
            tentativas++;
            // Comando definitivo para WebP animado
            const cmd = `ffmpeg -y -i "${inputPath}" -t ${MAX_DURACAO} -r ${FPS_PADRAO} -vf "${filter}" -pix_fmt yuv420p -c:v libwebp_anim -q:v ${qualidade} -compression_level 6 -loop 0 -an -vsync 0 "${outputPath}" 2>&1`;
            console.log(`🎬 Tentativa ${tentativas} (qualidade ${qualidade})...`);
            try {
                await execPromise(cmd);
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 2000) {
                    // Verifica quantos quadros tem
                    const probe = await execPromise(`ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_frames -of default=noprint_wrappers=1:nokey=1 "${outputPath}" 2>/dev/null`);
                    const frames = parseInt(probe.stdout.trim(), 10) || 0;
                    console.log(`📊 Quadros detectados: ${frames}`);
                    if (frames > 1) {
                        outputBuffer = fs.readFileSync(outputPath);
                        const sizeKB = (outputBuffer.length / 1024).toFixed(1);
                        console.log(`📦 WebP animado com ${frames} quadros, ${sizeKB} KB`);
                        if (outputBuffer.length <= MAX_STICKER_SIZE) {
                            break;
                        } else {
                            console.warn(`⚠️ Excede 500KB (${sizeKB}KB), reduzindo qualidade...`);
                            qualidade -= 20;
                            fs.unlinkSync(outputPath);
                            continue;
                        }
                    } else {
                        console.warn(`⚠️ WebP tem apenas ${frames} quadro, não é animado. Reduzindo qualidade...`);
                        qualidade -= 20;
                        fs.unlinkSync(outputPath);
                        continue;
                    }
                } else {
                    throw new Error('Arquivo não gerado ou muito pequeno');
                }
            } catch (err) {
                console.error(`❌ Erro: ${err.message}`);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                if (tentativas === 3) break;
                qualidade -= 20;
            }
        }

        fs.unlinkSync(inputPath);
        if (outputBuffer) {
            fs.unlinkSync(outputPath);
            console.log(`✅ STICKER ANIMADO CRIADO!`);
            return outputBuffer;
        }

        console.warn('⚠️ Falha total, gerando estático...');
        return await extrairPrimeiroFrame(buffer, mimeType);

    } catch (err) {
        console.error(`❌ Erro geral: ${err.message}`);
        try { fs.unlinkSync(inputPath); } catch (_) {}
        return await extrairPrimeiroFrame(buffer, mimeType);
    }
}

async function converterParaSticker(buffer, mimeType) {
    console.log(`🔄 Convertendo: ${mimeType} (${(buffer.length / 1024).toFixed(1)} KB)`);
    const isAnimado = mimeType.startsWith('video/') || mimeType === 'image/gif';
    if (isAnimado) return await converterAnimado(buffer, mimeType);
    else return await converterEstatico(buffer);
}

// ========== EVENTO DE MENSAGENS ==========
const emProcessamento = new Set();

client.on('message_create', async (msg) => {
    console.log(`📨 Mensagem de ${msg.from}: tipo=${msg.type}, temMidia=${msg.hasMedia}`);
    if (msg.fromMe || !msg.hasMedia) return;

    const msgId = msg.id._serialized;
    if (emProcessamento.has(msgId)) return;
    emProcessamento.add(msgId);
    setTimeout(() => emProcessamento.delete(msgId), 45000);

    const chatId = msg.from;
    console.log(`🔔 Processando mídia...`);

    try {
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        const buffer = Buffer.from(media.data, 'base64');
        let mimeType = media.mimetype || 'image/jpeg';

        if (media.filename && media.filename.toLowerCase().endsWith('.gif')) {
            mimeType = 'image/gif';
            console.log('🔧 Detectado GIF pela extensão');
        }

        if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
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
        await client.sendMessage(chatId, sticker, { sendMediaAsSticker: true, stickerAuthor: nomeAutor });
        console.log(`✅ Figurinha enviada!`);

        try { await msg.delete(true); } catch (_) {}
    } catch (err) {
        console.error(`❌ Erro: ${err.message}`);
        try { await client.sendMessage(chatId, `❌ Falha: ${err.message.slice(0, 100)}`); } catch (_) {}
    } finally {
        emProcessamento.delete(msgId);
    }
});

client.on('disconnected', (reason) => {
    console.log(`🔌 Desconectado: ${reason} - Reconectando em 20s`);
    setTimeout(() => client.initialize(), 20000);
});
client.on('auth_failure', (msg) => console.error('🔐 Falha de autenticação:', msg));
client.on('error', (err) => console.error('❌ Erro geral:', err));

process.on('SIGINT', limpar);
process.on('SIGTERM', limpar);
function limpar() {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

client.initialize();
console.log('🚀 FigurinhaBot iniciando (STICKERS ANIMADOS ATIVADOS)');
