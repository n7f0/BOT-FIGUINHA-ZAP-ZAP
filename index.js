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
const TAMANHO_STICKER = 512;            // 512x512 corte central
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

const MAX_STICKER_SIZE = 500 * 1024;    // 500 KB
const MAX_DURACAO = 6;                  // segundos
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
                <p>Envie imagens, GIFs ou vídeos curtos (até 6s)</p>
                <p>Todas as figurinhas serão 512x512 com corte central</p>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL DO CHROMIUM (SEM LOCKS) ==========
// Usa /dev/shm (RAM) para garantir perfil único e sem persistência
const uniqueId = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(2, 8)}`;
const profileDir = `/dev/shm/chrome-profile-${uniqueId}`;

// Remove qualquer lock residual (segurança)
const lockFile = path.join(profileDir, 'SingletonLock');
const cookieLock = path.join(profileDir, 'LOCK');

fs.mkdirSync(profileDir, { recursive: true });
if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
if (fs.existsSync(cookieLock)) fs.unlinkSync(cookieLock);

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
    '--no-singleton-check'       // Crucial para evitar "profile in use"
];

// Detecta Chromium (prioriza o instalado via nixpacks)
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
    console.warn('⚠️ Chromium não encontrado. O Puppeteer tentará baixar (pode falhar no Railway).');
}

// ========== CLIENTE WHATSAPP ==========
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        executablePath,
        defaultViewport: { width: 1280, height: 720 }
    }
});

// ========== VERIFICAÇÃO DO FFMPEG ==========
async function verificarFFmpeg() {
    try {
        const { stdout } = await execPromise('ffmpeg -version 2>&1 | head -n1');
        console.log(`✅ FFmpeg encontrado: ${stdout.trim()}`);
        // Testa se o codec webp está disponível
        const { stdout: encoders } = await execPromise('ffmpeg -encoders 2>/dev/null | grep -E "webp|libwebp" || true');
        console.log(`📼 Codecs WebP disponíveis:\n${encoders || 'nenhum específico'}`);
        return true;
    } catch (err) {
        console.error('❌ FFmpeg NÃO ENCONTRADO! Stickers animados não funcionarão.');
        console.error('   Adicione "ffmpeg-full" à variável RAILPACK_PACKAGES e reimplante.');
        return false;
    }
}

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado! Escaneie no WhatsApp (Acesse a URL do Railway)\n');
    qrcode.generate(qr, { small: true });
});

// ========== BOT PRONTO ==========
client.on('ready', async () => {
    ultimoQRCode = null;
    console.log('\n✅ Bot ONLINE! Aguardando mídias...\n');
    await verificarFFmpeg();
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    console.log(`📋 Participando de ${grupos.length} grupos:`);
    grupos.slice(0, 5).forEach(g => console.log(`   👥 ${g.name}`));
    if (grupos.length > 5) console.log(`   ... e mais ${grupos.length - 5}`);
    console.log('');
});

// ========== FUNÇÕES DE CONVERSÃO ==========
async function converterEstatico(buffer) {
    const webp = await sharp(buffer)
        .resize(TAMANHO_STICKER, TAMANHO_STICKER, { fit: 'cover', position: 'centre' })
        .webp({ quality: 90 })
        .toBuffer();
    console.log(`✅ Sticker estático: ${(webp.length / 1024).toFixed(1)} KB`);
    return webp;
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
        console.log('📸 Primeiro frame extraído, convertendo para estático...');
        return await converterEstatico(frameBuffer);
    } catch (err) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
        throw new Error('Falha ao extrair primeiro frame');
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

        // Filtro robusto: escala mantendo proporção, depois crop central
        const filterComplex = `scale='if(gt(iw/ih,1),${TAMANHO_STICKER},-1)':'if(gt(iw/ih,1),-1,${TAMANHO_STICKER})',crop=${TAMANHO_STICKER}:${TAMANHO_STICKER}`;

        let qualidade = 80;
        let tentativas = 0;
        let sucesso = false;
        let outputBuffer = null;

        while (!sucesso && tentativas < 3) {
            tentativas++;
            // Tentativa 1: codec webp (genérico)
            let cmd = `ffmpeg -y -i "${inputPath}" -t ${MAX_DURACAO} -r ${FPS_PADRAO} -vf "${filterComplex}" -pix_fmt yuv420p -c:v webp -quality ${qualidade} -loop 0 -an -vsync 0 "${outputPath}" 2>&1`;
            console.log(`🎬 Tentativa ${tentativas} - codec webp, qualidade ${qualidade}`);
            try {
                await execPromise(cmd);
                if (!fs.existsSync(outputPath)) throw new Error('Arquivo não gerado');
            } catch (e) {
                // Tentativa 2: libwebp_anim (se disponível)
                console.warn(`⚠️ codec webp falhou, tentando libwebp_anim...`);
                cmd = `ffmpeg -y -i "${inputPath}" -t ${MAX_DURACAO} -r ${FPS_PADRAO} -vf "${filterComplex}" -pix_fmt yuv420p -c:v libwebp_anim -q:v ${qualidade} -compression_level 6 -loop 0 -an -vsync 0 "${outputPath}" 2>&1`;
                await execPromise(cmd);
            }

            if (fs.existsSync(outputPath)) {
                outputBuffer = fs.readFileSync(outputPath);
                const sizeKB = (outputBuffer.length / 1024).toFixed(1);
                console.log(`📦 WebP gerado: ${sizeKB} KB`);
                if (outputBuffer.length <= MAX_STICKER_SIZE) {
                    sucesso = true;
                } else {
                    console.warn(`⚠️ Tamanho ${sizeKB}KB > 500KB, reduzindo qualidade...`);
                    qualidade -= 20;
                    fs.unlinkSync(outputPath);
                }
            } else {
                console.error(`❌ Falha: ffmpeg não gerou o arquivo ${outputPath}`);
                break;
            }
        }

        // Limpeza
        fs.unlinkSync(inputPath);
        if (sucesso && outputBuffer) {
            fs.unlinkSync(outputPath);
            console.log(`✅ Sticker animado criado com sucesso!`);
            return outputBuffer;
        }

        // Fallback: estático
        console.warn('⚠️ Criando sticker estático como fallback...');
        return await extrairPrimeiroFrame(buffer, mimeType);

    } catch (err) {
        console.error('❌ Erro na conversão animada:', err.message);
        if (err.stderr) console.error('stderr:', err.stderr);
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (_) {}
        return await extrairPrimeiroFrame(buffer, mimeType);
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

// ========== PROCESSAMENTO DE MENSAGENS (COM LOGS DETALHADOS) ==========
const emProcessamento = new Set();

client.on('message_create', async (msg) => {
    // Log BRUTO de toda mensagem recebida
    console.log(`📨 Mensagem recebida de ${msg.from}: tipo=${msg.type}, temMidia=${msg.hasMedia}, body="${msg.body?.substring(0, 50)}"`);

    if (msg.fromMe) {
        console.log(`↩️ Ignorando mensagem do próprio bot`);
        return;
    }
    if (!msg.hasMedia) {
        console.log(`⏭️ Sem mídia, ignorando`);
        return;
    }

    const msgId = msg.id._serialized;
    if (emProcessamento.has(msgId)) return;
    emProcessamento.add(msgId);
    setTimeout(() => emProcessamento.delete(msgId), 45000);

    const chatId = msg.from;
    console.log(`\n🔔 PROCESSANDO MÍDIA de: ${chatId}`);

    try {
        console.log('📥 Baixando mídia...');
        const media = await msg.downloadMedia();
        if (!media?.data) throw new Error('Falha ao baixar mídia');
        console.log(`📦 Baixado: tipo=${media.mimetype}, tamanho=${media.data.length} bytes`);

        const buffer = Buffer.from(media.data, 'base64');
        let mimeType = media.mimetype || 'image/jpeg';

        // Detecta GIFs que chegam como video/mp4
        if (media.filename && media.filename.toLowerCase().endsWith('.gif')) {
            mimeType = 'image/gif';
            console.log('🔧 Detectado GIF pela extensão, tratando como animado');
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
        await client.sendMessage(chatId, sticker, {
            sendMediaAsSticker: true,
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha enviada (autor: ${nomeAutor})`);

        // Tenta apagar a original (se bot for admin)
        try {
            await msg.delete(true);
            console.log(`🗑️ Mensagem original apagada`);
        } catch (_) {
            console.log(`⚠️ Não foi possível apagar (pode precisar ser admin)`);
        }
    } catch (err) {
        console.error(`❌ ERRO GRAVE: ${err.message}`);
        try {
            await client.sendMessage(chatId, `❌ Falha ao criar figurinha: ${err.message.slice(0, 100)}`);
        } catch (_) {}
    } finally {
        emProcessamento.delete(msgId);
    }
});

// ========== EVENTOS DE RECONEXÃO ==========
client.on('disconnected', (reason) => {
    console.log(`🔌 Desconectado: ${reason} - Reconectando em 20s`);
    setTimeout(() => client.initialize(), 20000);
});
client.on('auth_failure', (msg) => console.error('🔐 Falha de autenticação:', msg));
client.on('error', (err) => console.error('❌ Erro geral:', err));

// ========== LIMPEZA NA SAÍDA ==========
process.on('SIGINT', limpar);
process.on('SIGTERM', limpar);
function limpar() {
    console.log('🧹 Limpando arquivos temporários...');
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

// ========== INICIAR ==========
client.initialize();
console.log('🚀 FigurinhaBot iniciando... (512x512 corte central)');
