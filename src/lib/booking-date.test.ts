// ponytail: los bichos reales de este modelo son de huso horario — que la fecha
// caiga en otro día de semana, o que "hoy" se corra si el server no está en
// Argentina. Se testea eso, no los getters.
import { expect, test } from "bun:test";
import {
  parseDate,
  matchesDayOfWeek,
  timeToHHMM,
  todayInClub,
  nowTimeInClub,
  ultimaFechaReservable,
  DIAS_ADELANTE_SOCIO,
  DIAS_ADELANTE_ADMIN,
  HORAS_ANTES_CANCELAR,
  dentroDeVentanaCancelacion,
} from "./booking-date";

test("parsea en UTC, sin correrse por el huso del server", () => {
  // Un parseo local en Argentina (UTC-3) daría el 9 a las 21:00 → domingo
  const d = parseDate("2026-08-10");
  expect(d.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  expect(d.getUTCDay()).toBe(1); // lunes
});

test("matchesDayOfWeek acepta el día correcto y rechaza el resto", () => {
  const lunes = parseDate("2026-08-10");
  expect(matchesDayOfWeek(lunes, 1)).toBe(true);
  expect(matchesDayOfWeek(lunes, 2)).toBe(false);
  expect(matchesDayOfWeek(lunes, 0)).toBe(false);
});

test("domingo es 0 y sábado 6", () => {
  expect(parseDate("2026-08-09").getUTCDay()).toBe(0);
  expect(parseDate("2026-08-15").getUTCDay()).toBe(6);
});

test("una fecha inválida da NaN (el endpoint la rechaza)", () => {
  expect(Number.isNaN(parseDate("2026-13-45").getTime())).toBe(true);
});

test("timeToHHMM saca la hora del TIME de Prisma", () => {
  expect(timeToHHMM(new Date("1970-01-01T18:00:00Z"))).toBe("18:00");
  expect(timeToHHMM(new Date("1970-01-01T08:30:00Z"))).toBe("08:30");
});

test("todayInClub devuelve YYYY-MM-DD comparable como string", () => {
  const hoy = todayInClub();
  expect(hoy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // El orden lexicográfico tiene que coincidir con el cronológico
  expect("2026-08-09" < "2026-08-10").toBe(true);
});

test("el tope del socio cae 21 días después de hoy", () => {
  const hoy = todayInClub();
  const tope = ultimaFechaReservable(DIAS_ADELANTE_SOCIO);
  expect(tope).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Se compara como fecha real, no como string, para atrapar el cruce de mes
  const dias =
    (parseDate(tope).getTime() - parseDate(hoy).getTime()) / 86_400_000;
  expect(dias).toBe(21);
});

test("el tope de gestión es mayor que el del socio", () => {
  expect(DIAS_ADELANTE_ADMIN).toBeGreaterThan(DIAS_ADELANTE_SOCIO);
  expect(ultimaFechaReservable(DIAS_ADELANTE_ADMIN) > ultimaFechaReservable(DIAS_ADELANTE_SOCIO)).toBe(true);
});

test("hoy nunca queda fuera del tope (comparable como string)", () => {
  const hoy = todayInClub();
  expect(hoy <= ultimaFechaReservable(DIAS_ADELANTE_SOCIO)).toBe(true);
  expect(hoy <= ultimaFechaReservable(0)).toBe(true);
});

test("nowTimeInClub devuelve HH:MM de 24h con cero adelante", () => {
  const ahora = nowTimeInClub();
  expect(ahora).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  // Comparar horarios como string sólo funciona con el cero adelante
  expect("08:00" < "16:00").toBe(true);
});

// --- Ventana de cancelación -------------------------------------------------
// ponytail: el bicho acá es el mismo de siempre — mezclar el huso del server con
// el del club. Los casos se escriben en hora del club y se testea el borde
// exacto de las 10 horas, que es donde un > y un >= dan distinto.

/**
 * "YYYY-MM-DDTHH:MM" en hora del club → Date.
 * Argentina no tiene horario de verano desde 2009, así que el offset es -03:00
 * fijo y se puede escribir a mano sin que el test mienta media parte del año.
 */
const enClub = (stamp: string) => new Date(`${stamp}:00-03:00`);

/** Lunes 10/08/2026, turno de 19:00 a 20:00. */
const LUNES = parseDate("2026-08-10");
const T19 = new Date("1970-01-01T19:00:00Z");

test("faltando 11 horas todavía se puede cancelar", () => {
  expect(dentroDeVentanaCancelacion(LUNES, T19, enClub("2026-08-10T08:00"))).toBe(true);
});

test("faltando exactamente 10 horas todavía se puede cancelar (límite inclusivo)", () => {
  expect(dentroDeVentanaCancelacion(LUNES, T19, enClub("2026-08-10T09:00"))).toBe(true);
});

test("faltando 9 horas ya no se puede", () => {
  expect(dentroDeVentanaCancelacion(LUNES, T19, enClub("2026-08-10T10:00"))).toBe(false);
});

test("un minuto tarde tampoco: el borde no se redondea", () => {
  expect(dentroDeVentanaCancelacion(LUNES, T19, enClub("2026-08-10T09:01"))).toBe(false);
});

test("una reserva pasada no se puede cancelar", () => {
  const ayer = parseDate("2026-08-09");
  expect(dentroDeVentanaCancelacion(ayer, T19, enClub("2026-08-10T08:00"))).toBe(false);
});

test("una reserva ya empezada no se puede cancelar", () => {
  expect(dentroDeVentanaCancelacion(LUNES, T19, enClub("2026-08-10T19:30"))).toBe(false);
});

test("el cruce de medianoche se mide contra el día del turno, no contra el de hoy", () => {
  const martes = parseDate("2026-08-11");
  const T08 = new Date("1970-01-01T08:00:00Z");
  // 21:00 del lunes → faltan 11 horas para el turno de las 08:00 del martes
  expect(dentroDeVentanaCancelacion(martes, T08, enClub("2026-08-10T21:00"))).toBe(true);
  // 23:00 del lunes → faltan 9
  expect(dentroDeVentanaCancelacion(martes, T08, enClub("2026-08-10T23:00"))).toBe(false);
});

test("el server en UTC no adelanta la ventana", () => {
  // 23:00 UTC del domingo = 20:00 del domingo en el club → faltan 23 horas
  expect(dentroDeVentanaCancelacion(LUNES, T19, new Date("2026-08-09T23:00:00Z"))).toBe(true);
});

test("la ventana son 10 horas", () => {
  expect(HORAS_ANTES_CANCELAR).toBe(10);
});
