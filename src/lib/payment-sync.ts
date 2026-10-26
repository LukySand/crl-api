/**
 * Conciliación de pagos de Mercado Pago sobre liquidaciones (D13).
 *
 * ponytail: los webhooks son best-effort. `aplicarPagoMP` es el ÚNICO lugar que decide
 * qué le pasa a una cuota cuando cambia un pago; lo llaman el webhook y el conciliador.
 */
import type { Prisma, TransactionStatus } from "../../prisma/generated/client";
import prisma from "./prisma";
import { logger } from "./logger";
import { getPayment, mapEstadoMP, searchPaymentsByExternalReference } from "./mercadopago";

type Mp = Record<string, any>;

export const LIQ_SELECT = {
  id: true,
  status: true,
  amount: true,
  mp_last_updated: true,
  mp_payment_id: true,
  voided_at: true,
  items: { select: { payment_id: true, amount: true } },
} satisfies Prisma.PaymentTransactionSelect;

export type LiquidacionMP = Prisma.PaymentTransactionGetPayload<{ select: typeof LIQ_SELECT }>;

/** Un item que no pudo saldar su fila: la plata tiene que volver (B6) o retomar la reserva (B7). */
export interface ItemNoSaldado {
  payment_id: string | null;
  motivo: "monto-inconsistente" | "cancelada" | "fila-no-saldable";
}

export interface ResultadoMP {
  estado: TransactionStatus;
  noSaldados: ItemNoSaldado[];
}

const centavos = (n: unknown) => Math.round(Number(n) * 100);
const DEFINITIVOS: TransactionStatus[] = ["Reembolsado", "Contracargo"];
// Estados desde los que una aprobación sí salda (el resto ya se aplicó).
const SALDABLES_DESDE: TransactionStatus[] = ["Pendiente", "Rechazado", "Cancelado"];

/**
 * Vuelca un pago de MP sobre la liquidación, en una transacción.
 * @returns `null` si la notificación era vieja o ya la aplicó otro proceso.
 */
export async function aplicarPagoMP(mp: Mp, liq: LiquidacionMP): Promise<ResultadoMP | null> {
  const lastUpdated = mp?.date_last_updated ? new Date(mp.date_last_updated) : null;
  if (lastUpdated && liq.mp_last_updated && lastUpdated <= liq.mp_last_updated) return null;

  let estado = mapEstadoMP(String(mp?.status ?? ""));
  if (estado === "Aprobado" && Number(mp?.transaction_amount_refunded ?? 0) > 0) {
    estado = "ReembolsadoParcial";
  }
  // Una aprobación tardía nunca pisa una devolución ya registrada.
  if (DEFINITIVOS.includes(liq.status) && !DEFINITIVOS.includes(estado)) return null;
  if (liq.status === "ReembolsadoParcial" && estado === "Aprobado") estado = "ReembolsadoParcial";

  const aprobadoEn = mp?.date_approved ? new Date(mp.date_approved) : null;
  const fee = Array.isArray(mp?.fee_details)
    ? mp.fee_details.reduce((acc: number, f: any) => acc + Number(f?.amount ?? 0), 0)
    : null;
  const neto = mp?.transaction_details?.net_received_amount;
  const datosMP: Prisma.PaymentTransactionUpdateManyMutationInput = {
    status: estado,
    mp_payment_id: mp?.id ? String(mp.id) : undefined,
    mp_status: mp?.status ? String(mp.status) : null,
    mp_status_detail: mp?.status_detail ? String(mp.status_detail) : null,
    mp_payment_method: mp?.payment_method_id ? String(mp.payment_method_id) : null,
    mp_payment_type: mp?.payment_type_id ? String(mp.payment_type_id) : null,
    mp_fee: fee !== null ? fee.toFixed(2) : null,
    net_received_amount: neto !== undefined ? Number(neto).toFixed(2) : null,
    mp_last_updated: lastUpdated,
    ...(estado === "Aprobado" && { paid_at: aprobadoEn ?? new Date() }),
    raw: mp as object,
  };

  const noSaldados: ItemNoSaldado[] = [];
  const aplicado = await prisma.$transaction(async (tx) => {
    // Candado optimista: sólo un proceso hace la transición desde el estado que leímos.
    const { count } = await tx.paymentTransaction.updateMany({
      where: { id: liq.id, status: liq.status },
      data: datosMP,
    });
    if (count === 0) return false;

    const ids = liq.items.map((i) => i.payment_id);
    const entraAprobado = estado === "Aprobado" && SALDABLES_DESDE.includes(liq.status);

    if (entraAprobado) {
      const inconsistente = centavos(mp?.transaction_amount) !== centavos(liq.amount);
      if (inconsistente || liq.voided_at) {
        noSaldados.push(
          ...(inconsistente
            ? [{ payment_id: null, motivo: "monto-inconsistente" as const }]
            : ids.map((payment_id) => ({ payment_id, motivo: "cancelada" as const }))),
        );
      } else {
        const filas = await tx.payment.findMany({
          where: { id: { in: ids } },
          select: { id: true, concept: true, booking_id: true },
        });
        for (const f of filas) {
          const { count: saldada } = await tx.payment.updateMany({
            where: { id: f.id, status: { in: ["Pendiente", "EnRevision"] }, deleted_at: null },
            data: {
              status: "Pagado",
              method: "MercadoPago",
              paid_at: aprobadoEn ?? new Date(),
              registered_by: null,
            },
          });
          if (saldada === 0) {
            noSaldados.push({ payment_id: f.id, motivo: "fila-no-saldable" });
          } else if (f.concept === "Reserva" && f.booking_id) {
            await tx.booking.updateMany({
              where: { id: f.booking_id, status: "Pendiente" },
              data: { status: "Confirmada" },
            });
          }
        }
      }
      // La plata ya está en la cuenta: queda registrada la devolución pendiente (B6 la ejecuta).
      if (noSaldados.length > 0) {
        await tx.refund.createMany({
          skipDuplicates: true,
          data: noSaldados.map((n) => ({
            transaction_id: liq.id,
            payment_id: n.payment_id,
            amount: n.payment_id
              ? liq.items.find((i) => i.payment_id === n.payment_id)!.amount
              : (centavos(mp?.transaction_amount) / 100).toFixed(2),
            status: "pending",
            reason: n.motivo,
            requested_by: "sistema",
            income_reversal: false, // nunca saldó una fila, no fue ingreso
            idempotency_key: `reembolso:${liq.id}:${n.payment_id ?? "total"}`,
          })),
        });
      }
    } else if (DEFINITIVOS.includes(estado)) {
      const filas = await tx.payment.findMany({
        where: { id: { in: ids }, status: "Pagado" },
        select: { id: true, booking_id: true },
      });
      await tx.payment.updateMany({
        where: { id: { in: filas.map((f) => f.id) }, status: "Pagado" },
        data: {
          status: "Anulado",
          resolved_by: "mercadopago",
          resolved_reason: estado === "Contracargo" ? "Contracargo en Mercado Pago" : "Reembolsado en Mercado Pago",
          resolved_at: new Date(),
        },
      });
      const reservas = filas.flatMap((f) => (f.booking_id ? [f.booking_id] : []));
      if (reservas.length > 0) {
        await tx.booking.updateMany({
          where: { id: { in: reservas } },
          data: { status: "Cancelada", active: null },
        });
      }
    }
    return true;
  });
  if (!aplicado) return null;

  // B6 conecta `reembolsarItem` y B7 el retome de reservas; hasta entonces sólo se avisa.
  for (const n of noSaldados) {
    logger.error(new Error("pago de MP sin fila saldable"), "Reembolso pendiente", {
      metadata: { liquidacion_id: liq.id, ...n },
    });
  }
  return { estado, noSaldados };
}

