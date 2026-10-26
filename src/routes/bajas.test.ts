// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/bajas.test.ts`.
// Parte 1 (D21): la baja anula los períodos posteriores al mes de la baja y deja
// intacto el del mes, en formato mensual ("YYYY-MM") y diario ("YYYY-MM-DD").
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { periodoActual, periodoSiguiente } from "../lib/payment-period";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import { startMpStub } from "../test/mp-stub";
import { syncPayment } from "../lib/payment-sync";
import { parseDate, ultimaFechaReservable } from "../lib/booking-date";

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

// Parte 2 (D14): la baja de un socio reembolsa sus reservas futuras pagadas por Mercado Pago.
test("la baja del socio cancela sus reservas futuras y reembolsa las pagadas por MP", async () => {
  process.env.MP_ACCESS_TOKEN = "token-de-test";
  const stub = startMpStub();
  try {
    await prisma.chargeType.upsert({ where: { key: "Reserva" }, update: {}, create: { key: "Reserva", name: "Reserva", system: true } });
    const fecha = ultimaFechaReservable(1);
    const fee = await prisma.fee.create({ data: { name: `Tarifa baja ${Date.now()}`, amount: 100 } });
    const place = await prisma.place.create({ data: { name: `Cancha baja ${Date.now()}` } });
    const schedule = await prisma.schedule.create({
      data: {
        place_id: place.id, fee_id: fee.id, day_of_week: parseDate(fecha).getUTCDay(),
        start_time: new Date("1970-01-01T20:00:00Z"), end_time: new Date("1970-01-01T21:00:00Z"),
      },
    });
    const admin = await makeUser({ roles: ["Administrador"] });
    const socio = await makeUser({ roles: ["Socio"] });
    const r = await api("POST", "/api/bookings", { token: socio.token, body: { schedule_id: schedule.id, date: fecha } });
    expect(r.status).toBe(201);
    const liqId = r.body.pago.id as string;
    stub.setPago(`mp-${liqId}`, {
      status: "approved", external_reference: liqId, transaction_amount: 100,
      date_approved: new Date().toISOString(), date_last_updated: new Date().toISOString(),
    });
    await syncPayment(liqId);

    const baja = await api("DELETE", `/api/admin/users/${socio.id}`, { token: admin.token });
    expect(baja.status).toBe(200);
    expect(baja.body.reembolsos).toEqual([{ booking_id: r.body.booking.id, estado: "aprobado" }]);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id } })).toMatchObject({ status: "Cancelada", active: null });
    expect((await prisma.payment.findUniqueOrThrow({ where: { booking_id: r.body.booking.id } })).status).toBe("Anulado");
  } finally {
    await stub.close();
  }
});
