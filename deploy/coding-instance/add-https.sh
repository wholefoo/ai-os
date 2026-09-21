#!/usr/bin/env bash
# Put a coding instance's dashboard behind nginx + Let's Encrypt, at a hostname you choose.
#
# Run as root, AFTER provision.sh, AFTER filling in .env:
#     DOMAIN=hermes.example.com bash add-https.sh
# Optional:
#     DOMAIN=... HTTPS_ALLOW_FROM=<your-ip> bash add-https.sh   # only your IP can reach the login page
#     DOMAIN=... CERTBOT_EMAIL=you@example.com bash add-https.sh
#
# The app keeps listening on 127.0.0.1:3000. Only nginx is exposed. Idempotent.

set -euo pipefail

DOMAIN=${DOMAIN:?set DOMAIN to the hostname, e.g. DOMAIN=hermes.example.com bash add-https.sh}
APP_DIR=/home/hermes/work/ai-os
ENV_FILE=$APP_DIR/.env
VHOST=/etc/nginx/sites-available/hermes
WEBROOT=/var/www/letsencrypt

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mREFUSING:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

# ============================================================== PREFLIGHT ===
# Every check below BLOCKS. Nothing is installed or exposed until all pass.

# 1. Do not publish an unauthenticated admin panel. The first boot said
#    "Auth: disabled" because .env was blank; exposing that would hand anyone
#    who finds the hostname the ability to dispatch agents on your API key.
#    Checks for presence only; never prints a value.
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run provision.sh first"
env_set() { grep -Eq "^$1=.+" "$ENV_FILE"; }
missing=""
for k in ADMIN_EMAIL ADMIN_PASSWORD_HASH SESSION_SECRET API_TOKEN; do
  env_set "$k" || missing="$missing $k"
done
[ -z "$missing" ] || die "these are blank in .env:$missing
  Exposing the dashboard now would publish it with authentication DISABLED.
  Fill them in, restart ai-os-hermes, then re-run."

# 2. The app must be up, and on loopback only.
systemctl is-active --quiet ai-os-hermes || die "ai-os-hermes is not running (systemctl start ai-os-hermes)"
ss -tln | grep -q '127.0.0.1:3000 ' || die "nothing listening on 127.0.0.1:3000"
if ss -tln | grep -Eq '(0\.0\.0\.0|\[::\]|\*):3000 '; then
  die "port 3000 is bound to ALL interfaces. Remove HOST= from .env and restart; nginx is the only thing that should face the internet"
fi

# 3. The RUNNING process must have picked the values up — .env is read only at
#    start, and a duplicate key later in the file silently wins. Do not test this
#    with an anonymous request: in production the app fails CLOSED even with a
#    blank API_TOKEN, so a 401 would pass on the blank template too. Read what
#    this exact invocation of the service logged at boot instead.
INV=$(systemctl show -p InvocationID --value ai-os-hermes)
BOOTLOG=$(journalctl --no-pager -o cat _SYSTEMD_INVOCATION_ID="$INV" 2>/dev/null)
echo "$BOOTLOG" | grep -q 'Auth: enabled' || die "the running app logged 'Auth: disabled' — API_TOKEN did not reach it.
  Restart after filling .env:  systemctl restart ai-os-hermes"
if echo "$BOOTLOG" | grep -q 'No admin seeded'; then
  die "the running app logged 'No admin seeded' — there is no account to log in with.
  Check ADMIN_EMAIL / ADMIN_PASSWORD_HASH, then: systemctl restart ai-os-hermes"
fi

# 4. DNS must point straight at THIS box. If Cloudflare's proxy (orange cloud)
#    is on, the name resolves to Cloudflare, the certificate challenge fails,
#    and HTTPS_ALLOW_FROM would see only Cloudflare's addresses.
MY_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
[ -n "$DNS_IP" ] || die "$DOMAIN does not resolve"
[ "$DNS_IP" = "$MY_IP" ] || die "$DOMAIN resolves to $DNS_IP, but this box is $MY_IP.
  In Cloudflare, set the record to 'DNS only' (grey cloud) pointing at $MY_IP."

