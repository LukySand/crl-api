/**
 * Hold de reservas pagadas en el acto (D14).
 *
 * La reserva de la app de socio nace `Pendiente` y retiene el turno mientras paga con MP.
 * `liberarReservasVencidas` la suelta al vencer el plazo; `resolverReserva` la retoma si el
 * pago aprobado llega tarde (lo llama `aplicarPagoMP`).
 */
import { Prisma } from "../../prisma/generated/client";
import prisma from "./prisma";
import { logger } from "./logger";
import { bloqueoQueCierra } from "./schedule-block-db";
import { corteHoldReservas, hayTiempoParaPagar, timeToHHMM } from "./booking-date";
import { reembolsarItem } from "./refunds";
import { esConflictoDeEscritura } from "./settlement";

const MOTIVO_VENCIDA = "Venció el plazo para pagar la reserva";

/**
 * Suelta las reservas `Pendiente` y `active` creadas antes del corte que tienen una liquidación
 * de MP (las de mostrador no se tocan): reserva `Cancelada` + `active NULL` y fila `Pendiente →
 * Anulado` (`resolved_by "sistema"`), en una transacción guardada por el estado de la fila.
 * Nunca lanza: la llaman el cron y `GET /availability`.
 * @returns cuántas reservas liberó.
 */
export async function liberarReservasVencidas(): Promise<number> {
  let liberadas = 0;
  try {
    const vencidas = await prisma.booking.findMany({
      where: {
        status: "Pendiente",
        active: true,
        created_at: { lt: corteHoldReservas() },
        payment: { is: { status: "Pendiente", items: { some: { transaction: { method: "MercadoPago" } } } } },
      },
      select: { id: true },
      take: 200,
    });
    for (const b of vencidas) {
      try {
        const ok = await prisma.$transaction(async (tx) => {
          // La guarda es la fila: si el webhook la saldó entre la lectura y acá, no se suelta nada.
          const { count } = await tx.payment.updateMany({
            where: { booking_id: b.id, status: "Pendiente" },
            data: { status: "Anulado", resolved_by: "sistema", resolved_reason: MOTIVO_VENCIDA, resolved_at: new Date() },
          });
          if (count === 0) return false;
          await tx.booking.updateMany({
            where: { id: b.id, status: "Pendiente", active: true },
            data: { status: "Cancelada", active: null },
          });
          return true;
        });
        if (ok) liberadas++;
      } catch (error) {
        // Perdió contra otro proceso (webhook): la próxima pasada lo ve resuelto.
        if (!esConflictoDeEscritura(error)) logger.error(error, "Liberar reserva vencida falló", { metadata: { booking_id: b.id } });
      }
    }
  } catch (error) {
    logger.error(error, "Barrido de reservas vencidas falló");
  }
  return liberadas;
}

/**
 * Aprobación tardía de una reserva que el hold ya soltó (fila `Anulado` por "sistema"): si el
 * inicio sigue en el futuro y ningún bloqueo cierra el turno, la reserva vuelve a `Confirmada`
 * + `active true` y la fila a `Pagado`, dentro de la transacción del llamador.
 * @returns `false` si no se puede retomar (turno tomado por otro, bloqueo, ya empezó, otra
 * causa de anulación): el llamador devuelve la plata (`reserva-perdida`).
 */
export async function resolverReserva(
  tx: Prisma.TransactionClient,
  filaId: string,
  pagadoEn: Date,
): Promise<boolean> {
  const fila = await tx.payment.findUnique({
    where: { id: filaId },
    select: {
      status: true,
      resolved_by: true,
      booking: {
        select: { id: true, status: true, date: true, schedule: { select: { place_id: true, start_time: true, end_time: true } } },
      },
    },
  });
  const b = fila?.booking;
  if (!b || fila.status !== "Anulado" || fila.resolved_by !== "sistema" || b.status !== "Cancelada") return false;
  if (!hayTiempoParaPagar(b.date, b.schedule.start_time, new Date(), 0)) return false;
  const bloqueo = await bloqueoQueCierra(b.schedule.place_id, b.date.toISOString().slice(0, 10), {
    start: timeToHHMM(b.schedule.start_time),
    end: timeToHHMM(b.schedule.end_time),
  });
  if (bloqueo) return false;

  try {
    // P2002 = otro tomó el turno (unique schedule/date/active). En MySQL un error de statement no
    // aborta la transacción, así que se puede seguir usando `tx` tras atraparlo.
    const { count } = await tx.booking.updateMany({
      where: { id: b.id, status: "Cancelada", active: null },
      data: { status: "Confirmada", active: true },
    });
    if (count === 0) return false;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2002") return false;
    throw error;
  }

  const { count } = await tx.payment.updateMany({
    where: { id: filaId, status: "Anulado", resolved_by: "sistema" },
    data: {
      status: "Pagado",
      method: "MercadoPago",
      paid_at: pagadoEn,
      registered_by: null,
      resolved_by: null,
      resolved_reason: null,
      resolved_at: null,
    },
  });
  if (count === 0) {
    // Alguien tocó la fila entre la lectura y acá: se deshace la reserva y la plata vuelve.
    await tx.booking.updateMany({ where: { id: b.id, status: "Confirmada" }, data: { status: "Cancelada", active: null } });
    return false;
  }
  return true;
}

export type EstadoReembolsoReserva = "aprobado" | "pendiente" | "fallido";

/**
 * Reembolso automático de una reserva ya cancelada cuya fila quedó `Pagado` por Mercado Pago
 * (D14). Se llama DESPUÉS de commitear la cancelación: si MP falla, la reserva sigue cancelada,
 * la fila `Pagado` y el barrido de 15 minutos reintenta con la misma clave. Nunca lanza.
 * @returns `null` si la reserva no se pagó por MP (efectivo u otro medio manual no se reembolsa solo).
 */
export async function reembolsarReservaPagada(
  bookingId: string,
  actor: string,
): Promise<{ estado: EstadoReembolsoReserva } | null> {
  const fila = await prisma.payment.findFirst({
    where: { booking_id: bookingId, status: "Pagado", method: "MercadoPago" },
    select: {
      id: true,
      items: {
        where: { transaction: { method: "MercadoPago", status: { in: ["Aprobado", "ReembolsadoParcial"] } } },
        select: { transaction_id: true },
        take: 1,
      },
    },
  });
  const transaccionId = fila?.items[0]?.transaction_id;
  if (!fila || !transaccionId) return null;
  try {
    const r = await reembolsarItem({ transaccionId, filaId: fila.id, motivo: "reserva-cancelada", actor });
    if (r.estado === "en_curso") return { estado: "pendiente" };
    return { estado: r.estado === "failed" || r.estado === "rejected" ? "fallido" : "aprobado" };
  } catch (error) {
    logger.error(error, "Reembolso de reserva cancelada falló", { metadata: { booking_id: bookingId } });
    return { estado: "fallido" };
  }
}
