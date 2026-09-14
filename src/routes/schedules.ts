import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Prisma } from "../../prisma/generated/client";
import { requireAuth, requireAdmin } from "../lib/auth";
import { findOrCreateFeeForPlace } from "../lib/fee";
import { TIME, toTime, overlaps } from "../lib/time";

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

/** Marcadores de control para el catch — no son errores reales, son resultados esperados de la transacción. */
class SuperposicionError extends Error {}
class NoEncontradoError extends Error {}
class RangoInvalidoError extends Error {}

/**
 * ¿Hay algún turno del mismo espacio y día que se pise con [start,end)?
 *
 * El unique (place_id, day_of_week, start_time) sólo bloquea el duplicado exacto:
 * 19:00–20:30 y 19:15–20:00 pasan las dos. Esto se valida en código porque MySQL
 * no tiene exclusion constraints. `excludeId` es para el update: no comparar el
 * turno contra sí mismo.
 */
async function hayTurnoSuperpuesto(
  tx: Prisma.TransactionClient,
  place_id: number,
  day_of_week: number,
  start: Date,
  end: Date,
  excludeId?: number,
): Promise<boolean> {
  const otros = await tx.schedule.findMany({
    where: {
      place_id,
      day_of_week,
      ...(excludeId !== undefined && { id: { not: excludeId } }),
    },
    select: { start_time: true, end_time: true },
  });
  return otros.some((o) => overlaps(start, end, o.start_time, o.end_time));
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

      // Transacción: leer los turnos del día + crear tiene que ser atómico, si no
      // dos POST superpuestos podrían leer "libre" los dos antes de que cualquiera
      // inserte (el unique no los frena porque sus horas de inicio son distintas).
      const schedule = await prisma.$transaction(async (tx) => {
        if (await hayTurnoSuperpuesto(tx, place_id, day_of_week, start, end)) {
          throw new SuperposicionError();
        }
        return tx.schedule.create({
          data: {
            place_id,
            fee_id: await findOrCreateFeeForPlace(amount, place_id),
            day_of_week,
            start_time: start,
            end_time: end,
          },
          include: { fee: true },
        });
      });
      return res.status(201).json({ success: true, schedule });
    } catch (error: any) {
      if (error instanceof SuperposicionError) {
        return res.status(409).json({
          success: false,
          error: "Ese turno se superpone con otro ya cargado para el mismo espacio y día",
        });
      }
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

      // Todo (leer el turno actual, chequear superposición, actualizar) va en una
      // sola transacción: si no, dos PATCH concurrentes podrían leer "libre" los
      // dos antes de que cualquiera escriba.
      const schedule = await prisma.$transaction(async (tx) => {
        const actual = await tx.schedule.findUnique({ where: { id } });
        if (!actual) throw new NoEncontradoError();

        const feeId =
          amount !== undefined
            ? await findOrCreateFeeForPlace(amount, actual.place_id)
            : undefined;

        // Día y horas resultantes: los que manda el PATCH, o si no los que ya tenía.
        const nuevoDia = day_of_week ?? actual.day_of_week;
        const nuevoInicio = start_time !== undefined ? toTime(start_time) : actual.start_time;
        const nuevoFin = end_time !== undefined ? toTime(end_time) : actual.end_time;

        if (nuevoInicio >= nuevoFin) {
          throw new RangoInvalidoError();
        }
        if (await hayTurnoSuperpuesto(tx, actual.place_id, nuevoDia, nuevoInicio, nuevoFin, id)) {
          throw new SuperposicionError();
        }

        return tx.schedule.update({
          where: { id },
          data: {
            ...(feeId !== undefined && { fee_id: feeId }),
            day_of_week: nuevoDia,
            start_time: nuevoInicio,
            end_time: nuevoFin,
          },
          include: { fee: true },
        });
      });

      return res.json({ success: true, schedule });
    } catch (error: any) {
      if (error instanceof NoEncontradoError || error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }
      if (error instanceof RangoInvalidoError) {
        return res.status(400).json({
          success: false,
          error: "La hora de fin debe ser posterior a la de inicio",
        });
      }
      if (error instanceof SuperposicionError) {
        return res.status(409).json({
          success: false,
          error: "Ese turno se superpone con otro ya cargado para el mismo espacio y día",
        });
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
