// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/checkout.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import prisma from "../lib/prisma";
import { barrerDuplicados } from "../lib/payment-sync";
import { reembolsarItem, reintentarReembolsos } from "../lib/refunds";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import { startMpStub } from "../test/mp-stub";

const SECRET = "secreto-de-test";
let base = "";
let stub: ReturnType<typeof startMpStub>;

beforeAll(async () => {
  process.env.MP_ACCESS_TOKEN = "token-de-test";
  process.env.MP_WEBHOOK_SECRET = SECRET;
  stub = startMpStub();
  base = await startTestServer();
});
afterAll(async () => {
  await stub.close();
  await stopTestServer();
});

let n = 0;
async function cuota(userId: string, concept = "Otro", extra: Record<string, unknown> = {}) {
  await prisma.chargeType.upsert({ where: { key: concept }, update: {}, create: { key: concept, name: concept } });
  return prisma.payment.create({
    data: { user_id: userId, concept, name: `cuota-${++n}`, amount: 100, ref: `test:checkout:${Date.now()}:${n}`, ...extra },
  });
}

const checkout = (token: string, ids: string[]) =>
  api("POST", "/api/payments/checkout", { token, body: { payment_ids: ids } });

/** Notificación firmada como la arma MP (manifest con data.id de la query). */
async function webhook(mpId: string, firma = true) {
  const ts = "1789000000";
  const rid = `req-${Date.now()}-${++n}`;
  const v1 = createHmac("sha256", SECRET).update(`id:${mpId};request-id:${rid};ts:${ts};`).digest("hex");
  const res = await fetch(`${base}/api/webhooks/mercadopago?data.id=${mpId}&type=payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": rid, "x-signature": firma ? `ts=${ts},v1=${v1}` : "ts=1,v1=00" },
    body: JSON.stringify({ type: "payment", data: { id: mpId } }),
  });
  return res.status;
}

let reloj = Date.parse("2031-01-01T00:00:00Z");
function pagoMP(mpId: string, liqId: string, extra: Record<string, unknown> = {}) {
  reloj += 60_000;
  stub.setPago(mpId, {
    status: "approved",
    external_reference: liqId,
    transaction_amount: 100,
    date_approved: new Date(reloj).toISOString(),
    date_last_updated: new Date(reloj).toISOString(),
    ...extra,
  });
}

async function checkoutDeUna() {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await cuota(socio.id);
  const r = await checkout(socio.token, [fila.id]);
  expect(r.status).toBe(201);
  return { socio, fila, liqId: r.body.pago.id as string, mpId: `mp-${Date.now()}-${++n}` };
}

test("checkout: 201, liquidacion MP Pendiente con items, titulo = nombre; el segundo da pago_en_curso con checkout_url", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await cuota(socio.id);
  const r = await checkout(socio.token, [fila.id]);
  expect(r.status).toBe(201);
  expect(r.body.checkout_url).toContain("mp.test/checkout/");
  const liq = await prisma.paymentTransaction.findUnique({ where: { id: r.body.pago.id }, include: { items: true } });
  expect(liq?.status).toBe("Pendiente");
  expect(liq?.method).toBe("MercadoPago");
  expect(liq?.items.length).toBe(1);
  expect(stub.preferencias.at(-1)?.items[0].title).toBe(fila.name);
  const otra = await checkout(socio.token, [fila.id]);
  expect(otra.status).toBe(409);
  expect(otra.body.pago_en_curso.checkout_url).toBe(r.body.checkout_url);
});

test("checkout: validaciones (400 / 404 / 403 / 400 Reserva / 409 cuotas)", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const otro = await makeUser({ roles: ["Socio"] });
  const propia = await cuota(socio.id);
  const ajena = await cuota(otro.id);
  const reserva = await cuota(socio.id, "Reserva");
  const pagada = await cuota(socio.id, "Otro", { status: "Pagado" });
  expect((await checkout(socio.token, [])).status).toBe(400);
  expect((await checkout(socio.token, ["no-existe"])).status).toBe(404);
  expect((await checkout(socio.token, [propia.id, ajena.id])).status).toBe(400);
  expect((await checkout(socio.token, [ajena.id])).status).toBe(403);
  expect((await checkout(socio.token, [reserva.id])).status).toBe(400);
  const r = await checkout(socio.token, [pagada.id]);
  expect(r.status).toBe(409);
  expect(r.body.cuotas[0].estado).toBe("pagada");
});

test("checkout: P7, la cuota social no se paga con una anterior sin pagar", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  await cuota(socio.id, "Otro", { created_at: new Date("2031-01-01T00:00:00Z") });
  const social = await cuota(socio.id, "Socio", { created_at: new Date("2031-02-01T00:00:00Z") });
  const r = await checkout(socio.token, [social.id]);
  expect(r.status).toBe(409);
  expect(r.body.orden_de_pago.cuota_social_id).toBe(social.id);
});

test("checkout: sin MP_ACCESS_TOKEN -> 502 y no deja liquidacion", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await cuota(socio.id);
  delete process.env.MP_ACCESS_TOKEN;
  try {
    expect((await checkout(socio.token, [fila.id])).status).toBe(502);
  } finally {
    process.env.MP_ACCESS_TOKEN = "token-de-test";
  }
  expect(await prisma.paymentTransaction.count({ where: { items: { some: { payment_id: fila.id } } } })).toBe(0);
});

test("checkout: si MP falla la liquidacion queda Cancelado y la cuota se puede reintentar", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await cuota(socio.id);
  stub.fallarPreferencias();
  try {
    expect((await checkout(socio.token, [fila.id])).status).toBe(502);
  } finally {
    stub.fallarPreferencias(false);
  }
  expect((await checkout(socio.token, [fila.id])).status).toBe(201);
});

test("checkout: dos pedidos simultaneos -> uno 201 y otro 409", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const fila = await cuota(socio.id);
  const [a, b] = await Promise.all([checkout(socio.token, [fila.id]), checkout(socio.token, [fila.id])]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
});

test("webhook aprobado: salda las filas con method MercadoPago", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId);
  expect(await webhook(mpId)).toBe(200);
  const f = await prisma.payment.findUnique({ where: { id: fila.id } });
  expect(f?.status).toBe("Pagado");
  expect(f?.method).toBe("MercadoPago");
  expect(f?.registered_by).toBeNull();
  expect((await prisma.paymentTransaction.findUnique({ where: { id: liqId } }))?.status).toBe("Aprobado");
});

test("webhook: firma invalida -> 401 y no toca nada", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId);
  expect(await webhook(mpId, false)).toBe(401);
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pendiente");
});

test("aprobacion de una fila anulada durante el checkout: no salda y devuelve la plata (reembolso aprobado)", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  await prisma.payment.update({ where: { id: fila.id }, data: { status: "Anulado" } });
  pagoMP(mpId, liqId);
  expect(await webhook(mpId)).toBe(200);
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Anulado");
  const r = await prisma.refund.findFirst({ where: { transaction_id: liqId, payment_id: fila.id } });
  expect(r).toMatchObject({ status: "approved", attempts: 1, income_reversal: false, requested_by: "sistema" });
  expect(r?.idempotency_key).toBe(`reembolso:${liqId}:${fila.id}`);
  // B6 lo ejecuta contra MP con esa misma clave; la fila cubre todo el cobro, sin `amount`.
  expect(stub.reembolsos.at(-1)).toMatchObject({ paymentId: mpId, key: r?.idempotency_key, body: {} });
});

test("monto inconsistente: no salda y devuelve el total (reembolso aprobado)", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId, { transaction_amount: 50 });
  expect(await webhook(mpId)).toBe(200);
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pendiente");
  const r = await prisma.refund.findFirst({ where: { transaction_id: liqId, payment_id: null } });
  expect(r).toMatchObject({ status: "approved", attempts: 1, income_reversal: false, idempotency_key: `reembolso:${liqId}:total` });
  expect(Number(r?.amount)).toBe(50);
  expect(stub.reembolsos.at(-1)).toMatchObject({ paymentId: mpId, key: r?.idempotency_key, body: {} });
});

test("un approved tardio no pisa ReembolsadoParcial", async () => {
  const { liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId);
  await webhook(mpId);
  pagoMP(mpId, liqId, { transaction_amount_refunded: 30 });
  await webhook(mpId);
  expect((await prisma.paymentTransaction.findUnique({ where: { id: liqId } }))?.status).toBe("ReembolsadoParcial");
  pagoMP(mpId, liqId); // approved sin devolucion, mas nuevo
  await webhook(mpId);
  expect((await prisma.paymentTransaction.findUnique({ where: { id: liqId } }))?.status).toBe("ReembolsadoParcial");
});

const liqDe = (id: string) => prisma.paymentTransaction.findUnique({ where: { id } });
const reembolsosDe = (mpId: string) => stub.reembolsos.filter((r) => r.paymentId === mpId);

test("pago duplicado de la misma preferencia: se devuelve entero y no pisa el cobro original", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  expect(await webhook(mpId)).toBe(200);
  const antes = await liqDe(liqId);
  pagoMP(dup, liqId);
  expect(await webhook(dup)).toBe(200);
  expect(reembolsosDe(dup)).toEqual([{ paymentId: dup, key: `duplicado:${dup}`, body: {} }]);
  const despues = await liqDe(liqId);
  expect(despues).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
  expect(despues?.raw).toEqual(antes?.raw);
  expect(Number(despues?.mp_fee ?? 0)).toBe(Number(antes?.mp_fee ?? 0));
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
  // Queda como `Refund` del duplicado, ya aprobado, sin efectos contables.
  expect(await prisma.refund.findMany({ where: { transaction_id: liqId } })).toMatchObject([
    {
      mp_payment_id: dup,
      payment_id: null,
      income_reversal: false,
      status: "approved",
      requested_by: "sistema",
      idempotency_key: `duplicado:${dup}`,
    },
  ]);

  // La notificación se repite: misma clave de idempotencia y la liquidación no se mueve.
  expect(await webhook(dup)).toBe(200);
  expect(new Set(reembolsosDe(dup).map((r) => r.key))).toEqual(new Set([`duplicado:${dup}`]));
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
  expect(await prisma.refund.count({ where: { transaction_id: liqId } })).toBe(1);
  // El barrido de 15 minutos no lo vuelve a intentar: ya tiene su fila.
  await barrerDuplicados();
  expect(reembolsosDe(dup).length).toBe(1);
  expect(await prisma.refund.count({ where: { transaction_id: liqId } })).toBe(1);
});

test("pago duplicado cuya notificacion nunca llega: lo devuelve la del pago original", async () => {
  const { liqId, mpId } = await checkoutDeUna();
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  pagoMP(dup, liqId);
  expect(await webhook(mpId)).toBe(200);
  expect(reembolsosDe(dup).map((r) => r.key)).toEqual([`duplicado:${dup}`]);
  expect(reembolsosDe(mpId)).toEqual([]);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
  expect(await prisma.refund.count({ where: { transaction_id: liqId, mp_payment_id: dup, status: "approved" } })).toBe(1);
});

test("pago duplicado: si MP falla (5xx) queda failed con webhook 200 y reintentarReembolsos devuelve el DUPLICADO", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  await webhook(mpId);
  pagoMP(dup, liqId);
  stub.fallarReembolsos(500);
  try {
    expect(await webhook(dup)).toBe(200);
  } finally {
    stub.fallarReembolsos(null);
  }
  const clave = `duplicado:${dup}`;
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: clave } })).toMatchObject({
    status: "failed",
    mp_payment_id: dup,
    attempts: 1,
  });
  // Ni el webhook repetido ni el barrido de duplicados reintentan: eso es de reintentarReembolsos.
  expect(await webhook(dup)).toBe(200);
  await barrerDuplicados();
  expect(reembolsosDe(dup).length).toBe(1);

  expect((await reintentarReembolsos(50)) >= 1).toBe(true);
  expect(reembolsosDe(mpId)).toEqual([]);
  expect(reembolsosDe(dup).map((r) => r.key)).toEqual([clave, clave]);
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: clave } })).toMatchObject({ status: "approved", attempts: 2 });
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
});

test("pago duplicado: 4xx queda rejected, no se reintenta solo y una persona lo reintenta contra el DUPLICADO", async () => {
  const { liqId, mpId } = await checkoutDeUna();
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  await webhook(mpId);
  pagoMP(dup, liqId);
  stub.fallarReembolsos(400, { error: "bad_request" });
  try {
    expect(await webhook(dup)).toBe(200);
    await reintentarReembolsos(50);
    await barrerDuplicados();
  } finally {
    stub.fallarReembolsos(null);
  }
  const clave = `duplicado:${dup}`;
  expect(reembolsosDe(dup).length).toBe(1);
  expect(await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: clave } })).toMatchObject({ status: "rejected" });
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });

  const r = await reembolsarItem({
    transaccionId: liqId,
    filaId: null,
    motivo: "reintento",
    actor: "admin",
    persona: true,
    duplicado: { mpPaymentId: dup, monto: "100.00" },
  });
  expect(r.estado).toBe("approved");
  expect(reembolsosDe(mpId)).toEqual([]);
  expect(reembolsosDe(dup).map((x) => x.key)).toEqual([clave, clave]);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
});

test("pago duplicado rechazado: la gestion lo reintenta por /refunds/:id/reintentar contra el DUPLICADO, misma clave", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  const admin = await makeUser({ roles: ["Administrador"] });
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  await webhook(mpId);
  pagoMP(dup, liqId);
  stub.fallarReembolsos(400, { error: "bad_request" });
  try {
    expect(await webhook(dup)).toBe(200);
  } finally {
    stub.fallarReembolsos(null);
  }
  const clave = `duplicado:${dup}`;
  const refund = await prisma.refund.findUniqueOrThrow({ where: { idempotency_key: clave } });
  expect(refund.status).toBe("rejected");
  const antes = await liqDe(liqId);

  const r = await api("POST", `/api/transactions/refunds/${refund.id}/reintentar`, { token: admin.token });
  expect(r.status).toBe(200);
  expect(reembolsosDe(mpId)).toEqual([]);
  expect(reembolsosDe(dup).map((x) => x.key)).toEqual([clave, clave]);
  expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: "approved" });
  expect(await prisma.refund.count({ where: { transaction_id: liqId } })).toBe(1);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId, raw: antes?.raw });
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
  expect((await api("POST", `/api/transactions/refunds/${refund.id}/reintentar`, { token: admin.token })).status).toBe(409);
});

test("pago duplicado: si MP avisa que ya lo devolvio, no se concilia contra el cobro legitimo", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  const dup = `${mpId}-dup`;
  pagoMP(mpId, liqId);
  await webhook(mpId);
  pagoMP(dup, liqId);
  await webhook(dup);
  pagoMP(dup, liqId, { status: "refunded", transaction_amount_refunded: 100 });
  expect(await webhook(dup)).toBe(200);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
  expect(await prisma.refund.count({ where: { transaction_id: liqId } })).toBe(1);
});

test("pago duplicado que no cobro (rechazado / pendiente): se ignora sin devolver", async () => {
  const { liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId);
  await webhook(mpId);
  for (const status of ["rejected", "in_process"]) {
    const dup = `${mpId}-${status}`;
    pagoMP(dup, liqId, { status });
    expect(await webhook(dup)).toBe(200);
    expect(reembolsosDe(dup)).toEqual([]);
  }
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: mpId });
});

test("reintento legitimo: rechazado y despues aprobado sigue saldando con el id nuevo", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  const nuevo = `${mpId}-ok`;
  pagoMP(mpId, liqId, { status: "rejected" });
  await webhook(mpId);
  expect((await liqDe(liqId))?.status).toBe("Rechazado");
  pagoMP(nuevo, liqId);
  expect(await webhook(nuevo)).toBe(200);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: nuevo });
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
  expect(reembolsosDe(mpId)).toEqual([]);
});

test("X pendiente, Y aprobado, X aprobado despues: salda con Y y devuelve X", async () => {
  const { fila, liqId, mpId: x } = await checkoutDeUna();
  const y = `${x}-y`;
  pagoMP(x, liqId, { status: "in_process" });
  await webhook(x);
  expect(await liqDe(liqId)).toMatchObject({ status: "Pendiente", mp_payment_id: x });
  pagoMP(y, liqId);
  await webhook(y);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: y });
  pagoMP(x, liqId); // X termina aprobándose, más nuevo que Y
  expect(await webhook(x)).toBe(200);
  expect(reembolsosDe(x)).toEqual([{ paymentId: x, key: `duplicado:${x}`, body: {} }]);
  expect(reembolsosDe(y)).toEqual([]);
  expect(await liqDe(liqId)).toMatchObject({ status: "Aprobado", mp_payment_id: y });
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
});

test("refunded / charged_back: las filas pasan Pagado -> Anulado", async () => {
  for (const status of ["refunded", "charged_back"]) {
    const { fila, liqId, mpId } = await checkoutDeUna();
    pagoMP(mpId, liqId);
    await webhook(mpId);
    pagoMP(mpId, liqId, { status });
    await webhook(mpId);
    const f = await prisma.payment.findUnique({ where: { id: fila.id } });
    expect(f?.status).toBe("Anulado");
    expect(f?.resolved_by).toBe("mercadopago");
    expect(f?.paid_at).not.toBeNull();
  }
});

test("transactions: GET /:id para el pagador, 403 para un tercero; /sync concilia sin webhook", async () => {
  const { socio, liqId, mpId, fila } = await checkoutDeUna();
  const tercero = await makeUser({ roles: ["Socio"] });
  const ok = await api("GET", `/api/transactions/${liqId}`, { token: socio.token });
  expect(ok.status).toBe(200);
  expect(ok.body.filas[0].id).toBe(fila.id);
  expect((await api("GET", `/api/transactions/${liqId}`, { token: tercero.token })).status).toBe(403);
  pagoMP(mpId, liqId);
  const s = await api("POST", `/api/transactions/${liqId}/sync`, { token: socio.token });
  expect(s.status).toBe(200);
  expect(s.body.estado).toBe("Aprobado");
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pagado");
});
