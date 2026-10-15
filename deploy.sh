#!/usr/bin/env bash
# ========================================================
# OpenFront Discord Bot - Production Deploy & Update Script
# Run this on your Oracle Cloud VM to pull and deploy updates:
#   chmod +x deploy.sh
#   ./deploy.sh
# ========================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo " [1/5] Pulling latest code from Git..."
echo "========================================="
git pull origin main

echo "========================================="
echo " [2/5] Installing dependencies..."
echo "========================================="
npm install

echo "========================================="
echo " [3/5] Building TypeScript project..."
echo "========================================="
npm run build

echo "========================================="
echo " [4/5] Deploying Discord slash commands..."
echo "========================================="
npm run register-commands

echo "========================================="
echo " [5/5] Restarting bot under PM2..."
echo "========================================="
if pm2 describe clit-of-bot > /dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi

pm2 save

echo ""
echo "========================================="
echo " ✅ Bot successfully updated and online!"
echo "========================================="
pm2 status clit-of-bot
