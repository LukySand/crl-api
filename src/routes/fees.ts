// ponytail: sin PATCH ni DELETE a propósito. Fee es inmutable: cambiar un precio =
// crear una tarifa nueva y repuntar Schedule.fee_id. Así las reservas viejas (que
// guardan su propio fee_id) conservan para siempre el precio que se les cobró.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";

export const feesRouter = Router();

/** Las cinco categorías del enum; sirve para validar el filtro del GET. */
const CATEGORIAS = ["Reserva", "CuotaSocio", "Disciplina", "Donacion", "Otro"] as const;

/**
 * Las que un admin puede elegir a mano. `Reserva` queda afuera a propósito: esas
 * las crea sola `findOrCreateFeeForPlace()` a partir del precio del turno, con
 * nombre derivado del espacio. Dejarla acá permitiría una tarifa `Reserva` que no
 * cuelga de ningún espacio, y la categoría dejaría de ser confiable para filtrar.
 */
const CATEGORIAS_MANUALES = ["CuotaSocio", "Disciplina", "Donacion", "Otro"] as const;

const feeSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(255),
  // nonnegative y no positive: una cuota puede arrancar en $0 (disciplina nueva
  // sin precio cargado todavía), igual que una reserva de cortesía en bookings.ts.
  amount: z.coerce
    .number()
    .nonnegative("El monto no puede ser negativo")
    .max(99_999_999.99, "El monto es demasiado grande"),
  category: z
    .enum(CATEGORIAS_MANUALES, {
      error: "Las tarifas de reserva se crean solas al cargar el precio de un turno",
    })
    .default("Otro"),
  description: z.string().optional(),
});

/**
 * GET /api/fees — lista de tarifas (histórico incluido, las viejas siguen existiendo).
 * `?category=CuotaSocio` filtra por tipo; sin el parámetro vienen todas.
 */
feesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { category } = req.query;
    if (category !== undefined && !CATEGORIAS.includes(category as never)) {
      return res.status(400).json({
        success: false,
        error: `Categoría inválida. Opciones: ${CATEGORIAS.join(", ")}`,
      });
    }

    const fees = await prisma.fee.findMany({
      where: category ? { category: category as (typeof CATEGORIAS)[number] } : undefined,
      orderBy: { created_at: "desc" },
    });
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
  requireAdmin,
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
