// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/payment-admin.test.ts`.
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
      ref: `test:admin:${Date.now()}:${++n}`,
      ...extra,
    },
  });
}
const estadoDe = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } }));

test("anular: motivo obligatorio, Pendiente -> Anulado, auditado", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  const sin = await api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body: { action: "anular" } });
  expect(sin.status).toBe(400);
  const ok = await api("PATCH", `/api/payments/${p.id}`, {
    token: admin.token,
    body: { action: "anular", reason: "cargada por error" },
  });
  expect(ok.status).toBe(200);
  const fila = await estadoDe(p.id);
  expect(fila.status).toBe("Anulado");
  expect(fila.resolved_reason).toBe("cargada por error");
  await logger.flush();
});

test("anular una Pagado -> 409 y la fila no cambia", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  await api("POST", `/api/payments/${p.id}/cobro`, { token: admin.token, body: {} });
  const r = await api("PATCH", `/api/payments/${p.id}`, {
    token: admin.token,
    body: { action: "anular", reason: "intento" },
  });
  expect(r.status).toBe(409);
  expect((await estadoDe(p.id)).status).toBe("Pagado");
});

test("anular -> condonar 409; condonar valido; Reserva no se anula a mano", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  await api("PATCH", `/api/payments/${a.id}`, { token: admin.token, body: { action: "anular", reason: "motivo" } });
  const dos = await api("PATCH", `/api/payments/${a.id}`, {
    token: admin.token,
    body: { action: "condonar", reason: "motivo" },
  });
  expect(dos.status).toBe(409);
  const b = await cuota(socio.id, "Otro");
  const c = await api("PATCH", `/api/payments/${b.id}`, { token: admin.token, body: { action: "condonar", reason: "beca" } });
  expect(c.status).toBe(200);
  expect((await estadoDe(b.id)).status).toBe("Condonado");
  const r = await cuota(socio.id, "Reserva");
  const res = await api("PATCH", `/api/payments/${r.id}`, { token: admin.token, body: { action: "anular", reason: "motivo" } });
  expect(res.status).toBe(409);
});

test("confirmar/rechazar -> 400; no admin -> 403", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const prof = await makeUser({ roles: ["Profesor"] });
  const p = await cuota(socio.id, "Otro");
  for (const action of ["confirmar", "rechazar"]) {
    const r = await api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body: { action } });
    expect(r.status).toBe(400);
  }
  for (const t of [socio.token, prof.token]) {
    expect((await api("PATCH", `/api/payments/${p.id}`, { token: t, body: { action: "anular", reason: "motivo" } })).status).toBe(403);
    expect((await api("DELETE", `/api/payments/${p.id}`, { token: t, body: { reason: "motivo" } })).status).toBe(403);
  }
});

test("EnRevision legado: anulable, condonable y cobrable con Transferencia", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro", { status: "EnRevision" });
  const b = await cuota(socio.id, "Otro", { status: "EnRevision" });
  const c = await cuota(socio.id, "Otro", { status: "EnRevision" });
  expect((await api("PATCH", `/api/payments/${a.id}`, { token: admin.token, body: { action: "anular", reason: "motivo" } })).status).toBe(200);
  expect((await api("PATCH", `/api/payments/${b.id}`, { token: admin.token, body: { action: "condonar", reason: "motivo" } })).status).toBe(200);
  expect((await api("POST", `/api/payments/${c.id}/cobro`, { token: admin.token, body: { method: "Transferencia" } })).status).toBe(200);
});

test("editar vencimiento: a null y a fecha; el nulo no es vencida", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro", { due_date: new Date("2020-01-01T00:00:00Z") });
  const r = await api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body: { action: "editar", due_date: null } });
  expect(r.status).toBe(200);
  expect((await estadoDe(p.id)).due_date).toBeNull();
  const l = await api("GET", `/api/payments?user_id=${socio.id}`, { token: admin.token });
  expect(l.body.payments[0].estado).toBe("al_dia");
  expect((await api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body: { action: "editar", due_date: "2031-05-01" } })).status).toBe(200);
});

