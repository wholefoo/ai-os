#!/usr/bin/env bash
# ============================================================
#  aios-site-cert — obtain a Let's Encrypt cert for ONE domain via webroot http-01.
#
#  Root-owned at /usr/local/sbin/aios-site-cert; invoked by `aios` via sudoers.
#  Preconditions the CALLER must satisfy first:
#    1. The HTTP vhost exists (aios-site-vhost <domain>) so the ACME challenge is reachable.
#    2. DNS A/AAAA for <domain> already points at this box (the app does a mandatory
#       pre-check — issuing against mispointed DNS burns Let's Encrypt rate limits).
#  On success the caller re-renders TLS with: aios-site-vhost <domain> --tls
#
#  Usage: aios-site-cert <domain>
# ============================================================
set -euo pipefail
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
IFS=$' \t\n'
unset BASH_ENV ENV CDPATH 2>/dev/null || true

DOMAIN="${1:-}"
ACME_WEBROOT="/var/www/aios-acme"
EMAIL_FILE="/etc/aios/acme-email"

# Domain validation — positive char allowlist first (rejects newline/meta), then a
# whole-string FQDN match. See site-vhost.sh for why per-line grep was unsafe.
case "$DOMAIN" in
  '')            echo "aios-site-cert: empty domain" >&2; exit 2 ;;
  *[!a-z0-9.-]*) echo "aios-site-cert: invalid domain '$DOMAIN'" >&2; exit 2 ;;
esac
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
[[ "$DOMAIN" =~ $DOMAIN_RE ]] || { echo "aios-site-cert: invalid domain '$DOMAIN'" >&2; exit 2; }
[ "${#DOMAIN}" -le 253 ] || { echo "aios-site-cert: domain too long" >&2; exit 2; }

mkdir -p "${ACME_WEBROOT}/.well-known/acme-challenge"

# Use a registered email if the operator set one, else register without (still valid certs).
EMAIL="$(cat "$EMAIL_FILE" 2>/dev/null || true)"
if [ -n "$EMAIL" ]; then
  EMAIL_ARGS=(-m "$EMAIL")
else
  EMAIL_ARGS=(--register-unsafely-without-email)
fi

# --keep-until-expiring makes this idempotent: re-running won't re-issue a live cert
# (protects the 5 duplicate-certs/week Let's Encrypt limit).
certbot certonly --webroot -w "$ACME_WEBROOT" -d "$DOMAIN" \
  --non-interactive --agree-tos "${EMAIL_ARGS[@]}" --keep-until-expiring

echo "aios-site-cert: ok ${DOMAIN}"
