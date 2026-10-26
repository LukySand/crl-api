/**
 * Consultas de bloqueos a la base. Aparte de `schedule-block.ts` para que ése siga
 * siendo puro y testeable sin Prisma.
 */
import prisma from "./prisma";
import { parseDate, timeToHHMM } from "./booking-date";
import { bloqueaTurno, type BloqueoNormalizado } from "./schedule-block";

export interface BloqueoDelDia extends BloqueoNormalizado {
  id: number;
  reason: string;
}

/** Pasa una fila de Prisma (Date / TIME) al formato de strings que usa la lógica pura. */
export function normalizarBloqueo(b: {
  id: number;
  date_from: Date;
  date_to: Date;
  start_time: Date | null;
  end_time: Date | null;
  reason: string;
}): BloqueoDelDia {
  return {
    id: b.id,
    date_from: b.date_from.toISOString().slice(0, 10),
    date_to: b.date_to.toISOString().slice(0, 10),
    start_time: b.start_time ? timeToHHMM(b.start_time) : null,
    end_time: b.end_time ? timeToHHMM(b.end_time) : null,
    reason: b.reason,
  };
}

/** Los bloqueos de un espacio que cubren esa fecha (los que además pisan el turno se filtran después). */
export async function bloqueosDelDia(placeId: number, fecha: string): Promise<BloqueoDelDia[]> {
  const dia = parseDate(fecha);
  const filas = await prisma.scheduleBlock.findMany({
    where: { place_id: placeId, date_from: { lte: dia }, date_to: { gte: dia } },
    orderBy: { id: "asc" },
  });
  return filas.map(normalizarBloqueo);
}

/** El primer bloqueo que cierra ese turno en esa fecha, o `null` si está libre. */
export async function bloqueoQueCierra(
  placeId: number,
  fecha: string,
  turno: { start: string; end: string },
): Promise<BloqueoDelDia | null> {
  const bloqueos = await bloqueosDelDia(placeId, fecha);
  return bloqueos.find((b) => bloqueaTurno(b, fecha, turno)) ?? null;
}
