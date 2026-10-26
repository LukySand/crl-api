// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/payment-collect.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

let n = 0;
async function cuota(userId: string, concept: string, extra: Record<string, unknown> = {}) {
  await prisma.chargeType.upsert({ where: { key: concept }, update: {}, create: { key: concept, name: concept } });
  return prisma.payment.create({
    data: {
      user_id: userId,
      concept,
      name: `t-${concept}`,
      amount: 100,
      ref: `test:collect:${Date.now()}:${++n}`,
      ...extra,
    },
  });
}

test("cobro multiple: una liquidacion Aprobado, filas Pagado con el metodo", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  const b = await cuota(socio.id, "Otro");
  const r = await api("POST", "/api/payments/cobro", {
    token: admin.token,
    body: { payment_ids: [a.id, b.id], method: "TarjetaConPosnet" },
  });
  expect(r.status).toBe(200);
  expect(r.body.liquidacion.status).toBe("Aprobado");
  const filas = await prisma.payment.findMany({ where: { id: { in: [a.id, b.id] } } });
  expect(filas.every((f) => f.status === "Pagado" && f.method === "TarjetaConPosnet")).toBe(true);
  const liq = await prisma.paymentTransaction.findUnique({ where: { id: r.body.liquidacion.id }, include: { items: true } });
  expect(liq?.items).toHaveLength(2);
  expect(Number(liq?.amount)).toBe(200);
});

test("cobro: MercadoPago no es metodo manual (400)", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  const r = await api("POST", `/api/payments/${a.id}/cobro`, { token: admin.token, body: { method: "MercadoPago" } });
  expect(r.status).toBe(400);
});

test("cobro: socios distintos 400, deuda propia 403, socio 403, Reserva mezclada 400", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const s1 = await makeUser({ roles: ["Socio"] });
  const s2 = await makeUser({ roles: ["Socio"] });
  const a = await cuota(s1.id, "Otro");
  const b = await cuota(s2.id, "Otro");
  expect((await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [a.id, b.id] } })).status).toBe(400);
  const propia = await cuota(admin.id, "Otro");
  expect((await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [propia.id] } })).status).toBe(403);
  expect((await api("POST", `/api/payments/${a.id}/cobro`, { token: s1.token, body: {} })).status).toBe(403);
  const res = await cuota(s1.id, "Reserva");
  expect((await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [a.id, res.id] } })).status).toBe(400);
});

test("profesor: solo efectivo, solo su disciplina, EnRevision 403", async () => {
  const profe = await makeUser({ roles: ["Profesor"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const disc = await prisma.discipline.create({ data: { name: `D${Date.now()}` } });
  await prisma.disciplineProfessor.create({ data: { discipline_id: disc.id, professor_id: profe.id } });
  const enr = await prisma.enrollment.create({ data: { user_id: socio.id, discipline_id: disc.id } });
  const mia = await cuota(socio.id, "Disciplina", { enrollment_id: enr.id });
  const revision = await cuota(socio.id, "Disciplina", { enrollment_id: enr.id, status: "EnRevision" });
  const social = await cuota(socio.id, "Socio");
  expect((await api("POST", `/api/payments/${mia.id}/cobro`, { token: profe.token, body: { method: "Transferencia" } })).status).toBe(403);
  expect((await api("POST", `/api/payments/${revision.id}/cobro`, { token: profe.token, body: {} })).status).toBe(403);
  expect((await api("POST", `/api/payments/${social.id}/cobro`, { token: profe.token, body: {} })).status).toBe(403);
  expect((await api("POST", `/api/payments/${mia.id}/cobro`, { token: profe.token, body: {} })).status).toBe(200);
});

test("cobro concurrente: uno 200 y uno 409", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  const rs = await Promise.all([
    api("POST", `/api/payments/${a.id}/cobro`, { token: admin.token, body: {} }),
    api("POST", `/api/payments/${a.id}/cobro`, { token: admin.token, body: {} }),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await prisma.paymentTransaction.count({ where: { items: { some: { payment_id: a.id } } } })).toBe(1);
});

test("P7: la cuota social no se cobra con una anterior pendiente, 409 orden_de_pago", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const vieja = await cuota(socio.id, "Otro", { created_at: new Date("2030-01-01T00:00:00Z") });
  const social = await cuota(socio.id, "Socio", { created_at: new Date("2030-02-01T00:00:00Z") });
  const r = await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [social.id] } });
  expect(r.status).toBe(409);
  expect(r.body.orden_de_pago.bloqueantes.map((b: any) => b.id)).toEqual([vieja.id]);
  const juntas = await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [social.id, vieja.id] } });
  expect(juntas.status).toBe(200);
});

test("pago_en_curso: liquidacion MP viva bloquea el cobro manual", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  await prisma.paymentTransaction.create({
    data: {
      user_id: socio.id, method: "MercadoPago", status: "Pendiente", amount: 100,
      expires_at: new Date(Date.now() + 3_600_000),
      items: { create: [{ payment_id: a.id, amount: 100 }] },
    },
  });
  const r = await api("POST", `/api/payments/${a.id}/cobro`, { token: admin.token, body: {} });
  expect(r.status).toBe(409);
  expect(r.body.pago_en_curso).toBeDefined();
});

test("revertir: motivo obligatorio, deja la liquidacion Anulado visible y las filas Pendiente", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  const b = await cuota(socio.id, "Otro");
  const c = await api("POST", "/api/payments/cobro", { token: admin.token, body: { payment_ids: [a.id, b.id] } });
  expect((await api("POST", `/api/payments/${a.id}/revertir`, { token: admin.token, body: {} })).status).toBe(400);
  expect((await api("POST", `/api/payments/${a.id}/revertir`, { token: socio.token, body: { reason: "error de carga" } })).status).toBe(403);
  const r = await api("POST", `/api/payments/${a.id}/revertir`, { token: admin.token, body: { reason: "error de carga" } });
  expect(r.status).toBe(200);
  expect(r.body.filas.sort()).toEqual([a.id, b.id].sort());
  const liq = await prisma.paymentTransaction.findUnique({ where: { id: c.body.liquidacion.id } });
  expect(liq?.status).toBe("Anulado");
  expect(liq?.voided_reason).toBe("error de carga");
  const filas = await prisma.payment.findMany({ where: { id: { in: [a.id, b.id] } } });
  expect(filas.every((f) => f.status === "Pendiente" && f.method === null && f.paid_at === null)).toBe(true);
  await logger.flush();
  // segunda vez: ya no esta paga
  expect((await api("POST", `/api/payments/${a.id}/revertir`, { token: admin.token, body: { reason: "otra vez" } })).status).toBe(409);
});

test("revertir: cobro de MP y cobro con reserva son 409", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const mp = await cuota(socio.id, "Otro", { status: "Pagado", method: "MercadoPago" });
  await prisma.paymentTransaction.create({
    data: { user_id: socio.id, method: "MercadoPago", status: "Aprobado", amount: 100, items: { create: [{ payment_id: mp.id, amount: 100 }] } },
  });
  expect((await api("POST", `/api/payments/${mp.id}/revertir`, { token: admin.token, body: { reason: "probando" } })).status).toBe(409);
  const reserva = await cuota(socio.id, "Reserva");
  await api("POST", `/api/payments/${reserva.id}/cobro`, { token: admin.token, body: {} });
  expect((await api("POST", `/api/payments/${reserva.id}/revertir`, { token: admin.token, body: { reason: "probando" } })).status).toBe(409);
});
