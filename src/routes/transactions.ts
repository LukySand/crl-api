/**
 * Liquidaciones (`/api/transactions`). B5: lectura para la pantalla de retorno de MP y
 * sincronización a demanda. Lo lee quien pagó, el deudor de alguna fila o la gestión.
 */
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma";
import { isAdmin, requireAuth } from "../lib/auth";
import { syncPayment } from "../lib/payment-sync";
import { logger } from "../lib/logger";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

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
