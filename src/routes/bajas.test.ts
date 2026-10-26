// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/bajas.test.ts`.
// Parte 1 (D21): la baja anula los períodos posteriores al mes de la baja y deja
// intacto el del mes, en formato mensual ("YYYY-MM") y diario ("YYYY-MM-DD").
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { periodoActual, periodoSiguiente } from "../lib/payment-period";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(async () => {
  await startTestServer();
  await prisma.chargeType.upsert({
    where: { key: "Disciplina" },
    update: {},
    create: { key: "Disciplina", name: "Cuota de disciplina", system: true },
  });
});
afterAll(stopTestServer);

async function escenario() {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const discipline = await prisma.discipline.create({ data: { name: `Baja ${Date.now()}` } });
  const enrollment = await prisma.enrollment.create({
    data: { user_id: socio.id, discipline_id: discipline.id },
  });
  const actual = periodoActual();
  const siguiente = periodoSiguiente(actual);
  const periods = [actual, `${actual}-15`, siguiente, `${siguiente}-03`];
  const payments = await Promise.all(
    periods.map((period) =>
      prisma.payment.create({
        data: {
          user_id: socio.id,
          concept: "Disciplina",
          name: `Cuota ${period}`,
          enrollment_id: enrollment.id,
          amount: 1000,
          period,
          ref: `disciplina:${enrollment.id}:${period}`,
        },
      }),
    ),
  );
  return { admin, discipline, enrollment, payments };
}

const estados = (ids: string[]) =>
  prisma.payment.findMany({ where: { id: { in: ids } }, orderBy: { period: "asc" } });

test("desinscribirse conserva el mes de la baja (mensual y diario) y anula el siguiente", async () => {
  const { admin, enrollment, payments } = await escenario();
  const res = await api("DELETE", `/api/enrollments/${enrollment.id}`, { token: admin.token });
  expect(res.status).toBe(200);
  const filas = await estados(payments.map((p) => p.id));
  expect(filas.map((f) => f.status)).toEqual(["Pendiente", "Pendiente", "Anulado", "Anulado"]);
});

test("dar de baja la disciplina conserva el mes de la baja y anula el siguiente", async () => {
  const { admin, discipline, payments } = await escenario();
  const res = await api("DELETE", `/api/disciplines/${discipline.id}`, { token: admin.token });
  expect(res.status).toBe(200);
  const filas = await estados(payments.map((p) => p.id));
  expect(filas.map((f) => f.status)).toEqual(["Pendiente", "Pendiente", "Anulado", "Anulado"]);
});
