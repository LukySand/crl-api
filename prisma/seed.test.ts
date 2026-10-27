// Requiere la base de test: `bun run test:db` y luego `bun test prisma/seed.test.ts`.
// El seed no exporta nada y corre `main()` al importarse, así que se lo ejecuta como
// proceso: hereda DATABASE_URL (ya apuntada a la base de test por src/test/setup.ts).
import { expect, test } from "bun:test";
import prisma from "../src/lib/prisma";

function correrSeed() {
  const r = Bun.spawnSync(["bun", "prisma/seed.ts"], {
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
}

async function contar() {
  return {
    tipos: await prisma.chargeType.count(),
    plantillas: await prisma.recurringTemplate.count(),
    pagos: await prisma.payment.count(),
    liquidaciones: await prisma.paymentTransaction.count({ where: { id: { startsWith: "seed:" } } }),
  };
}

test("el seed es idempotente: dos corridas no duplican nada", async () => {
  correrSeed();
  const primera = await contar();
  correrSeed();
  expect(await contar()).toEqual(primera);
  expect(primera.tipos).toBe(5);
  expect(primera.plantillas).toBe(2);
}, 120_000);

test("toda fila Pagado sembrada tiene su liquidación", async () => {
  correrSeed();
  const sinLiquidacion = await prisma.payment.count({
    where: { status: "Pagado", ref: { not: { startsWith: "test:" } }, items: { none: {} } },
  });
  expect(sinLiquidacion).toBe(0);
  expect(await prisma.payment.count({ where: { name: "" } })).toBe(0);
}, 120_000);
