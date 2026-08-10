// ponytail: el único bicho real de este modelo es que la fecha caiga en un día de
// semana distinto al del turno, y que el huso del server corra el día. Se testea eso.
import { expect, test } from "bun:test";
import { parseDate, todayUTC, matchesDayOfWeek } from "./booking-date";

test("parsea en UTC, sin correrse por el huso del server", () => {
  // En Argentina (UTC-3) un parseo local daría el 9 a las 21:00 → getDay() = domingo
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

test("todayUTC queda a medianoche, así una reserva de hoy no cuenta como pasada", () => {
  const t = todayUTC();
  expect(t.getUTCHours()).toBe(0);
  expect(t.getUTCMinutes()).toBe(0);
  expect(t.getUTCSeconds()).toBe(0);
  expect(t.getUTCMilliseconds()).toBe(0);
});

test("una fecha inválida da NaN (el endpoint la rechaza)", () => {
  expect(Number.isNaN(parseDate("2026-13-45").getTime())).toBe(true);
});
