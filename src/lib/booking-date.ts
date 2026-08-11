/**
 * Fechas y horas de reserva.
 *
 * La fecha de una reserva es sólo un día (sin hora), así que se guarda como
 * medianoche UTC. El parseo va con sufijo Z a propósito: `new Date("2026-08-10")`
 * ya es UTC, pero `new Date("2026-08-10T00:00:00")` sería hora local y en
 * Argentina (UTC-3) caería el 9 a las 21:00 → getDay() devolvería domingo en vez
 * de lunes y el turno del lunes se rechazaría.
 *
 * "Hoy" y "ahora", en cambio, van en el huso del club: si el server corre en UTC,
 * a las 22:00 de Argentina ya sería el día siguiente y rechazaría una reserva para
 * hoy que todavía es hoy para el socio.
 */

export const CLUB_TZ = "America/Argentina/Buenos_Aires";

/** "YYYY-MM-DD" → medianoche UTC de ese día. Invalid Date si la fecha no existe. */
export function parseDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00Z`);
}

/** ¿La fecha cae en el día de semana del turno? (0=domingo … 6=sábado) */
export function matchesDayOfWeek(date: Date, dayOfWeek: number): boolean {
  return date.getUTCDay() === dayOfWeek;
}

/** Hoy en el club, como "YYYY-MM-DD" (en-CA da el formato ISO). */
export function todayInClub(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

/** Ahora en el club, como "HH:MM" de 24h con cero adelante. */
export function nowTimeInClub(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: CLUB_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "HH:MM" de un TIME de Prisma (se guarda como 1970-01-01T HH:MM Z). */
export function timeToHHMM(time: Date): string {
  return time.toISOString().slice(11, 16);
}

/**
 * Hasta cuándo se puede reservar hacia adelante.
 *
 * El socio tiene 3 semanas; la gestión llega a 6 meses para poder tomar reservas
 * de eventos con anticipación. El tope vive acá y no sólo en el front: hasta
 * ahora `SEMANAS_ADELANTE = 3` existía únicamente en ReservasScreen.tsx, así que
 * pegándole a la API se podía reservar cualquier fecha futura.
 */
export const DIAS_ADELANTE_SOCIO = 21;
export const DIAS_ADELANTE_ADMIN = 183; // ~6 meses

/** "YYYY-MM-DD" del último día reservable, contando desde hoy en el club. */
export function ultimaFechaReservable(diasAdelante: number): string {
  const hoy = parseDate(todayInClub());
  return new Date(hoy.getTime() + diasAdelante * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
