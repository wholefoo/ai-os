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
TLS=""
ALLOW_SCHEME_CHANGE=0
shift 2>/dev/null || true
for a in "$@"; do
  case "$a" in
    --tls)                  TLS="--tls" ;;
    --allow-scheme-change)  ALLOW_SCHEME_CHANGE=1 ;;
    '')                     ;;
    *) echo "aios-site-vhost: bad flag '$a'" >&2; exit 2 ;;
  esac
done

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

SITE_ROOT="/opt/ai-os/sites/${DOMAIN}/current"
ACME_WEBROOT="/var/www/aios-acme"
AVAIL="/etc/nginx/sites-available/aios-site-${DOMAIN}"
ENABLED="/etc/nginx/sites-enabled/aios-site-${DOMAIN}"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

# --- SCHEME-CHANGE GUARD (added 2026-08-10 after this script took a live site down) ---
#
# Re-rendering an EXISTING site with the opposite scheme silently rewrites what port 80 does, and
# for a site behind a CDN in flexible-TLS mode that is an outage, not a config tweak. Concretely:
# aiserp.org served HTTP-only at the origin because Cloudflare terminated TLS and connected back
# over port 80. Re-rendering it with --tls replaced the port-80 content block with
# `return 301 https://...`, so the CDN fetched over HTTP, got a redirect to HTTPS, handed it to the
# browser, and the browser came back through the CDN over HTTP again. Infinite loop, whole site
# down. `nginx -t` passed and this script reported `ok` — nothing in the machinery could see it.
#
# The promotion in attachDomainWithTls() is a LEGITIMATE scheme change (render HTTP, issue cert,
# re-render TLS), so this cannot simply forbid them. The difference is intent: that flow knows it is
# promoting and passes --allow-scheme-change. A human re-rendering an established site does not, and
# is exactly who needs stopping.
#
# Only fires when a vhost ALREADY exists, so first-time renders are unaffected, and a re-render at
# the SAME scheme — the routine case, e.g. picking up a template fix — is never blocked.
if [ -f "$AVAIL" ]; then
  if grep -qE '^[[:space:]]*listen[[:space:]]+443' "$AVAIL"; then CURRENT_SCHEME=tls; else CURRENT_SCHEME=http; fi
  if [ "$TLS" = "--tls" ]; then WANTED_SCHEME=tls; else WANTED_SCHEME=http; fi
  if [ "$CURRENT_SCHEME" != "$WANTED_SCHEME" ] && [ "$ALLOW_SCHEME_CHANGE" != "1" ]; then
    echo "aios-site-vhost: REFUSING to change ${DOMAIN} from ${CURRENT_SCHEME} to ${WANTED_SCHEME}." >&2
    echo "  The existing vhost serves ${CURRENT_SCHEME} at the origin. Changing that rewrites what" >&2
    echo "  port 80 does and can take the site down — a CDN terminating TLS in flexible mode will" >&2
    echo "  loop on the resulting redirect. This script cannot see your CDN's TLS mode." >&2
    if [ "$WANTED_SCHEME" = "tls" ]; then
      echo "  If you only meant to re-apply the template, drop --tls and re-run." >&2
    else
      echo "  If you only meant to re-apply the template, add --tls and re-run." >&2
    fi
    echo "  If you REALLY mean to change the scheme, pass --allow-scheme-change." >&2
    exit 5
  fi
fi

# --- Security headers, emitted at the server level AND repeated inside every location block that
# declares an add_header of its own. ---
# nginx does NOT inherit add_header into a block that sets any add_header: one
# `add_header Cache-Control` in a child REPLACES the entire parent set rather than adding to it.
# The static-asset location below sets Cache-Control, so before this every .css/.js/.woff2 on
# EVERY hosted client site was served without nosniff — on the path that serves JavaScript.
# Same defect class as AS-03 in deploy/nginx.conf; found here by `nginx -t` on 2026-08-10, in the
# customer-facing generator rather than the admin dashboard.
# The repetition is required by nginx semantics. Do not de-duplicate it, and if you add another
# location block that sets any header, call this there too.
sec_headers() {
  local ind="${1:-    }"
  echo "${ind}add_header X-Content-Type-Options \"nosniff\" always;"
  echo "${ind}add_header Referrer-Policy \"strict-origin-when-cross-origin\" always;"
  # HSTS only on the TLS vhost: sending it over plain HTTP is ignored by browsers by spec, and
  # emitting it there would be a claim the server cannot honour.
  if [ "$TLS" = "--tls" ]; then
    echo "${ind}add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;"
  fi
}

# --- HTTP/2 directive form, chosen from the LOCAL nginx version. ---
# nginx 1.25.1 deprecated `listen ... ssl http2` in favour of a separate `http2` directive. The
# modern form is a HARD ERROR on older builds — and this script writes configs for LIVE CLIENT
# SITES, so the fallback must be the form that is valid everywhere. Deprecated-but-working beats
# modern-but-fatal: an unparseable vhost takes nginx's whole reload down, not just one site.
# If the version cannot be determined, we assume old. Failing safe here means failing deprecated.
# The probe must not be able to KILL this script. `set -euo pipefail` is on and PATH is pinned
# above, so a bare `VER="$(nginx -v | ...)"` exits the whole run when nginx is absent from the
# pinned PATH — which would abort a site deploy rather than fall back, the exact opposite of the
# intent stated above. Guard the lookup and swallow the status explicitly.
NGINX_VER=""
if command -v nginx >/dev/null 2>&1; then
  NGINX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p' || true)"
fi
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
if [ -n "$NGINX_VER" ] && ver_ge "$NGINX_VER" "1.25.1"; then HTTP2_MODERN=1; else HTTP2_MODERN=0; fi

listen_tls() {
  if [ "$HTTP2_MODERN" = "1" ]; then
    echo "    listen 443 ssl;"
    echo "    listen [::]:443 ssl;"
    echo "    http2 on;"
  else
    echo "    listen 443 ssl http2;"
    echo "    listen [::]:443 ssl http2;"
  fi
}

static_body() {
  cat <<EOF
    root ${SITE_ROOT};
    index index.html;
    # vhost-attributed analytics (format defined in /etc/nginx/conf.d/aios-logformat.conf;
    # if that drop-in is absent nginx -t fails loudly rather than silently losing attribution)
    access_log /var/log/nginx/access.log aios_vhost;
    location / { try_files \$uri \$uri/ \$uri.html /index.html =404; }

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1000;

    location ~* \\.(css|js|svg|png|jpg|jpeg|gif|webp|woff2?|ico)\$ {
        expires 7d;
        add_header Cache-Control "public";
$(sec_headers "        ")
        access_log off;
    }

$(sec_headers "    ")
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
    listen_tls
    echo "    server_name ${DOMAIN};"
    echo "    ssl_certificate ${CERT_DIR}/fullchain.pem;"
    echo "    ssl_certificate_key ${CERT_DIR}/privkey.pem;"
    echo "    ssl_protocols TLSv1.2 TLSv1.3;"
    echo "    ssl_prefer_server_ciphers on;"
    echo "    ssl_session_cache shared:SSL:10m;"
    # HSTS is emitted by sec_headers() inside static_body — at the server level AND inside the
    # asset location, which is the whole point. It was previously here only, and therefore absent
    # from every static asset.
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
