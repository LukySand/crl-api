import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin, readToken } from "../lib/auth";
import { esGestion } from "../lib/roles";
import { nowTimeInClub, parseDate, timeToHHMM, todayInClub } from "../lib/booking-date";
import { normalizarBloqueo } from "../lib/schedule-block-db";
import { calcularOcupacion } from "../lib/occupancy";

export const placesRouter = Router();

// ponytail: schemas acá y no en lib/validation.ts — ese archivo está duplicado con
// el front y solo tiene sentido sincronizar lo que ambos usan. Cuando el front
// tenga formulario de espacios, mover los campos compartidos allá.
const placeSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(255),
  address: z.string().max(170).optional(),
  capacity: z.number().int().positive().max(32767).optional(),
  description: z.string().optional(),
  file_id: z.string().optional(),
});

const placeUpdateSchema = placeSchema.partial();

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

/**
 * GET /api/places — lista de espacios. Público: el visitante ve qué hay.
 *
 * Por defecto sólo los activos. Con `?all=true` vienen también los dados de baja,
 * para que la gestión pueda verlos y reactivarlos — pero sólo si es admin: si no,
 * el socio vería en la app espacios que no puede reservar.
 */
placesRouter.get("/", async (req: Request, res: Response) => {
  try {
    // La ruta es pública, así que no pasa por requireAuth y req.user está vacío:
    // el token se lee a mano para saber si hay una sesión de gestión detrás.
    const sesion = readToken(req);
    const esAdmin = !!sesion && esGestion(sesion.roles);
    const verTodos = req.query.all === "true" && esAdmin;

    const places = await prisma.place.findMany({
      where: verTodos ? undefined : { active: true },
      orderBy: { name: "asc" },
    });
    return res.json({ success: true, places });
  } catch (error) {
    console.error("List places error:", error);
    return res.status(500).json({ success: false, error: "Error al listar espacios" });
  }
});

/**
 * GET /api/places/occupancy?date=YYYY-MM-DD — ocupación de cada espacio en un
 * día (hoy si no viene `date`), para la gestión (#44).
 *
 * Por espacio: cuántos turnos hay, cuántos están reservados, tomados por una
 * clase o cerrados por un bloqueo, y el detalle de cada turno (con quién
 * reservó: la ruta es sólo de gestión). Si el día es hoy, además el turno en
 * curso. La cuenta vive en `lib/occupancy.ts`.
 *
 * Pocas consultas para todos los espacios, no una por espacio: la pantalla de
 * Espacios la repite cada 15 s y un N+1 acá se nota.
 *
 * Va antes de "/:id" a propósito: Express matchea por orden y si no tomaría
 * "occupancy" como un id — mismo caso que /api/bookings/availability.
 *
 * ponytail: esta ruta ya había existido (commit ab1d896) y se perdió en un merge;
 * el front la siguió llamando y caía en "/:id" → 400.
 */
