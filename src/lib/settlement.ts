/**
 * Liquidaciones (D4, D8, D9). Único lugar que escribe un cobro manual: crea la
 * `PaymentTransaction` + sus items y actualiza, en la MISMA transacción de base,
 * los campos desnormalizados de cada fila (`status/method/paid_at/registered_by`).
 */
import { Prisma, type PaymentMethod } from "../../prisma/generated/client";
import prisma from "./prisma";
import { bloqueantesDeOrden } from "./payment-rules";

type Db = Prisma.TransactionClient;

/** Una fila ya no estaba `Pendiente`/`EnRevision`: el perdedor de la carrera. */
export class CuotaYaSaldada extends Error {
  constructor() {
    super("Esa cuota ya fue cobrada o anulada");
  }
}

/**
 * P2034: MySQL abortó la transacción por conflicto de escritura o deadlock. Pasa cuando dos
 * pedidos simultáneos pelean las mismas filas: el perdedor tiene que ver lo mismo que vería
 * con el `updateMany` guardado (409), no un 500.
 */
export const esConflictoDeEscritura = (e: unknown) => (e as { code?: string } | null)?.code === "P2034";

export interface FilaASaldar {
  id: string;
  amount: Prisma.Decimal | number | string;
}

/**
 * Liquidación manual `Aprobado` que salda `filas`. Cada fila pasa a `Pagado` con un
 * `updateMany` guardado por estado; si alguna ya no estaba pendiente lanza
 * `CuotaYaSaldada` y la transacción que la contiene se revierte entera.
 */
export async function saldarItems(
  tx: Db,
  args: {
    userId: string;
    method: PaymentMethod;
    registeredBy: string;
    notes?: string;
    filas: FilaASaldar[];
  },
): Promise<{ liquidacionId: string }> {
  const ahora = new Date();
  const total = args.filas.reduce((acc, f) => acc + Math.round(Number(f.amount) * 100), 0) / 100;

  const liquidacion = await tx.paymentTransaction.create({
    data: {
      user_id: args.userId,
      method: args.method,
      status: "Aprobado",
      amount: total,
      registered_by: args.registeredBy,
      notes: args.notes ?? null,
      paid_at: ahora,
      items: {
        create: args.filas.map((f) => ({ payment_id: f.id, amount: f.amount as never })),
      },
    },
    select: { id: true },
  });

  const { count } = await tx.payment.updateMany({
    where: { id: { in: args.filas.map((f) => f.id) }, status: { in: ["Pendiente", "EnRevision"] } },
    data: {
      status: "Pagado",
      paid_at: ahora,
      method: args.method,
      registered_by: args.registeredBy,
      ...(args.notes !== undefined && { notes: args.notes }),
    },
  });
  if (count !== args.filas.length) throw new CuotaYaSaldada();

  return { liquidacionId: liquidacion.id };
}

/**
 * Cobro manual de una o varias filas del mismo socio. Una fila `Reserva` confirma
 * además su reserva (viajan juntas). Devuelve `null` si alguien se adelantó.
 */
export async function registrarCobroManual(args: {
  userId: string;
  method: PaymentMethod;
  registeredBy: string;
  notes?: string;
  filas: (FilaASaldar & { concept: string; booking_id: string | null })[];
}): Promise<{ liquidacionId: string } | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await saldarItems(tx, args);
      for (const f of args.filas) {
        if (f.concept === "Reserva" && f.booking_id) {
          await tx.booking.updateMany({
            where: { id: f.booking_id, status: "Pendiente" },
            data: { status: "Confirmada" },
          });
        }
      }
      return r;
    });
  } catch (e) {
    if (e instanceof CuotaYaSaldada || esConflictoDeEscritura(e)) return null;
    throw e;
  }
}

/** Liquidación de MP `Pendiente` y sin vencer que incluye alguna de las filas (D8). */
export async function liquidacionViva(ids: string[], db: Pick<Db, "paymentTransaction"> = prisma) {
  // ponytail: leer-y-después-escribir; un unique parcial sería el upgrade.
  return db.paymentTransaction.findFirst({
    where: {
      method: "MercadoPago",
      status: "Pendiente",
      expires_at: { gt: new Date() },
      items: { some: { payment_id: { in: ids } } },
    },
    select: { id: true, expires_at: true, checkout_url: true },
  });
}

/** P7 (D9): lee las pendientes del socio y aplica la regla pura. */
export async function verificarOrdenDePago(userId: string, ids: string[]) {
  const pendientes = await prisma.payment.findMany({
    where: { user_id: userId, status: "Pendiente", deleted_at: null },
    select: { id: true, concept: true, created_at: true, name: true, amount: true, due_date: true },
  });
  const seleccion = pendientes.filter((p) => ids.includes(p.id));
  const bloqueo = bloqueantesDeOrden(seleccion, pendientes);
  if (!bloqueo) return null;
  return {
    payment_id: bloqueo.cuota_social_id,
    cuota_social_id: bloqueo.cuota_social_id,
    bloqueantes: pendientes
      .filter((p) => bloqueo.bloqueantes.includes(p.id))
      .map((p) => ({
        id: p.id,
        nombre: p.name,
        monto: p.amount.toString(),
        vencimiento: p.due_date ? p.due_date.toISOString().slice(0, 10) : null,
      })),
  };
}

/** ¿Puede `actor` pagar la deuda de `deudorId`? Dueño, tutor activo o gestión. */
export async function puedePagarPor(
  actor: { id: string; esGestion: boolean },
  deudorId: string,
): Promise<boolean> {
  if (actor.esGestion || actor.id === deudorId) return true;
  const vinculo = await prisma.family.findFirst({
    where: { parent_id: actor.id, child_id: deudorId, active: true },
    select: { id: true },
  });
  return vinculo !== null;
}

/** Otro checkout se adelantó con alguna de las filas (la carrera, D8). */
export class PagoEnCurso extends Error {
  constructor(readonly viva: { id: string; expires_at: Date | null; checkout_url: string | null }) {
    super("Hay un pago en curso para esta cuota");
  }
}

/**
 * Liquidación de MP `Pendiente` con sus items, en una transacción. Bloquea las filas
 * (`FOR UPDATE`) y vuelve a mirar `liquidacionViva` adentro: dos checkouts simultáneos
 * se serializan y el segundo recibe `PagoEnCurso`.
 */
export async function crearLiquidacionMP(args: {
  userId: string;
  filas: FilaASaldar[];
  expiresAt: Date;
}): Promise<{ id: string; total: number }> {
  const total = args.filas.reduce((acc, f) => acc + Math.round(Number(f.amount) * 100), 0) / 100;
  const ids = args.filas.map((f) => f.id);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`payments\` WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
      const viva = await liquidacionViva(ids, tx);
      if (viva) throw new PagoEnCurso(viva);
      const liq = await tx.paymentTransaction.create({
        data: {
          user_id: args.userId,
          method: "MercadoPago",
          status: "Pendiente",
          amount: total,
          expires_at: args.expiresAt,
          items: { create: args.filas.map((f) => ({ payment_id: f.id, amount: f.amount as never })) },
        },
        select: { id: true },
      });
      return { id: liq.id, total };
    });
  } catch (e) {
    // Perdió la carrera contra otro checkout: mismo resultado que ver la liquidación viva.
    const viva = esConflictoDeEscritura(e) ? await liquidacionViva(ids) : null;
    if (viva) throw new PagoEnCurso(viva);
    throw e;
  }
}
