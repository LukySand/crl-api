/**
 * Conciliación de pagos de Mercado Pago sobre liquidaciones (D13).
 *
 * ponytail: los webhooks son best-effort. `aplicarPagoMP` es el ÚNICO lugar que decide
 * qué le pasa a una cuota cuando cambia un pago; lo llaman el webhook y el conciliador.
 */
import type { Prisma, TransactionStatus } from "../../prisma/generated/client";
import prisma from "./prisma";
import { logger } from "./logger";
import { getPayment, listRefunds, mapEstadoMP, searchPaymentsByExternalReference } from "./mercadopago";
import { resolverReserva } from "./booking-hold";
import { aprobarReembolso, efectosDeReembolso, reembolsarItem } from "./refunds";

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

/** Un item que no pudo saldar su fila: la plata tiene que volver (D12) salvo que la reserva se retome (D14). */
export interface ItemNoSaldado {
  payment_id: string | null;
  motivo: "monto-inconsistente" | "cancelada" | "fila-no-saldable" | "reserva-perdida";
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
  // Una preferencia se puede pagar dos veces (mismo link abierto en dos pestañas). Si la liquidación
  // ya cerró con OTRO pago, éste es un duplicado: no se vuelca (pisaría `mp_payment_id` y el cobro
  // original quedaría olvidado) y, si cobró, se devuelve entero. Va antes del chequeo de "vieja":
  // `mp_last_updated` es del otro pago y no sirve para comparar.
  const mpId = String(mp?.id ?? "");
  if (mpId && liq.mp_payment_id && liq.mp_payment_id !== mpId && !SALDABLES_DESDE.includes(liq.status)) {
    if (mapEstadoMP(String(mp?.status ?? "")) === "Aprobado" && !(Number(mp?.transaction_amount_refunded ?? 0) > 0)) {
      // Queda como `Refund` (con `mp_payment_id` del duplicado) y sale por la misma máquina que los
      // reembolsos normales: 5xx -> `failed` y lo reintenta `reintentarReembolsos`; 4xx -> `rejected`
      // y lo ve el admin en "Problemas de pagos". Si la fila ya existe, los reintentos son de ese
      // barrido, no de cada webhook. Sólo lanza (webhook 500, MP reintenta) si no se pudo registrar.
      const clave = `duplicado:${mpId}`;
      if (await prisma.refund.findUnique({ where: { idempotency_key: clave }, select: { id: true } })) return null;
      const r = await reembolsarItem({
        transaccionId: liq.id,
        filaId: null,
        motivo: "Pago duplicado de la misma preferencia",
        actor: "sistema",
        duplicado: { mpPaymentId: mpId, monto: (centavos(mp?.transaction_amount) / 100).toFixed(2) },
      });
      logger.info("Pago duplicado de Mercado Pago registrado", {
        metadata: { liquidacion_id: liq.id, mp_payment_id: mpId, refund_id: r.refundId, estado: r.estado },
      });
    }
    return null;
  }

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
            // Aprobación tardía de una reserva que el hold soltó: se retoma si el turno sigue libre.
            const esReserva = f.concept === "Reserva" && f.booking_id;
            if (esReserva && (await resolverReserva(tx, f.id, aprobadoEn ?? new Date()))) continue;
            noSaldados.push({ payment_id: f.id, motivo: esReserva ? "reserva-perdida" : "fila-no-saldable" });
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
  // Perdió el candado: si ganó otro pago de la misma preferencia, `devolverDuplicados` lo devuelve.
  if (!aplicado) return null;

  // La plata que no pudo saldar una fila vuelve sola (D12); la reserva ya tuvo su retome en la transacción.
  for (const n of noSaldados) {
    try {
      await reembolsarItem({
        transaccionId: liq.id,
        filaId: n.payment_id,
        motivo: n.motivo,
        actor: "sistema",
        propio: true,
      });
    } catch (error) {
      // El `pending` ya está registrado: el barrido de 15 minutos lo reintenta.
      logger.error(error, "Reembolso automático falló", { metadata: { liquidacion_id: liq.id, ...n } });
    }
  }
  if (Number(mp?.transaction_amount_refunded ?? 0) > 0) {
    try {
      await conciliarReembolsosExternos(liq.id, String(mp.id));
    } catch (error) {
      logger.error(error, "Conciliación de reembolsos externos falló", { metadata: { liquidacion_id: liq.id } });
    }
  }
  return { estado, noSaldados };
}

/**
 * Reembolsos hechos fuera de la app (D13.5), uno por uno: se adjuntan a un `Refund` local
 * `pending` del mismo monto; si no, a la fila `Pagado` de monto exacto (menor id si empata);
 * si nada calza queda un `Refund` sin fila, que sólo se informa. Los que ya conocemos
 * (propios o ya conciliados) se saltean por `mp_refund_id`.
 */