log "Preflight passed: auth enforced, app on loopback, $DOMAIN -> $MY_IP"

# ================================================================ INSTALL ===
log "Installing nginx and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq nginx certbot
rm -f /etc/nginx/sites-enabled/default

# Rate-limit zone (http{} context). A second line of defence behind the app's
# own limiter, and it slows password guessing against the login form.
cat > /etc/nginx/conf.d/hermes-limits.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=hermes_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=hermes_login:10m rate=10r/m;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF

# =============================================================== FIREWALL ===
# 80 stays open to everyone: certificate renewal needs it, and all it does is
# redirect to HTTPS. 443 can be narrowed to your IP.
log "Opening 80 and 443"
ufw allow 80/tcp >/dev/null
if [ -n "${HTTPS_ALLOW_FROM:-}" ]; then
  ufw allow from "$HTTPS_ALLOW_FROM" to any port 443 proto tcp >/dev/null
  log "443 restricted to $HTTPS_ALLOW_FROM"
else
  ufw allow 443/tcp >/dev/null
fi

# ============================================================ CERTIFICATE ===
install -d -m 0755 "$WEBROOT"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  log "Serving the ACME challenge over plain HTTP to obtain the first certificate"
  cat > "$VHOST" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 404; }
}
EOF
  ln -sfn "$VHOST" /etc/nginx/sites-enabled/hermes
  nginx -t
  systemctl reload nginx

  log "Requesting a certificate for $DOMAIN"
  if [ -n "${CERTBOT_EMAIL:-}" ]; then EMAIL_ARGS=(--email "$CERTBOT_EMAIL"); else EMAIL_ARGS=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --agree-tos --non-interactive "${EMAIL_ARGS[@]}" \
    --deploy-hook "systemctl reload nginx"
else
  log "Certificate already present, skipping issuance"
fi

# ================================================================== VHOST ===
log "Writing the HTTPS vhost"
BACKUP=""
[ -f "$VHOST" ] && BACKUP=$(mktemp) && cp "$VHOST" "$BACKUP"

