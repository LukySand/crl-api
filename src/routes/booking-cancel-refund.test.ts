// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/booking-cancel-refund.test.ts`.
// D14: cancelar una reserva pagada por Mercado Pago la reembolsa sola.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import { startMpStub } from "../test/mp-stub";
import { syncPayment } from "../lib/payment-sync";
import { reintentarReembolsos } from "../lib/refunds";
import { parseDate, ultimaFechaReservable } from "../lib/booking-date";

let stub: ReturnType<typeof startMpStub>;
beforeAll(async () => {
  process.env.MP_ACCESS_TOKEN = "token-de-test";
  stub = startMpStub();
  await startTestServer();
  await prisma.chargeType.upsert({ where: { key: "Reserva" }, update: {}, create: { key: "Reserva", name: "Reserva", system: true } });
});
afterAll(async () => {
  await stub.close();
  await stopTestServer();
});

let n = 0;
const FECHA = ultimaFechaReservable(1);

async function turno() {
  const fee = await prisma.fee.create({ data: { name: `Tarifa cancel ${++n}`, amount: 100 } });
  const place = await prisma.place.create({ data: { name: `Cancha cancel ${Date.now()}-${n}` } });
  return prisma.schedule.create({
    data: {
      place_id: place.id,
      fee_id: fee.id,
      day_of_week: parseDate(FECHA).getUTCDay(),
      start_time: new Date("1970-01-01T20:00:00Z"),
      end_time: new Date("1970-01-01T21:00:00Z"),
    },
  });
}

let reloj = Date.parse("2033-01-01T00:00:00Z");
/** Reserva pagada por MP: el socio reserva en el acto y la aprobación se concilia. */
async function reservaPagada() {
  const schedule = await turno();
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await api("POST", "/api/bookings", { token: socio.token, body: { schedule_id: schedule.id, date: FECHA } });
  expect(r.status).toBe(201);
  const liqId = r.body.pago.id as string;
  reloj += 60_000;
  stub.setPago(`mp-${liqId}`, {
    status: "approved",
    external_reference: liqId,
    transaction_amount: 100,
    date_approved: new Date(reloj).toISOString(),
    date_last_updated: new Date(reloj).toISOString(),
  });
  await syncPayment(liqId);
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: r.body.booking.id } });
  expect(fila.status).toBe("Pagado");
  return { socio, schedule, bookingId: r.body.booking.id as string, liqId, fila };
}

const cancelar = (token: string, id: string) => api("DELETE", `/api/bookings/${id}`, { token });

test("el socio cancela dentro de la ventana: reembolso aprobado, fila Anulado (conserva paid_at) y reserva Cancelada", async () => {
  const c = await reservaPagada();
  const r = await cancelar(c.socio.token, c.bookingId);
  expect(r.status).toBe(200);
  expect(r.body.reembolso).toEqual({ estado: "aprobado" });
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  const fila = await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } });
  expect(fila.status).toBe("Anulado");
  expect(fila.paid_at).not.toBeNull();
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${c.liqId}:${c.fila.id}` } })).toMatchObject({
    status: "approved", income_reversal: true, requested_by: c.socio.id,
  });
});

test("la gestion cancela en cualquier momento y también reembolsa", async () => {
  const c = await reservaPagada();
  const admin = await makeUser({ roles: ["Administrador"] });
  const r = await cancelar(admin.token, c.bookingId);
  expect(r.status).toBe(200);
  expect(r.body.reembolso.estado).toBe("aprobado");
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).status).toBe("Anulado");
});

test("MP caido: la reserva queda cancelada, estado fallido, fila Pagado, y el barrido reintenta con la misma clave", async () => {
  const c = await reservaPagada();
  stub.fallarReembolsos(503, { message: "caido" });
  const r = await cancelar(c.socio.token, c.bookingId);
  expect(r.status).toBe(200);
  expect(r.body.reembolso).toEqual({ estado: "fallido" });
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).status).toBe("Pagado");
  const key = `reembolso:${c.liqId}:${c.fila.id}`;
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } })).toMatchObject({ status: "failed" });

  stub.fallarReembolsos(null);
  await reintentarReembolsos(100);
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } })).toMatchObject({ status: "approved" });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).status).toBe("Anulado");
  expect(stub.reembolsos.filter((x) => x.key === key).length).toBe(2); // misma clave en el reintento
});

test("un 4xx de MP deja el reembolso rejected y el barrido no lo reintenta", async () => {
  const c = await reservaPagada();
  stub.fallarReembolsos(400, { error: "bad_request" });
  const r = await cancelar(c.socio.token, c.bookingId);
  expect(r.body.reembolso).toEqual({ estado: "fallido" });
  const key = `reembolso:${c.liqId}:${c.fila.id}`;
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } })).toMatchObject({ status: "rejected" });

  stub.fallarReembolsos(null);
  const llamadas = stub.reembolsos.length;
  await reintentarReembolsos(100);
  expect(stub.reembolsos.length).toBe(llamadas);
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).status).toBe("Pagado");
});

test("una reserva cobrada en efectivo no se reembolsa sola: la fila queda Pagado y no hay Refund", async () => {
  const schedule = await turno();
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await api("POST", "/api/bookings", {
    token: admin.token,
    body: { schedule_id: schedule.id, date: FECHA, user_id: socio.id, status: "Confirmada", method: "Efectivo" },
  });
  expect(r.status).toBe(201);
  const id = r.body.booking.id as string;
  const del = await cancelar(admin.token, id);
  expect(del.status).toBe(200);
  expect(del.body.reembolso).toBeUndefined();
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: id } });
  expect(fila.status).toBe("Pagado");
  expect(await prisma.refund.count({ where: { payment_id: fila.id } })).toBe(0);
});

test("una reserva propia sin pagar se cancela siempre (la ventana rige sólo para Confirmada)", async () => {
  const schedule = await turno();
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await api("POST", "/api/bookings", { token: socio.token, body: { schedule_id: schedule.id, date: FECHA } });
  // Turno de mañana a las 20:00: pase lo que pase con la ventana de 10 horas, está en hold y se suelta.
  const del = await cancelar(socio.token, r.body.booking.id);
  expect(del.status).toBe(200);
  expect(del.body.reembolso).toBeUndefined();
});

test("el dueño cancela con el pago en curso: la liquidacion queda voided y la aprobacion posterior reembolsa en vez de retomar", async () => {
  const schedule = await turno();
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await api("POST", "/api/bookings", { token: socio.token, body: { schedule_id: schedule.id, date: FECHA } });
  const bookingId = r.body.booking.id as string;
  const liqId = r.body.pago.id as string;
  const del = await cancelar(socio.token, bookingId);
  expect(del.status).toBe(200);
  expect(del.body.reembolso).toBeUndefined(); // todavía no había pagado
  const liq = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liqId } });
  expect(liq.voided_at).not.toBeNull();
  expect(liq.status).toBe("Pendiente");

  reloj += 60_000;
  stub.setPago(`mp-${liqId}`, {
    status: "approved", external_reference: liqId, transaction_amount: 100,
    date_approved: new Date(reloj).toISOString(), date_last_updated: new Date(reloj).toISOString(),
  });
  await syncPayment(liqId);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: bookingId } });
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${liqId}:${fila.id}` } })).toMatchObject({ status: "approved" });
});
