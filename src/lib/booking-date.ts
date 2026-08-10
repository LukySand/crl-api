/**
 * Fechas de reserva, siempre en UTC.
 *
 * ponytail: el parseo va con sufijo Z a propósito. `new Date("2026-08-10")` ya es UTC,
 * pero `new Date("2026-08-10T00:00:00")` sería hora local y en Argentina (UTC-3)
 * caería el 9 a las 21:00 → getDay() devolvería domingo en vez de lunes y el turno
 * del lunes se rechazaría. Se guarda y se compara todo en UTC.
 */

/** "YYYY-MM-DD" → medianoche UTC de ese día. Devuelve Invalid Date si no es válida. */
export function parseDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00Z`);
}

/** Hoy a medianoche UTC, para comparar contra fechas de reserva. */
export function todayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** ¿La fecha cae en el día de semana del turno? (0=domingo … 6=sábado) */
export function matchesDayOfWeek(date: Date, dayOfWeek: number): boolean {
  return date.getUTCDay() === dayOfWeek;
}
