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
