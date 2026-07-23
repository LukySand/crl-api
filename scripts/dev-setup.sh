#!/usr/bin/env bash
# Levanta la DB, genera Prisma, aplica el schema y siembra los roles. Idempotente.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "✗ Falta .env — copialo con: cp .env.example .env  y completá los valores"
  exit 1
fi

echo "▶ Levantando MySQL (docker compose)..."
docker compose up -d db

echo "▶ Esperando a que MySQL esté healthy..."
until [ "$(docker inspect -f '{{.State.Health.Status}}' mysql-dev 2>/dev/null || true)" = "healthy" ]; do
  sleep 2
  echo "  ...esperando DB"
done

echo "▶ Generando cliente Prisma..."
bunx --bun prisma generate

echo "▶ Aplicando schema a la DB..."
bunx --bun prisma db push

echo "▶ Sembrando roles (Administrador / Profesor / Socio)..."
bunx --bun prisma db seed

echo "✅ Backend listo. Arrancá con: bun dev"
