import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";
import { findOrCreateFeeForPlace } from "../lib/fee";

export const schedulesRouter = Router();

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM 24h

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

/** Prisma guarda TIME como DateTime; usamos una fecha fija y solo importa la hora. */
function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00Z`);
}

/**
 * True si el turno [start, end) se superpone con otro del mismo espacio y día.
 * Dos intervalos se pisan si uno empieza antes de que el otro termine y viceversa
 * (start < otroEnd && end > otroStart). `exceptId` excluye el turno que se edita.
 */
async function haySolapamiento(
  place_id: number,
  day_of_week: number,
  start: Date,
  end: Date,
  exceptId?: number,
): Promise<boolean> {
  const choque = await prisma.schedule.findFirst({
    where: {
      place_id,
      day_of_week,
      ...(exceptId !== undefined && { id: { not: exceptId } }),
      start_time: { lt: end },
      end_time: { gt: start },
    },
    select: { id: true },
  });
  return choque !== null;
}


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

      const start = toTime(start_time);
      const end = toTime(end_time);
      if (await haySolapamiento(place_id, day_of_week, start, end)) {
        return res.status(409).json({
          success: false,
          error: "El turno se superpone con otro del mismo espacio y día",
        });
      }

      const schedule = await prisma.schedule.create({
        data: {
          place_id,
          fee_id: await findOrCreateFeeForPlace(amount, place_id),
          day_of_week,
          start_time: start,
          end_time: end,
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

      // El turno actual: hace falta para el espacio (tarifa) y para chequear
      // solapamiento con los valores efectivos (los nuevos si vienen, los
      // actuales si no).
      const actual = await prisma.schedule.findUnique({
        where: { id },
        select: { place_id: true, day_of_week: true, start_time: true, end_time: true },
      });
      if (!actual) {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }

      const effDay = day_of_week ?? actual.day_of_week;
      const effStart = start_time !== undefined ? toTime(start_time) : actual.start_time;
      const effEnd = end_time !== undefined ? toTime(end_time) : actual.end_time;

      if (effStart >= effEnd) {
        return res.status(400).json({
          success: false,
          error: "La hora de fin debe ser posterior a la de inicio",
        });
      }
      // Solo revalidar solapamiento si cambió el día o alguna hora.
      if (day_of_week !== undefined || start_time !== undefined || end_time !== undefined) {
        if (await haySolapamiento(actual.place_id, effDay, effStart, effEnd, id)) {
          return res.status(409).json({
            success: false,
            error: "El turno se superpone con otro del mismo espacio y día",
          });
        }
      }

      const feeId =
        amount !== undefined ? await findOrCreateFeeForPlace(amount, actual.place_id) : undefined;

      const schedule = await prisma.schedule.update({
        where: { id },
        data: {
          ...(feeId !== undefined && { fee_id: feeId }),
          ...(day_of_week !== undefined && { day_of_week }),
          ...(start_time !== undefined && { start_time: effStart }),
          ...(end_time !== undefined && { end_time: effEnd }),
        },
        include: { fee: true },
      });

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