test("editar monto, nombre y descripcion: solo Pendiente sin pago en curso, auditado", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro", { due_date: new Date("2031-01-01T00:00:00Z") });
  const patch = (id: string, body: object) => api("PATCH", `/api/payments/${id}`, { token: admin.token, body: { action: "editar", ...body } });

  const r = await patch(p.id, { amount: 250.5, name: "Cuota corregida", description: "detalle" });
  expect(r.status).toBe(200);
  const editada = await estadoDe(p.id);
  expect(Number(editada.amount)).toBe(250.5);
  expect(editada).toMatchObject({ name: "Cuota corregida", description: "detalle" });
  expect(editada.due_date?.toISOString().slice(0, 10)).toBe("2031-01-01"); // campo ausente no se toca
  await logger.flush();

  // el listado trae description para precargar la hoja; null y "" la borran
  const l = await api("GET", `/api/payments?user_id=${socio.id}`, { token: admin.token });
  expect(l.body.payments.find((x: { id: string }) => x.id === p.id).description).toBe("detalle");
  expect((await patch(p.id, { description: "" })).status).toBe(200);
  expect((await estadoDe(p.id)).description).toBeNull();
  expect((await patch(p.id, { description: "otra" })).status).toBe(200);
  expect((await patch(p.id, { description: null })).status).toBe(200);
  expect((await estadoDe(p.id)).description).toBeNull();

  expect((await patch(p.id, {})).status).toBe(400);
  expect((await patch(p.id, { amount: 0 })).status).toBe(400);
  expect((await patch(p.id, { name: "" })).status).toBe(400);
  expect((await patch(p.id, { status: "Pagado" })).status).toBe(400);

  const pagada = await cuota(socio.id, "Otro", { status: "Pagado", method: "Efectivo", paid_at: new Date() });
  expect((await patch(pagada.id, { amount: 1 })).status).toBe(409);
  const enRevision = await cuota(socio.id, "Otro", { status: "EnRevision" });
  expect((await patch(enRevision.id, { name: "x" })).status).toBe(409);

  const viva = await cuota(socio.id, "Otro");
  await prisma.paymentTransaction.create({
    data: {
      user_id: socio.id, method: "MercadoPago", status: "Pendiente", amount: 100,
      expires_at: new Date(Date.now() + 3_600_000),
      items: { create: [{ payment_id: viva.id, amount: 100 }] },
    },
  });
  expect((await patch(viva.id, { amount: 5 })).status).toBe(409);
  expect(Number((await estadoDe(viva.id)).amount)).toBe(100);
});

test("anular concurrente: uno 200 y uno 409", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  const body = { action: "anular", reason: "motivo" };
  const rs = await Promise.all([
    api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body }),
    api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body }),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
});

test("pago en curso (MP viva) bloquea anular y eliminar con 409", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  await prisma.paymentTransaction.create({
    data: {
      user_id: socio.id,
      method: "MercadoPago",
      status: "Pendiente",
      amount: 100,
      expires_at: new Date(Date.now() + 3_600_000),
      items: { create: { payment_id: p.id, amount: 100 } },
    },
  });
  expect((await api("PATCH", `/api/payments/${p.id}`, { token: admin.token, body: { action: "anular", reason: "motivo" } })).status).toBe(409);
  expect((await api("DELETE", `/api/payments/${p.id}`, { token: admin.token, body: { reason: "motivo" } })).status).toBe(409);
});

test("eliminar: Anulado + deleted_*, oculta salvo ?eliminados=1; Pagado y Reserva 409", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  expect((await api("DELETE", `/api/payments/${p.id}`, { token: admin.token, body: {} })).status).toBe(400);
  expect((await api("DELETE", `/api/payments/${p.id}`, { token: admin.token, body: { reason: "duplicada" } })).status).toBe(200);
  const fila = await estadoDe(p.id);
  expect(fila.status).toBe("Anulado");
  expect(fila.deleted_at).not.toBeNull();
  expect(fila.deleted_by).toBe(admin.id);
  const oculta = await api("GET", `/api/payments?user_id=${socio.id}`, { token: admin.token });
  expect(oculta.body.payments).toHaveLength(0);
  const visible = await api("GET", `/api/payments?user_id=${socio.id}&eliminados=1`, { token: admin.token });
  expect(visible.body.payments[0].eliminado).toBe(true);
  const pagada = await cuota(socio.id, "Otro");
  await api("POST", `/api/payments/${pagada.id}/cobro`, { token: admin.token, body: {} });
  expect((await api("DELETE", `/api/payments/${pagada.id}`, { token: admin.token, body: { reason: "motivo" } })).status).toBe(409);
  const r = await cuota(socio.id, "Reserva");
  expect((await api("DELETE", `/api/payments/${r.id}`, { token: admin.token, body: { reason: "motivo" } })).status).toBe(409);
});

