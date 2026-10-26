// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/checkout.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import prisma from "../lib/prisma";
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

test("aprobacion de una fila anulada durante el checkout: no salda y deja el reembolso pedido", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  await prisma.payment.update({ where: { id: fila.id }, data: { status: "Anulado" } });
  pagoMP(mpId, liqId);
  expect(await webhook(mpId)).toBe(200);
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Anulado");
  const r = await prisma.refund.findFirst({ where: { transaction_id: liqId, payment_id: fila.id } });
  expect(r?.status).toBe("pending");
  expect(r?.idempotency_key).toBe(`reembolso:${liqId}:${fila.id}`);
});

test("monto inconsistente: no salda y pide el reembolso total", async () => {
  const { fila, liqId, mpId } = await checkoutDeUna();
  pagoMP(mpId, liqId, { transaction_amount: 50 });
  expect(await webhook(mpId)).toBe(200);
  expect((await prisma.payment.findUnique({ where: { id: fila.id } }))?.status).toBe("Pendiente");
  const r = await prisma.refund.findFirst({ where: { transaction_id: liqId, payment_id: null } });
  expect(r?.status).toBe("pending");
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
