#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/orienteer-live}"
APP_PORT="${APP_PORT:-3000}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/ubuntu-setup.sh"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

mkdir -p "$APP_DIR"
echo "App directory: $APP_DIR"
echo "Copy project files to $APP_DIR, then run:"
echo "  cd $APP_DIR"
echo "  npm install --omit=dev"
echo "  PORT=$APP_PORT pm2 start server.js --name orienteer-live"
echo "  pm2 save"
echo "  pm2 startup systemd"

