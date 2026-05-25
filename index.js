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
const TAMANHO_STICKER = 512;            // 512x512 pixels
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// Limites do WhatsApp para stickers animados
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
                <p style="color:#666;font-size:14px">Envie imagens, GIFs ou vídeos em qualquer conversa.</p>
                <p style="color:#666;font-size:14px">Todas as figurinhas serão 512x512 pixels.</p>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

// ========== PERFIL EFÊMERO DO CHROMIUM ==========
const profileDir = `/tmp/chrome-profile-${Date.now()}`;
fs.mkdirSync(profileDir, { recursive: true });

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
        console.log(`✅ Chromium: ${p}`);
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

// ========== VERIFICAR FFMPEG NA INICIALIZAÇÃO ==========
async function verificarFFmpeg() {
    try {
        const { stdout } = await execPromise('ffmpeg -version 2>&1 | head -n1');
        console.log(`✅ FFmpeg encontrado: ${stdout.trim()}`);
        return true;
    } catch (err) {
        console.error('❌ FFmpeg não encontrado! Stickers animados não funcionarão.');
        console.error('   Instale com: apt-get install ffmpeg');
        return false;
    }
}

// ========== QR CODE ==========
client.on('qr', qr => {
    ultimoQRCode = qr;
    console.log('\n📱 QR Code gerado! Acesse a URL pública da Railway.\n');
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

// ========== FUNÇÃO DE CONVERSÃO ==========
async function converterParaSticker(buffer, mimeType) {
    const tamanhoKB = (buffer.length / 1024).toFixed(1);
    console.log(`🔄 Convertendo: ${mimeType} (${tamanhoKB} KB)`);

    const isAnimado = mimeType.startsWith('video/') || mimeType === 'image/gif';

    if (isAnimado) {
        return await converterAnimado(buffer, mimeType);
    } else {
        return await converterEstatico(buffer);
    }
}

// Conversão de imagem estática (512x512 com fundo transparente)
async function converterEstatico(buffer) {
    try {
        const webp = await sharp(buffer)
            .resize(TAMANHO_STICKER, TAMANHO_STICKER, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .webp({ quality: 90 })
            .toBuffer();
        
        console.log(`✅ Sticker estático 512x512: ${(webp.length / 1024).toFixed(1)} KB`);
        return webp;
    } catch (err) {
        console.error('❌ Erro sharp:', err.message);
        throw err;
    }
}

// Conversão de vídeo/GIF animado (512x512 com fundo transparente)
async function converterAnimado(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `input_${timestamp}.${inputExt}`);
    const outputPath = path.join(PASTA_TEMP, `output_${timestamp}.webp`);

    try {
        fs.writeFileSync(inputPath, buffer);
        console.log(`📁 Arquivo temporário: ${inputPath}`);

        // Filtro: escala mantendo proporção e padding transparente para 512x512
        // color=black@0.0 = preto 100% transparente
        const scaleFilter = `scale='min(${TAMANHO_STICKER},iw)':min'(${TAMANHO_STICKER},ih)':force_original_aspect_ratio=decrease,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`;
        
        let qualidade = 80;
        let tentativas = 0;
        let sucesso = false;

        while (!sucesso && tentativas < 3) {
            tentativas++;
            
            const cmd = [
                'ffmpeg -y',
                `-i "${inputPath}"`,
                `-t ${MAX_DURACAO}`,
                `-r ${FPS_PADRAO}`,
                `-vf "${scaleFilter}"`,
                `-pix_fmt yuva420p`,           // Preserva transparência
                `-c:v libwebp_anim`,            // Encoder para animações com alpha
                `-q:v ${qualidade}`,
                `-compression_level 6`,
                `-loop 0`,
                `-an`,
                `-vsync 0`,
                `"${outputPath}"`,
                '2>&1'
            ].join(' ');

            console.log(`🎬 FFmpeg (tentativa ${tentativas}, qualidade ${qualidade})...`);
            
            try {
                await execPromise(cmd);
                
                if (!fs.existsSync(outputPath)) {
                    throw new Error('Arquivo WebP não foi gerado');
                }

                const outputBuffer = fs.readFileSync(outputPath);
                const outputSize = outputBuffer.length;
                const outputKB = (outputSize / 1024).toFixed(1);

                console.log(`📦 WebP animado 512x512 gerado: ${outputKB} KB`);

                if (outputSize <= MAX_STICKER_SIZE) {
                    sucesso = true;
                    fs.unlinkSync(inputPath);
                    fs.unlinkSync(outputPath);
                    console.log(`✅ Sticker animado 512x512 transparente criado!`);
                    return outputBuffer;
                } else {
                    console.warn(`⚠️ Tamanho ${outputKB}KB > 500KB, reduzindo qualidade...`);
                    qualidade -= 20;
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                }

            } catch (ffmpegErr) {
                console.error(`❌ Erro ffmpeg (tentativa ${tentativas}):`, ffmpegErr.message?.substring(0, 300));
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            }
        }

        // Fallback: sticker estático a partir do primeiro frame
        console.warn('⚠️ Falha ao criar sticker animado. Criando versão estática 512x512...');
        fs.unlinkSync(inputPath);
        return await extrairPrimeiroFrame(buffer, mimeType);

    } catch (err) {
        console.error('❌ Erro geral na conversão animada:', err.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw err;
    }
}

// Fallback: extrai primeiro frame do vídeo/GIF e gera sticker estático 512x512
async function extrairPrimeiroFrame(buffer, mimeType) {
    const timestamp = Date.now();
    const inputExt = mimeType === 'image/gif' ? 'gif' : 'mp4';
    const inputPath = path.join(PASTA_TEMP, `frame_${timestamp}.${inputExt}`);
    const framePath = path.join(PASTA_TEMP, `frame_${timestamp}.png`);

    try {
        fs.writeFileSync(inputPath, buffer);
        
        const cmd = `ffmpeg -y -i "${inputPath}" -vframes 1 "${framePath}" 2>&1`;
        await execPromise(cmd);

        const frameBuffer = fs.readFileSync(framePath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(framePath);

        console.log('📸 Primeiro frame extraído, convertendo para sticker estático 512x512...');
        return await converterEstatico(frameBuffer);

    } catch (err) {
        console.error('❌ Falha ao extrair frame:', err.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
        throw new Error('Não foi possível processar o vídeo/GIF');
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
        const mimeType = media.mimetype || 'image/jpeg';

        const suportado = mimeType.startsWith('image/') || mimeType.startsWith('video/');
        if (!suportado) {
            console.log(`⏭️ Tipo não suportado: ${mimeType}`);
            emProcessamento.delete(msgId);
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
            stickerName: '512x512',
            stickerAuthor: nomeAutor
        });
        console.log(`✅ Figurinha 512x512 enviada (autor: ${nomeAutor})`);

        try {
            await msg.delete(true);
            console.log(`🗑️ Original apagada para todos`);
        } catch (delErr) {
            console.warn(`⚠️ Não foi possível apagar: ${delErr.message}`);
            try {
                await msg.delete(false);
                console.log(`🗑️ Apagada apenas para o bot`);
            } catch (_) {
                console.log('ℹ️ Bot precisa ser admin do grupo para apagar mensagens');
            }
        }

    } catch (err) {
        console.error(`❌ Erro: ${err.message}`);
    } finally {
        emProcessamento.delete(msgId);
    }
});

// ========== EVENTOS ==========
client.on('disconnected', (reason) => {
    console.log(`\n🔌 Desconectado: ${reason}`);
    console.log('🔄 Reconectando em 20s...\n');
    setTimeout(() => client.initialize(), 20000);
});

client.on('auth_failure', (msg) => {
    console.error('🔐 Falha de autenticação:', msg);
    console.log('💡 Apague a pasta .wwebjs_auth e reinicie.');
});

client.on('error', (err) => console.error('❌ Erro:', err));

// Limpeza
process.on('SIGINT', limpar);
process.on('SIGTERM', limpar);
process.on('exit', limpar);

function limpar() {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
}

// ========== INICIAR ==========
client.initialize();
console.log('🚀 FigurinhaBot iniciando... (tamanho: 512x512 pixels)');
