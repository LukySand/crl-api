// Requiere la base de test: `bun run test:db` y luego `bun test src/lib/emission.test.ts`.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import prisma from "./prisma";
import { emitirCargos } from "./emission";
import { periodoActual, todayInClub } from "./payment-period";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";
import type { Prisma } from "../../prisma/generated/client";

const hoy = todayInClub();
const periodo = periodoActual();

beforeAll(async () => {
  await startTestServer();
  for (const key of ["Disciplina", "Socio", "Extra"]) {
    await prisma.chargeType.upsert({
      where: { key },
      update: { active: true },
      create: { key, name: key, system: key !== "Extra" },
    });
  }
});

afterAll(stopTestServer);

// Cada test arranca sin plantillas activas: el motor emite para TODAS las activas.
beforeEach(() => prisma.recurringTemplate.updateMany({ data: { active: false } }));

async function plantilla(data: Partial<Prisma.RecurringTemplateUncheckedCreateInput> & { targets?: string[] }) {
  const admin = await makeUser({ roles: ["Administrador"] });
  const { targets = [], ...resto } = data;
  return prisma.recurringTemplate.create({
    data: {
      concept: "Extra",
      name: "Plantilla de prueba",
      amount: 500,
      period_mode: "DiaDelMes",
      day_of_month: 1,
      start_date: new Date("2020-01-01T00:00:00Z"),
      target_mode: "Socio",
      created_by: admin.id,
      ...resto,
      targets: { create: targets.map((user_id) => ({ user_id })) },
    },
  });
}

const filas = (template_id: number) => prisma.payment.findMany({ where: { template_id } });

test("doble corrida: la segunda no crea filas", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const t = await plantilla({ targets: [socio.id] });
  const a = await emitirCargos({ userId: socio.id, hoy });
  const b = await emitirCargos({ userId: socio.id, hoy });
  expect(a.generadas).toBe(1);
  expect(b.generadas).toBe(0);
  expect(await filas(t.id)).toHaveLength(1);
});

test("un ref con el formato de dev no se duplica", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  await plantilla({ concept: "Socio", targets: [socio.id] });
  await prisma.payment.create({
    data: {
      user_id: socio.id,
      concept: "Socio",
      name: "Cuota social (dev)",
      amount: 15000,
      period: periodo,
      ref: `socio:${socio.id}:${periodo}`,
    },
  });
  const r = await emitirCargos({ userId: socio.id, hoy });
  expect(r.generadas).toBe(0);
  expect(await prisma.payment.count({ where: { user_id: socio.id, concept: "Socio" } })).toBe(1);
});

test("Lista: un cargo por integrante", async () => {
  const [a, b] = [await makeUser({ roles: ["Socio"] }), await makeUser({ roles: ["Socio"] })];
  const t = await plantilla({ target_mode: "Lista", targets: [a.id, b.id] });
  await emitirCargos({ hoy });
  expect((await filas(t.id)).map((f) => f.user_id).sort()).toEqual([a.id, b.id].sort());
});

test("Disciplina: cursó el mes sí, se fue antes no; monto = Fee vigente", async () => {
  const fee = await prisma.fee.create({ data: { name: "Cuota test", amount: 7000, kind: "Disciplina" } });
  const disc = await prisma.discipline.create({ data: { name: `Emision ${Date.now()}`, fee_id: fee.id } });
  const activo = await makeUser({ roles: ["Socio"] });
  const baja = await makeUser({ roles: ["Socio"] });
  const eActivo = await prisma.enrollment.create({ data: { user_id: activo.id, discipline_id: disc.id } });
  await prisma.enrollment.create({
    data: {
      user_id: baja.id,
      discipline_id: disc.id,
      active: null,
      created_at: new Date("2020-01-10T00:00:00Z"),
      left_at: new Date("2020-02-10T00:00:00Z"),
    },
  });
  const t = await plantilla({ concept: "Disciplina", target_mode: "Disciplina", discipline_id: disc.id, amount: null });
  await emitirCargos({ hoy });
  const f = await filas(t.id);
  expect(f).toHaveLength(1);
  expect(f[0]!.ref).toBe(`disciplina:${eActivo.id}:${periodo}`);
  expect(Number(f[0]!.amount)).toBe(7000);
  expect(f[0]!.fee_id).toBe(fee.id);
});

test("editar el monto de la plantilla sólo rige hacia adelante", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const t = await plantilla({ targets: [socio.id], amount: 500 });
  await emitirCargos({ hoy });
  await prisma.recurringTemplate.update({ where: { id: t.id }, data: { amount: 900 } });
  await emitirCargos({ hoy });
  const f = await filas(t.id);
  expect(f).toHaveLength(1);
  expect(Number(f[0]!.amount)).toBe(500);
});

test("monto 0 nace Pagado, sin método", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const t = await plantilla({ targets: [socio.id], amount: 0 });
  await emitirCargos({ hoy });
  const [fila] = await filas(t.id);
  expect(fila!.status).toBe("Pagado");
  expect(fila!.method).toBeNull();
  expect(fila!.paid_at).not.toBeNull();
});

test("antes del inicio o después del fin no emite", async () => {
  const socio = await makeUser({ roles: ["Socio"] });
  const futura = await plantilla({ targets: [socio.id], start_date: new Date("2999-01-01T00:00:00Z") });
  const vencida = await plantilla({ targets: [socio.id], end_date: new Date("2020-06-01T00:00:00Z") });
  await emitirCargos({ hoy });
  expect(await filas(futura.id)).toHaveLength(0);
  expect(await filas(vencida.id)).toHaveLength(0);
});

test("todas las filas de una corrida llevan el mismo created_at", async () => {
  const [a, b] = [await makeUser({ roles: ["Socio"] }), await makeUser({ roles: ["Socio"] })];
  const t = await plantilla({ target_mode: "Lista", targets: [a.id, b.id] });
  await emitirCargos({ hoy });
  const [x, y] = await filas(t.id);
  expect(x!.created_at.getTime()).toBe(y!.created_at.getTime());
});

test("inscribirse cobra en el acto la cuota del ciclo vigente", async () => {
  const fee = await prisma.fee.create({ data: { name: "Cuota alta", amount: 4000, kind: "Disciplina" } });
  const disc = await prisma.discipline.create({ data: { name: `Alta ${Date.now()}`, fee_id: fee.id } });
  const socio = await makeUser({ roles: ["Socio"] });
  const t = await plantilla({ concept: "Disciplina", target_mode: "Disciplina", discipline_id: disc.id, amount: null });
  const res = await api("POST", "/api/enrollments", { token: socio.token, body: { discipline_id: disc.id } });
  expect(res.status).toBe(201);
  const f = await filas(t.id);
  expect(f).toHaveLength(1);
  expect(f[0]!.user_id).toBe(socio.id);
});
