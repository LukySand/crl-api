// Requiere la base de test: `bun run test:db` y luego `bun test src/routes`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

/** Crea un socio con tres cobros pendientes: sin vencimiento, lejano y cercano. */
async function escenario() {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  await prisma.chargeType.upsert({
    where: { key: "Otro" },
    update: {},
    create: { key: "Otro", name: "Otro" },
  });
  const sufijo = `${Date.now()}`;
  const filas = [
    { name: "sin-vencimiento", due_date: null },
    { name: "lejano", due_date: new Date("2031-12-31T00:00:00Z") },
    { name: "cercano", due_date: new Date("2031-01-01T00:00:00Z") },
  ];
  for (const f of filas) {
    await prisma.payment.create({
      data: {
        user_id: socio.id,
        concept: "Otro",
        name: f.name,
        amount: 100,
        due_date: f.due_date,
        ref: `test:orden:${sufijo}:${f.name}`,
      },
    });
  }
  return { admin, socio };
}

test("/por-cobrar: los cobros sin vencimiento van al final", async () => {
  const { admin, socio } = await escenario();
  const res = await api("GET", "/api/payments/por-cobrar", { token: admin.token });
  expect(res.status).toBe(200);
  const nombres = res.body.payments
    .filter((p: any) => p.user_id === socio.id)
    .map((p: any) => p.name);
  expect(nombres).toEqual(["cercano", "lejano", "sin-vencimiento"]);
});

test("/resumen: no falla con vencimientos nulos y el próximo es el primero no nulo", async () => {
  const { socio } = await escenario();
  const res = await api("GET", "/api/payments/resumen", { token: socio.token });
  expect(res.status).toBe(200);
  expect(String(res.body.resumen.proximo_vencimiento).slice(0, 10)).toBe("2031-01-01");
});
