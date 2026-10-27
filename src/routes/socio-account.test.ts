// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/socio-account.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

let n = 0;
const ayer = () => new Date(Date.now() - 3 * 86_400_000);

async function fila(userId: string, concept: string, extra: Record<string, unknown> = {}) {
  await prisma.chargeType.upsert({ where: { key: concept }, update: {}, create: { key: concept, name: concept } });
  return prisma.payment.create({
    data: { user_id: userId, concept, name: `t-${concept}`, amount: 100, ref: `test:socio:${Date.now()}:${++n}`, ...extra },
  });
}
const idsDe = (cuotas: { id: string }[]) => cuotas.map((c) => c.id);

test("cuotas: sin reservas ni filas eliminadas; montos como string; deuda y vencidas", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const vencida = await fila(socio.id, "Otro", { due_date: ayer() });
  const sinVto = await fila(socio.id, "Otro");
  const reserva = await fila(socio.id, "Reserva");
  const borrada = await fila(socio.id, "Otro", { deleted_at: new Date(), status: "Anulado" });
  const r = await api("GET", "/api/socio/cuotas", { token: socio.token });
  expect(r.status).toBe(200);
  const ids = idsDe(r.body.cuotas);
  expect(ids).toContain(vencida.id);
  expect(ids).toContain(sinVto.id);
  expect(ids).not.toContain(reserva.id);
  expect(ids).not.toContain(borrada.id);
  const v = r.body.cuotas.find((c: any) => c.id === vencida.id);
  expect(v.estado).toBe("vencida");
  expect(v.monto).toBe("100");
  expect(v.tipo.key).toBe("Otro");
  expect(r.body.cuotas.find((c: any) => c.id === sinVto.id).vencimiento).toBeNull();
  expect(typeof r.body.deuda_total).toBe("string");
  expect(r.body.vencidas).toBeGreaterThanOrEqual(1);
});

test("cuotas/menor: con vinculo activo devuelve las del menor; sin vinculo 403", async () => {
  const padre = await makeUser({ roles: ["Socio"] });
  const hijo = await makeUser({ roles: ["Socio"] });
  const ajeno = await makeUser({ roles: ["Socio"] });
  const cuotaHijo = await fila(hijo.id, "Otro");
  await prisma.family.create({ data: { parent_id: padre.id, child_id: hijo.id, active: true } });
  const ok = await api("GET", `/api/socio/cuotas/menor/${hijo.id}`, { token: padre.token });
  expect(ok.status).toBe(200);
  expect(idsDe(ok.body.cuotas)).toContain(cuotaHijo.id);
  expect((await api("GET", `/api/socio/cuotas/menor/${ajeno.id}`, { token: padre.token })).status).toBe(403);
  expect((await api("GET", `/api/socio/credential/menor/${ajeno.id}`, { token: padre.token })).status).toBe(403);
  await prisma.family.updateMany({ where: { parent_id: padre.id, child_id: hijo.id }, data: { active: false } });
  expect((await api("GET", `/api/socio/cuotas/menor/${hijo.id}`, { token: padre.token })).status).toBe(403);
});

test("credencial: la bloquea sólo una Cuota social Pendiente vencida", async () => {
  const credencial = async (u: { token: string }) => (await api("GET", "/api/socio/credential", { token: u.token })).body.credencial;

  const conDisciplina = await makeUser({ roles: ["Socio"] });
  await fila(conDisciplina.id, "Disciplina", { due_date: ayer() });
  expect((await credencial(conDisciplina)).habilitada).toBe(true);

  const enRevision = await makeUser({ roles: ["Socio"] });
  await fila(enRevision.id, "Socio", { due_date: ayer(), status: "EnRevision" });
  expect((await credencial(enRevision)).habilitada).toBe(true);

  const sinVto = await makeUser({ roles: ["Socio"] });
  await fila(sinVto.id, "Socio");
  expect((await credencial(sinVto)).habilitada).toBe(true);

  const vencida = await makeUser({ roles: ["Socio"] });
  await fila(vencida.id, "Socio", { due_date: ayer() });
  const c = await credencial(vencida);
  expect(c.habilitada).toBe(false);
  expect(c.cuotas_vencidas).toBeGreaterThanOrEqual(1);
  expect(c.es_socio).toBe(true);

  const profesor = await makeUser({ roles: ["Profesor"] });
  expect((await credencial(profesor)).habilitada).toBe(false);
});

