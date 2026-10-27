/**
 * Reembolsos de Mercado Pago (D12).
 *
 * `reembolsarItem` es el ÚNICO camino que devuelve plata. La fila `Refund` con
 * `idempotency_key = reembolso:{liquidacion}:{fila}` se inserta ANTES de llamar a MP:
 * el `@unique` es el candado, y la misma clave viaja en cada reintento, así un
 * timeout + reintento no devuelve la plata dos veces.
 */
import type { Prisma, TransactionStatus } from "../../prisma/generated/client";
import prisma from "./prisma";
import { logger } from "./logger";
import { MercadoPagoError, refundPayment } from "./mercadopago";

/** Un pending más viejo que esto se considera abandonado y se puede reclamar. */
export const PENDING_VIEJO_MS = 2 * 60_000;
/** Ventana en la que el barrido sigue reintentando. */
export const VENTANA_REINTENTO_MS = 7 * 24 * 3600_000;

const centavos = (n: unknown) => Math.round(Number(n) * 100);

/**
 * Resume un error de MP para `Refund.last_error`: `"HTTP {status} {codigo}"`, `"timeout"` o `"red"`.
 * Usa sólo el status y los códigos de máquina (`error`, `cause[].code`); jamás el mensaje ni el
 * cuerpo, que MP puede llenar con el email o la tarjeta del pagador.
 */
export function errorSeguroMP(err: unknown): string {
  if (err instanceof MercadoPagoError) {
    const b = err.body as { error?: unknown; cause?: unknown } | null;
    const causa = Array.isArray(b?.cause) ? (b.cause[0] as { code?: unknown } | undefined)?.code : undefined;
    // El código tiene que parecer un identificador: un texto libre podría traer datos del pagador.
    const codigo = [b?.error, causa]
      .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
      .find((c) => /^[\w.-]{1,64}$/.test(c));
    return `HTTP ${err.status}${codigo ? ` ${codigo}` : ""}`.slice(0, 200);
  }
  const nombre = (err as { name?: string } | null)?.name;
  return nombre === "TimeoutError" || nombre === "AbortError" ? "timeout" : "red";
}

export type EstadoReembolso = "approved" | "failed" | "rejected" | "en_curso" | "ya_reembolsado" | "resuelto";

export interface ResultadoReembolso {
  estado: EstadoReembolso;
  refundId: number;
}

export interface ReembolsoOpts {
  transaccionId: string;
  /** Fila a devolver; `null` = el total de la liquidación (monto inconsistente). */
  filaId: string | null;
  motivo: string;
  /** Id de usuario, "sistema" o "mercadopago". */
  actor: string;
  /** Sólo una persona reclama un `rejected` (el barrido nunca). */
  persona?: boolean;
  /** El llamador acaba de insertar el `pending` (aplicarPagoMP): no esperar a que envejezca. */
  propio?: boolean;
  /**
   * Pago duplicado de la misma preferencia: se devuelve ESE pago (no el de la liquidación), entero,
   * con clave `duplicado:{id}`, y no toca filas, reserva ni estado de la liquidación.
   */
  duplicado?: { mpPaymentId: string; monto: string | number };
}

const esDuplicado = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * Efecto sobre la fila de un reembolso que devolvió plata: `Pagado → Anulado` (conserva
 * `paid_at`/`method`, D22; sólo si descontó un ingreso) y, si era una `Reserva`, cancela la reserva.
 */
async function anularFilaReembolsada(
  tx: Prisma.TransactionClient,
  r: { payment_id: string | null; income_reversal: boolean },
  actor: string,
  motivo: string,
) {
  if (!r.payment_id || !r.income_reversal) return;
  const { count } = await tx.payment.updateMany({
    where: { id: r.payment_id, status: "Pagado" },
    data: { status: "Anulado", resolved_by: actor, resolved_reason: motivo, resolved_at: new Date() },
  });
  if (count > 0) {
    const f = await tx.payment.findUnique({ where: { id: r.payment_id }, select: { booking_id: true } });
    if (f?.booking_id) {
      await tx.booking.updateMany({ where: { id: f.booking_id }, data: { status: "Cancelada", active: null } });
    }
  }
}

/**
 * Efectos de contabilidad de un reembolso aprobado, dentro de la transacción del llamador:
 * la fila y la reserva (`anularFilaReembolsada`) y el estado de la liquidación
 * (`Reembolsado` si ya salió todo). Un pago duplicado (`mp_payment_id` seteado) no tiene efectos:
 * la liquidación y su cobro legítimo siguen como están.
 */
