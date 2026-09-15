/**
 * ponytail: se testea el schema del monto de la cuota, no el handler (pediría
 * Express + MySQL). Lo que importa es la regla de negocio: la cuota se manda
 * como monto entero positivo, y el error sale bajo la clave `amount` porque el
 * front lo pinta debajo de ese campo.
 */
import { expect, test } from "bun:test";
import { z } from "zod";

// Espejo del cuotaAmountSchema de disciplines.ts. Si se desincroniza, este test
// deja de proteger nada.
const cuotaAmountSchema = z.coerce
  .number({ error: "El monto debe ser un número" })
  .int("El monto debe ser un número entero de pesos")
  .positive("El monto debe ser mayor a cero")
  .max(99_999_999, "El monto es demasiado grande");

const disciplineSchema = z.object({
  name: z.string().min(1).max(100),
  amount: cuotaAmountSchema.optional().nullable(),
  fee_id: z.coerce.number().int().positive().optional().nullable(),
});

const base = { name: "Vóley" };

test("un monto entero positivo pasa", () => {
  const r = disciplineSchema.safeParse({ ...base, amount: 9000 });
  expect(r.success).toBe(true);
  expect(r.data?.amount).toBe(9000);
});

test("sin amount o con amount null la disciplina queda sin cuota", () => {
  expect(disciplineSchema.safeParse(base).success).toBe(true);
  const r = disciplineSchema.safeParse({ ...base, amount: null });
  expect(r.success).toBe(true);
  expect(r.data?.amount).toBeNull();
});

test("cero, negativo, decimal o no numérico caen bajo la clave amount", () => {
  for (const amount of [0, -1, 1500.5, "abc", {}]) {
    const r = disciplineSchema.safeParse({ ...base, amount });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path[0]).toBe("amount");
  }
});

test("fee_id se sigue aceptando para los clientes viejos", () => {
  expect(disciplineSchema.safeParse({ ...base, fee_id: 3 }).success).toBe(true);
});
