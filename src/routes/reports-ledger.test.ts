// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/reports-ledger.test.ts`.
// Cada test usa su propio tipo de cargo (clave única por corrida) y el filtro `concept` lo aísla.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { todayInClub } from "../lib/booking-date";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

let n = 0;
async function tipo() {
  const key = `Rep${Date.now()}x${++n}`;
  await prisma.chargeType.create({ data: { key, name: `Tipo ${key}` } });
  return key;
}

async function pagada(userId: string, concept: string, paidAt: string, monto = 1000, status: "Pagado" | "Anulado" = "Pagado") {
  return prisma.payment.create({
    data: {
      user_id: userId, concept, name: `rep-${n}`, amount: monto, status, method: "MercadoPago",
      paid_at: new Date(`${paidAt}T15:00:00Z`), ref: `test:reports:${Date.now()}:${++n}`,
    },
  });
}

async function reembolso(userId: string, paymentId: string | null, o: { fecha: string | null; income_reversal?: boolean; status?: string; monto?: number }) {
  const tx = await prisma.paymentTransaction.create({
    data: { user_id: userId, method: "MercadoPago", status: "Aprobado", mp_payment_id: `mp-rep-${Date.now()}-${++n}`, amount: o.monto ?? 1000 },
  });
  return prisma.refund.create({
    data: {
      transaction_id: tx.id, payment_id: paymentId, amount: o.monto ?? 1000, status: o.status ?? "approved",
      requested_by: "sistema", income_reversal: o.income_reversal ?? true,
      refunded_at: o.fecha ? new Date(`${o.fecha}T15:00:00Z`) : null,
      idempotency_key: `test:rep:${Date.now()}:${++n}`,
    },
  });
}

const ingresos = (token: string, concept: string, group = "mes") =>
  api("GET", `/api/reports/ingresos?concept=${concept}&group=${group}`, { token });
const mes = (body: any, clave: string) => body.serie.find((s: { clave: string }) => s.clave === clave);

test("venta de septiembre reembolsada en octubre: septiembre sigue bruto, octubre muestra egreso y neto negativo", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  const p = await pagada(socio.id, key, "2031-09-10", 1000, "Anulado");
  await reembolso(socio.id, p.id, { fecha: "2031-10-05" });

  const r = await ingresos(admin.token, key);
  expect(r.status).toBe(200);
  expect(mes(r.body, "2031-09")).toMatchObject({ cobrado: 1000, reembolsado: 0, total: 1000 });
  expect(mes(r.body, "2031-10")).toMatchObject({ cobrado: 0, reembolsado: 1000, total: -1000 });
  expect(r.body.totales).toMatchObject({ cobrado: 1000, reembolsado: 1000, neto: 0, cobros: 1, reembolsos: 1 });
});

test("income_reversal=false no resta; un reembolso sin aprobar (refunded_at null) tampoco", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  const p = await pagada(socio.id, key, "2031-09-10");
  await reembolso(socio.id, p.id, { fecha: "2031-10-05", income_reversal: false });
  await reembolso(socio.id, p.id, { fecha: null, status: "failed" });
  const r = await ingresos(admin.token, key);
  expect(r.body.totales).toMatchObject({ cobrado: 1000, reembolsado: 0, neto: 1000 });
});

test("D22b: revertir un cobro manual saca el ingreso de su mes original, aunque este cerrado, y no hay egreso", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  const fila = await prisma.payment.create({
    data: { user_id: socio.id, concept: key, name: "rev", amount: 700, ref: `test:reports:${Date.now()}:${++n}` },
  });
  expect((await api("POST", `/api/payments/${fila.id}/cobro`, { token: admin.token, body: { method: "Efectivo" } })).status).toBe(200);
  await prisma.payment.update({ where: { id: fila.id }, data: { paid_at: new Date("2031-09-10T15:00:00Z") } }); // mes viejo
  expect((await ingresos(admin.token, key)).body.totales.cobrado).toBe(700);

  expect((await api("POST", `/api/payments/${fila.id}/revertir`, { token: admin.token, body: { reason: "error de carga" } })).status).toBe(200);
  const r = await ingresos(admin.token, key);
  expect(r.body.totales).toMatchObject({ cobrado: 0, reembolsado: 0, neto: 0 });
  expect(mes(r.body, "2031-09")).toBeUndefined();
});

test("D24b: devolucion en mano resuelta hoy es egreso del mes de la resolucion, con el metodo original; el ingreso queda en su mes", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  const p = await pagada(socio.id, key, "2031-09-10");
  const refund = await reembolso(socio.id, p.id, { fecha: null, status: "failed" });

  const res = await api("POST", `/api/transactions/refunds/${refund.id}/resolver`, {
    token: admin.token, body: { note: "devuelto en efectivo en secretaria", devuelto_en_mano: true },
  });
  expect(res.status).toBe(200);

  const hoy = todayInClub().slice(0, 7);
  const r = await ingresos(admin.token, key);
  expect(mes(r.body, "2031-09")).toMatchObject({ cobrado: 1000, reembolsado: 0, total: 1000 });
  expect(mes(r.body, hoy)).toMatchObject({ reembolsado: 1000, total: -1000 });
  const porMetodo = await ingresos(admin.token, key, "metodo");
  expect(mes(porMetodo.body, "MercadoPago")).toMatchObject({ cobrado: 1000, reembolsado: 1000, total: 0 });
});

test("series: reembolsos alineados con buckets, un tipo nuevo aparece como concepto y due_date null no rompe", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  const p = await pagada(socio.id, key, "2031-09-10", 1000, "Anulado"); // due_date null
  await reembolso(socio.id, p.id, { fecha: "2031-10-05" });
  const r = await api("GET", "/api/reports/series?bucket=mes&by=concepto&from=2031-09-01&to=2031-11-30", { token: admin.token });
  expect(r.status).toBe(200);
  expect(r.body.buckets).toEqual(["2031-09", "2031-10", "2031-11"]);
  expect(r.body.reembolsos).toHaveLength(r.body.buckets.length);
  expect(r.body.reembolsos[1]).toBeGreaterThanOrEqual(1000);
  expect(r.body.series.find((s: { clave: string }) => s.clave === key).puntos).toEqual([1000, 0, 0]);
  expect(r.body.total).toBeLessThanOrEqual(r.body.series.reduce((t: number, s: { total: number }) => t + s.total, 0));
});

test("concept: acepta la clave de un tipo nuevo y rechaza una forma invalida", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const key = await tipo();
  expect((await ingresos(admin.token, key, "concepto")).status).toBe(200);
  expect((await ingresos(admin.token, "no%20valido", "concepto")).status).toBe(400);
});

test("group=concepto trae la etiqueta (nombre del tipo)", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = await tipo();
  await pagada(socio.id, key, "2031-09-10");
  const r = await ingresos(admin.token, key, "concepto");
  expect(mes(r.body, key).etiqueta).toBe(`Tipo ${key}`);
});
