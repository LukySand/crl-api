// ponytail: extraído de routes/schedules.ts cuando los horarios de disciplina
// necesitaron lo mismo. Una sola fuente de verdad para el formato HH:MM.

/** HH:MM en 24h. */
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Prisma guarda TIME como DateTime; usamos una fecha fija y solo importa la hora. */
export function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00Z`);
}

/**
 * ¿Se superponen dos rangos [aStart,aEnd) y [bStart,bEnd)?
 *
 * Semiabiertos a propósito: 19:00–20:00 y 20:00–21:00 no se pisan, uno termina
 * cuando el otro empieza. Sirve tanto para Date (TIME de Prisma) como para
 * strings "HH:MM" — ambos comparan bien con < porque son comparables por orden.
 */
export function overlaps<T extends Date | string>(
  aStart: T,
  aEnd: T,
  bStart: T,
  bEnd: T,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
