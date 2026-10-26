import { expect, test } from "bun:test";
import { errorDeRango, LIMITE_COLUMNAS } from "./report-data";

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
