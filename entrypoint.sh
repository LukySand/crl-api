#!/bin/bash
set -e

echo "Running migrations..."
bunx prisma migrate deploy --config prisma.config.ts

echo "Running seed..."
bunx prisma db seed

echo "Starting API..."
exec bun src/server.ts
