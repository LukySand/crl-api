import { expect, test } from "bun:test";
import {
  agruparNeto,
  armarSerie,
  claveDe,
  claveDeEgreso,
  errorDeRango,
  LIMITE_COLUMNAS,
  type Movimiento,
} from "./report-data";

test("dos meses por día entran y tres no", () => {
  expect(errorDeRango("dia", "2026-07-01", "2026-08-31")).toBeNull(); // 62 días
  expect(errorDeRango("dia", "2026-07-01", "2026-09-30")).not.toBeNull();
});

test("un año entero no entra por día pero sí por semana y por mes", () => {
  expect(errorDeRango("dia", "2025-01-01", "2025-12-31")).not.toBeNull();
  expect(errorDeRango("semana", "2025-01-01", "2025-12-31")).toBeNull();
  expect(errorDeRango("mes", "2025-01-01", "2025-12-31")).toBeNull();
});

test("cualquier año entra por semana, aunque arranque en domingo y tenga 54 lunes", () => {
  for (const anio of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    expect(errorDeRango("semana", `${anio}-01-01`, `${anio}-12-31`)).toBeNull();
  }
});

test("dos años ya son demasiado para verlos por semana", () => {
  expect(errorDeRango("semana", "2025-01-01", "2026-12-31")).not.toBeNull();
});

test("seis años entran por mes, que es lo que ofrece el selector de años", () => {
  expect(errorDeRango("mes", "2021-01-01", "2026-12-31")).toBeNull();
  expect(errorDeRango("mes", "2020-01-01", "2026-12-31")).not.toBeNull();
});

test("el mensaje dice cuánto se pidió y hasta cuánto se lee", () => {
  const mensaje = errorDeRango("semana", "2021-01-01", "2026-10-26")!;
  expect(mensaje).toContain("semanas");
  expect(mensaje).toContain("1 año");
});

test("un rango invertido no cuenta como largo: eso lo valida el handler", () => {
  expect(errorDeRango("dia", "2026-12-31", "2026-01-01")).toBeNull();
});

test("los topes son los acordados", () => {
  expect(LIMITE_COLUMNAS).toEqual({ dia: 62, semana: 54, mes: 72 });
});

// ---- D22 / D22b / D24b: ingresos, egresos y neto (puro, sin base) ----
const mov = (clave: string | null, fecha: string, monto: number): Movimiento => ({
  clave,
  fecha: new Date(`${fecha}T12:00:00Z`),
  monto,
});

test("venta de septiembre reembolsada en octubre: septiembre queda bruto, octubre muestra el egreso y neto negativo", () => {
  const ingresos = [mov("2026-09", "2026-09-10", 1000)];
  const egresos = [mov("2026-10", "2026-10-05", 1000)];
  const r = agruparNeto(ingresos, egresos).sort((a, b) => a.clave.localeCompare(b.clave));
  expect(r).toEqual([
    { clave: "2026-09", cobrado: 1000, reembolsado: 0, cantidad: 1, total: 1000 },
    { clave: "2026-10", cobrado: 0, reembolsado: 1000, cantidad: 0, total: -1000 },
  ]);
});

test("series: reembolsos alineados con buckets, series en bruto y total neto", () => {
  const buckets = ["2026-09", "2026-10", "2026-11"];
  const r = armarSerie(
    [mov("Cancha 1", "2026-09-10", 1000), mov("Cancha 1", "2026-11-02", 500)],
    [mov("Cancha 1", "2026-10-05", 1000), mov(null, "2027-01-01", 99)], // fuera de la grilla: se saltea
    buckets,
    "mes",
  );
  expect(r.reembolsos).toEqual([0, 1000, 0]);
  expect(r.reembolsos).toHaveLength(buckets.length);
  expect(r.series).toEqual([{ clave: "Cancha 1", total: 1500, puntos: [1000, 0, 500] }]);
  expect(r.total).toBe(500);
});

test("dimensiones: una reserva no es de ninguna disciplina; un reembolso sin fila va a Sin definir", () => {
  const reserva = {
    concept: "Reserva",
    method: "Efectivo",
    enrollment: null,
    booking: { schedule: { place: { name: "Cancha 1" } } },
  };
  expect(claveDe("disciplina", reserva)).toBeUndefined();
  expect(claveDe("espacio", reserva)).toBe("Cancha 1");
  expect(claveDe("concepto", reserva)).toBe("Reserva");
  expect(claveDeEgreso("metodo", null)).toBeNull();
  expect(agruparNeto([], [mov(claveDeEgreso("metodo", null) ?? null, "2026-10-05", 10)])[0]!.clave).toBe("Sin definir");
  expect(claveDeEgreso("total", null)).toBe("Total");
});
