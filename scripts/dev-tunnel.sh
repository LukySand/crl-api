#!/usr/bin/env bash
#
# Backend en dev + túnel de ngrok, para probar Mercado Pago de punta a punta.
#
#   bun run dev:tunnel
#
# El túnel apunta al FRONT (:3000), no a este backend: la vuelta del checkout
# (back_urls) son páginas del SPA, y el webhook entra por el proxy /api/* del
# front. Así que crl-web tiene que estar corriendo aparte con `bun dev`.
#
# MP_BACK_URL_BASE y MP_NOTIFICATION_URL se arman acá desde NGROK_DOMAIN y se
# exportan antes de arrancar: dotenv no pisa variables ya definidas, así que le
# ganan al .env sin tocarlo.

set -euo pipefail

cd "$(dirname "$0")/.."

die() { printf '\n✗ %s\n\n' "$1" >&2; exit 1; }

command -v ngrok >/dev/null || die "Falta ngrok: brew install ngrok"
[[ -f .env ]] || die "No hay .env acá. Copiá .env.example y completalo."

# Sin `source`: el .env tiene valores con espacios y comillas (igual que probar-webhook.sh).
leer_env() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

DOMAIN="${NGROK_DOMAIN:-$(leer_env NGROK_DOMAIN || true)}"
[[ -n "$DOMAIN" ]] || die "Poné NGROK_DOMAIN=tu-dominio.ngrok-free.dev en el .env (el estático de tu cuenta de ngrok)."

export MP_BACK_URL_BASE="https://$DOMAIN"
export MP_NOTIFICATION_URL="https://$DOMAIN/api/webhooks/mercadopago"

ngrok http --url="$DOMAIN" 3000 --log=stdout --log-level=warn > /tmp/crl-ngrok.log 2>&1 &
NGROK_PID=$!
trap 'kill $NGROK_PID 2>/dev/null || true' EXIT INT TERM

# El inspector local de ngrok responde cuando el túnel ya está arriba.
for _ in {1..20}; do
  curl -fs http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1 && break
  kill -0 $NGROK_PID 2>/dev/null || die "ngrok no arrancó:
$(cat /tmp/crl-ngrok.log)"
  sleep 0.5
done

printf '\n✓ Túnel  https://%s → localhost:3000 (front)\n' "$DOMAIN"
printf '  Webhook %s\n' "$MP_NOTIFICATION_URL"
printf '  Inspector http://127.0.0.1:4040\n'
printf '  Acordate: crl-web tiene que estar corriendo (bun dev).\n\n'

bun --hot src/server.ts
