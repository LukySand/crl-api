// ponytail: sin PATCH ni DELETE a propósito. Fee es inmutable: cambiar un precio =
// crear una tarifa nueva y repuntar Schedule.fee_id. Así las reservas viejas (que
// guardan su propio fee_id) conservan para siempre el precio que se les cobró.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireRole } from "../lib/auth";

export const feesRouter = Router();

const feeSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(255),
  amount: z.coerce
    .number()
    .positive("El monto debe ser mayor a cero")
    .max(99_999_999.99, "El monto es demasiado grande"),
  description: z.string().optional(),
});

/** GET /api/fees — lista de tarifas (histórico incluido, las viejas siguen existiendo). */
feesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const fees = await prisma.fee.findMany({ orderBy: { created_at: "desc" } });
    return res.json({ success: true, fees });
  } catch (error) {
    console.error("List fees error:", error);
    return res.status(500).json({ success: false, error: "Error al listar tarifas" });
  }
});

/** GET /api/fees/:id */
feesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }

    const fee = await prisma.fee.findUnique({ where: { id } });
    if (!fee) {
      return res.status(404).json({ success: false, error: "Tarifa no encontrada" });
    }
    return res.json({ success: true, fee });
  } catch (error) {
    console.error("Get fee error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener la tarifa" });
  }
});

/** POST /api/fees — crea una tarifa. Solo Administrador. */
feesRouter.post(
  "/",
  requireAuth,
  requireRole("Administrador"),
  async (req: Request, res: Response) => {
    try {
      const parsed = feeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        parsed.error.issues.forEach((e) => {
          errors[e.path[0] as string] = e.message;
        });
        return res
          .status(400)
          .json({ success: false, error: "Validación fallida", errors });
      }

      const fee = await prisma.fee.create({ data: parsed.data });
      return res.status(201).json({ success: true, fee });
    } catch (error) {
      console.error("Create fee error:", error);
      return res.status(500).json({ success: false, error: "Error al crear la tarifa" });
    }
  },
);
