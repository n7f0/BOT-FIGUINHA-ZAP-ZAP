/**
 * 🎴 Sticker Bot WhatsApp - Conversor Automático
 * 
 * Funcionalidade:
 *   - Envie qualquer FOTO ou GIF para o bot
 *   - Ele devolve uma FIGURINHA (sticker) com o AUTOR = seu nome no WhatsApp
 *   - Nenhum comando necessário
 *   - Suporte a imagens estáticas (JPG, PNG, WebP, etc) e GIFs animados
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

// ========== CONFIGURAÇÕES ==========
const TAMANHO_STICKER = 512;
const PASTA_TEMP = path.join(__dirname, 'temp');

// Cria pasta temporária se não existir
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// ========== INICIALIZAÇÃO DO CLIENTE ==========
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});

// ========== QR CODE ==========
client.on('qr', qr => {
    console.log('\n📱 Escaneie o QR Code abaixo:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n👉 WhatsApp > Configurações > Aparelhos Conectados > Conectar aparelho\n');
});

// ========== BOT PRONTO ==========
client.on('ready', () => {
    console.log('\n✅ Bot ONLINE! Envie qualquer imagem ou GIF.');
    console.log('   O sticker virá com o autor = seu nome no WhatsApp.\n');
});

// ========== FUNÇÃO PARA OBTER NOME DO CONTATO ==========
async function obterNomeContato(msg) {
    try {
        const contato = await msg.getContact();
        // Prioridade: pushname (nome que a pessoa definiu no perfil)
        if (contato.pushname && contato.pushname.trim()) return contato.pushname;
        // Nome salvo nos seus contatos
        if (contato.name && contato.name.trim()) return contato.name;
        // Número como fallback
        return contato.number || msg.from.replace('@c.us', '');
    } catch (err) {
        console.log('Erro ao obter nome:', err.message);
        return msg.from.replace('@c.us', '');
    }
}

// ========== CONVERTER IMAGEM ESTÁTICA (JPG, PNG, WebP, etc) ==========
async function converterImagemEstatica(bufferImagem) {
    // Garante que o buffer é processável pelo sharp
    let imagem = sharp(bufferImagem);
    const metadata = await imagem.metadata().catch(() => null);
    if (!metadata) {
        throw new Error('Formato de imagem não reconhecido ou corrompido');
    }

    // Se a imagem já for WebP, converte mesmo assim (sharp reconverte)
    return await imagem
        .resize(TAMANHO_STICKER, TAMANHO_STICKER, {
            fit: 'cover',
            position: 'centre'
        })
        .webp({ quality: 80 })
        .toBuffer();
}

// ========== CONVERTER GIF PARA WEBP ANIMADO (usando ffmpeg) ==========
async function converterGifParaWebp(bufferGif) {
    const inputPath = path.join(PASTA_TEMP, `input_${Date.now()}.gif`);
    const outputPath = path.join(PASTA_TEMP, `output_${Date.now()}.webp`);
    
    fs.writeFileSync(inputPath, bufferGif);
    
    // Comando ffmpeg para converter GIF para WebP animado
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libwebp -q:v 80 -vf "scale=${TAMANHO_STICKER}:${TAMANHO_STICKER}:force_original_aspect_ratio=1,pad=${TAMANHO_STICKER}:${TAMANHO_STICKER}:(ow-iw)/2:(oh-ih)/2:black" -loop 0 -vsync 0 "${outputPath}" -y`;
    
    try {
        await execPromise(ffmpegCmd);
        const outputBuffer = fs.readFileSync(outputPath);
        // Limpeza
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return outputBuffer;
    } catch (err) {
        // Limpeza em caso de erro
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw new Error(`Falha no ffmpeg: ${err.message}`);
    }
}

// ========== DETECTAR SE É GIF ==========
function isGif(mimeType) {
    return mimeType === 'image/gif';
}

// ========== TRATAMENTO DE MENSAGENS ==========
client.on('message', async (msg) => {
    // Ignora comandos antigos ou textos
    const texto = msg.body?.trim() || '';
    if (texto.startsWith('!')) return;
    if (!msg.hasMedia) return;

    // Mensagem de "processando" (opcional, pode comentar)
    await msg.reply('🔄 Convertendo para sticker...');

    try {
        const media = await msg.downloadMedia();
        if (!media || !media.data) throw new Error('Falha ao baixar a mídia');

        const bufferOriginal = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        const ehGif = isGif(mimeType);

        let webpBuffer;
        if (ehGif) {
            console.log('🎞️ Convertendo GIF animado...');
            webpBuffer = await converterGifParaWebp(bufferOriginal);
        } else {
            console.log('🖼️ Convertendo imagem estática...');
            webpBuffer = await converterImagemEstatica(bufferOriginal);
        }

        const nomeAutor = await obterNomeContato(msg);
        const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));

        await client.sendMessage(msg.from, sticker, {
            sendMediaAsSticker: true,
            stickerName: '',        // sem nome da figurinha (apenas autor)
            stickerAuthor: nomeAutor
        });

        console.log(`✅ Sticker enviado | Autor: "${nomeAutor}" | GIF: ${ehGif}`);
    } catch (err) {
        console.error('Erro na conversão:', err.message);
        await msg.reply('❌ Não foi possível converter essa imagem/GIF. Verifique o formato ou tente outro arquivo.');
    }
});

// ========== RECONEXÃO AUTOMÁTICA ==========
client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
    console.log('🔄 Tentando reconectar em 10 segundos...');
    setTimeout(() => client.initialize(), 10000);
});

// ========== TRATAMENTO DE ERROS GLOBAIS ==========
process.on('unhandledRejection', (err) => {
    if (err.message?.includes('ProtocolError')) {
        console.log('⚠️ Erro de protocolo (ignorado).');
    } else {
        console.error('Erro não tratado:', err);
    }
});

// ========== INICIAR ==========
console.log('🚀 Iniciando bot conversor de figurinhas...');
client.initialize();