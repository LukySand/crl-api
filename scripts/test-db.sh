#!/usr/bin/env bash
# Levanta la base de test y le aplica el schema.
#
# Es aparte de la de dev a propósito: los tests de ruta escriben y borran.
# Corré esto una vez; después `bun test` la reusa.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

URL="${DATABASE_URL_TEST:-}"
if [[ -z "$URL" ]]; then
  echo "❌ Falta DATABASE_URL_TEST en el .env. Copiá la línea de .env.example."
  exit 1
fi

echo "▸ levantando mysql-test (puerto 3307)..."
docker compose up -d db_test

echo "▸ esperando que esté healthy..."
for _ in $(seq 1 40); do
  estado=$(docker inspect -f '{{.State.Health.Status}}' mysql-test 2>/dev/null || echo "starting")
  [[ "$estado" == "healthy" ]] && break
  sleep 2
done
[[ "$estado" == "healthy" ]] || { echo "❌ mysql-test no arrancó"; exit 1; }

echo "▸ aplicando el schema..."
# db push y no migrate: la base de test es efímera y se arma desde cero, así que
# no hay historial que preservar ni drift posible.
bunx --bun prisma db push --url "$URL" --accept-data-loss

echo "✅ base de test lista."
