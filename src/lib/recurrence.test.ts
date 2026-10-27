import { expect, test } from "bun:test";
import { cicloVigente, proximoCiclo, vencimientoPara, type Periodicidad } from "./recurrence";

const mensual = (inicio: string, fin: string | null = null): Periodicidad => ({
  modo: "CadaN", n: 1, unidad: "Meses", inicio, fin,
});

test("N=1 mes equivale al mensual por día fijo", () => {
  const cadaN = mensual("2026-01-01");
  const dia: Periodicidad = { modo: "DiaDelMes", dia: 1, inicio: "2026-01-01", fin: null };
  for (const hoy of ["2026-02-01", "2026-02-20", "2026-12-31"]) {
    expect(cicloVigente(cadaN, hoy)).toEqual(cicloVigente(dia, hoy)!);
  }
  expect(cicloVigente(cadaN, "2026-02-20")).toEqual({ period: "2026-02", emision: "2026-02-01" });
});

test("día 31 se recorta a 28/29 y vuelve al 31 sin acumular", () => {
  const p = mensual("2026-01-31");
  expect(cicloVigente(p, "2026-02-28")).toEqual({ period: "2026-02", emision: "2026-02-28" });
  expect(cicloVigente(p, "2026-02-27")).toEqual({ period: "2026-01", emision: "2026-01-31" });
  expect(cicloVigente(p, "2026-03-31")).toEqual({ period: "2026-03", emision: "2026-03-31" });
  expect(cicloVigente(mensual("2024-01-31"), "2024-02-29")?.emision).toBe("2024-02-29");
  const dia: Periodicidad = { modo: "DiaDelMes", dia: 31, inicio: "2026-01-01", fin: null };
  expect(cicloVigente(dia, "2026-04-30")?.emision).toBe("2026-04-30");
});

test("cada N meses y sin back-fill de ciclos perdidos", () => {
  const p: Periodicidad = { modo: "CadaN", n: 3, unidad: "Meses", inicio: "2026-01-15", fin: null };
  expect(cicloVigente(p, "2026-04-14")).toEqual({ period: "2026-01", emision: "2026-01-15" });
  expect(cicloVigente(p, "2026-04-15")).toEqual({ period: "2026-04", emision: "2026-04-15" });
  // se perdió abril entero: el 20/07 devuelve sólo el ciclo de julio
  expect(cicloVigente(p, "2026-07-20")).toEqual({ period: "2026-07", emision: "2026-07-15" });
});

test("semanas y días: periodo con fecha completa, k = floor", () => {
  const sem: Periodicidad = { modo: "CadaN", n: 2, unidad: "Semanas", inicio: "2026-10-05", fin: null };
  expect(cicloVigente(sem, "2026-10-18")).toEqual({ period: "2026-10-05", emision: "2026-10-05" });
  expect(cicloVigente(sem, "2026-10-19")).toEqual({ period: "2026-10-19", emision: "2026-10-19" });
  expect(proximoCiclo(sem, "2026-10-19")).toBe("2026-11-02");
  const dias: Periodicidad = { modo: "CadaN", n: 10, unidad: "Dias", inicio: "2026-12-25", fin: null };
  expect(cicloVigente(dias, "2027-01-04")).toEqual({ period: "2027-01-04", emision: "2027-01-04" });
});

test("fecha de fin y inicio futuro", () => {
  const p = mensual("2026-01-01", "2026-03-15");
  expect(cicloVigente(p, "2026-03-10")?.period).toBe("2026-03");
  expect(cicloVigente(p, "2026-03-16")).toBeNull();
  expect(proximoCiclo(p, "2026-03-10")).toBeNull(); // 1/4 pasa el fin
  expect(proximoCiclo(p, "2026-02-10")).toBe("2026-03-01");
  const futuro = mensual("2026-12-01");
  expect(cicloVigente(futuro, "2026-11-30")).toBeNull();
  expect(proximoCiclo(futuro, "2026-11-30")).toBe("2026-12-01");
});

test("DiaDelMes: no emite el mes de inicio si el día ya pasó", () => {
  const p: Periodicidad = { modo: "DiaDelMes", dia: 5, inicio: "2026-10-10", fin: null };
  expect(cicloVigente(p, "2026-10-20")).toBeNull();
  expect(proximoCiclo(p, "2026-10-20")).toBe("2026-11-05");
  expect(cicloVigente(p, "2026-11-05")).toEqual({ period: "2026-11", emision: "2026-11-05" });
});

test("vencimientoPara: Ninguna y DiasDesdeEmision", () => {
  expect(vencimientoPara({ regla: "Ninguna", valor: null }, "2026-10", "2026-10-01", 10)).toBeNull();
  expect(vencimientoPara({ regla: "DiasDesdeEmision", valor: 15 }, null, "2026-10-20", 10)).toBe("2026-11-04");
});

test("vencimientoPara: DiaDelMes NULL usa payment_due_day", () => {
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, "2026-10", "2026-10-01", 10)).toBe("2026-10-10");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: 20 }, "2026-10", "2026-10-01", 10)).toBe("2026-10-20");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: 31 }, "2026-02", "2026-02-01", 10)).toBe("2026-02-28");
});

test("vencimientoPara: emisión tardía corre al mes siguiente, nunca nace vencida", () => {
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, "2026-10", "2026-10-12", 10)).toBe("2026-11-10");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, "2026-10", "2026-10-10", 10)).toBe("2026-10-10");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, "2026-08", "2026-10-12", 10)).toBe("2026-11-10");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, "2026-12", "2026-12-20", 10)).toBe("2027-01-10");
});

test("vencimientoPara: período diario o cargo único toma el primer día d >= creación", () => {
  expect(vencimientoPara({ regla: "DiaDelMes", valor: 20 }, "2026-10-05", "2026-10-05", 10)).toBe("2026-10-20");
  expect(vencimientoPara({ regla: "DiaDelMes", valor: null }, null, "2026-10-12", 10)).toBe("2026-11-10");
});