export async function conciliarReembolsosExternos(liquidacionId: string, mpPaymentId: string) {
  const externos = await listRefunds(mpPaymentId);
  for (const r of externos) {
    const mpId = String(r.id);
    const monto = (centavos(r.amount) / 100).toFixed(2);
    const fecha = r.date_created ? new Date(r.date_created) : new Date();
    if (await prisma.refund.findFirst({ where: { OR: [{ mp_refund_id: mpId }, { idempotency_key: `mp:${mpId}` }] }, select: { id: true } })) {
      continue;
    }
    const local = await prisma.refund.findFirst({
      // `mp_payment_id: null`: un duplicado pendiente (mismo monto) no es de este pago.
      where: { transaction_id: liquidacionId, status: "pending", amount: monto, mp_payment_id: null },
      orderBy: { id: "asc" },
      select: { id: true, reason: true, requested_by: true },
    });
    if (local && (await aprobarReembolso(local.id, { mpRefundId: mpId, refundedAt: fecha, actor: local.requested_by, motivo: local.reason ?? "Reembolso" }))) {
      continue;
    }

    const items = await prisma.paymentTransactionItem.findMany({
      where: { transaction_id: liquidacionId, amount: monto },
      select: { payment_id: true },
      orderBy: { payment_id: "asc" },
    });
    const conReembolso = new Set(
      (
        await prisma.refund.findMany({
          where: { transaction_id: liquidacionId, payment_id: { not: null }, status: { in: ["approved", "pending", "resolved_offline"] } },
          select: { payment_id: true },
        })
      ).map((x) => x.payment_id),
    );
    // Una fila que MP ya anuló al ver el `refunded` también cuenta: es la plata que volvió.
    const filas = await prisma.payment.findMany({
      where: {
        id: { in: items.map((i) => i.payment_id).filter((id) => !conReembolso.has(id)) },
        OR: [{ status: "Pagado" }, { status: "Anulado", resolved_by: "mercadopago" }],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const fila = filas[0];

    try {
      await prisma.$transaction(async (tx) => {
        const creado = await tx.refund.create({
          data: {
            transaction_id: liquidacionId,
            payment_id: fila?.id ?? null,
            amount: monto,
            status: "approved",
            reason: "Reembolso hecho en Mercado Pago",
            requested_by: "mercadopago",
            income_reversal: fila !== undefined,
            refunded_at: fecha,
            mp_refund_id: mpId,
            idempotency_key: `mp:${mpId}`,
          },
        });
        await efectosDeReembolso(tx, creado, "mercadopago", "Reembolsado en Mercado Pago");
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") continue; // otro proceso lo conciliaba
      throw e;
    }
    if (!fila) {
      logger.error(new Error("reembolso externo sin fila asignable"), "Reembolso externo sin asignar", {
        metadata: { liquidacion_id: liquidacionId, mp_refund_id: mpId, monto },
      });
      logger.audit(
        "create",
        { metadata: { operacion: "create", entidad: "refund", entidad_id: mpId, actor_id: "mercadopago", despues: { liquidacion_id: liquidacionId, monto, sin_asignar: true } } },
        "refund create",
      );
    }
  }
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
  const aplicado = mp ? await aplicarPagoMP(mp, liq) : null;
  try {
    await devolverDuplicados(liq.id);
  } catch (error) {
    // Lo levanta el barrido de duplicados; no le rompe la vuelta del checkout al socio.
    logger.error(error, "Devolución de duplicados falló", { metadata: { liquidacion_id: liq.id } });
  }
  return aplicado;
}

/**
 * Devuelve todo pago aprobado de la preferencia que no sea el que saldó la liquidación (el mismo
 * link pagado dos veces). No depende de que llegue la notificación de ESE pago: alcanza con la del
 * otro, la vuelta del checkout o el barrido. La devolución en sí es la guarda de `aplicarPagoMP`.
 * Lanza sólo si no se pudo registrar una devolución (las fallas de MP quedan en el `Refund`).
 * `yaProcesado`: el pago que el llamador acaba de aplicar.
 */
export async function devolverDuplicados(liquidacionId: string, yaProcesado?: string): Promise<void> {
  const liq = await prisma.paymentTransaction.findUnique({ where: { id: liquidacionId }, select: LIQ_SELECT });
  if (!liq?.mp_payment_id || SALDABLES_DESDE.includes(liq.status)) return;
  for (const p of await searchPaymentsByExternalReference(liq.id)) {
    if (String(p.id) !== liq.mp_payment_id && String(p.id) !== yaProcesado) await aplicarPagoMP(p, liq);
  }
}

/**
 * Red de seguridad: revisa las liquidaciones MP saldadas en los últimos 7 días. Un link se puede
 * pagar mientras no venza (las cuotas, 24 h). Nunca lanza.
 * ponytail: una búsqueda en MP por liquidación; con volumen, acotar por `paid_at` reciente.
 */
export async function barrerDuplicados(limite = 50): Promise<void> {
  try {
    const liqs = await prisma.paymentTransaction.findMany({
      where: {
        method: "MercadoPago",
        status: { notIn: SALDABLES_DESDE },
        mp_payment_id: { not: null },
        created_at: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
      },
      orderBy: { created_at: "desc" },
      select: { id: true },
      take: limite,
    });
    for (const l of liqs) {
      try {
        await devolverDuplicados(l.id);
      } catch (error) {
        logger.error(error, "Devolución de duplicados falló", { metadata: { liquidacion_id: l.id } });
      }
    }
  } catch (error) {
    logger.error(error, "Barrido de pagos duplicados falló");
  }
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
