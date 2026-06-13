#!/usr/bin/env bash
# ============================================================
#  aios-site-remove — tear down the nginx vhost for ONE domain (cert optional).
#
#  Root-owned at /usr/local/sbin/aios-site-remove; invoked by `aios` via sudoers.
#  Does NOT touch the site's files under /opt/ai-os/sites/<domain>/ (the app, running
#  as aios, owns and removes those itself). This only undoes the root-side nginx/TLS.
#
#  Usage: aios-site-remove <domain> [--cert]
#    --cert  also delete the Let's Encrypt certificate for <domain>
# ============================================================
set -euo pipefail
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
IFS=$' \t\n'
unset BASH_ENV ENV CDPATH 2>/dev/null || true

DOMAIN="${1:-}"
DROP_CERT="${2:-}"

# Domain validation — positive char allowlist first (rejects newline/meta), then a
# whole-string FQDN match. See site-vhost.sh for why per-line grep was unsafe.
case "$DOMAIN" in
  '')            echo "aios-site-remove: empty domain" >&2; exit 2 ;;
  *[!a-z0-9.-]*) echo "aios-site-remove: invalid domain '$DOMAIN'" >&2; exit 2 ;;
esac
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
[[ "$DOMAIN" =~ $DOMAIN_RE ]] || { echo "aios-site-remove: invalid domain '$DOMAIN'" >&2; exit 2; }
[ "$DROP_CERT" = "" ] || [ "$DROP_CERT" = "--cert" ] || { echo "aios-site-remove: bad flag '$DROP_CERT'" >&2; exit 2; }

rm -f "/etc/nginx/sites-enabled/aios-site-${DOMAIN}"
rm -f "/etc/nginx/sites-available/aios-site-${DOMAIN}"

# Reload only if the remaining config is valid; never leave nginx unreloadable.
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
else
  echo "aios-site-remove: warning — nginx -t failed after removal; not reloading" >&2
fi

if [ "$DROP_CERT" = "--cert" ]; then
  certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1 || true
fi

echo "aios-site-remove: ok ${DOMAIN}"