export async function efectosDeReembolso(
  tx: Prisma.TransactionClient,
  r: { transaction_id: string; payment_id: string | null; income_reversal: boolean; mp_payment_id?: string | null },
  actor: string,
  motivo: string,
) {
  if (r.mp_payment_id) return;
  await anularFilaReembolsada(tx, r, actor, motivo);
  const liq = await tx.paymentTransaction.findUnique({ where: { id: r.transaction_id }, select: { amount: true } });
  const { _sum } = await tx.refund.aggregate({
    where: { transaction_id: r.transaction_id, status: "approved", mp_payment_id: null },
    _sum: { amount: true },
  });
  const estado: TransactionStatus =
    liq && centavos(_sum.amount) >= centavos(liq.amount) ? "Reembolsado" : "ReembolsadoParcial";
  await tx.paymentTransaction.updateMany({
    where: { id: r.transaction_id, status: { in: ["Aprobado", "ReembolsadoParcial"] } },
    data: { status: estado },
  });
}

/**
 * Marca un `Refund` pendiente/fallido como aprobado y aplica sus efectos, una sola vez
 * (el `updateMany` guardado hace que el perdedor de una carrera no repita nada).
 */
export async function aprobarReembolso(
  refundId: number,
  datos: { mpRefundId: string | null; refundedAt: Date; actor: string; motivo: string },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.refund.updateMany({
      where: { id: refundId, status: { in: ["pending", "failed"] } },
      data: {
        status: "approved",
        refunded_at: datos.refundedAt,
        mp_refund_id: datos.mpRefundId,
        last_error: null,
        attempts: { increment: 1 },
      },
    });
    if (count === 0) return false;
    const r = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: { transaction_id: true, payment_id: true, income_reversal: true, mp_payment_id: true },
    });
    await efectosDeReembolso(tx, r, datos.actor, datos.motivo);
    return true;
  });
}

/**
 * Devuelve a MP la plata de una fila (o el total) de una liquidación.
 * @throws Error con `code` `NOT_GATEWAY` | `NOT_ITEM` si el pedido no tiene sentido.
 */
export async function reembolsarItem(o: ReembolsoOpts): Promise<ResultadoReembolso> {
  const liq = await prisma.paymentTransaction.findUnique({
    where: { id: o.transaccionId },
    select: { id: true, method: true, amount: true, mp_payment_id: true, items: { select: { payment_id: true, amount: true } } },
  });
  if (!liq || liq.method !== "MercadoPago" || !liq.mp_payment_id) {
    throw Object.assign(new Error("no-es-de-pasarela"), { code: "NOT_GATEWAY" });
  }
  const item = o.filaId ? liq.items.find((i) => i.payment_id === o.filaId) : null;
  if (o.filaId && !item) throw Object.assign(new Error("fila-fuera-de-la-liquidacion"), { code: "NOT_ITEM" });
  const monto = o.duplicado?.monto ?? (item ? item.amount : liq.amount);
  const key = o.duplicado ? `duplicado:${o.duplicado.mpPaymentId}` : `reembolso:${liq.id}:${o.filaId ?? "total"}`;
  // El pago a devolver: el duplicado, o el que saldó la liquidación.
  const mpPaymentId = o.duplicado?.mpPaymentId ?? liq.mp_payment_id;

  let refund: { id: number; status: string; updated_at: Date };
  try {
    // La plata vuelve a MP sin ser ingreso si la fila no había quedado cobrada.
    const fila = o.filaId
      ? await prisma.payment.findUnique({ where: { id: o.filaId }, select: { status: true } })
      : null;
    refund = await prisma.refund.create({
      data: {
        transaction_id: liq.id,
        payment_id: o.filaId,
        amount: monto,
        status: "pending",
        reason: o.motivo,
        requested_by: o.actor,
        income_reversal: fila?.status === "Pagado",
        idempotency_key: key,
        mp_payment_id: o.duplicado?.mpPaymentId ?? null,
      },
      select: { id: true, status: true, updated_at: true },
    });
  } catch (e) {
    if (!esDuplicado(e)) throw e;
    const previo = await prisma.refund.findUniqueOrThrow({
      where: { idempotency_key: key },
      select: { id: true, status: true, updated_at: true },
    });
    if (previo.status === "approved") return { estado: "ya_reembolsado", refundId: previo.id };
    // D24b: cerrado a mano, terminal; nadie lo reintenta.
    if (previo.status === "resolved_offline") return { estado: "resuelto", refundId: previo.id };
    const viejo = Date.now() - previo.updated_at.getTime() > PENDING_VIEJO_MS;
    const reclamable =
      previo.status === "failed" ||
      (previo.status === "pending" && (viejo || o.propio)) ||
      (previo.status === "rejected" && o.persona);
    if (!reclamable) {
      return { estado: previo.status === "rejected" ? "rejected" : "en_curso", refundId: previo.id };
    }
    // Guardado por estado y fecha leídos: sólo un proceso lo reclama.
    const { count } = await prisma.refund.updateMany({
      where: { id: previo.id, status: previo.status, updated_at: previo.updated_at },
      data: { status: "pending" },
    });
    if (count === 0) return { estado: "en_curso", refundId: previo.id };
    refund = previo;
  }

  try {
    // Sin `amount` cuando es todo lo que queda de la liquidación.
    const todo = !item || centavos(monto) === centavos(liq.amount);
    const res = await refundPayment(mpPaymentId, key, todo ? undefined : Number(monto));
    // Si devuelve false otro proceso (conciliación) ya lo aprobó: el resultado es el mismo.
    await aprobarReembolso(refund.id, {
      mpRefundId: res?.id !== undefined && res?.id !== null ? String(res.id) : null,
      refundedAt: new Date(),
      actor: o.actor,
      motivo: o.motivo,
    });
    return { estado: "approved", refundId: refund.id };
  } catch (error) {
    const rechazado = error instanceof MercadoPagoError && error.status >= 400 && error.status < 500;
    const lastError = errorSeguroMP(error);
    await prisma.refund.updateMany({
      where: { id: refund.id, status: "pending" },
      data: { status: rechazado ? "rejected" : "failed", attempts: { increment: 1 }, last_error: lastError },
    });
    // Se loguea el resumen seguro, no el error de MP (su cuerpo puede traer datos del pagador).
    logger.error(new Error(lastError), "Reembolso de Mercado Pago falló", {
      metadata: { liquidacion_id: liq.id, payment_id: o.filaId, mp_payment_id: mpPaymentId, refund_id: refund.id, rechazado },
    });
    if (rechazado) {
      logger.audit(
        "update",
        { metadata: { operacion: "update", entidad: "refund", entidad_id: String(refund.id), actor_id: o.actor, despues: { status: "rejected" }, motivo: lastError } },
        "refund rejected",
      );
    }
    return { estado: rechazado ? "rejected" : "failed", refundId: refund.id };
  }
}

