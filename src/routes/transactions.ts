/**
 * Liquidaciones (`/api/transactions`). B5: lectura para la pantalla de retorno de MP y
 * sincronización a demanda. Lo lee quien pagó, el deudor de alguna fila o la gestión.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import { auditar } from "../lib/audit";
import { syncPayment } from "../lib/payment-sync";
import { PENDING_VIEJO_MS, resolverFueraDeMP, VENTANA_REINTENTO_MS } from "../lib/refunds";
import { logger } from "../lib/logger";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const LIMITE_PROBLEMAS = 100;
const resolverSchema = z
  .object({ note: z.string().trim().min(3).max(500), devuelto_en_mano: z.boolean() })
  .strict();

/**
 * GET /api/transactions/problemas (D24) — reembolsos `failed`/`rejected` o `pending` abandonados
 * (>2 min) y contracargos. Un `select` explícito: nunca `raw` ni `mp_*` salvo `mp_payment_id`.
 */
transactionsRouter.get("/problemas", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const ahora = Date.now();
    const [reembolsos, contracargos] = await Promise.all([
      prisma.refund.findMany({
        where: {
          OR: [
            { status: { in: ["failed", "rejected"] } },
            { status: "pending", updated_at: { lt: new Date(ahora - PENDING_VIEJO_MS) } },
          ],
        },
        orderBy: { created_at: "desc" },
        take: LIMITE_PROBLEMAS,
        select: {
          id: true,
          transaction_id: true,
          payment_id: true,
          amount: true,
          status: true,
          reason: true,
          requested_by: true,
          attempts: true,
          last_error: true,
          created_at: true,
          updated_at: true,
          mp_payment_id: true,
          transaction: { select: { mp_payment_id: true } },
          payment: { select: { id: true, name: true, concept: true, user: { select: { name: true, last_name: true } } } },
        },
      }),
      prisma.paymentTransaction.findMany({
        where: { status: "Contracargo" },
        orderBy: { updated_at: "desc" },
        take: LIMITE_PROBLEMAS,
        select: {
          id: true,
          amount: true,
          mp_payment_id: true,
          updated_at: true,
          user: { select: { name: true, last_name: true } },
          items: { select: { payment: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    const ventana = new Date(ahora - VENTANA_REINTENTO_MS);
    return res.json({
      reembolsos: reembolsos.map((r) => ({
        id: r.id,
        liquidacion_id: r.transaction_id,
        // Un duplicado se devuelve por su propio pago, no por el de la liquidación.
        mp_payment_id: r.mp_payment_id ?? r.transaction.mp_payment_id,
        monto: r.amount.toFixed(2),
        estado: r.status,
        motivo: r.reason,
        // Sin id de usuario: sólo de dónde salió el pedido.
        origen: r.requested_by === "sistema" || r.requested_by === "mercadopago" ? r.requested_by : "gestion",
        intentos: r.attempts,
        ultimo_error: r.last_error,
        reintento_automatico: r.status !== "rejected" && r.created_at >= ventana,
        creado: r.created_at,
        actualizado: r.updated_at,
        cargo: r.payment
          ? {
              id: r.payment.id,
              name: r.payment.name,
              concepto: r.payment.concept,
              socio: `${r.payment.user.name} ${r.payment.user.last_name}`,
            }
          : null,
      })),
      contracargos: contracargos.map((c) => ({
        id: c.id,
        mp_payment_id: c.mp_payment_id,
        monto: c.amount.toFixed(2),
        socio: `${c.user.name} ${c.user.last_name}`,
        actualizado: c.updated_at,
        cargos: c.items.map((i) => ({ id: i.payment.id, name: i.payment.name })),
      })),
    });
  } catch (error) {
    console.error("List problems error:", error);
    return res.status(500).json({ success: false, error: "Error al leer los problemas" });
  }
});

/**
 * POST /api/transactions/refunds/:id/resolver { note, devuelto_en_mano } (D24b) — cierra a mano un
 * reembolso `failed`/`rejected`. 409 si está en curso, aprobado o ya resuelto; 404 si no existe.
 */
transactionsRouter.post("/refunds/:id/resolver", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = resolverSchema.safeParse(req.body ?? {});
    const id = Number(req.params.id);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      parsed.error.issues.forEach((i) => (errors[i.path[0] as string] = i.message));
      return res.status(400).json({ success: false, error: "Validación fallida", errors });
    }
    if (!Number.isInteger(id) || id < 1) {
      return res.status(404).json({ success: false, error: "Reembolso no encontrado" });
    }
    const { note, devuelto_en_mano } = parsed.data;
    const r = await resolverFueraDeMP(id, { note, devueltoEnMano: devuelto_en_mano, actor: req.user!.id });
    if (r === "no_existe") return res.status(404).json({ success: false, error: "Reembolso no encontrado" });
    if (r === "en_curso") return res.status(409).json({ success: false, error: "Hay un reembolso en curso" });
    if (r === "no_resoluble") {
      return res.status(409).json({ success: false, error: "Ese reembolso ya está aprobado o resuelto" });
    }
    auditar(req, "update", "refund", id, {
      motivo: note,
      despues: { operacion: "reembolso.resolver", estado: "resolved_offline", devuelto_en_mano },
    });
    return res.json({ reembolso: { id, estado: "resolved_offline", devuelto_en_mano } });
  } catch (error) {
    console.error("Resolve refund error:", error);
    return res.status(500).json({ success: false, error: "Error al resolver el reembolso" });
  }
});

async function cargar(req: Request<{ id: string }>, res: Response) {
  const liq = await prisma.paymentTransaction.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      user_id: true,
      method: true,
      status: true,
      amount: true,
      items: {
        select: {
          payment: { select: { id: true, name: true, user_id: true, booking: { select: { id: true, status: true } } } },
        },
      },
    },
  });
  if (!liq) {
    res.status(404).json({ success: false, error: "Pago no encontrado" });
    return null;
  }
  const yo = req.user!.id;
  if (!isAdmin(req) && liq.user_id !== yo && !liq.items.some((i) => i.payment.user_id === yo)) {
    res.status(403).json({ success: false, error: "No tenés acceso a este pago" });
    return null;
  }
  return liq;
}

transactionsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const liq = await cargar(req, res);
    if (!liq) return;
    return res.json({
      id: liq.id,
      estado: liq.status,
      monto: liq.amount.toFixed(2),
      metodo: liq.method,
      reserva: liq.items.map((i) => i.payment.booking).find(Boolean) ?? null,
      filas: liq.items.map((i) => ({ id: i.payment.id, name: i.payment.name })),
    });
  } catch (error) {
    console.error("Get transaction error:", error);
    return res.status(500).json({ success: false, error: "Error al leer el pago" });
  }
});

transactionsRouter.post("/:id/sync", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const liq = await cargar(req, res);
    if (!liq) return;
    if (liq.method !== "MercadoPago") {
      return res.status(400).json({ success: false, error: "Este pago no es de Mercado Pago" });
    }
    let aplicado;
    try {
      aplicado = await syncPayment(liq.id);
    } catch (error) {
      logger.error(error, "Sincronización de liquidación falló", { metadata: { liquidacion_id: liq.id } });
      return res.status(502).json({ success: false, error: "No pudimos consultar Mercado Pago" });
    }
    const actual = await prisma.paymentTransaction.findUnique({ where: { id: liq.id }, select: { status: true } });
    return res.json({ sincronizado: aplicado !== null, estado: actual?.status });
  } catch (error) {
    console.error("Sync transaction error:", error);
    return res.status(500).json({ success: false, error: "Error al sincronizar el pago" });
  }
});
