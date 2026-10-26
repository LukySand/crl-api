import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAdmin, requireAuth } from "../lib/auth";
import { parseDate, timeToHHMM, todayInClub } from "../lib/booking-date";
import { bloqueaTurno, bloqueoCreateSchema } from "../lib/schedule-block";
import { normalizarBloqueo } from "../lib/schedule-block-db";

export const blocksRouter = Router();

// Bloquear un espacio es una decisión de gestión; el socio sólo ve el efecto
// (el turno aparece cerrado, con el motivo) a través de /api/bookings/availability.
blocksRouter.use(requireAuth, requireAdmin);

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((issue) => {
    const field = issue.path[0]?.toString() ?? "_form";
    if (!errors[field]) errors[field] = issue.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

const include = { place: { select: { id: true, name: true } } } as const;

function serialize(b: Parameters<typeof normalizarBloqueo>[0] & { place_id: number; place: { id: number; name: string } }) {
  const n = normalizarBloqueo(b);
  return {
    id: n.id,
    place: b.place,
    date_from: n.date_from,
    date_to: n.date_to,
    start_time: n.start_time,
    end_time: n.end_time,
    reason: n.reason,
  };
}

/**
 * GET /api/blocks?place_id= — los bloqueos vigentes (los que todavía no
 * terminaron), del más próximo al más lejano. Los vencidos no se listan: ya no
 * cierran nada.
 */
blocksRouter.get("/", async (req: Request, res: Response) => {
  try {
    const placeId = req.query.place_id !== undefined ? Number(req.query.place_id) : undefined;
    if (placeId !== undefined && !Number.isInteger(placeId)) {
      return res.status(400).json({ success: false, error: "place_id inválido" });
    }
    const filas = await prisma.scheduleBlock.findMany({
      where: {
        date_to: { gte: parseDate(todayInClub()) },
        ...(placeId !== undefined && { place_id: placeId }),
      },
      include,
      orderBy: [{ date_from: "asc" }, { id: "asc" }],
    });
    return res.json({ success: true, blocks: filas.map(serialize) });
  } catch (error) {
    console.error("List blocks error:", error);
    return res.status(500).json({ success: false, error: "Error al listar los bloqueos" });
  }
});

/**
 * POST /api/blocks — bloquea un espacio.
 *
 * Si ya hay reservas vivas en lo que se quiere cerrar, no se bloquea: responde 409
 * con la lista, y la gestión decide qué hacer con cada una (cancelarla por la vía
 * de siempre, que además se ocupa de su cobro). Cancelarlas en silencio desde acá
 * dejaría socios sin turno sin que nadie les avise ni les devuelva lo pagado.
 */
blocksRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = bloqueoCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);

    const { place_id, from, reason } = parsed.data;
    const to = parsed.data.to ?? from;
    const { start_time, end_time } = parsed.data;

    if (from < todayInClub()) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: { from: "No se puede bloquear una fecha pasada" },
      });
    }

    const place = await prisma.place.findUnique({ where: { id: place_id }, select: { id: true } });
    if (!place) {
      return res.status(404).json({ success: false, error: "El espacio no existe" });
    }

    const reservas = await prisma.booking.findMany({
      where: {
        active: true,
        date: { gte: parseDate(from), lte: parseDate(to) },
        schedule: { place_id },
      },
      select: {
        id: true,
        date: true,
        user: { select: { name: true, last_name: true } },
        schedule: { select: { start_time: true, end_time: true } },
      },
      orderBy: { date: "asc" },
    });

    const candidato = {
      date_from: from,
      date_to: to,
      start_time: start_time ?? null,
      end_time: end_time ?? null,
    };
    const conflictos = reservas
      .map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        start_time: timeToHHMM(r.schedule.start_time),
        end_time: timeToHHMM(r.schedule.end_time),
        socio: r.user ? `${r.user.name} ${r.user.last_name}` : null,
      }))
      .filter((r) => bloqueaTurno(candidato, r.date, { start: r.start_time, end: r.end_time }));

    if (conflictos.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Hay ${conflictos.length} ${conflictos.length === 1 ? "reserva" : "reservas"} en ese rango. Cancelalas antes de bloquear.`,
        conflictos,
      });
    }

    const creado = await prisma.scheduleBlock.create({
      data: {
        place_id,
        date_from: parseDate(from),
        date_to: parseDate(to),
        start_time: start_time ? new Date(`1970-01-01T${start_time}:00Z`) : null,
        end_time: end_time ? new Date(`1970-01-01T${end_time}:00Z`) : null,
        reason,
        created_by: req.user!.id,
      },
      include,
    });
    return res.status(201).json({ success: true, block: serialize(creado) });
  } catch (error) {
    console.error("Create block error:", error);
    return res.status(500).json({ success: false, error: "Error al crear el bloqueo" });
  }
});

/** DELETE /api/blocks/:id — levanta el bloqueo: el espacio vuelve a poder reservarse. */
blocksRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    await prisma.scheduleBlock.delete({ where: { id } });
    return res.json({ success: true });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return res.status(404).json({ success: false, error: "Bloqueo no encontrado" });
    }
    console.error("Delete block error:", error);
    return res.status(500).json({ success: false, error: "Error al levantar el bloqueo" });
  }
});