/**
 * Barrido de 15 minutos: reintenta con la misma clave los `failed` y los `pending` viejos de
 * los últimos 7 días. Nunca toca un `rejected` (sólo una persona lo reintenta).
 */
export async function reintentarReembolsos(limite = 20): Promise<number> {
  const ahora = Date.now();
  const candidatos = await prisma.refund.findMany({
    where: {
      created_at: { gte: new Date(ahora - VENTANA_REINTENTO_MS) },
      OR: [{ status: "failed" }, { status: "pending", updated_at: { lt: new Date(ahora - PENDING_VIEJO_MS) } }],
    },
    orderBy: { created_at: "asc" },
    take: limite,
    select: { transaction_id: true, payment_id: true, reason: true, requested_by: true, amount: true, mp_payment_id: true },
  });
  let aprobados = 0;
  for (const c of candidatos) {
    try {
      const r = await reembolsarItem({
        transaccionId: c.transaction_id,
        filaId: c.payment_id,
        motivo: c.reason ?? "reintento",
        actor: c.requested_by,
        duplicado: c.mp_payment_id ? { mpPaymentId: c.mp_payment_id, monto: c.amount.toString() } : undefined,
      });
      if (r.estado === "approved") aprobados++;
    } catch (error) {
      logger.error(error, "Reintento de reembolso falló", { metadata: { liquidacion_id: c.transaction_id } });
    }
  }
  return aprobados;
}

export type ResultadoResolver = "resuelto" | "no_existe" | "en_curso" | "no_resoluble";

/**
 * D24b: cierra a mano un reembolso `failed`/`rejected` ("Resuelta fuera de Mercado Pago").
 * Terminal: queda `resolved_offline` y nadie lo reintenta. Con `devueltoEnMano` la plata salió de
 * la caja del club: `refunded_at = now` (egreso del mes de hoy, D22) y, en la misma transacción,
 * la fila `Pagado → Anulado` y la reserva cancelada. La liquidación no se toca (refleja a MP).
 * El `updateMany` guardado por estado hace que un resolver concurrente o el barrido, uno solo gane.
 */
export async function resolverFueraDeMP(
  refundId: number,
  o: { note: string; devueltoEnMano: boolean; actor: string },
): Promise<ResultadoResolver> {
  return prisma.$transaction(async (tx) => {
    const ahora = new Date();
    const { count } = await tx.refund.updateMany({
      where: { id: refundId, status: { in: ["failed", "rejected"] } },
      data: {
        status: "resolved_offline",
        resolved_by: o.actor,
        resolved_note: o.note,
        resolved_at: ahora,
        ...(o.devueltoEnMano ? { refunded_at: ahora } : {}),
      },
    });
    if (count === 0) {
      const r = await tx.refund.findUnique({ where: { id: refundId }, select: { status: true } });
      if (!r) return "no_existe";
      return r.status === "pending" ? "en_curso" : "no_resoluble";
    }
    if (o.devueltoEnMano) {
      const r = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        select: { payment_id: true, income_reversal: true },
      });
      await anularFilaReembolsada(tx, r, o.actor, o.note);
    }
    return "resuelto";
  });
}
