import { describe, expect, test } from "bun:test";
import {
  bloqueaTurno,
  bloqueoCreateSchema,
  DIAS_MAX_BLOQUEO,
  diasDelRango,
  franjasSePisan,
  type BloqueoNormalizado,
} from "./schedule-block";

const valido = { place_id: 1, from: "2026-11-02", reason: "Mantenimiento de la cancha" };

describe("bloqueoCreateSchema", () => {
  test("acepta un bloqueo de un día entero con motivo", () => {
    expect(bloqueoCreateSchema.safeParse(valido).success).toBe(true);
  });

  test("recorta el motivo y rechaza uno vacío o demasiado corto", () => {
    expect(bloqueoCreateSchema.parse({ ...valido, reason: "  Pintura  " }).reason).toBe("Pintura");
    expect(bloqueoCreateSchema.safeParse({ ...valido, reason: "   " }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, reason: "ab" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, reason: "x".repeat(256) }).success).toBe(false);
  });

  test("la fecha final no puede ser anterior a la inicial", () => {
    expect(bloqueoCreateSchema.safeParse({ ...valido, to: "2026-11-02" }).success).toBe(true);
    expect(bloqueoCreateSchema.safeParse({ ...valido, to: "2026-11-01" }).success).toBe(false);
  });

  test("rechaza fechas que no existen", () => {
    expect(bloqueoCreateSchema.safeParse({ ...valido, from: "2026-02-30" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, from: "02/11/2026" }).success).toBe(false);
  });

  test("tiene un tope de días", () => {
    const ok = bloqueoCreateSchema.safeParse({ ...valido, from: "2026-11-01", to: "2027-05-02" });
    expect(diasDelRango("2026-11-01", "2027-05-02")).toBe(DIAS_MAX_BLOQUEO);
    expect(ok.success).toBe(true);
    expect(bloqueoCreateSchema.safeParse({ ...valido, from: "2026-11-01", to: "2027-05-03" }).success).toBe(false);
  });

  test("la franja va completa o no va, y el inicio tiene que ser anterior al fin", () => {
    expect(bloqueoCreateSchema.safeParse({ ...valido, start_time: "10:00", end_time: "12:00" }).success).toBe(true);
    expect(bloqueoCreateSchema.safeParse({ ...valido, start_time: "10:00" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, end_time: "12:00" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, start_time: "12:00", end_time: "10:00" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, start_time: "10:00", end_time: "10:00" }).success).toBe(false);
    expect(bloqueoCreateSchema.safeParse({ ...valido, start_time: "25:00", end_time: "26:00" }).success).toBe(false);
  });

  test("no acepta campos de más, como quién lo creó", () => {
    expect(bloqueoCreateSchema.safeParse({ ...valido, created_by: "otro" }).success).toBe(false);
  });
});

describe("diasDelRango", () => {
  test("cuenta inclusivo y cruza meses y años", () => {
    expect(diasDelRango("2026-11-21", "2026-11-21")).toBe(1);
    expect(diasDelRango("2026-11-28", "2026-12-02")).toBe(5);
    expect(diasDelRango("2026-12-30", "2027-01-02")).toBe(4);
  });
});

describe("franjasSePisan", () => {
  test("tocarse en el borde no es pisarse", () => {
    expect(franjasSePisan("10:00", "11:00", "11:00", "12:00")).toBe(false);
    expect(franjasSePisan("11:00", "12:00", "10:00", "11:00")).toBe(false);
  });

  test("solapamiento parcial y contención", () => {
    expect(franjasSePisan("10:00", "12:00", "11:00", "13:00")).toBe(true);
    expect(franjasSePisan("10:00", "14:00", "11:00", "12:00")).toBe(true);
  });
});

describe("bloqueaTurno", () => {
  const diaEntero: BloqueoNormalizado = { date_from: "2026-11-21", date_to: "2026-11-21", start_time: null, end_time: null };
  const turno = { start: "18:00", end: "19:00" };

  test("un bloqueo de un día cierra ese día y no los otros", () => {
    expect(bloqueaTurno(diaEntero, "2026-11-21", turno)).toBe(true);
    expect(bloqueaTurno(diaEntero, "2026-11-28", turno)).toBe(false);
    expect(bloqueaTurno(diaEntero, "2026-11-14", turno)).toBe(false);
  });

  test("un rango incluye el primer y el último día", () => {
    const rango = { ...diaEntero, date_to: "2026-11-23" };
    expect(bloqueaTurno(rango, "2026-11-21", turno)).toBe(true);
    expect(bloqueaTurno(rango, "2026-11-23", turno)).toBe(true);
    expect(bloqueaTurno(rango, "2026-11-24", turno)).toBe(false);
  });

  test("con franja horaria sólo cierra los turnos que se pisan con ella", () => {
    const franja = { ...diaEntero, start_time: "17:00", end_time: "19:00" };
    expect(bloqueaTurno(franja, "2026-11-21", { start: "18:00", end: "19:00" })).toBe(true);
    expect(bloqueaTurno(franja, "2026-11-21", { start: "16:00", end: "17:00" })).toBe(false);
    expect(bloqueaTurno(franja, "2026-11-21", { start: "19:00", end: "20:00" })).toBe(false);
    expect(bloqueaTurno(franja, "2026-11-21", { start: "16:30", end: "17:30" })).toBe(true);
  });
});
