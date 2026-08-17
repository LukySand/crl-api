import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin, readToken, ADMIN_ROLES } from "../lib/auth";
import { parseDate, todayInClub, nowTimeInClub, timeToHHMM } from "../lib/booking-date";

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
    const esAdmin = !!sesion && (ADMIN_ROLES as readonly string[]).includes(sesion.role);
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
 * GET /api/places/occupancy — ocupación de hoy de cada espacio, para la gestión.
 *
 * Por espacio devuelve los turnos de hoy, cuántos están reservados y si en este
 * momento hay uno en curso ocupado. "Hoy" y "ahora" salen del huso del club, no
 * del server (ver lib/booking-date.ts).
 *
 * Dos consultas para todos los espacios, no una por espacio: la pantalla de
 * gestión la repite cada 15s y un N+1 acá se nota.
 *
 * Va antes de "/:id" a propósito: Express matchea por orden y si no tomaría
 * "occupancy" como un id — mismo caso que /api/bookings/availability.
 */
placesRouter.get(
  "/occupancy",
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const date = todayInClub();
      const now = nowTimeInClub();
      const dayOfWeek = parseDate(date).getUTCDay();

      const [schedules, bookings] = await Promise.all([
        prisma.schedule.findMany({
          where: { day_of_week: dayOfWeek },
          select: { id: true, place_id: true, start_time: true, end_time: true },
          orderBy: { start_time: "asc" },
        }),
        prisma.booking.findMany({
          // active: true deja afuera las canceladas, que liberan el turno
          where: { date: parseDate(date), active: true },
          select: { schedule_id: true },
        }),
      ]);

      const reservados = new Set(bookings.map((b) => b.schedule_id));

      const porEspacio = new Map<
        number,
        {
          place_id: number;
          total: number;
          reservados: number;
          ocupado_ahora: boolean;
          turno_actual: { start: string; end: string; reservado: boolean } | null;
        }
      >();

      for (const s of schedules) {
        const start = timeToHHMM(s.start_time);
        const end = timeToHHMM(s.end_time);
        const reservado = reservados.has(s.id);

        const fila =
          porEspacio.get(s.place_id) ??
          {
            place_id: s.place_id,
            total: 0,
            reservados: 0,
            ocupado_ahora: false,
            turno_actual: null,
          };

        fila.total += 1;
        if (reservado) fila.reservados += 1;

        // "HH:MM" con cero adelante compara bien como string, no hace falta parsear.
        if (start <= now && now < end) {
          fila.turno_actual = { start, end, reservado };
          fila.ocupado_ahora = reservado;
        }

        porEspacio.set(s.place_id, fila);
      }

      return res.json({
        success: true,
        date,
        now,
        occupancy: [...porEspacio.values()],
      });
    } catch (error) {
      console.error("Occupancy error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al calcular la ocupación" });
    }
  },
);

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
