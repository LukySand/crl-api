import { describe, expect, test } from "bun:test";
import {
  AJUSTES_POR_DEFECTO,
  ajustesPatchSchema,
  aplicarCambio,
  errorDeCoherencia,
  LIMITES,
} from "./settings";

const parse = (x: unknown) => ajustesPatchSchema.safeParse(x);

describe("ajustesPatchSchema", () => {
  test("acepta un cambio parcial", () => {
    expect(parse({ cancel_hours_before: 24 }).success).toBe(true);
    expect(parse({ payment_due_day: 5, days_ahead_member: 30 }).success).toBe(true);
  });

  test("rechaza un cuerpo vacío y campos desconocidos", () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ otra_cosa: 1 }).success).toBe(false);
    expect(parse({ updated_by: "alguien" }).success).toBe(false);
    // El alias para transferir se sacó: el cobro va a ser por Mercado Pago.
    expect(parse({ bank_alias: "club.crl" }).success).toBe(false);
    // La cuota social todavía no tiene dónde cobrarse: se sacó hasta que existan las cuotas de socio.
    expect(parse({ member_fee_amount: 8500 }).success).toBe(false);
  });

  test("respeta los rangos de cada campo", () => {
    expect(parse({ cancel_hours_before: 0 }).success).toBe(true);
    expect(parse({ cancel_hours_before: 168 }).success).toBe(true);
    expect(parse({ cancel_hours_before: 169 }).success).toBe(false);
    expect(parse({ cancel_hours_before: -1 }).success).toBe(false);
    expect(parse({ days_ahead_member: 0 }).success).toBe(false);
    expect(parse({ days_ahead_member: 91 }).success).toBe(false);
    expect(parse({ days_ahead_admin: 366 }).success).toBe(true);
    expect(parse({ days_ahead_admin: 367 }).success).toBe(false);
    expect(parse({ payment_due_day: 28 }).success).toBe(true);
    expect(parse({ payment_due_day: 29 }).success).toBe(false);
    expect(parse({ payment_due_day: 0 }).success).toBe(false);
  });

  test("los números tienen que ser enteros", () => {
    expect(parse({ cancel_hours_before: 10.5 }).success).toBe(false);
    expect(parse({ payment_due_day: "10" }).success).toBe(false);
  });

});

describe("aplicarCambio", () => {
  test("cambia sólo lo que viene", () => {
    const r = aplicarCambio(AJUSTES_POR_DEFECTO, { cancel_hours_before: 24 });
    expect(r).toEqual({ ...AJUSTES_POR_DEFECTO, cancel_hours_before: 24 });
  });

  test("lo que no viene no se toca", () => {
    const actual = { ...AJUSTES_POR_DEFECTO, payment_due_day: 15 };
    expect(aplicarCambio(actual, {})).toEqual(actual);
    expect(aplicarCambio(actual, { cancel_hours_before: 2 }).payment_due_day).toBe(15);
  });
});

describe("errorDeCoherencia", () => {
  test("el socio no puede tener más anticipación que la gestión", () => {
    expect(errorDeCoherencia(AJUSTES_POR_DEFECTO)).toBeNull();
    expect(errorDeCoherencia({ ...AJUSTES_POR_DEFECTO, days_ahead_member: 60, days_ahead_admin: 30 })?.campo).toBe(
      "days_ahead_member",
    );
    expect(errorDeCoherencia({ ...AJUSTES_POR_DEFECTO, days_ahead_member: 30, days_ahead_admin: 30 })).toBeNull();
  });
});

test("los valores por defecto son los de las constantes de antes", () => {
  expect(AJUSTES_POR_DEFECTO).toEqual({
    cancel_hours_before: 10,
    days_ahead_member: 21,
    days_ahead_admin: 183,
    payment_due_day: 10,
  });
});
