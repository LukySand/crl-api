// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/booking-checkout.test.ts`.
// D14: reserva pagada en el acto desde la app de socio, hold de 5 minutos, aprobación tardía.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import { startMpStub } from "../test/mp-stub";
import { liberarReservasVencidas } from "../lib/booking-hold";
import { syncPayment } from "../lib/payment-sync";
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
const FECHA = ultimaFechaReservable(1); // mañana: siempre hay más de 5 minutos para el turno

/** Un espacio con un turno mañana a las 20:00 y su tarifa. Cada test usa uno propio. */
async function turno(monto = 100) {
  const fee = await prisma.fee.create({ data: { name: `Tarifa ${++n}`, amount: monto } });
  const place = await prisma.place.create({ data: { name: `Cancha ${Date.now()}-${n}` } });
  const schedule = await prisma.schedule.create({
    data: {
      place_id: place.id,
      fee_id: fee.id,
      day_of_week: parseDate(FECHA).getUTCDay(),
      start_time: new Date("1970-01-01T20:00:00Z"),
      end_time: new Date("1970-01-01T21:00:00Z"),
    },
  });
  return { fee, place, schedule };
}

const reservar = (token: string, scheduleId: number, query = "") =>
  api("POST", `/api/bookings${query}`, { token, body: { schedule_id: scheduleId, date: FECHA } });

/** El socio reserva y paga en el acto; devuelve todo lo necesario para seguir. */
async function reservaConHold(monto = 100) {
  const t = await turno(monto);
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await reservar(socio.token, t.schedule.id);
  expect(r.status).toBe(201);
  const bookingId = r.body.booking.id as string;
  const liqId = r.body.pago.id as string;
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: bookingId } });
  return { ...t, socio, bookingId, liqId, fila, monto };
}

let reloj = Date.parse("2032-01-01T00:00:00Z");
/** Registra el pago aprobado en MP y concilia la liquidación (como haría el webhook). */
async function aprobar(liqId: string, monto: number) {
  reloj += 60_000;
  stub.setPago(`mp-${liqId}`, {
    status: "approved",
    external_reference: liqId,
    transaction_amount: monto,
    date_approved: new Date(reloj).toISOString(),
    date_last_updated: new Date(reloj).toISOString(),
  });
  return syncPayment(liqId);
}

/** Retrocede el reloj de la reserva: como si hubieran pasado más de 5 minutos. */
const envejecer = (bookingId: string) =>
  prisma.booking.update({ where: { id: bookingId }, data: { created_at: new Date(Date.now() - 6 * 60_000) } });

test("el socio reserva y paga en el acto: reserva y fila Pendiente, liquidacion MP con vencimiento a 5 minutos y checkout_url", async () => {
  const { bookingId, liqId, fila } = await reservaConHold();
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  expect(booking).toMatchObject({ status: "Pendiente", active: true });
  expect(fila.status).toBe("Pendiente");
  const liq = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liqId }, include: { items: true } });
  expect(liq).toMatchObject({ method: "MercadoPago", status: "Pendiente" });
  expect(liq.items.map((i) => i.payment_id)).toEqual([fila.id]);
  const minutos = (liq.expires_at!.getTime() - Date.now()) / 60_000;
  expect(minutos).toBeGreaterThan(4);
  expect(minutos).toBeLessThanOrEqual(5);
  expect(liq.checkout_url).toContain("mp.test/checkout/");
  // MP no acepta vigencias de minutos: la preferencia sale sin `expires`.
  expect(stub.preferencias.at(-1)?.expires).toBeUndefined();
  expect(stub.preferencias.at(-1)?.external_reference).toBe(liqId);
});

test("la gestion sin ?propias va por el mostrador (sin liquidacion); con ?propias=true paga en el acto", async () => {
  const t = await turno();
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const mostrador = await api("POST", "/api/bookings", {
    token: admin.token,
    body: { schedule_id: t.schedule.id, date: FECHA, user_id: socio.id },
  });
  expect(mostrador.status).toBe(201);
  expect(mostrador.body.checkout_url).toBeUndefined();
  expect(await prisma.paymentTransaction.count({ where: { items: { some: { payment: { booking_id: mostrador.body.booking.id } } } } })).toBe(0);

  const t2 = await turno();
  const propia = await reservar(admin.token, t2.schedule.id, "?propias=true");
  expect(propia.status).toBe(201);
  expect(propia.body.checkout_url).toContain("mp.test/checkout/");
});

test("monto 0: la reserva nace Confirmada y la fila Pagado, sin liquidacion", async () => {
  const t = await turno(0);
  const socio = await makeUser({ roles: ["Socio"] });
  const r = await reservar(socio.token, t.schedule.id);
  expect(r.status).toBe(201);
  expect(r.body.checkout_url).toBeUndefined();
  expect(r.body.booking.status).toBe("Confirmada");
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: r.body.booking.id } });
  expect(fila.status).toBe("Pagado");
  expect(await prisma.paymentTransactionItem.count({ where: { payment_id: fila.id } })).toBe(0);
});

test("si MP falla: 502, liquidacion Cancelado, fila Anulado, reserva Cancelada y el turno queda libre", async () => {
  const t = await turno();
  const socio = await makeUser({ roles: ["Socio"] });
  stub.fallarPreferencias(true);
  const r = await reservar(socio.token, t.schedule.id);
  stub.fallarPreferencias(false);
  expect(r.status).toBe(502);
  const booking = await prisma.booking.findFirstOrThrow({ where: { schedule_id: t.schedule.id } });
  expect(booking).toMatchObject({ status: "Cancelada", active: null });
  const fila = await prisma.payment.findUniqueOrThrow({ where: { booking_id: booking.id } });
  expect(fila.status).toBe("Anulado");
  const item = await prisma.paymentTransactionItem.findFirstOrThrow({ where: { payment_id: fila.id }, include: { transaction: true } });
  expect(item.transaction.status).toBe("Cancelado");
  expect((await reservar(socio.token, t.schedule.id)).status).toBe(201);
});

