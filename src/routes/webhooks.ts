import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma";
import { verifySignature, getPayment, MercadoPagoError } from "../lib/mercadopago";
import { aplicarPagoMP, devolverDuplicados, LIQ_SELECT } from "../lib/payment-sync";
import { logger } from "../lib/logger";

export const webhooksRouter = Router();

/**
 * Notificaciones de Mercado Pago. Única ruta pública que escribe en la base: no lleva
 * `requireAuth`, autentica por firma HMAC. Reglas: firma primero; el monto y el estado se
 * releen de `GET /v1/payments/{id}` (el body es input de internet); responder 200 salvo
 * fallo propio (500 = MP reintenta); idempotente y tolerante al desorden (`aplicarPagoMP`).
 */
webhooksRouter.post("/mercadopago", async (req: Request, res: Response) => {
  try {
    const type = (req.query.type ?? req.query.topic ?? req.body?.type) as string | undefined;

    // El id del manifest sale SÓLO de la query (es lo que MP firmó); el de lectura, de cualquier lado.
    const firmaDataId = String(req.query["data.id"] ?? "");
    const dataId = firmaDataId || String(req.body?.data?.id ?? req.query.id ?? "");
    const xSignature = req.header("x-signature") ?? "";
    const xRequestId = req.header("x-request-id") ?? "";

    if (!verifySignature(xSignature, xRequestId, firmaDataId, process.env.MP_WEBHOOK_SECRET ?? "")) {
      console.warn("Webhook con firma inválida", { xRequestId, dataId });
      return res.status(401).json({ error: "Firma inválida" });
    }
    if (type !== "payment") return res.status(200).json({ ok: true, ignored: type ?? "sin-tipo" });
    if (!dataId) return res.status(200).json({ ok: true, ignored: "sin-data-id" });

    const mp = await getPayment(dataId);

    // `external_reference` es el id de nuestra liquidación; `mp_payment_id` cubre las
    // notificaciones siguientes del mismo pago.
    const externalReference = mp?.external_reference ? String(mp.external_reference) : null;
    const liq = await prisma.paymentTransaction.findFirst({
      where: {
        OR: [
          ...(externalReference ? [{ id: externalReference }] : []),
          { mp_payment_id: String(mp?.id ?? dataId) },
        ],
      },
      select: LIQ_SELECT,
    });
    if (!liq) {
      console.warn("Webhook de un pago desconocido", { dataId, externalReference });
      return res.status(200).json({ ok: true, unknown: true });
    }

    const aplicado = await aplicarPagoMP(mp, liq);
    // Con cualquier notificación de la preferencia se devuelven los otros pagos aprobados: la del
    // duplicado puede no llegar nunca. Si falla, 500 y MP reintenta.
    await devolverDuplicados(liq.id, String(mp?.id ?? dataId));
    if (aplicado === null) return res.status(200).json({ ok: true, stale: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    // Un 404 de MP no se arregla reintentando.
    if (error instanceof MercadoPagoError && error.status === 404) {
      return res.status(200).json({ ok: true, ignored: "pago-inexistente" });
    }
    logger.error(error, "Webhook Mercado Pago falló");
    return res.status(500).json({ error: "Error al procesar la notificación" });
  }
});