test("credential/menor: respeta el vinculo y calcula sobre el menor", async () => {
  const padre = await makeUser({ roles: ["Socio"] });
  const hijo = await makeUser({ roles: ["Socio"] });
  await fila(hijo.id, "Socio", { due_date: ayer() });
  await prisma.family.create({ data: { parent_id: padre.id, child_id: hijo.id, active: true } });
  const r = await api("GET", `/api/socio/credential/menor/${hijo.id}`, { token: padre.token });
  expect(r.status).toBe(200);
  expect(r.body.credencial.habilitada).toBe(false);
});

test("historial: los cinco metodos, reembolsos y booking_id", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const admin = await makeUser({ roles: ["Administrador"] });
  const metodos = ["MercadoPago", "Efectivo", "Transferencia", "MPFueraDeApp", "TarjetaConPosnet"] as const;
  const ids: Record<string, string> = {};
  for (const method of metodos) {
    const f = await fila(socio.id, "Otro", { status: "Pagado", method, paid_at: new Date() });
    const liq = await prisma.paymentTransaction.create({
      data: {
        user_id: socio.id, method, status: "Aprobado", amount: 100, paid_at: new Date(),
        registered_by: method === "Efectivo" ? admin.id : null,
        items: { create: [{ payment_id: f.id, amount: 100 }] },
      },
    });
    ids[method] = liq.id;
  }
  // Refund aprobado de la liquidacion MP, y uno pendiente que no debe aparecer.
  const mpFila = (await prisma.paymentTransactionItem.findFirstOrThrow({ where: { transaction_id: ids.MercadoPago } })).payment_id;
  await prisma.refund.create({
    data: {
      transaction_id: ids.MercadoPago!, payment_id: mpFila, amount: 100, status: "approved", requested_by: admin.id,
      refunded_at: new Date(), idempotency_key: `test:socio:hist:${Date.now()}:ok`,
    },
  });
  await prisma.refund.create({
    data: {
      transaction_id: ids.MercadoPago!, payment_id: mpFila, amount: 5, status: "pending", requested_by: admin.id,
      idempotency_key: `test:socio:hist:${Date.now()}:pend`,
    },
  });

  const r = await api("GET", "/api/socio/historial-pagos", { token: socio.token });
  expect(r.status).toBe(200);
  expect(r.body.pagos.map((p: any) => p.forma_de_pago).sort()).toEqual([...metodos].sort());
  const efectivo = r.body.pagos.find((p: any) => p.id === ids.Efectivo);
  expect(efectivo.registrado_por).toContain("Test");
  expect(efectivo.cuotas).toHaveLength(1);
  const mp = r.body.pagos.find((p: any) => p.id === ids.MercadoPago);
  expect(mp.reembolsos).toHaveLength(1);
  expect(mp.reembolsos[0].monto).toBe("100");
  expect(mp.reembolsos[0].cuota_id).toBe(mpFila);
  expect(mp.booking_id).toBeNull();
});

test("historial: la liquidacion del tutor aparece en la cuenta del menor", async () => {
  const padre = await makeUser({ roles: ["Socio"] });
  const hijo = await makeUser({ roles: ["Socio"] });
  const f = await fila(hijo.id, "Otro", { status: "Pagado", method: "Efectivo", paid_at: new Date() });
  const liq = await prisma.paymentTransaction.create({
    data: {
      user_id: padre.id, method: "Efectivo", status: "Aprobado", amount: 100, paid_at: new Date(),
      items: { create: [{ payment_id: f.id, amount: 100 }] },
    },
  });
  const r = await api("GET", "/api/socio/historial-pagos", { token: hijo.token });
  expect(r.body.pagos.map((p: any) => p.id)).toContain(liq.id);
});

test("sin sesion: 401", async () => {
  expect((await api("GET", "/api/socio/cuotas")).status).toBe(401);
});
