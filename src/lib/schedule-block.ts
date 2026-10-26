/**
 * Bloqueo temporal de un espacio.
 *
 * Un bloqueo cierra un espacio durante un rango de fechas (y, si trae franja
 * horaria, sólo en esa franja). Sirve para lo que borrar un turno no puede: el
 * turno de los lunes vale para todos los lunes, y cerrar la cancha el lunes 21
 * por mantenimiento no tiene que tocar los demás.
 *
 * Todo acá es puro (strings "YYYY-MM-DD" y "HH:MM"): la conversión desde Prisma
 * y las consultas viven en las rutas, igual que `booking-date.ts`.
 */
import { z } from "zod";
import { parseDate } from "./booking-date";

export const MOTIVO_MIN = 3;
export const MOTIVO_MAX = 255;

/** Cuántos días hacia adelante se puede extender un bloqueo (el mismo horizonte de la gestión). */
export const DIAS_MAX_BLOQUEO = 183;

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD");
const HORA = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La hora debe ser HH:MM");

/** ¿Existe ese día en el calendario? ("2026-02-30" no.) */
export function esFechaReal(yyyymmdd: string): boolean {
  const fecha = parseDate(yyyymmdd);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === yyyymmdd;
}

/** Días entre dos fechas "YYYY-MM-DD" (inclusive: del 21 al 21 es 1 día). */
export function diasDelRango(desde: string, hasta: string): number {
  return Math.round((parseDate(hasta).getTime() - parseDate(desde).getTime()) / 86_400_000) + 1;
}

export const bloqueoCreateSchema = z
  .object({
    place_id: z.number({ error: "El espacio es requerido" }).int().positive("El espacio es requerido"),
    from: FECHA,
    // Sin `to` es un solo día.
    to: FECHA.optional(),
    start_time: HORA.optional(),
    end_time: HORA.optional(),
    reason: z
      .string({ error: "El motivo es requerido" })
      .trim()
      .min(MOTIVO_MIN, `El motivo debe tener al menos ${MOTIVO_MIN} caracteres`)
      .max(MOTIVO_MAX, `El motivo debe tener máximo ${MOTIVO_MAX} caracteres`),
  })
  .strict()
  .superRefine((b, ctx) => {
    const fecha = (campo: "from" | "to", valor: string) => {
      // Ida y vuelta: `new Date("2026-02-30")` no falla, lo corre al 2 de marzo.
      if (!esFechaReal(valor)) {
        ctx.addIssue({ code: "custom", path: [campo], message: "Fecha inválida" });
        return false;
      }
      return true;
    };
    const desdeOk = fecha("from", b.from);
    const hastaOk = b.to === undefined || fecha("to", b.to);

    if (desdeOk && hastaOk && b.to !== undefined) {
      if (b.to < b.from) {
        ctx.addIssue({ code: "custom", path: ["to"], message: "La fecha final no puede ser anterior a la inicial" });
      } else if (diasDelRango(b.from, b.to) > DIAS_MAX_BLOQUEO) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: `Un bloqueo puede durar como máximo ${DIAS_MAX_BLOQUEO} días`,
        });
      }
    }

    // La franja va completa o no va: "desde las 10" sin hasta no es una franja.
    if ((b.start_time === undefined) !== (b.end_time === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [b.start_time === undefined ? "start_time" : "end_time"],
        message: "Indicá la hora de inicio y la de fin, o ninguna para bloquear todo el día",
      });
    } else if (b.start_time !== undefined && b.end_time !== undefined && b.start_time >= b.end_time) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "La hora de fin debe ser posterior a la de inicio",
      });
    }
  });

/** Un bloqueo ya normalizado: fechas "YYYY-MM-DD" y horas "HH:MM" (o null = todo el día). */
export interface BloqueoNormalizado {
  date_from: string;
  date_to: string;
  start_time: string | null;
  end_time: string | null;
}

/**
 * ¿Se pisan dos franjas horarias? Rangos semiabiertos: que una termine a las 11
 * y la otra empiece a las 11 no es pisarse. Mismo criterio que `seSuperponen` del
 * front para los turnos.
 */
export function franjasSePisan(aDesde: string, aHasta: string, bDesde: string, bHasta: string): boolean {
  return aDesde < bHasta && bDesde < aHasta;
}

/** ¿Este bloqueo cubre ese turno en esa fecha? */
export function bloqueaTurno(
  bloqueo: BloqueoNormalizado,
  fecha: string,
  turno: { start: string; end: string },
): boolean {
  if (fecha < bloqueo.date_from || fecha > bloqueo.date_to) return false;
  // Sin franja bloquea el día entero.
  if (bloqueo.start_time === null || bloqueo.end_time === null) return true;
  return franjasSePisan(bloqueo.start_time, bloqueo.end_time, turno.start, turno.end);
}
