/**
 * Helpers del dominio de pagos: claves de idempotencia y serialización de montos.
 *
 * Las reglas de período y vencimiento viven en payment-period.ts; acá va lo que
 * es propio de la fila de pago.
 */

import type { Prisma } from "../../prisma/generated/client";

// ── Claves de idempotencia ───────────────────────────────────────────────
//
// ponytail: `Payment.ref` es unique, así que estas funciones son las que hacen
// que generar cuotas sea re-ejecutable. Un `ref` mal armado no rompe nada visible
// hasta que alguien corre la generación dos veces y aparecen cuotas duplicadas,
// así que se arman en un solo lugar y nunca a mano en un handler.

/** Una reserva se cobra una sola vez. */
export function refReserva(bookingId: string): string {
  return `reserva:${bookingId}`;
}

/**
 * Una cuota por inscripción y por mes.
 *
 * Va por enrollment y no por (socio, disciplina): si el socio se va y vuelve en
 * el mismo mes son dos inscripciones distintas, y cada una tiene que poder
 * llevar su propia cuota sin pisarse.
 */
export function refDisciplina(enrollmentId: number, periodo: string): string {
  return `disciplina:${enrollmentId}:${periodo}`;
}

/** Cuota de socio: una por persona y por mes. Todavía sin usar. */
export function refSocio(userId: string, periodo: string): string {
  return `socio:${userId}:${periodo}`;
}

// ── Serialización de montos ──────────────────────────────────────────────

/**
 * Decimal de Prisma → number.
 *
 * `Decimal` es un objeto (decimal.js) y su toJSON devuelve un **string**: sin
 * esto, `amount` viaja como "12000.5" y no como 12000.5. No se rompe nada a la
 * vista — revienta más adelante y callado, cuando el front hace
 * `amount.toLocaleString("es-AR")` para mostrar $12.000,50: sobre un string eso
 * devuelve el string igual, sin separador de miles.
 *
 * Se pierde precisión más allá de 2^53, pero un monto tope de 99.999.999,99
 * entra sobrado en un double.
 */
export function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

/**
 * Deja un pago listo para responder: el monto como número.
 *
 * Genérico para que sirva igual con los include que sume cada endpoint, sin
 * tener que declarar un tipo por cada forma de respuesta.
 */
export function serializePayment<T extends { amount: Prisma.Decimal | number }>(
  payment: T,
): Omit<T, "amount"> & { amount: number } {
  return { ...payment, amount: toNumber(payment.amount) };
}

/** Lo mismo para una lista. */
export function serializePayments<T extends { amount: Prisma.Decimal | number }>(
  payments: T[],
): (Omit<T, "amount"> & { amount: number })[] {
  return payments.map(serializePayment);
}