/**
 * Le pregunta a MP cómo terminó una liquidación y la actualiza. Busca por
 * `external_reference` (= id de la liquidación) cuando todavía no hay `mp_payment_id`.
 * @returns `null` si MP no tiene ningún pago todavía.
 */
export async function syncPayment(liquidacionId: string) {
  const liq = await prisma.paymentTransaction.findUnique({
    where: { id: liquidacionId },
    select: { ...LIQ_SELECT, method: true },
  });
  if (!liq) throw Object.assign(new Error("liquidacion-inexistente"), { code: "NOT_FOUND" });
  if (liq.method !== "MercadoPago") {
    throw Object.assign(new Error("no-es-de-pasarela"), { code: "NOT_GATEWAY" });
  }
  const mp = liq.mp_payment_id
    ? await getPayment(liq.mp_payment_id)
    : // El más reciente: un checkout reintentado deja varios intentos.
      (await searchPaymentsByExternalReference(liq.id)).sort((a, b) =>
        String(b.date_created).localeCompare(String(a.date_created)),
      )[0];
  return mp ? aplicarPagoMP(mp, liq) : null;
}

/**
 * Concilia liquidaciones MP `Pendiente` con preferencia (de un socio o de todos).
 * Nunca lanza: un error de conciliación no puede dejar al socio sin ver su cuenta.
 */
export async function syncPendingPayments(opts: { userId?: string; limite: number; desde?: Date }) {
  const pendientes = await prisma.paymentTransaction.findMany({
    where: {
      method: "MercadoPago",
      status: "Pendiente",
      mp_preference_id: { not: null },
      ...(opts.userId && { user_id: opts.userId }),
      ...(opts.desde && { created_at: { gte: opts.desde } }),
    },
    orderBy: { created_at: "desc" },
    take: opts.limite,
    select: { id: true },
  });
  let actualizadas = 0;
  for (const p of pendientes) {
    try {
      if (await syncPayment(p.id)) actualizadas++;
    } catch (error) {
      logger.error(error, "Conciliación de liquidación falló", { metadata: { liquidacion_id: p.id } });
    }
  }
  return actualizadas;
}
