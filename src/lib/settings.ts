/**
 * Ajustes del club: lo que la gestión puede cambiar sin tocar el código.
 *
 * Todo acá es puro. La lectura y escritura en la base están en `settings-db.ts`.
 * Los valores por defecto son los que antes eran constantes sueltas
 * (`HORAS_ANTES_CANCELAR`, `DIAS_ADELANTE_*`, `DIA_VENCIMIENTO`): una instalación
 * sin fila de ajustes se comporta exactamente igual que antes.
 */
import { z } from "zod";

export interface Ajustes {
  /** Hasta cuántas horas antes del turno puede cancelar un socio. La gestión no tiene tope. */
  cancel_hours_before: number;
  /** Con cuántos días de anticipación puede reservar un socio. */
  days_ahead_member: number;
  /** Lo mismo para la gestión (eventos, reservas a futuro). */
  days_ahead_admin: number;
  /** Día del mes en que vence la cuota. */
  payment_due_day: number;
}

export const AJUSTES_POR_DEFECTO: Ajustes = {
  cancel_hours_before: 10,
  days_ahead_member: 21,
  days_ahead_admin: 183,
  payment_due_day: 10,
};

/**
 * Rangos permitidos. El día de vencimiento llega hasta el 28 para que exista en
 * todos los meses (un 31 caería en el último día de los meses cortos, y no es lo
 * que se entiende al leer "vence el 31"). Los demás topes son de sentido común: una
 * semana para cancelar, tres meses de anticipación para un socio, un año para la
 * gestión.
 */
export const LIMITES = {
  cancel_hours_before: { min: 0, max: 168 },
  days_ahead_member: { min: 1, max: 90 },
  days_ahead_admin: { min: 1, max: 366 },
  payment_due_day: { min: 1, max: 28 },
} as const;

const entero = (campo: keyof typeof LIMITES, etiqueta: string) =>
  z
    .number({ error: `${etiqueta} tiene que ser un número` })
    .int(`${etiqueta} tiene que ser un número entero`)
    .min(LIMITES[campo].min, `${etiqueta} no puede ser menor a ${LIMITES[campo].min}`)
    .max(LIMITES[campo].max, `${etiqueta} no puede ser mayor a ${LIMITES[campo].max}`);

/**
 * Cambio parcial de ajustes: se manda sólo lo que se quiere cambiar.
 */
export const ajustesPatchSchema = z
  .object({
    cancel_hours_before: entero("cancel_hours_before", "Las horas para cancelar").optional(),
    days_ahead_member: entero("days_ahead_member", "Los días de anticipación del socio").optional(),
    days_ahead_admin: entero("days_ahead_admin", "Los días de anticipación de la gestión").optional(),
    payment_due_day: entero("payment_due_day", "El día de vencimiento").optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (Object.keys(p).length === 0) {
      ctx.addIssue({ code: "custom", path: ["_form"], message: "No hay nada para cambiar" });
    }
  });

export type AjustesPatch = z.output<typeof ajustesPatchSchema>;

/** Lo que no cierra entre dos campos, o `null` si está bien. Se chequea sobre el resultado de aplicar el cambio. */
export function errorDeCoherencia(a: Ajustes): { campo: keyof Ajustes; mensaje: string } | null {
  if (a.days_ahead_member > a.days_ahead_admin) {
    return {
      campo: "days_ahead_member",
      mensaje: "El socio no puede reservar con más anticipación que la gestión",
    };
  }
  return null;
}

/** Aplica un cambio parcial sobre los ajustes vigentes. */
export function aplicarCambio(actual: Ajustes, patch: AjustesPatch): Ajustes {
  return {
    cancel_hours_before: patch.cancel_hours_before ?? actual.cancel_hours_before,
    days_ahead_member: patch.days_ahead_member ?? actual.days_ahead_member,
    days_ahead_admin: patch.days_ahead_admin ?? actual.days_ahead_admin,
    payment_due_day: patch.payment_due_day ?? actual.payment_due_day,
  };
}
