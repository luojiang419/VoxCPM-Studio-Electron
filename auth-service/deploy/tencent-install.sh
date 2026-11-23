#!/usr/bin/env bash
set -euo pipefail
# 在腾讯云宿主机执行；归档内source是公开源码，initial只在数据库首次不存在时使用。
stage="$1"
deploy_id="$2"
base=/opt/useradmin
state=/opt/useradmin/data
site=/opt/1panel/www/conf.d/admin.ee2x.cn.conf
container=$(docker ps --format '{{.Names}}' | sed -n '/^1Panel-openresty-/p' | head -n 1)
test -n "$container"
if ! id ee2x-auth >/dev/null 2>&1; then useradd --system --home-dir "$base" --shell /usr/sbin/nologin ee2x-auth; fi
mkdir -p "$base/releases/$deploy_id" "$state"
chmod 700 "$state"
cp -a "$stage/source/." "$base/releases/$deploy_id/"
if test ! -e "$state/auth.sqlite3"; then
  if test -e /var/lib/ee2x-auth/auth.sqlite3; then
    systemctl stop ee2x-auth
    python3 - <<'MIGRATE'
import sqlite3, shutil
from pathlib import Path
source=Path('/var/lib/ee2x-auth')
target=Path('/opt/useradmin/data')
with sqlite3.connect(source/'auth.sqlite3') as old:
    with sqlite3.connect(target/'auth.sqlite3') as new:
        old.backup(new)
shutil.copy2(source/'license-ed25519.key',target/'license-ed25519.key')
MIGRATE
  else
    cp "$stage/initial/auth.sqlite3" "$state/auth.sqlite3"
    cp "$stage/initial/license-ed25519.key" "$state/license-ed25519.key"
  fi
fi
chown -R ee2x-auth:ee2x-auth "$state"
chmod 600 "$state/"*
if test ! -x "$base/venv/bin/python"; then python3 -m venv "$base/venv"; fi
requirements="$base/releases/$deploy_id/requirements.txt"
if test -f "$base/releases/$deploy_id/requirements.lock.txt"; then requirements="$base/releases/$deploy_id/requirements.lock.txt"; fi
"$base/venv/bin/pip" install --disable-pip-version-check -r "$requirements"
if test -L "$base/current"; then readlink "$base/current" > "$base/previous-release"; fi
mkdir -p "$base/backups"
if test ! -f "$base/backups/pre-$deploy_id.sqlite3"; then
  python3 - "$state/auth.sqlite3" "$base/backups/pre-$deploy_id.sqlite3" <<'BACKUP'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source:
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
BACKUP
fi
ln -sfn "$base/releases/$deploy_id" "$base/current"
chgrp -R ee2x-auth "$base"
chmod -R g+rX "$base"
chmod -R go-w "$base"
cat > /etc/systemd/system/ee2x-auth.service <<'UNIT'
[Unit]
Description=EE2X unified software authorization
After=network.target
[Service]
Type=simple
User=ee2x-auth
Group=ee2x-auth
WorkingDirectory=/opt/useradmin/current
Environment=EE2X_DATA_ROOT=/opt/useradmin/data
Environment=EE2X_PUBLIC_URL=https://admin.ee2x.cn
Environment=EE2X_PORT=4102
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/useradmin/venv/bin/python server.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/useradmin/data
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ee2x-auth
systemctl restart ee2x-auth
for n in $(seq 1 20); do if curl -fsS http://127.0.0.1:4102/api/v1/health; then break; fi; sleep 1; done
curl -fsS http://127.0.0.1:4102/api/v1/health >/dev/null
if test -e "$site"; then cp "$site" "$base/admin-site-before-$deploy_id.conf"; fi
cat > "$site" <<'HTTP'
server {
    listen 80;
    server_name admin.ee2x.cn;
    location ^~ /.well-known/acme-challenge/ { root /usr/share/nginx/html; allow all; }
    location / { return 301 https://$host$request_uri; }
}
HTTP
docker exec "$container" openresty -t
docker exec "$container" openresty -s reload
if test ! -f /etc/letsencrypt/live/admin.ee2x.cn/fullchain.pem; then
  certbot certonly --webroot -w /opt/1panel/apps/openresty/openresty/root -d admin.ee2x.cn --cert-name admin.ee2x.cn --non-interactive --agree-tos --register-unsafely-without-email
fi
mkdir -p /opt/1panel/www/sites/admin.ee2x.cn/ssl
cp /etc/letsencrypt/live/admin.ee2x.cn/fullchain.pem /opt/1panel/www/sites/admin.ee2x.cn/ssl/fullchain.pem
cp /etc/letsencrypt/live/admin.ee2x.cn/privkey.pem /opt/1panel/www/sites/admin.ee2x.cn/ssl/privkey.pem
chmod 600 /opt/1panel/www/sites/admin.ee2x.cn/ssl/privkey.pem
cat >> "$site" <<'HTTPS'
server {
    listen 443 ssl;
    http2 on;
    server_name admin.ee2x.cn;
    ssl_certificate /www/sites/admin.ee2x.cn/ssl/fullchain.pem;
    ssl_certificate_key /www/sites/admin.ee2x.cn/ssl/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 64k;
    add_header Strict-Transport-Security "max-age=31536000" always;
    location / {
        proxy_pass http://127.0.0.1:4102;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
HTTPS
docker exec "$container" openresty -t
docker exec "$container" openresty -s reload
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/ee2x-auth.sh <<'HOOK'
#!/bin/sh
case " $RENEWED_DOMAINS " in
 *" admin.ee2x.cn "*)
 cp "$RENEWED_LINEAGE/fullchain.pem" /opt/1panel/www/sites/admin.ee2x.cn/ssl/fullchain.pem
 cp "$RENEWED_LINEAGE/privkey.pem" /opt/1panel/www/sites/admin.ee2x.cn/ssl/privkey.pem
 chmod 600 /opt/1panel/www/sites/admin.ee2x.cn/ssl/privkey.pem
 container=$(docker ps --format '{{.Names}}' | sed -n '/^1Panel-openresty-/p' | head -n 1)
 docker exec "$container" openresty -t && docker exec "$container" openresty -s reload
 ;;
esac
HOOK
chmod 700 /etc/letsencrypt/renewal-hooks/deploy/ee2x-auth.sh
systemctl enable --now certbot.timer
curl -fsS https://admin.ee2x.cn/api/v1/health
systemctl is-active ee2x-auth