test("el hold vencido se libera: reserva Cancelada, fila Anulado por el sistema, turno libre; el mostrador no se toca", async () => {
  const c = await reservaConHold();
  const admin = await makeUser({ roles: ["Administrador"] });
  const otroSocio = await makeUser({ roles: ["Socio"] });
  const t2 = await turno();
  const mostrador = await api("POST", "/api/bookings", {
    token: admin.token,
    body: { schedule_id: t2.schedule.id, date: FECHA, user_id: otroSocio.id },
  });
  await envejecer(c.bookingId);
  await envejecer(mostrador.body.booking.id);

  expect(await liberarReservasVencidas()).toBeGreaterThanOrEqual(1);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).toMatchObject({ status: "Anulado", resolved_by: "sistema" });
  // El mostrador sigue Pendiente: no tiene liquidacion de MP.
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: mostrador.body.booking.id } })).toMatchObject({ status: "Pendiente", active: true });
  const disp = await api("GET", `/api/bookings/availability?place_id=${c.place.id}&date=${FECHA}`, { token: c.socio.token });
  expect(disp.body.taken).not.toContain(c.schedule.id);
});

test("la aprobacion dentro del plazo confirma la reserva y salda la fila", async () => {
  const c = await reservaConHold();
  await aprobar(c.liqId, c.monto);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Confirmada", active: true });
  expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).toMatchObject({ status: "Pagado", method: "MercadoPago" });
});

test("aprobacion tardia con el turno libre: retoma la reserva (Confirmada + active) y la fila vuelve a Pagado, sin reembolso", async () => {
  const c = await reservaConHold();
  await envejecer(c.bookingId);
  await liberarReservasVencidas();
  await aprobar(c.liqId, c.monto);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Confirmada", active: true });
  expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).toMatchObject({
    status: "Pagado", method: "MercadoPago", resolved_by: null,
  });
  expect(await prisma.refund.count({ where: { transaction_id: c.liqId } })).toBe(0);
});

test("aprobacion tardia con el turno tomado por otro: reembolsa por reserva-perdida y la reserva sigue Cancelada", async () => {
  const c = await reservaConHold();
  await envejecer(c.bookingId);
  await liberarReservasVencidas();
  const otro = await makeUser({ roles: ["Socio"] });
  expect((await reservar(otro.token, c.schedule.id)).status).toBe(201);

  await aprobar(c.liqId, c.monto);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.fila.id } })).status).toBe("Anulado");
  const refund = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${c.liqId}:${c.fila.id}` } });
  expect(refund).toMatchObject({ status: "approved", reason: "reserva-perdida", income_reversal: false });
  expect(stub.reembolsos.at(-1)?.key).toBe(refund.idempotency_key);
});

test("aprobacion tardia con el turno bloqueado: reembolsa", async () => {
  const c = await reservaConHold();
  await envejecer(c.bookingId);
  await liberarReservasVencidas();
  const admin = await makeUser({ roles: ["Administrador"] });
  await prisma.scheduleBlock.create({
    data: { place_id: c.place.id, date_from: parseDate(FECHA), date_to: parseDate(FECHA), reason: "mantenimiento", created_by: admin.id },
  });

  await aprobar(c.liqId, c.monto);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).toMatchObject({ status: "Cancelada", active: null });
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${c.liqId}:${c.fila.id}` } })).toMatchObject({
    status: "approved", reason: "reserva-perdida",
  });
});

test("POST /:id/checkout: sólo el dueño, devuelve el mismo link sin crear otra preferencia", async () => {
  const c = await reservaConHold();
  const admin = await makeUser({ roles: ["Administrador"] });
  const preferencias = stub.preferencias.length;

  const r = await api("POST", `/api/bookings/${c.bookingId}/checkout`, { token: c.socio.token });
  expect(r.status).toBe(200);
  const liq = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: c.liqId } });
  expect(r.body.checkout_url).toBe(liq.checkout_url);
  expect(stub.preferencias.length).toBe(preferencias);
  expect(await prisma.paymentTransaction.count({ where: { items: { some: { payment_id: c.fila.id } } } })).toBe(1);

  expect((await api("POST", `/api/bookings/${c.bookingId}/checkout`, { token: admin.token })).status).toBe(403);
  expect((await api("POST", "/api/bookings/no-existe/checkout", { token: c.socio.token })).status).toBe(404);

  await prisma.paymentTransaction.update({ where: { id: c.liqId }, data: { expires_at: new Date(Date.now() - 1000) } });
  expect((await api("POST", `/api/bookings/${c.bookingId}/checkout`, { token: c.socio.token })).status).toBe(409);
});

test("PATCH: confirmar o cambiar el monto con un pago en curso da 409", async () => {
  const c = await reservaConHold();
  const admin = await makeUser({ roles: ["Administrador"] });
  const confirmar = await api("PATCH", `/api/bookings/${c.bookingId}`, { token: admin.token, body: { status: "Confirmada" } });
  expect(confirmar.status).toBe(409);
  const monto = await api("PATCH", `/api/bookings/${c.bookingId}`, { token: admin.token, body: { amount: 50 } });
  expect(monto.status).toBe(409);
  const notas = await api("PATCH", `/api/bookings/${c.bookingId}`, { token: admin.token, body: { notes: "ok" } });
  expect(notas.status).toBe(200);
});
