#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 Vultr instance. Run as root:
#   APP_HOST=sandbox.example.com DEMO_HOST=demo.example.com bash deploy/setup.sh
# Then put the secrets in /opt/signup-sandbox/.env (see .env.example) and
#   systemctl restart signup-sandbox
set -euo pipefail
: "${APP_HOST:?set APP_HOST}" "${DEMO_HOST:?set DEMO_HOST}"
APP_DIR=/opt/signup-sandbox
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

apt-get update
apt-get install -y ca-certificates curl gnupg ufw docker.io debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# Service user; it drives Docker, so it only exists on this dedicated machine.
id sbx >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin sbx
usermod -aG docker sbx

mkdir -p "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  cp -r "$SRC_DIR"/{package.json,package-lock.json,tsconfig.json,src,sandbox,proxy,deploy} "$APP_DIR"/
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
docker build -t signup-sandbox-browser sandbox
docker build -t signup-sandbox-proxy proxy
[[ -f .env ]] || cp deploy/env.production .env
sed -i "s#^DEMO_PUBLIC_URL=.*#DEMO_PUBLIC_URL=https://$DEMO_HOST#" .env
chown -R sbx:sbx "$APP_DIR"
chmod 600 .env

sed -e "s/APP_HOST/$APP_HOST/" -e "s/DEMO_HOST/$DEMO_HOST/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

cp deploy/signup-sandbox.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now signup-sandbox

ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

echo "Done. App: https://$APP_HOST  Demo sites: https://$DEMO_HOST"
