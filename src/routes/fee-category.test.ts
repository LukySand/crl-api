/**
 * ponytail: se testea el schema del alta de tarifa, no el handler (pediría Express
 * + MySQL). Lo que importa es la regla de negocio: `Reserva` no se elige a mano.
 */
import { expect, test } from "bun:test";
import { z } from "zod";

// Espejo del feeSchema de fees.ts. Si se desincroniza, este test deja de proteger
// nada — está acá porque el schema real no se exporta.
const CATEGORIAS_MANUALES = ["CuotaSocio", "Disciplina", "Donacion", "Otro"] as const;

const feeSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(255),
  amount: z.coerce
    .number()
    .nonnegative("El monto no puede ser negativo")
    .max(99_999_999.99, "El monto es demasiado grande"),
  category: z
    .enum(CATEGORIAS_MANUALES, {
      error: "Las tarifas de reserva se crean solas al cargar el precio de un turno",
    })
    .default("Otro"),
  description: z.string().optional(),
});

const base = { name: "Cuota mensual socio", amount: 8000 };

test("sin categoría cae en Otro", () => {
  const r = feeSchema.safeParse(base);
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.category).toBe("Otro");
});

test("acepta las cuatro categorías manuales", () => {
  for (const c of CATEGORIAS_MANUALES) {
    expect(feeSchema.safeParse({ ...base, category: c }).success).toBe(true);
  }
});

test("Reserva NO se puede elegir a mano", () => {
  // Las de reserva las crea findOrCreateFeeForPlace() con nombre derivado del
  // espacio. Si se pudieran crear sueltas, una tarifa Reserva podría no colgar de
  // ningún espacio y el filtro por categoría dejaría de ser confiable.
  expect(feeSchema.safeParse({ ...base, category: "Reserva" }).success).toBe(false);
});

test("una categoría inventada no pasa", () => {
  expect(feeSchema.safeParse({ ...base, category: "Torneo" }).success).toBe(false);
});

test("una cuota puede valer 0, pero no negativo", () => {
  // Las disciplinas arrancan con cuota en $0 hasta que gestión carga el precio
  expect(
    feeSchema.safeParse({ ...base, amount: 0, category: "Disciplina" }).success,
  ).toBe(true);
  expect(feeSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
});
