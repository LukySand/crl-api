// Requiere la base de test: `bun run test:db` y luego `bun test src/routes/charge-catalog.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

const unico = () => `K${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("socio y profesor reciben 403; sin token 401", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const profe = await makeUser({ roles: ["Profesor"] });
  expect((await api("GET", "/api/charge-types")).status).toBe(401);
  for (const u of [socio, profe]) {
    expect((await api("GET", "/api/charge-types", { token: u.token })).status).toBe(403);
    expect((await api("GET", "/api/recurring-templates", { token: u.token })).status).toBe(403);
    expect((await api("POST", "/api/recurring-templates/preview", { token: u.token, body: {} })).status).toBe(403);
    expect((await api("POST", "/api/recurring-templates/1/targets", { token: u.token, body: { user_id: u.id } })).status).toBe(403);
    expect((await api("DELETE", `/api/recurring-templates/1/targets/${u.id}`, { token: u.token })).status).toBe(403);
  }
});

test("alta de tipo: clave válida, duplicada sin distinguir mayúsculas -> 409, bloquea_credencial -> 400", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const key = unico();
  const ok = await api("POST", "/api/charge-types", { token: admin.token, body: { key, name: "Prueba" } });
  expect(ok.status).toBe(201);
  expect(ok.body.charge_type.bloquea_credencial).toBe(false);

  const dup = await api("POST", "/api/charge-types", { token: admin.token, body: { key: key.toLowerCase(), name: "Otra" } });
  expect(dup.status).toBe(409);

  const mala = await api("POST", "/api/charge-types", { token: admin.token, body: { key: "1mala", name: "x" } });
  expect(mala.status).toBe(400);

  const bloqueo = await api("POST", "/api/charge-types", {
    token: admin.token,
    body: { key: unico(), name: "x", bloquea_credencial: true },
  });
  expect(bloqueo.status).toBe(400);
});

test("PATCH de tipo: la clave no se edita y un tipo del sistema no se desactiva", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const sys = await prisma.chargeType.upsert({
    where: { key: "Socio" },
    update: {},
    create: { key: "Socio", name: "Cuota social", system: true },
  });
  expect((await api("PATCH", `/api/charge-types/${sys.id}`, { token: admin.token, body: { active: false } })).status).toBe(400);
  expect((await api("PATCH", `/api/charge-types/${sys.id}`, { token: admin.token, body: { key: "Otra" } })).status).toBe(400);
  expect((await api("PATCH", `/api/charge-types/${sys.id}`, { token: admin.token, body: { bloquea_credencial: false } })).status).toBe(400);
  const ok = await api("PATCH", `/api/charge-types/${sys.id}`, { token: admin.token, body: { name: "Cuota social" } });
  expect(ok.status).toBe(200);
  expect(ok.body.charge_type.bloquea_credencial).toBe(true);
});

test("plantilla: reglas de validación y proximo_ciclo", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = unico();
  await api("POST", "/api/charge-types", { token: admin.token, body: { key, name: "T" } });
  const base = {
    concept: key,
    name: "Mensual",
    amount: 100,
    period_mode: "DiaDelMes",
    day_of_month: 5,
    start_date: "2030-01-01",
    target_mode: "Socio",
    targets: [socio.id],
  };
  const crear = (cambio: object) => api("POST", "/api/recurring-templates", { token: admin.token, body: { ...base, ...cambio } });

  expect((await crear({ day_of_month: undefined })).status).toBe(400);
  expect((await crear({ period_mode: "CadaN" })).status).toBe(400);
  expect((await crear({ end_date: "2029-01-01" })).status).toBe(400);
  expect((await crear({ targets: [] })).status).toBe(400);
  expect((await crear({ target_mode: "Lista", targets: [] })).status).toBe(400);
  expect((await crear({ amount: null })).status).toBe(400);
  expect((await crear({ due_rule: "DiasDesdeEmision" })).status).toBe(400);

  const ok = await crear({});
  expect(ok.status).toBe(201);
  expect(ok.body.template.proximo_ciclo).toBe("2030-01-05");
});

test("editar el tipo o la plantilla no toca filas ya emitidas", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const socio = await makeUser({ roles: ["Socio"] });
  const key = unico();
  const tipo = await api("POST", "/api/charge-types", { token: admin.token, body: { key, name: "Original" } });
  const t = await api("POST", "/api/recurring-templates", {
    token: admin.token,
    body: { concept: key, name: "P", amount: 100, period_mode: "DiaDelMes", day_of_month: 1, start_date: "2030-01-01", target_mode: "Socio", targets: [socio.id] },
  });
  const fila = await prisma.payment.create({
    data: { user_id: socio.id, concept: key, name: "Emitida", amount: 100, ref: `${key.toLowerCase()}:${socio.id}:2030-01`, template_id: t.body.template.id },
  });
  await api("PATCH", `/api/charge-types/${tipo.body.charge_type.id}`, { token: admin.token, body: { name: "Cambiado" } });
  await api("PATCH", `/api/recurring-templates/${t.body.template.id}`, { token: admin.token, body: { amount: 999 } });
  const despues = await prisma.payment.findUnique({ where: { id: fila.id } });
  expect(Number(despues!.amount)).toBe(100);
  expect(despues!.name).toBe("Emitida");
});

test("cada alta y edición queda en la auditoría", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const key = unico();
  const alta = await api("POST", "/api/charge-types", { token: admin.token, body: { key, name: "Auditado" } });
  await api("PATCH", `/api/charge-types/${alta.body.charge_type.id}`, { token: admin.token, body: { name: "Auditado 2" } });
  await logger.flush();
  const filas = await prisma.$queryRawUnsafe<{ metadata: any }[]>(
    "SELECT metadata FROM logs WHERE topic = 'audit' AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.entidad')) = 'charge_type' AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.entidad_id')) = ?",
    String(alta.body.charge_type.id),
  );
  const ops = filas.map((f) => (typeof f.metadata === "string" ? JSON.parse(f.metadata) : f.metadata)).map((m) => m.operacion);
  expect(ops.sort()).toEqual(["create", "update"]);
});

async function plantillaLista(admin: { token: string }, ids: string[], extra: object = {}) {
  const key = unico();
  await api("POST", "/api/charge-types", { token: admin.token, body: { key, name: "T" } });
  const base = {
    concept: key, name: "Lista", amount: 100, period_mode: "DiaDelMes", day_of_month: 5,
    start_date: "2030-01-01", target_mode: "Lista", targets: ids,
  };
  return { key, base: { ...base, ...extra } };
}

test("preview: no guarda nada y cuenta destinatarios activos de una Lista", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const a = await makeUser({ roles: ["Socio"] });
  const b = await makeUser({ roles: ["Socio"] });
  const baja = await makeUser({ roles: ["Socio"] });
  await prisma.user.update({ where: { id: baja.id }, data: { active: false } });
  const { key, base } = await plantillaLista(admin, [a.id, b.id, baja.id]);

  const antes = await prisma.recurringTemplate.count({ where: { concept: key } });
  const r = await api("POST", "/api/recurring-templates/preview", { token: admin.token, body: base });
  expect(r.status).toBe(200);
  expect(r.body.preview).toMatchObject({ fecha: "2030-01-05", period: "2030-01", destinatarios: 2, monto_unitario: 100, monto_total: 200 });
  expect(await prisma.payment.count({ where: { concept: key } })).toBe(0);
  expect(await prisma.recurringTemplate.count({ where: { concept: key } })).toBe(antes);

  const fin = await api("POST", "/api/recurring-templates/preview", {
    token: admin.token,
    body: { ...base, start_date: "2020-01-01", end_date: "2020-06-01" },
  });
  expect(fin.body.preview).toBeNull();
});

test("asignar socio a una Lista: ok, idempotente, y rechaza otros modos", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const a = await makeUser({ roles: ["Socio"] });
  const b = await makeUser({ roles: ["Socio"] });
  const { base } = await plantillaLista(admin, [a.id]);
  const t = await api("POST", "/api/recurring-templates", { token: admin.token, body: base });
  const id = t.body.template.id;

  const ok = await api("POST", `/api/recurring-templates/${id}/targets`, { token: admin.token, body: { user_id: b.id } });
  expect(ok.status).toBe(200);
  expect(ok.body.template.targets.sort()).toEqual([a.id, b.id].sort());
  const otra = await api("POST", `/api/recurring-templates/${id}/targets`, { token: admin.token, body: { user_id: b.id } });
  expect(otra.status).toBe(200);
  expect(otra.body.template.targets).toHaveLength(2);
  expect((await api("POST", `/api/recurring-templates/${id}/targets`, { token: admin.token, body: { user_id: "no-existe" } })).status).toBe(400);
  expect((await api("POST", "/api/recurring-templates/99999999/targets", { token: admin.token, body: { user_id: b.id } })).status).toBe(404);

  const socio = await api("POST", "/api/recurring-templates", {
    token: admin.token,
    body: { ...base, target_mode: "Socio", targets: [a.id] },
  });
  const mal = await api("POST", `/api/recurring-templates/${socio.body.template.id}/targets`, { token: admin.token, body: { user_id: b.id } });
  expect(mal.status).toBe(400);
});

test("quitar socio de una Lista: ok, el último -> 409, ajeno -> 404", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  const a = await makeUser({ roles: ["Socio"] });
  const b = await makeUser({ roles: ["Socio"] });
  const { base } = await plantillaLista(admin, [a.id, b.id]);
  const id = (await api("POST", "/api/recurring-templates", { token: admin.token, body: base })).body.template.id;

  const ok = await api("DELETE", `/api/recurring-templates/${id}/targets/${b.id}`, { token: admin.token });
  expect(ok.status).toBe(200);
  expect(ok.body.template.targets).toEqual([a.id]);
  expect((await api("DELETE", `/api/recurring-templates/${id}/targets/${b.id}`, { token: admin.token })).status).toBe(404);
  expect((await api("DELETE", `/api/recurring-templates/${id}/targets/${a.id}`, { token: admin.token })).status).toBe(409);
});