test("cargo unico: monto del tipo, 400 sin monto, Reserva 400, duplicado permitido", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  await prisma.chargeType.upsert({ where: { key: "Sugerido" }, update: {}, create: { key: "Sugerido", name: "Sugerido", suggested_amount: 250 } });
  await prisma.chargeType.upsert({ where: { key: "SinMonto" }, update: {}, create: { key: "SinMonto", name: "SinMonto" } });
  const a = await api("POST", "/api/payments", { token: admin.token, body: { user_id: socio.id, concept: "Sugerido" } });
  expect(a.status).toBe(201);
  expect(a.body.payment.amount).toBe(250);
  expect(a.body.payment.name).toBe("Sugerido");
  expect(a.body.payment.due_date).toBeNull();
  const b = await api("POST", "/api/payments", { token: admin.token, body: { user_id: socio.id, concept: "Sugerido" } });
  expect(b.status).toBe(201);
  expect(b.body.payment.ref).not.toBe(a.body.payment.ref);
  expect((await api("POST", "/api/payments", { token: admin.token, body: { user_id: socio.id, concept: "SinMonto" } })).status).toBe(400);
  expect((await api("POST", "/api/payments", { token: admin.token, body: { user_id: socio.id, concept: "Reserva", amount: 10 } })).status).toBe(400);
  expect((await api("POST", "/api/payments", { token: socio.token, body: { user_id: socio.id, concept: "Sugerido" } })).status).toBe(403);
});

test("listado: filas enriquecidas, acciones solo gestion, paginado con hay_mas", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  for (let i = 0; i < 3; i++) await cuota(socio.id, "Otro");
  const g = await api("GET", `/api/payments?user_id=${socio.id}&page=1&page_size=2`, { token: admin.token });
  expect(g.body.payments).toHaveLength(2);
  expect(g.body.hay_mas).toBe(true);
  expect(g.body.payments[0].acciones).toContain("cobrar");
  expect(g.body.payments[0].tipo.key).toBe("Otro");
  const s = await api("GET", "/api/payments", { token: socio.token });
  expect(s.body.payments[0].acciones).toBeUndefined();
  expect(s.body.hay_mas).toBeUndefined();
});

test("D25: indicadores == filas de ?concept=Socio&estado=vencida; estado invalido 400; no admin 403", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const pasado = new Date("2020-01-01T00:00:00Z");
  await cuota(socio.id, "Socio", { due_date: pasado });
  await cuota(socio.id, "Socio", { due_date: pasado });
  await cuota(socio.id, "Socio", { due_date: null });
  await cuota(socio.id, "Socio", { due_date: pasado, status: "EnRevision" });
  await cuota(socio.id, "Otro", { due_date: pasado });
  const ind = await api("GET", "/api/payments/indicadores", { token: admin.token });
  expect(ind.status).toBe(200);
  const lista = await api("GET", "/api/payments?concept=Socio&estado=vencida", { token: admin.token });
  expect(lista.body.payments).toHaveLength(ind.body.cuotas_sociales_vencidas);
  expect(ind.body.socios).toBeGreaterThanOrEqual(1);
  expect((await api("GET", "/api/payments?estado=otro", { token: admin.token })).status).toBe(400);
  expect((await api("GET", "/api/payments/indicadores", { token: socio.token })).status).toBe(403);
});

test("accionesPermitidas == guardas: una Pagado no ofrece anular ni eliminar", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  await api("POST", `/api/payments/${p.id}/cobro`, { token: admin.token, body: {} });
  const l = await api("GET", `/api/payments?user_id=${socio.id}`, { token: admin.token });
  expect(l.body.payments[0].acciones).toEqual(["revertir"]);
  expect(l.body.payments[0].liquidacion.status).toBe("Aprobado");
});