placesRouter.get("/occupancy", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const hoy = todayInClub();
    const { date } = req.query;
    if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      return res.status(400).json({ success: false, error: "La fecha debe ser YYYY-MM-DD" });
    }
    const fecha = (date as string | undefined) ?? hoy;
    const dia = parseDate(fecha);
    if (Number.isNaN(dia.getTime())) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }
    const dayOfWeek = dia.getUTCDay();
    const ahora = fecha === hoy ? nowTimeInClub() : null;

    const [turnos, reservas, clases, bloqueos] = await Promise.all([
      prisma.schedule.findMany({
        where: { day_of_week: dayOfWeek },
        select: { id: true, place_id: true, start_time: true, end_time: true },
      }),
      prisma.booking.findMany({
        // active: true deja afuera las canceladas, que liberan el turno.
        where: { date: dia, active: true },
        select: {
          id: true,
          schedule_id: true,
          status: true,
          user: { select: { name: true, last_name: true } },
        },
      }),
      prisma.disciplineSchedule.findMany({
        where: { day_of_week: dayOfWeek, discipline: { active: true, place_id: { not: null } } },
        select: {
          start_time: true,
          end_time: true,
          discipline: { select: { name: true, place_id: true } },
        },
      }),
      prisma.scheduleBlock.findMany({
        where: { date_from: { lte: dia }, date_to: { gte: dia } },
        orderBy: { id: "asc" },
      }),
    ]);

    const occupancy = calcularOcupacion(fecha, ahora, {
      turnos: turnos.map((t) => ({
        id: t.id,
        place_id: t.place_id,
        start: timeToHHMM(t.start_time),
        end: timeToHHMM(t.end_time),
      })),
      reservas: reservas.map((r) => ({
        id: r.id,
        schedule_id: r.schedule_id,
        status: r.status,
        socio: `${r.user.name} ${r.user.last_name}`,
      })),
      clases: clases.map((c) => ({
        place_id: c.discipline.place_id!,
        disciplina: c.discipline.name,
        start: timeToHHMM(c.start_time),
        end: timeToHHMM(c.end_time),
      })),
      bloqueos: bloqueos.map((b) => ({ ...normalizarBloqueo(b), place_id: b.place_id })),
    });

    return res.json({ success: true, date: fecha, now: ahora, occupancy });
  } catch (error) {
    console.error("Occupancy error:", error);
    return res.status(500).json({ success: false, error: "Error al calcular la ocupación" });
  }
});

/** GET /api/places/:id — un espacio con sus horarios y tarifas. */
placesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }

    const place = await prisma.place.findUnique({
      where: { id },
      include: {
        schedules: { include: { fee: true }, orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }] },
      },
    });

    if (!place) {
      return res.status(404).json({ success: false, error: "Espacio no encontrado" });
    }
    return res.json({ success: true, place });
  } catch (error) {
    console.error("Get place error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener el espacio" });
  }
});

/** POST /api/places — crea un espacio. Solo Administrador. */
placesRouter.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = placeSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const place = await prisma.place.create({ data: parsed.data });
      return res.status(201).json({ success: true, place });
    } catch (error: any) {
      if (error?.code === "P2003") {
        return res.status(400).json({ success: false, error: "El archivo indicado no existe" });
      }
      console.error("Create place error:", error);
      return res.status(500).json({ success: false, error: "Error al crear el espacio" });
    }
  },
);

/** PATCH /api/places/:id — edita un espacio. Solo Administrador. */
placesRouter.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      const parsed = placeUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const place = await prisma.place.update({ where: { id }, data: parsed.data });
      return res.json({ success: true, place });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Espacio no encontrado" });
      }
      console.error("Update place error:", error);
      return res.status(500).json({ success: false, error: "Error al actualizar el espacio" });
    }
  },
);

/**
 * DELETE /api/places/:id — baja lógica (active=false). Solo gestión.
 *
 * No se borra la fila: un espacio borrado orfanaría los horarios y, con ellos, el
 * historial de reservas que apunta a cada turno. Desactivado deja de aparecer para
 * reservar pero las reservas viejas siguen siendo legibles.
 *
 * Devuelve `reservas_futuras` para que el front pueda avisar a quién afecta antes
 * de confirmar — la baja no las cancela ni las bloquea.
 */
placesRouter.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      const place = await prisma.place.update({
        where: { id },
        data: { active: false },
      });

      const reservas_futuras = await prisma.booking.count({
        where: {
          active: true,
          date: { gte: parseDate(todayInClub()) },
          schedule: { place_id: id },
        },
      });

      return res.json({ success: true, place, reservas_futuras });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Espacio no encontrado" });
      }
      console.error("Deactivate place error:", error);
      return res.status(500).json({ success: false, error: "Error al dar de baja el espacio" });
    }
  },
);

/** PATCH /api/places/:id/reactivate — vuelve a habilitar un espacio. Solo gestión. */
placesRouter.patch(
  "/:id/reactivate",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      const place = await prisma.place.update({
        where: { id },
        data: { active: true },
      });
      return res.json({ success: true, place });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Espacio no encontrado" });
      }
      console.error("Reactivate place error:", error);
      return res.status(500).json({ success: false, error: "Error al reactivar el espacio" });
    }
  },
);
