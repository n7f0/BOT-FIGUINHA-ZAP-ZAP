#!/bin/bash
# =====================================================
# 🎴 FigurinhaBot — Script de Instalação Automática
# =====================================================

echo ""
echo "🎴 FigurinhaBot — Instalação"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Verifica Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado!"
    echo "   Instale em: https://nodejs.org (versão 18 ou superior)"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js versão $NODE_VERSION detectada. Necessário versão 18+."
    echo "   Baixe em: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js $(node -v) encontrado"

# Instala dependências do sistema (Linux)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo ""
    echo "📦 Instalando dependências do sistema (Linux)..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        chromium-browser \
        libgconf-2-4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libasound2 \
        2>/dev/null || true
fi

# Instala dependências do Node
echo ""
echo "📦 Instalando dependências do projeto..."
npm install

if [ $? -eq 0 ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ Instalação concluída com sucesso!"
    echo ""
    echo "▶️  Para iniciar o bot, execute:"
    echo "    node index.js"
    echo ""
    echo "📱 Depois, escaneie o QR Code que aparecer"
    echo "   no WhatsApp → Configurações → Aparelhos Conectados"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "❌ Erro na instalação. Verifique sua conexão com internet."
    exit 1
fi
