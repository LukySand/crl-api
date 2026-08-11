// ponytail: extraído de routes/schedules.ts cuando los horarios de disciplina
// necesitaron lo mismo. Una sola fuente de verdad para el formato HH:MM.

/** HH:MM en 24h. */
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Prisma guarda TIME como DateTime; usamos una fecha fija y solo importa la hora. */
export function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00Z`);
}
