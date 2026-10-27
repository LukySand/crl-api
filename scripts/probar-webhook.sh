#!/usr/bin/env bash
#
# Dispara una notificación FIRMADA contra nuestro webhook, sin Mercado Pago.
#
#   bash scripts/probar-webhook.sh                 # contra localhost:3001
#   bash scripts/probar-webhook.sh <data-id>       # con un id de pago real
#   URL=https://tu-tunel.ngrok-free.dev bash scripts/probar-webhook.sh
#   MODO=simulador bash scripts/probar-webhook.sh  # id sólo en el body
#
# ponytail: existe porque el simulador del panel de Mercado Pago no es confiable
# — devuelve 1111/timeout y 1111/503 sin que la request llegue siquiera al túnel
# (verificado en el inspector de ngrok: cero requests de MP). Firmar nosotros es
# quince líneas de openssl y prueba MÁS: la firma, la ruta, el túnel y la base.
#
# El secreto sale del .env, nunca de un argumento: un argumento queda en el
# historial del shell.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  B=$(tput bold); G=$(tput setaf 2); Y=$(tput setaf 3); R=$(tput setaf 1); D=$(tput dim); N=$(tput sgr0)
else B=""; G=""; Y=""; R=""; D=""; N=""; fi

die() { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N"; exit 1; }

[[ -f .env ]] || die "No hay .env acá. Copiá .env.example y completalo."

# Se lee sin `source` a propósito: el .env tiene valores con espacios y comillas
# (SMTP_FROM, por ejemplo) que romperían el shell.
leer_env() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

SECRET=$(leer_env MP_WEBHOOK_SECRET)
[[ -n "$SECRET" ]] || die "MP_WEBHOOK_SECRET está vacío en .env — verifySignature() rechaza todo sin eso."

URL="${URL:-http://localhost:3001}"
DATA_ID="${1:-123123123}"
MODO="${MODO:-real}"

# Mercado Pago manda el ts en segundos epoch y un request-id tipo uuid.
TS=$(date +%s)
REQUEST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# El manifest omite el par que no vino, y el data.id va en minúsculas.
# Ver el encabezado de verifySignature() en src/lib/mercadopago.ts.
ID_LOWER=$(printf '%s' "$DATA_ID" | tr '[:upper:]' '[:lower:]')

if [[ "$MODO" == "simulador" ]]; then
  # Lo que manda el simulador del panel: el id sólo en el body, así que por
  # query no llega nada y el par `id:` NO entra al manifest.
  MANIFEST="request-id:${REQUEST_ID};ts:${TS};"
  QS=""
  printf '%s  modo simulador: data.id sólo en el body, manifest sin el par id:%s\n' "$D" "$N"
else
  # Lo que manda una notificación real de Checkout Pro.
  MANIFEST="id:${ID_LOWER};request-id:${REQUEST_ID};ts:${TS};"
  QS="?data.id=${DATA_ID}&type=payment"
fi

V1=$(printf '%s' "$MANIFEST" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')

printf '\n%s→ POST%s %s/api/webhooks/mercadopago%s\n' "$B" "$N" "$URL" "$QS"
printf '%s  manifest: %s%s\n\n' "$D" "$MANIFEST" "$N"

RESP=$(curl -s -w '\n%{http_code} %{time_total}' --max-time 30 \
  -X POST "${URL}/api/webhooks/mercadopago${QS}" \
  -H "Content-Type: application/json" \
  -H "x-signature: ts=${TS},v1=${V1}" \
  -H "x-request-id: ${REQUEST_ID}" \
  -d "{\"type\":\"payment\",\"action\":\"payment.updated\",\"data\":{\"id\":\"${DATA_ID}\"}}" 2>&1) \
  || die "No pude llegar a ${URL}. ¿Está corriendo 'bun dev'?"

CODIGO=$(printf '%s' "$RESP" | tail -1 | cut -d' ' -f1)
TIEMPO=$(printf '%s' "$RESP" | tail -1 | cut -d' ' -f2)
CUERPO=$(printf '%s' "$RESP" | sed '$d')

printf '  respuesta: %s  (%ss)\n  %s\n\n' "$CODIGO" "$TIEMPO" "$CUERPO"

case "$CODIGO" in
  200) printf '%s✓ La firma validó y el webhook procesó la notificación.%s\n' "$G" "$N"
       printf '%s  "pago-inexistente" = el data.id no existe en Mercado Pago.%s\n' "$D" "$N"
       printf '%s  "unknown" = existe en MP pero no es un Payment nuestro.%s\n' "$D" "$N"
       printf '%s  Los dos son lo esperado con un id inventado: la firma es lo que se probó.%s\n' "$D" "$N"
       printf '%s  Pasale el id de un pago real para recorrer el camino completo.%s\n' "$D" "$N" ;;
  401) printf '%s✗ Firma rechazada.%s El MP_WEBHOOK_SECRET del .env no es el mismo\n' "$R" "$N"
       printf '  que el de la pestaña del panel (Modo de prueba / Modo productivo) que estás usando.\n' ;;
  500) printf '%s✗ La firma pasó, pero falló al procesar.%s Mirá el log de bun dev:\n' "$Y" "$N"
       printf '  suele ser la API de Mercado Pago (data.id inexistente) o la base.\n' ;;
  000) printf '%s✗ Sin respuesta: se colgó o no hay nadie escuchando.%s\n' "$R" "$N" ;;
  *)   printf '%s✗ Código inesperado.%s Si es 502/503 y apuntaste a un túnel, es el túnel, no la app.\n' "$R" "$N" ;;
esac
printf '\n'