test("listado ?id= / ?ids=: solo gestion, devuelve las filas pedidas con acciones", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const a = await cuota(socio.id, "Otro");
  const b = await cuota(socio.id, "Otro");
  await cuota(socio.id, "Otro");
  const uno = await api("GET", `/api/payments?id=${a.id}`, { token: admin.token });
  expect(uno.body.payments.map((p: any) => p.id)).toEqual([a.id]);
  expect(Array.isArray(uno.body.payments[0].acciones)).toBe(true);
  const dos = await api("GET", `/api/payments?ids=${a.id},${b.id}`, { token: admin.token });
  expect(dos.body.payments.map((p: any) => p.id).sort()).toEqual([a.id, b.id].sort());
  // Un socio no usa el filtro para ver filas ajenas: sigue acotado a las propias.
  const otro = await makeUser({ roles: ["Socio"] });
  const ajeno = await api("GET", `/api/payments?id=${a.id}`, { token: otro.token });
  expect(ajeno.body.payments).toHaveLength(0);
});

async function cobroCon(userId: string, paymentId: string, method: "Efectivo" | "MercadoPago", paidAt: Date, amount = 100) {
  const tx = await prisma.paymentTransaction.create({
    data: { user_id: userId, method, status: "Aprobado", amount, paid_at: paidAt },
  });
  await prisma.paymentTransactionItem.create({ data: { transaction_id: tx.id, payment_id: paymentId, amount } });
  return tx;
}

test("listado ?discipline_id= y ?method=: filtran; invalidos 400", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const disc = await prisma.discipline.create({ data: { name: `Filtro ${Date.now()}` } });
  const enr = await prisma.enrollment.create({ data: { user_id: socio.id, discipline_id: disc.id } });
  const deDisc = await cuota(socio.id, "Otro", { enrollment_id: enr.id });
  const otra = await cuota(socio.id, "Otro");
  await cobroCon(socio.id, deDisc.id, "MercadoPago", new Date());
  await cobroCon(socio.id, otra.id, "Efectivo", new Date());

  const porDisc = await api("GET", `/api/payments?user_id=${socio.id}&discipline_id=${disc.id}`, { token: admin.token });
  expect(porDisc.body.payments.map((p: any) => p.id)).toEqual([deDisc.id]);
  const porMetodo = await api("GET", `/api/payments?user_id=${socio.id}&method=Efectivo`, { token: admin.token });
  expect(porMetodo.body.payments.map((p: any) => p.id)).toEqual([otra.id]);

  expect((await api("GET", "/api/payments?method=Bitcoin", { token: admin.token })).status).toBe(400);
  expect((await api("GET", "/api/payments?discipline_id=abc", { token: admin.token })).status).toBe(400);
  expect((await api("GET", "/api/payments?discipline_id=-3", { token: admin.token })).status).toBe(400);
});

test("historial: pagos y reembolsos, nuevo primero, con el monto del item; 403 y 404", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const p = await cuota(socio.id, "Otro");
  const otra = await cuota(socio.id, "Otro");
  // Una transaccion de 300 que cubrio dos cargos: aca debe verse sólo el item de 100.
  const tx = await prisma.paymentTransaction.create({
    data: { user_id: socio.id, method: "MercadoPago", status: "Aprobado", amount: 300, paid_at: new Date("2026-03-01T12:00:00Z") },
  });
  await prisma.paymentTransactionItem.createMany({
    data: [
      { transaction_id: tx.id, payment_id: p.id, amount: 100 },
      { transaction_id: tx.id, payment_id: otra.id, amount: 200 },
    ],
  });
  await prisma.refund.create({
    data: {
      transaction_id: tx.id, payment_id: p.id, amount: 40, status: "approved", requested_by: admin.id,
      refunded_at: new Date("2026-04-01T12:00:00Z"), idempotency_key: `test:hist:${Date.now()}:${++n}`,
    },
  });

  const r = await api("GET", `/api/payments/${p.id}/historial`, { token: admin.token });
  expect(r.status).toBe(200);
  expect(r.body.historial.map((h: any) => h.tipo)).toEqual(["reembolso", "pago"]);
  expect(r.body.historial[0]).toMatchObject({ amount: 40, status: "approved", method: "MercadoPago" });
  expect(r.body.historial[1]).toMatchObject({ id: tx.id, amount: 100, status: "Aprobado", method: "MercadoPago" });
  expect(r.body.historial[1].fecha).toBe("2026-03-01T12:00:00.000Z");

  expect((await api("GET", `/api/payments/${p.id}/historial`, { token: socio.token })).status).toBe(403);
  expect((await api("GET", "/api/payments/no-existe/historial", { token: admin.token })).status).toBe(404);
});
