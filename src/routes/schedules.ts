import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";
import { findOrCreateFeeForPlace } from "../lib/fee";
import { TIME, toTime } from "../lib/time";

export const schedulesRouter = Router();

// El precio del turno se manda como monto, no como fee_id: quien carga horarios
// piensa en "la hora sale $12.000", no en elegir una fila de tarifas. La tarifa la
// resuelve findOrCreateFee.
const amountSchema = z.coerce
  .number()
  .positive("El precio debe ser mayor a cero")
  .max(99_999_999.99, "El precio es demasiado grande");

const scheduleSchema = z
  .object({
    place_id: z.number().int().positive(),
    amount: amountSchema,
    day_of_week: z.number().int().min(0, "0=domingo").max(6, "6=sábado"),
    start_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)"),
    end_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)"),
  })
  .refine((s) => s.start_time < s.end_time, {
    message: "La hora de fin debe ser posterior a la de inicio",
    path: ["end_time"],
  });

const scheduleUpdateSchema = z.object({
  amount: amountSchema.optional(),
  day_of_week: z.number().int().min(0).max(6).optional(),
  start_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)").optional(),
  end_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)").optional(),
});

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

/** GET /api/schedules?place_id=1 — horarios, opcionalmente filtrados por espacio. */
schedulesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const placeId = req.query.place_id ? Number(req.query.place_id) : undefined;
    if (placeId !== undefined && !Number.isInteger(placeId)) {
      return res.status(400).json({ success: false, error: "place_id inválido" });
    }

    const schedules = await prisma.schedule.findMany({
      where: placeId ? { place_id: placeId } : undefined,
      include: { fee: true, place: true },
      orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
    });
    return res.json({ success: true, schedules });
  } catch (error) {
    console.error("List schedules error:", error);
    return res.status(500).json({ success: false, error: "Error al listar horarios" });
  }
});

/** GET /api/schedules/:id */
schedulesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id },
      include: { fee: true, place: true },
    });
    if (!schedule) {
      return res.status(404).json({ success: false, error: "Horario no encontrado" });
    }
    return res.json({ success: true, schedule });
  } catch (error) {
    console.error("Get schedule error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener el horario" });
  }
});

/** POST /api/schedules — crea un turno para un espacio. Solo Administrador. */
schedulesRouter.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = scheduleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const { place_id, amount, day_of_week, start_time, end_time } = parsed.data;

      const schedule = await prisma.schedule.create({
        data: {
          place_id,
          fee_id: await findOrCreateFeeForPlace(amount, place_id),
          day_of_week,
          start_time: toTime(start_time),
          end_time: toTime(end_time),
        },
        include: { fee: true },
      });
      return res.status(201).json({ success: true, schedule });
    } catch (error: any) {
      if (error?.code === "P2002") {
        return res.status(409).json({
          success: false,
          error: "Ya existe un turno para ese espacio, día y hora de inicio",
        });
      }
      if (error?.code === "P2003") {
        return res
          .status(400)
          .json({ success: false, error: "El espacio o la tarifa no existen" });
      }
      console.error("Create schedule error:", error);
      return res.status(500).json({ success: false, error: "Error al crear el horario" });
    }
  },
);

/**
 * PATCH /api/schedules/:id — Solo Administrador.
 *
 * Cambiar `amount` repunta el turno a otra tarifa (reusada o nueva). Las reservas
 * ya hechas guardan su propio fee_id, así que conservan el precio que se les cobró.
 */
schedulesRouter.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      const parsed = scheduleUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const { amount, day_of_week, start_time, end_time } = parsed.data;

      // La tarifa se resuelve dentro del espacio del turno, así que hace falta
      // saber a qué espacio pertenece antes de tocar el precio.
      let feeId: number | undefined;
      if (amount !== undefined) {
        const actual = await prisma.schedule.findUnique({
          where: { id },
          select: { place_id: true },
        });
        if (!actual) {
          return res.status(404).json({ success: false, error: "Horario no encontrado" });
        }
        feeId = await findOrCreateFeeForPlace(amount, actual.place_id);
      }

      const schedule = await prisma.schedule.update({
        where: { id },
        data: {
          ...(feeId !== undefined && { fee_id: feeId }),
          ...(day_of_week !== undefined && { day_of_week }),
          ...(start_time !== undefined && { start_time: toTime(start_time) }),
          ...(end_time !== undefined && { end_time: toTime(end_time) }),
        },
        include: { fee: true },
      });

      if (schedule.start_time >= schedule.end_time) {
        return res.status(400).json({
          success: false,
          error: "La hora de fin debe ser posterior a la de inicio",
        });
      }
      return res.json({ success: true, schedule });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }
      if (error?.code === "P2002") {
        return res.status(409).json({
          success: false,
          error: "Ya existe un turno para ese espacio, día y hora de inicio",
        });
      }
      console.error("Update schedule error:", error);
      return res.status(500).json({ success: false, error: "Error al actualizar el horario" });
    }
  },
);

/** DELETE /api/schedules/:id — Solo Administrador. Falla si tiene reservas. */
schedulesRouter.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      await prisma.schedule.delete({ where: { id } });
      return res.json({ success: true, message: "Horario eliminado" });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }
      if (error?.code === "P2003") {
        return res.status(409).json({
          success: false,
          error: "No se puede eliminar: el horario tiene reservas asociadas",
        });
      }
      console.error("Delete schedule error:", error);
      return res.status(500).json({ success: false, error: "Error al eliminar el horario" });
    }
  },
);
