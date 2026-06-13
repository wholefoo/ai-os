#!/usr/bin/env bash
# ============================================================
#  aios-site-vhost — render + enable an nginx static vhost for ONE hosted site.
#
#  Installed ROOT-OWNED at /usr/local/sbin/aios-site-vhost (mode 755) by
#  install-vps.sh, and invoked by the unprivileged `aios` user ONLY through the
#  /etc/sudoers.d/aios-hosting allowlist. The DOMAIN is the only caller-supplied
#  value; it is re-validated here (defense in depth) so a compromised app process
#  cannot smuggle command injection or path traversal through sudo. The nginx
#  config is generated INLINE (not from an app-writable template file) for the
#  same reason.
#
#  Usage: aios-site-vhost <domain> [--tls]
#    (no flag) HTTP vhost serving the static site + the ACME challenge location
#    --tls     HTTP->HTTPS redirect + HTTPS vhost (requires an existing cert)
# ============================================================
set -euo pipefail
# Self-defending environment — do not rely solely on the global sudoers
# env_reset/secure_path. Pin PATH and drop shell-init hooks before anything runs.
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
IFS=$' \t\n'
unset BASH_ENV ENV CDPATH 2>/dev/null || true

DOMAIN="${1:-}"
TLS="${2:-}"

# --- Strict domain validation (defense in depth; the REAL gate — a compromised app
# can invoke this binary via sudo directly, bypassing the Node-side check). ---
# A positive char allowlist runs FIRST and rejects any byte outside the FQDN set
# (newline, ';', '{', '}', '/', space, ...). This closes the multi-line-injection
# class: a per-line `grep -Eq` accepts a payload whose first line is a valid domain
# and lets the remaining lines carry nginx directives into a root-written config.
case "$DOMAIN" in
  '')            echo "aios-site-vhost: empty domain" >&2; exit 2 ;;
  *[!a-z0-9.-]*) echo "aios-site-vhost: invalid domain '$DOMAIN'" >&2; exit 2 ;;
esac
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
# bash [[ =~ ]] matches the WHOLE string (not per line like grep) — ^/$ are string anchors.
[[ "$DOMAIN" =~ $DOMAIN_RE ]] || { echo "aios-site-vhost: invalid domain '$DOMAIN'" >&2; exit 2; }
[ "${#DOMAIN}" -le 253 ] || { echo "aios-site-vhost: domain too long" >&2; exit 2; }
[ "$TLS" = "" ] || [ "$TLS" = "--tls" ] || { echo "aios-site-vhost: bad flag '$TLS'" >&2; exit 2; }

SITE_ROOT="/opt/ai-os/sites/${DOMAIN}/current"
ACME_WEBROOT="/var/www/aios-acme"
AVAIL="/etc/nginx/sites-available/aios-site-${DOMAIN}"
ENABLED="/etc/nginx/sites-enabled/aios-site-${DOMAIN}"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

static_body() {
  cat <<EOF
    root ${SITE_ROOT};
    index index.html;
    location / { try_files \$uri \$uri/ \$uri.html /index.html =404; }

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1000;

    location ~* \\.(css|js|svg|png|jpg|jpeg|gif|webp|woff2?|ico)\$ {
        expires 7d;
        add_header Cache-Control "public";
        access_log off;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    location ~ /\\. { deny all; return 404; }
    client_max_body_size 2M;
EOF
}

render() {
  # Port 80 — always present: ACME challenge, plus either the static site (no TLS)
  # or a redirect to HTTPS (TLS).
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name ${DOMAIN};"
  echo "    location ^~ /.well-known/acme-challenge/ { root ${ACME_WEBROOT}; default_type \"text/plain\"; access_log off; }"
  if [ "$TLS" = "--tls" ]; then
    echo "    location / { return 301 https://\$host\$request_uri; }"
    echo "}"
    echo "server {"
    echo "    listen 443 ssl http2;"
    echo "    listen [::]:443 ssl http2;"
    echo "    server_name ${DOMAIN};"
    echo "    ssl_certificate ${CERT_DIR}/fullchain.pem;"
    echo "    ssl_certificate_key ${CERT_DIR}/privkey.pem;"
    echo "    ssl_protocols TLSv1.2 TLSv1.3;"
    echo "    ssl_prefer_server_ciphers on;"
    echo "    ssl_session_cache shared:SSL:10m;"
    echo "    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;"
    static_body
    echo "}"
  else
    static_body
    echo "}"
  fi
}

if [ "$TLS" = "--tls" ] && [ ! -s "${CERT_DIR}/fullchain.pem" ]; then
  echo "aios-site-vhost: --tls requested but no cert at ${CERT_DIR}/fullchain.pem" >&2; exit 3
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
render > "$TMP"

install -o root -g root -m 644 "$TMP" "$AVAIL"
ln -sfn "$AVAIL" "$ENABLED"

# Validate before reloading; on failure pull the symlink so nginx never reloads a broken config.
if ! nginx -t >/dev/null 2>&1; then
  rm -f "$ENABLED" "$AVAIL"
  echo "aios-site-vhost: nginx -t failed; reverted ${DOMAIN}" >&2; exit 4
fi
systemctl reload nginx
echo "aios-site-vhost: ok ${DOMAIN}${TLS:+ (tls)}"
