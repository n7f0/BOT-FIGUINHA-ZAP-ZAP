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
const TAMANHO_STICKER = 512;
const PASTA_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(PASTA_TEMP)) fs.mkdirSync(PASTA_TEMP);

// COLOQUE O ID DO CANAL DESCOBERTO
let CHANNEL_ID = null;

const app = express();
let ultimoQRCode = null;
app.get('/', (req, res) => {
  if (ultimoQRCode) {
    const qr_svg = qrImage.imageSync(ultimoQRCode, { type: 'svg' });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(qr_svg);
  } else {
    res.send('⏳ QR Code ainda não gerado');
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor HTTP na porta ${PORT}`));

const profileDir = `/tmp/chrome-profile-${Date.now()}`;
fs.mkdirSync(profileDir, { recursive: true });
console.log(`📁 Chromium profile: ${profileDir}`);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--disable-default-apps',
      '--disable-extensions', '--disable-sync', '--hide-scrollbars',
      `--user-data-dir=${profileDir}`,
      '--disable-session-crashed-bubble',
      '--disable-features=LockProfileCookieDatabase'
    ],
    executablePath: '/usr/bin/chromium',
    defaultViewport: { width: 1280, height: 720 }
  }
});

client.on('qr', qr => {
  ultimoQRCode = qr;
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ Bot conectado!');
  // Comando interno para listar canais (via console)
  const chats = await client.getChats();
  for (const chat of chats) {
    if (chat.isChannel) {
      console.log(`📢 Canal encontrado: ${chat.name} -> ID: ${chat.id._serialized}`);
      if (!CHANNEL_ID && chat.name.toLowerCase().includes('figurinha')) {
        CHANNEL_ID = chat.id._serialized;
      }
    }
  }
  if (!CHANNEL_ID) console.warn('⚠️ Canal não detectado automaticamente. Use !canal_id');
});

client.on('message', async msg => {
  if (msg.body === '!canal_id') {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.isChannel) {
        await msg.reply(`📢 Canal: ${chat.name}\nID: ${chat.id._serialized}`);
      }
    }
    return;
  }

  if (!msg.hasMedia) return;

  if (!CHANNEL_ID) {
    await msg.reply('⚠️ Canal não definido. Use !canal_id para obter o ID e depois configure no código.');
    return;
  }

  try {
    const media = await msg.downloadMedia();
    const buffer = Buffer.from(media.data, 'base64');
    let webpBuffer;

    if (media.mimetype.startsWith('video/')) {
      const input = path.join(PASTA_TEMP, `vid_${Date.now()}.mp4`);
      const output = path.join(PASTA_TEMP, `sticker_${Date.now()}.webp`);
      fs.writeFileSync(input, buffer);
      await execPromise(`ffmpeg -i "${input}" -t 15 -r 15 -c:v libwebp -q:v 80 -vf "scale=512:512:force_original_aspect_ratio=1,pad=512:512:(ow-iw)/2:(oh-ih)/2:black" -loop 0 "${output}" -y`);
      webpBuffer = fs.readFileSync(output);
      fs.unlinkSync(input);
      fs.unlinkSync(output);
    } else {
      webpBuffer = await sharp(buffer)
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 80 })
        .toBuffer();
    }

    const sticker = new MessageMedia('image/webp', webpBuffer.toString('base64'));
    const autor = (await msg.getContact()).pushname || 'Usuário';
    await client.sendMessage(CHANNEL_ID, sticker, {
      sendMediaAsSticker: true,
      stickerName: '🎴',
      stickerAuthor: autor
    });
    await msg.reply(`✅ Figurinha de *${autor}* postada no canal!`);
  } catch (err) {
    console.error(err);
    await msg.reply('❌ Erro ao processar mídia.');
  }
});

client.initialize();
