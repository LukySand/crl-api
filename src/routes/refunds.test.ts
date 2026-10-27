// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/refunds.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import { startMpStub } from "../test/mp-stub";
import { reintentarReembolsos } from "../lib/refunds";
import { conciliarReembolsosExternos, syncPayment } from "../lib/payment-sync";

let stub: ReturnType<typeof startMpStub>;
beforeAll(async () => {
  process.env.MP_ACCESS_TOKEN = "token-de-test";
  stub = startMpStub();
  await startTestServer();
});
afterAll(async () => {
  await stub.close();
  await stopTestServer();
});

let n = 0;
/** Liquidacion MP `Aprobado` con una fila `Pagado` por monto, ya cobradas por MP. */
async function cobrada(montos: number[], concept = "Otro") {
  await prisma.chargeType.upsert({ where: { key: concept }, update: {}, create: { key: concept, name: concept } });
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const filas = [];
  for (const monto of montos) {
    filas.push(
      await prisma.payment.create({
        data: {
          user_id: socio.id, concept, name: `ref-${++n}`, amount: monto, status: "Pagado", method: "MercadoPago",
          paid_at: new Date(), ref: `test:refunds:${Date.now()}:${n}`,
        },
      }),
    );
  }
  const mpId = `mp-ref-${Date.now()}-${++n}`;
  const liq = await prisma.paymentTransaction.create({
    data: {
      user_id: socio.id, method: "MercadoPago", status: "Aprobado", mp_payment_id: mpId,
      amount: montos.reduce((a, b) => a + b, 0),
      items: { create: filas.map((f, i) => ({ payment_id: f.id, amount: montos[i]! })) },
    },
  });
  return { admin, socio, filas, liq, mpId };
}

const reembolsar = (token: string, id: string) =>
  api("POST", `/api/payments/${id}/reembolso`, { token, body: { reason: "pedido del socio" } });

