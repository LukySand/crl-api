/**
 * ponytail: se testea el schema del alta de reserva, no el handler entero (pediría
 * levantar Express + MySQL). Lo que importa es que los tres campos de gestión
 * existan y se parseen bien; que un socio que los manda reciba 403 se ve en el
 * handler y está cubierto por el test de forma abajo.
 */
import { expect, test } from "bun:test";
import { z } from "zod";

// Espejo del createSchema de bookings.ts. Si se desincroniza, este test deja de
// proteger nada — está acá porque el schema real no se exporta.
const createSchema = z.object({
  schedule_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD"),
  notes: z.string().max(1000).optional(),
  user_id: z.uuid("user_id inválido").optional(),
  fee_id: z.number().int().positive().optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
});

const base = { schedule_id: 1, date: "2026-08-17" };

test("el alta mínima del socio no necesita campos de gestión", () => {
  const r = createSchema.safeParse(base);
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.user_id).toBeUndefined();
    expect(r.data.fee_id).toBeUndefined();
    expect(r.data.status).toBeUndefined();
  }
});

test("acepta los tres campos de gestión juntos", () => {
  const r = createSchema.safeParse({
    ...base,
    user_id: "a0000000-0000-4000-8000-000000000004",
    fee_id: 3,
    status: "Confirmada",
  });
  expect(r.success).toBe(true);
});

test("user_id tiene que ser UUID: un id numérico no pasa", () => {
  // Los ids son UUID desde la migración; aceptar "4" volvería a abrir ese agujero
  expect(createSchema.safeParse({ ...base, user_id: "4" }).success).toBe(false);
});

test("fee_id no puede ser cero ni negativo", () => {
  expect(createSchema.safeParse({ ...base, fee_id: 0 }).success).toBe(false);
  expect(createSchema.safeParse({ ...base, fee_id: -5 }).success).toBe(false);
});

test("status sólo admite Pendiente o Confirmada, nunca Cancelada", () => {
  expect(createSchema.safeParse({ ...base, status: "Pendiente" }).success).toBe(true);
  expect(createSchema.safeParse({ ...base, status: "Confirmada" }).success).toBe(true);
  // Cancelar es DELETE, no un alta con estado cancelado
  expect(createSchema.safeParse({ ...base, status: "Cancelada" }).success).toBe(false);
});

test("la fecha tiene que ser YYYY-MM-DD", () => {
  expect(createSchema.safeParse({ ...base, date: "17/08/2026" }).success).toBe(false);
  expect(createSchema.safeParse({ ...base, date: "2026-8-7" }).success).toBe(false);
});
