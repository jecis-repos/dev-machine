#!/usr/bin/env bash
set -euo pipefail

# Generate local TLS certificates using mkcert.
# Usage: bash scripts/generate-certs.sh [domain_suffix]

DOMAIN_SUFFIX="${DEVMACHINE_DOMAIN_SUFFIX:-app.test}"
CERT_DIR="${DEVMACHINE_CERT_DIR:-_docker/caddy/certs}"

mkdir -p "$CERT_DIR"

if ! command -v mkcert &>/dev/null; then
  echo "Error: mkcert is not installed."
  echo "Install: https://github.com/FiloSottile/mkcert#installation"
  exit 1
fi

# Install local CA if not already done
mkcert -install 2>/dev/null || true

# Generate wildcard cert for *.app.test (or custom suffix)
mkcert \
  -cert-file "$CERT_DIR/local.pem" \
  -key-file "$CERT_DIR/local-key.pem" \
  "*.${DOMAIN_SUFFIX}" \
  "${DOMAIN_SUFFIX}" \
  localhost \
  127.0.0.1 \
  ::1

echo "Certificates generated in $CERT_DIR/"
echo "  *.${DOMAIN_SUFFIX} — wildcard for all instances"