test("reembolso de A en una liquidacion A+B: A Anulado (conserva paid_at/method), B Pagado, liquidacion ReembolsadoParcial", async () => {
  const { admin, filas, liq } = await cobrada([100, 50]);
  const r = await reembolsar(admin.token, filas[0]!.id);
  expect(r.status).toBe(200);
  const [a, b] = await Promise.all(filas.map((f) => prisma.payment.findUniqueOrThrow({ where: { id: f.id } })));
  expect(a!.status).toBe("Anulado");
  expect(a!.paid_at).not.toBeNull();
  expect(a!.method).toBe("MercadoPago");
  expect(b!.status).toBe("Pagado");
  expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liq.id } })).status).toBe("ReembolsadoParcial");
  const refund = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${liq.id}:${filas[0]!.id}` } });
  expect(refund).toMatchObject({ status: "approved", attempts: 1, last_error: null, income_reversal: true });
  expect(refund.refunded_at).not.toBeNull();
  const llamada = stub.reembolsos.at(-1)!;
  expect(llamada.key).toBe(refund.idempotency_key);
  expect(llamada.body.amount).toBe(100);
  // y una segunda vez ya no (la fila quedo Anulado)
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(409);
});

test("reembolso total de la liquidacion de una sola fila: Reembolsado y sin amount", async () => {
  const { admin, filas, liq } = await cobrada([80]);
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(200);
  expect(stub.reembolsos.at(-1)!.body).toEqual({});
  expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liq.id } })).status).toBe("Reembolsado");
});

test("validaciones: 403 socio, 400 sin motivo, 400 no MP, 409 no Pagado", async () => {
  const { admin, socio, filas } = await cobrada([10]);
  expect((await reembolsar(socio.token, filas[0]!.id)).status).toBe(403);
  expect((await api("POST", `/api/payments/${filas[0]!.id}/reembolso`, { token: admin.token, body: {} })).status).toBe(400);
  const efectivo = await prisma.payment.create({
    data: { user_id: socio.id, concept: "Otro", name: "ef", amount: 5, status: "Pagado", method: "Efectivo", paid_at: new Date(), ref: `test:refunds:ef:${Date.now()}:${++n}` },
  });
  expect((await reembolsar(admin.token, efectivo.id)).status).toBe(400);
  const pendiente = await prisma.payment.create({
    data: { user_id: socio.id, concept: "Otro", name: "pe", amount: 5, ref: `test:refunds:pe:${Date.now()}:${++n}` },
  });
  expect((await reembolsar(admin.token, pendiente.id)).status).toBe(400); // sin metodo: no es MP
});

test("error 5xx de MP: 502, Refund failed con last_error; el barrido reintenta con la MISMA clave (attempts=2)", async () => {
  const { admin, filas, liq } = await cobrada([60]);
  stub.fallarReembolsos(500, { message: "juan@mail.com tarjeta 4509" });
  const r = await reembolsar(admin.token, filas[0]!.id);
  stub.fallarReembolsos(null);
  expect(r.status).toBe(502);
  const key = `reembolso:${liq.id}:${filas[0]!.id}`;
  const fallido = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } });
  expect(fallido).toMatchObject({ status: "failed", attempts: 1, last_error: "HTTP 500" });
  expect(fallido.last_error).not.toMatch(/@|4509/);

  await reintentarReembolsos(20);
  const ok = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } });
  expect(ok).toMatchObject({ status: "approved", attempts: 2, last_error: null });
  const claves = stub.reembolsos.filter((x) => x.paymentId === liq.mp_payment_id).map((x) => x.key);
  expect(claves).toEqual([key, key]);
});

test("4xx de MP: rejected, el barrido NO lo reintenta, la gestion si", async () => {
  const { admin, filas, liq } = await cobrada([70]);
  stub.fallarReembolsos(400, { error: "bad_request", message: "dato personal" });
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(502);
  const key = `reembolso:${liq.id}:${filas[0]!.id}`;
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } })).toMatchObject({
    status: "rejected", attempts: 1, last_error: "HTTP 400 bad_request",
  });
  stub.fallarReembolsos(null);
  const antes = stub.reembolsos.length;
  await reintentarReembolsos(20);
  expect(stub.reembolsos.length).toBe(antes);
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(200);
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: key } })).toMatchObject({ status: "approved", attempts: 2 });
});

test("pedidos concurrentes: uno gana y el otro recibe 409", async () => {
  const { admin, filas } = await cobrada([90]);
  const [a, b] = await Promise.all([reembolsar(admin.token, filas[0]!.id), reembolsar(admin.token, filas[0]!.id)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(stub.reembolsos.filter((x) => x.key?.endsWith(`:${filas[0]!.id}`)).length).toBe(1);
});

test("un pending viejo (>2 min) se reclama con la misma clave; uno reciente da 409", async () => {
  const { admin, filas, liq } = await cobrada([40, 41]);
  const key = (i: number) => `reembolso:${liq.id}:${filas[i]!.id}`;
  const base = { transaction_id: liq.id, status: "pending", requested_by: "sistema" };
  await prisma.refund.create({
    data: { ...base, payment_id: filas[0]!.id, amount: 40, idempotency_key: key(0), updated_at: new Date(Date.now() - 10 * 60_000) },
  });
  await prisma.refund.create({ data: { ...base, payment_id: filas[1]!.id, amount: 41, idempotency_key: key(1) } });
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(200);
  expect(stub.reembolsos.at(-1)!.key).toBe(key(0));
  expect((await reembolsar(admin.token, filas[1]!.id)).status).toBe(409);
});

test("plata que no salda una fila (monto inconsistente): vuelve sola, income_reversal=false y la fila no se toca", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await prisma.payment.create({
    data: { user_id: socio.id, concept: "Otro", name: "inc", amount: 100, ref: `test:refunds:inc:${Date.now()}:${++n}` },
  });
  const liq = await prisma.paymentTransaction.create({
    data: { user_id: socio.id, method: "MercadoPago", amount: 100, mp_preference_id: "pref-x", items: { create: [{ payment_id: fila.id, amount: 100 }] } },
  });
  const t = new Date(Date.parse("2032-01-01T00:00:00Z") + ++n * 60_000).toISOString();
  stub.setPago(`mp-inc-${liq.id}`, { status: "approved", external_reference: liq.id, transaction_amount: 999, date_approved: t, date_last_updated: t });
  await syncPayment(liq.id);
  const refund = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `reembolso:${liq.id}:total` } });
  expect(refund).toMatchObject({ status: "approved", income_reversal: false, requested_by: "sistema", payment_id: null });
  expect(stub.reembolsos.at(-1)!.body).toEqual({});
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: fila.id } })).status).toBe("Pendiente");
});

test("reembolso externo: se adjunta a un pending local, a la fila Pagado de monto exacto, o queda sin asignar", async () => {
  const { filas, liq, mpId } = await cobrada([30, 55, 12]);
  // (a) pending local del mismo monto (30)
  await prisma.refund.create({
    data: { transaction_id: liq.id, payment_id: filas[0]!.id, amount: 30, status: "pending", requested_by: "sistema", idempotency_key: `reembolso:${liq.id}:${filas[0]!.id}` },
  });
  const id = (k: number) => 9_000_000 + Date.now() % 1_000_000 * 10 + k;
  const ids = [id(1), id(2), id(3)];
  stub.agregarReembolsoExterno(mpId, { id: ids[0], amount: 30, date_created: new Date().toISOString() });
  // (b) sin pending, calza la fila Pagado de 55
  stub.agregarReembolsoExterno(mpId, { id: ids[1], amount: 55, date_created: new Date().toISOString() });
  // (c) nada calza
  stub.agregarReembolsoExterno(mpId, { id: ids[2], amount: 7, date_created: new Date().toISOString() });
  await conciliarReembolsosExternos(liq.id, mpId);
  await conciliarReembolsosExternos(liq.id, mpId); // idempotente

  const a = await prisma.refund.findUniqueOrThrow({ where: { mp_refund_id: String(ids[0]) } });
  expect(a).toMatchObject({ payment_id: filas[0]!.id, status: "approved" });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } })).status).toBe("Anulado");
  const b = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `mp:${ids[1]}` } });
  expect(b).toMatchObject({ payment_id: filas[1]!.id, status: "approved", income_reversal: true, requested_by: "mercadopago" });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[1]!.id } })).status).toBe("Anulado");
  const c = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: `mp:${ids[2]}` } });
  expect(c).toMatchObject({ payment_id: null, status: "approved", income_reversal: false });
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[2]!.id } })).status).toBe("Pagado");
  expect(await prisma.refund.count({ where: { transaction_id: liq.id } })).toBe(3);
});

test("reembolsar una fila Reserva cancela la reserva", async () => {
  const schedule = await prisma.schedule.findFirst();
  const fee = await prisma.fee.findFirst();
  if (!schedule || !fee) return; // la base de test no trae turnos ni tarifas sembrados
  const { admin, socio, liq } = await cobrada([20]);
  const booking = await prisma.booking.create({
    data: { schedule_id: schedule.id, fee_id: fee.id, user_id: socio.id, date: new Date("2033-03-03T00:00:00Z"), status: "Confirmada", active: true },
  });
  const fila = await prisma.payment.create({
    data: { user_id: socio.id, concept: "Reserva", booking_id: booking.id, name: "res", amount: 20, status: "Pagado", method: "MercadoPago", paid_at: new Date(), ref: `test:refunds:res:${Date.now()}:${++n}` },
  });
  await prisma.paymentTransactionItem.create({ data: { transaction_id: liq.id, payment_id: fila.id, amount: 20 } });
  await prisma.paymentTransaction.update({ where: { id: liq.id }, data: { amount: 40 } });
  expect((await reembolsar(admin.token, fila.id)).status).toBe(200);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: "Cancelada", active: null });
});

// ---- D24 / D24b: "Con problemas" y resolución fuera de MP ----

const problemas = (token: string) => api("GET", "/api/transactions/problemas", { token });
const resolver = (token: string, id: number, body: object) =>
  api("POST", `/api/transactions/refunds/${id}/resolver`, { token, body });
const keyDe = (liqId: string, filaId: string) => `reembolso:${liqId}:${filaId}`;

test("problemas: MP caido -> failed con intentos y reintento automatico; el barrido sube attempts y al aprobar sale de la lista", async () => {
  const { admin, filas, liq } = await cobrada([60]);
  stub.fallarReembolsos(500, { message: "juan@mail.com tarjeta 4509" });
  await reembolsar(admin.token, filas[0]!.id);
  stub.fallarReembolsos(null);
  const refund = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: keyDe(liq.id, filas[0]!.id) } });

  const r = await problemas(admin.token);
  expect(r.status).toBe(200);
  const fila = r.body.reembolsos.find((x: { id: number }) => x.id === refund.id);
  expect(fila).toMatchObject({ estado: "failed", intentos: 1, ultimo_error: "HTTP 500", reintento_automatico: true, origen: "gestion" });
  expect(fila.cargo.id).toBe(filas[0]!.id);
  expect(fila.monto).toBe("60.00");
  expect(JSON.stringify(r.body)).not.toMatch(/"raw"|mp_status_detail|juan@mail|4509/);
  expect(JSON.stringify(fila)).not.toContain(admin.id); // sin id de usuario

  await reintentarReembolsos(20);
  expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).attempts).toBe(2);
  expect((await problemas(admin.token)).body.reembolsos.some((x: { id: number }) => x.id === refund.id)).toBe(false);
});

test("problemas: rejected sin reintento automatico (el barrido lo saltea, la gestion lo reintenta); pending viejo si, reciente no; sin fila -> cargo null", async () => {
  const { admin, socio, filas, liq } = await cobrada([70, 71, 72]);
  stub.fallarReembolsos(400, { error: "bad_request" });
  await reembolsar(admin.token, filas[0]!.id);
  stub.fallarReembolsos(null);
  const rechazado = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: keyDe(liq.id, filas[0]!.id) } });
  const base = { transaction_id: liq.id, status: "pending", requested_by: "sistema" };
  const viejo = await prisma.refund.create({
    data: { ...base, payment_id: filas[1]!.id, amount: 71, idempotency_key: keyDe(liq.id, filas[1]!.id), updated_at: new Date(Date.now() - 10 * 60_000) },
  });
  const reciente = await prisma.refund.create({
    data: { ...base, payment_id: filas[2]!.id, amount: 72, idempotency_key: keyDe(liq.id, filas[2]!.id) },
  });
  const huerfano = await prisma.refund.create({
    data: { transaction_id: liq.id, payment_id: null, amount: 5, status: "failed", requested_by: "mercadopago", income_reversal: false, idempotency_key: `reembolso:${liq.id}:total` },
  });

  const r = await problemas(admin.token);
  const por = (id: number) => r.body.reembolsos.find((x: { id: number }) => x.id === id);
  expect(por(rechazado.id)).toMatchObject({ estado: "rejected", reintento_automatico: false, ultimo_error: "HTTP 400 bad_request" });
  expect(por(viejo.id)).toBeDefined();
  expect(por(reciente.id)).toBeUndefined();
  expect(por(huerfano.id)).toMatchObject({ cargo: null, origen: "mercadopago" });
  expect((await problemas(socio.token)).status).toBe(403);

  const antes = stub.reembolsos.length;
  await reintentarReembolsos(20);
  expect((await prisma.refund.findUniqueOrThrow({ where: { id: rechazado.id } })).status).toBe("rejected");
  expect(stub.reembolsos.length).toBeGreaterThan(antes); // el pending viejo y el failed si se reintentaron
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(200); // la gestion si
});

test("problemas: un contracargo aparece en su lista", async () => {
  const { admin, liq } = await cobrada([33]);
  await prisma.paymentTransaction.update({ where: { id: liq.id }, data: { status: "Contracargo" } });
  const r = await problemas(admin.token);
  const c = r.body.contracargos.find((x: { id: string }) => x.id === liq.id);
  expect(c).toMatchObject({ mp_payment_id: liq.mp_payment_id, monto: "33.00" });
  expect(c.cargos).toHaveLength(1);
  expect(JSON.stringify(c)).not.toContain('"raw"');
});

/** Una fila Pagado con un Refund `failed` o `rejected` ya creado. */
async function conReembolsoFallido(estado: "failed" | "rejected", monto = 90) {
  const c = await cobrada([monto]);
  const refund = await prisma.refund.create({
    data: {
      transaction_id: c.liq.id, payment_id: c.filas[0]!.id, amount: monto, status: estado, requested_by: c.admin.id,
      attempts: 1, last_error: "HTTP 500", idempotency_key: keyDe(c.liq.id, c.filas[0]!.id),
    },
  });
  return { ...c, refund };
}

test("resolver sin devolver plata: queda resolved_offline, la fila sigue Pagado y no hay egreso", async () => {
  const { admin, filas, liq, refund } = await conReembolsoFallido("failed");
  const r = await resolver(admin.token, refund.id, { note: "se acredita en la proxima cuota", devuelto_en_mano: false });
  expect(r.status).toBe(200);
  expect(r.body.reembolso).toEqual({ id: refund.id, estado: "resolved_offline", devuelto_en_mano: false });
  const despues = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  expect(despues).toMatchObject({ status: "resolved_offline", resolved_by: admin.id, resolved_note: "se acredita en la proxima cuota", refunded_at: null });
  expect(despues.resolved_at).not.toBeNull();
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } })).status).toBe("Pagado");
  expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liq.id } })).status).toBe("Aprobado");
  expect((await problemas(admin.token)).body.reembolsos.some((x: { id: number }) => x.id === refund.id)).toBe(false);
  // terminal: ni el barrido ni /reembolso lo vuelven a intentar
  const antes = stub.reembolsos.length;
  await reintentarReembolsos(20);
  expect(stub.reembolsos.length).toBe(antes);
  expect((await reembolsar(admin.token, filas[0]!.id)).status).toBe(409);
  expect(stub.reembolsos.length).toBe(antes);
});

test("resolver con devolucion en mano (rejected): fila Anulado (conserva paid_at/method), refunded_at hoy, liquidacion intacta", async () => {
  const { admin, filas, liq, refund } = await conReembolsoFallido("rejected");
  const r = await resolver(admin.token, refund.id, { note: "se devolvio en efectivo en secretaria", devuelto_en_mano: true });
  expect(r.status).toBe(200);
  const despues = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  expect(despues.status).toBe("resolved_offline");
  expect(despues.refunded_at).not.toBeNull();
  expect(Math.abs(Date.now() - despues.refunded_at!.getTime())).toBeLessThan(60_000); // egreso del mes de la resolucion
  const fila = await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } });
  expect(fila).toMatchObject({ status: "Anulado", method: "MercadoPago", resolved_by: admin.id, resolved_reason: "se devolvio en efectivo en secretaria" });
  expect(fila.paid_at).not.toBeNull();
  expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: liq.id } })).status).toBe("Aprobado");
});

test("resolver con devolucion en mano e income_reversal=false: marca refunded_at pero no toca la fila (no hay egreso)", async () => {
  const { admin, filas, refund } = await conReembolsoFallido("failed", 25);
  await prisma.refund.update({ where: { id: refund.id }, data: { income_reversal: false } });
  expect((await resolver(admin.token, refund.id, { note: "devuelto en mano", devuelto_en_mano: true })).status).toBe(200);
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } })).status).toBe("Pagado");
});

test("resolver con devolucion en mano de una Reserva cancela la reserva", async () => {
  const schedule = await prisma.schedule.findFirst();
  const fee = await prisma.fee.findFirst();
  if (!schedule || !fee) return; // la base de test no trae turnos ni tarifas sembrados
  const { admin, socio, filas, refund } = await conReembolsoFallido("failed", 20);
  const booking = await prisma.booking.create({
    data: { schedule_id: schedule.id, fee_id: fee.id, user_id: socio.id, date: new Date("2034-04-04T00:00:00Z"), status: "Confirmada", active: true },
  });
  await prisma.payment.update({ where: { id: filas[0]!.id }, data: { concept: "Reserva", booking_id: booking.id } });
  expect((await resolver(admin.token, refund.id, { note: "devuelto en mano", devuelto_en_mano: true })).status).toBe(200);
  expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: "Cancelada", active: null });
});

test("resolver: 400 sin nota o campos sueltos, 403 no admin, 404 inexistente, 409 pending / aprobado / ya resuelto", async () => {
  const { admin, socio, refund } = await conReembolsoFallido("failed");
  expect((await resolver(admin.token, refund.id, { devuelto_en_mano: false })).status).toBe(400);
  expect((await resolver(admin.token, refund.id, { note: "ok", devuelto_en_mano: false })).status).toBe(400); // nota < 3
  expect((await resolver(admin.token, refund.id, { note: "motivo", devuelto_en_mano: false, extra: 1 })).status).toBe(400);
  expect((await resolver(socio.token, refund.id, { note: "motivo", devuelto_en_mano: false })).status).toBe(403);
  expect((await resolver(admin.token, 2_000_000_000, { note: "motivo", devuelto_en_mano: false })).status).toBe(404);

  const pendiente = await prisma.refund.create({
    data: { transaction_id: refund.transaction_id, payment_id: null, amount: 1, status: "pending", requested_by: "sistema", idempotency_key: `reembolso:${refund.transaction_id}:total` },
  });
  expect((await resolver(admin.token, pendiente.id, { note: "motivo", devuelto_en_mano: false })).status).toBe(409);
  await prisma.refund.update({ where: { id: pendiente.id }, data: { status: "approved" } });
  expect((await resolver(admin.token, pendiente.id, { note: "motivo", devuelto_en_mano: false })).status).toBe(409);

  expect((await resolver(admin.token, refund.id, { note: "motivo", devuelto_en_mano: false })).status).toBe(200);
  expect((await resolver(admin.token, refund.id, { note: "otra vez", devuelto_en_mano: true })).status).toBe(409);
});

test("resolver concurrente contra el barrido: exactamente uno gana", async () => {
  const { admin, filas, refund } = await conReembolsoFallido("failed", 45);
  const [res] = await Promise.all([
    resolver(admin.token, refund.id, { note: "devuelto en mano", devuelto_en_mano: true }),
    reintentarReembolsos(20),
  ]);
  const final = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  const fila = await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } });
  if (res.status === 200) {
    expect(final.status).toBe("resolved_offline");
  } else {
    // el barrido lo reclamo primero: ya no es resoluble y el reembolso salio por MP
    expect(res.status).toBe(409);
    expect(final.status).toBe("approved");
  }
  expect(fila.status).toBe("Anulado"); // en ambos caminos la fila queda anulada una sola vez
});

const reintentar = (token: string, id: number) => api("POST", `/api/transactions/refunds/${id}/reintentar`, { token });

test("reintentar a mano un monto inconsistente (payment_id null, failed): misma clave, sin fila nueva, queda approved", async () => {
  const { admin, filas, liq, mpId } = await cobrada([60]);
  const clave = `reembolso:${liq.id}:total`;
  const refund = await prisma.refund.create({
    data: { transaction_id: liq.id, payment_id: null, amount: 60, status: "failed", requested_by: "sistema", attempts: 1, last_error: "HTTP 500", idempotency_key: clave },
  });
  const antes = stub.reembolsos.length;
  const r = await reintentar(admin.token, refund.id);
  expect(r.status).toBe(200);
  expect(r.body.reembolso).toEqual({ id: refund.id, estado: "aprobado" });
  expect(stub.reembolsos.slice(antes)).toMatchObject([{ paymentId: mpId, key: clave }]);
  expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: "approved", attempts: 2, last_error: null });
  expect(await prisma.refund.count({ where: { transaction_id: liq.id } })).toBe(1);
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } })).status).toBe("Pagado");
});

test("reintentar: rejected con MP fallando devuelve 502 y sigue rejected; despues aprueba", async () => {
  const { admin, refund } = await conReembolsoFallido("rejected", 35);
  stub.fallarReembolsos(400, { error: "bad_request" });
  try {
    const r = await reintentar(admin.token, refund.id);
    expect(r.status).toBe(502);
    expect(r.body.reembolso).toEqual({ id: refund.id, estado: "rejected" });
  } finally {
    stub.fallarReembolsos(null);
  }
  expect((await reintentar(admin.token, refund.id)).status).toBe(200);
  expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("approved");
});

test("reintentar: 403 no admin, 404 inexistente, 409 pending reciente / aprobado / resuelto", async () => {
  const { admin, socio, refund } = await conReembolsoFallido("failed");
  expect((await reintentar(socio.token, refund.id)).status).toBe(403);
  expect((await reintentar(admin.token, 2_000_000_000)).status).toBe(404);
  const antes = stub.reembolsos.length;

  const pendiente = await prisma.refund.create({
    data: { transaction_id: refund.transaction_id, payment_id: null, amount: 1, status: "pending", requested_by: "sistema", idempotency_key: `reembolso:${refund.transaction_id}:total` },
  });
  expect((await reintentar(admin.token, pendiente.id)).status).toBe(409);
  await prisma.refund.update({ where: { id: pendiente.id }, data: { status: "approved" } });
  expect((await reintentar(admin.token, pendiente.id)).status).toBe(409);
  await prisma.refund.update({ where: { id: pendiente.id }, data: { status: "resolved_offline" } });
  expect((await reintentar(admin.token, pendiente.id)).status).toBe(409);
  expect(stub.reembolsos.length).toBe(antes);
  // No dejar un failed suelto: el barrido de otros tests lo reintentaria.
  await prisma.refund.update({ where: { id: refund.id }, data: { status: "resolved_offline" } });
});

test("reintentar concurrente contra resolver: exactamente uno gana", async () => {
  const { admin, filas, refund } = await conReembolsoFallido("failed", 55);
  const [rei, res] = await Promise.all([
    reintentar(admin.token, refund.id),
    resolver(admin.token, refund.id, { note: "devuelto en mano", devuelto_en_mano: true }),
  ]);
  expect([rei.status, res.status].sort()).toEqual([200, 409]);
  const final = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  expect(final.status).toBe(rei.status === 200 ? "approved" : "resolved_offline");
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: filas[0]!.id } })).status).toBe("Anulado");
});