cat > "$VHOST" <<EOF
# Hermes-Dev dashboard — generated by add-https.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:HERMES_SSL:10m;
    ssl_session_timeout 10m;

    # No 'preload' and no includeSubDomains: this is one host on a domain whose
    # other names are not ours to commit to HTTPS-forever.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # Nobody but you should be finding this in a search engine.
    add_header X-Robots-Tag "noindex, nofollow" always;

    client_max_body_size 25M;

    # Never serve repo internals, even if a route ever tried to.
    location ~ /\.(env|git|magent|claude) { return 404; }
    location ~ /(state|vault|artifacts)/  { return 404; }

    # The Hermes MCP endpoint has no auth of its own. Closed, as on production.
    location /hermes/ { return 403; }

    # Login: throttled hard. 10/min per IP is plenty for a human. EXACT match on
    # purpose — the dashboard calls /api/auth/me on every page load, and a
    # /api/auth/ prefix here would 503 ordinary refreshing.
    location = /api/auth/login {
        limit_req zone=hermes_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        limit_req zone=hermes_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    # Everything else, INCLUDING the WebSocket: the app attaches its WebSocket
    # server to the same HTTP server on any path, so upgrade headers go here,
    # not on one /ws block that could miss the path the client really uses.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF
ln -sfn "$VHOST" /etc/nginx/sites-enabled/hermes

# A config that does not parse must not replace one that does.
if ! nginx -t 2>/dev/null; then
  nginx -t || true
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$VHOST"; warn "restored the previous vhost"; fi
  die "nginx -t failed; nothing reloaded"
fi
systemctl reload nginx

# ================================================================ APP URL ===
# The app builds absolute links (provenance, emails, OAuth callbacks) from
# AIOS_PUBLIC_URL; without it they would say http://127.0.0.1:3000.
log "Setting AIOS_PUBLIC_URL"
if grep -q '^AIOS_PUBLIC_URL=' "$ENV_FILE"; then
  sed -i "s|^AIOS_PUBLIC_URL=.*|AIOS_PUBLIC_URL=https://$DOMAIN|" "$ENV_FILE"
else
  printf '\n# Public address, behind nginx (set by add-https.sh)\nAIOS_PUBLIC_URL=https://%s\n' "$DOMAIN" >> "$ENV_FILE"
fi
systemctl restart ai-os-hermes
for i in $(seq 1 20); do ss -tln | grep -q '127.0.0.1:3000 ' && break; sleep 1; done

# ================================================================= VERIFY ===
# Tested the way a browser will reach it: real DNS, real certificate checks, no -k.
log "Verifying"
set +e
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
URL="https://$DOMAIN"

check "certificate valid for 30+ days" \
  "openssl x509 -checkend 2592000 -noout -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem"
check "HTTPS answers with a trusted certificate" \
  "curl -sS -o /dev/null --max-time 10 $URL/"
check "HTTP redirects to HTTPS" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' http://$DOMAIN/x)\" = '301 $URL/x' ]"
check "HSTS header sent" \
  "curl -sI $URL/ | grep -qi '^strict-transport-security:'"
check "unauthenticated API refused through nginx" \
  "curl -s -o /dev/null -w '%{http_code}' $URL/api/hermes/tasks | grep -Eq '^(401|403)$'"
check "WebSocket upgrade reaches the app's auth (401, not 400/502)" \
  "curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' $URL/ | grep -q '^401$'"
check "/hermes/ MCP path closed" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $URL/hermes/)\" = 403 ]"
check "/.env not served" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $URL/.env)\" = 404 ]"
check "port 3000 not exposed" \
  "! ss -tln | grep -Eq '(0\.0\.0\.0|\[::\]|\*):3000 '"
check "ufw does not open 3000" \
  "! ufw status | grep -q '^3000'"
check "certificate renewal works (dry run)" \
  "certbot renew --dry-run --cert-name $DOMAIN"

# The one check that proves the whole path: a REAL login through HTTPS. It
# exercises the bcrypt hash surviving .env parsing, the admin seed, and the
# Secure session cookie (which a browser would silently drop over plain HTTP).
# Asked for only on an interactive terminal; the password goes to curl through
# stdin, never argv, and is not stored.
if [ -t 0 ]; then
  echo
  read -r -p "  Admin email to test a real login (Enter to skip): " LOGIN_EMAIL
  if [ -n "$LOGIN_EMAIL" ]; then
    read -r -s -p "  Password: " LOGIN_PW; echo
    HDRS=$(E="$LOGIN_EMAIL" P="$LOGIN_PW" jq -n '{email:env.E,password:env.P}' \
      | curl -s -D - -o /dev/null -H 'Content-Type: application/json' --data @- "$URL/api/auth/login")
    unset LOGIN_PW
    check "real login over HTTPS succeeds" \
      "echo \"\$HDRS\" | head -1 | grep -q ' 200'"
    check "session cookie is Secure + HttpOnly" \
      "echo \"\$HDRS\" | grep -i '^set-cookie: ai-os-session=' | grep -qi 'secure' && echo \"\$HDRS\" | grep -i '^set-cookie: ai-os-session=' | grep -qi 'httponly'"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  cat <<DONE
Done. Open $URL and log in with ADMIN_EMAIL and your password.

The SSH tunnel is no longer needed. Renewal runs automatically (certbot.timer)
and reloads nginx when a new certificate lands.
DONE
else
  echo "Some checks FAILED above. The vhost is live; fix before relying on it."
  exit 1
fi
