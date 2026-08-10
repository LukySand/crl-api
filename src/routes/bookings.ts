import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import { parseDate, todayUTC, matchesDayOfWeek } from "../lib/booking-date";

export const bookingsRouter = Router();

// Todo lo de acá exige sesión: no se reserva sin estar logueado.
bookingsRouter.use(requireAuth);

const createSchema = z.object({
  schedule_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD"),
  notes: z.string().max(1000).optional(),
});

const updateSchema = z.object({
  notes: z.string().max(1000).optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
});

const isAdmin = (req: Request) => req.user?.role === "Administrador";

/**
 * GET /api/bookings — reservas. El Administrador ve todas; el resto, las propias.
 * Filtros: ?status=Confirmada  ?place_id=1
 */
bookingsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { status, place_id } = req.query;

    const placeId = place_id ? Number(place_id) : undefined;
    if (placeId !== undefined && !Number.isInteger(placeId)) {
      return res.status(400).json({ success: false, error: "place_id inválido" });
    }

    const bookings = await prisma.booking.findMany({
      where: {
        // Sale del token, nunca de la query: nadie mira las reservas de otro
        ...(isAdmin(req) ? {} : { user_id: req.user!.id }),
        ...(typeof status === "string" && { status: status as any }),
        ...(placeId !== undefined && { schedule: { place_id: placeId } }),
      },
      include: { schedule: { include: { place: true } }, fee: true },
      orderBy: [{ date: "desc" }],
    });

    return res.json({ success: true, bookings });
  } catch (error) {
    console.error("List bookings error:", error);
    return res.status(500).json({ success: false, error: "Error al listar reservas" });
  }
});

/** GET /api/bookings/:id — propia, o cualquiera si es Administrador. */
bookingsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { schedule: { include: { place: true } }, fee: true },
    });

    if (!booking) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (!isAdmin(req) && booking.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error("Get booking error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener la reserva" });
  }
});

/** POST /api/bookings — reserva un turno para una fecha. El socio sale del token. */
bookingsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      parsed.error.issues.forEach((e) => {
        errors[e.path[0] as string] = e.message;
      });
      return res.status(400).json({ success: false, error: "Validación fallida", errors });
    }

    const { schedule_id, date, notes } = parsed.data;
    const when = parseDate(date);

    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }
    if (when < todayUTC()) {
      return res.status(400).json({ success: false, error: "No se puede reservar una fecha pasada" });
    }

    const schedule = await prisma.schedule.findUnique({ where: { id: schedule_id } });
    if (!schedule) {
      return res.status(404).json({ success: false, error: "El horario no existe" });
    }

    // El schema no puede validar esto: la fecha tiene que caer en el día de semana del turno
    if (!matchesDayOfWeek(when, schedule.day_of_week)) {
      const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      return res.status(400).json({
        success: false,
        error: `Ese turno es los ${dias[schedule.day_of_week]}, y la fecha elegida es ${dias[when.getUTCDay()]}`,
      });
    }

    const booking = await prisma.booking.create({
      data: {
        schedule_id,
        // Snapshot de la tarifa vigente. Sale del schedule, no del cliente:
        // si no, cualquiera reservaría el salón a precio de cancha.
        fee_id: schedule.fee_id,
        user_id: req.user!.id,
        date: when,
        notes,
        active: true,
      },
      include: { schedule: { include: { place: true } }, fee: true },
    });

    return res.status(201).json({ success: true, booking });
  } catch (error: any) {
    // La unique constraint (schedule_id, date, active) es la que evita la doble reserva
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "Ese turno ya está reservado" });
    }
    console.error("Create booking error:", error);
    return res.status(500).json({ success: false, error: "Error al crear la reserva" });
  }
});

/**
 * PATCH /api/bookings/:id — el dueño edita sus notas; el Administrador confirma.
 * Cancelar no se hace acá, va por DELETE.
 */
bookingsRouter.patch("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      parsed.error.issues.forEach((e) => {
        errors[e.path[0] as string] = e.message;
      });
      return res.status(400).json({ success: false, error: "Validación fallida", errors });
    }

    const existing = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }
    if (existing.status === "Cancelada") {
      return res.status(409).json({ success: false, error: "La reserva está cancelada" });
    }

    const { notes, status } = parsed.data;
    if (status && !isAdmin(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Solo un administrador puede cambiar el estado" });
    }

    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data: {
        ...(notes !== undefined && { notes }),
        ...(status !== undefined && { status }),
      },
      include: { schedule: { include: { place: true } }, fee: true },
    });

    return res.json({ success: true, booking });
  } catch (error) {
    console.error("Update booking error:", error);
    return res.status(500).json({ success: false, error: "Error al actualizar la reserva" });
  }
});

/**
 * DELETE /api/bookings/:id — cancela (no borra). status = Cancelada y active = null
 * en el mismo update: el NULL saca la fila de la unique constraint y libera el turno,
 * pero la reserva queda para el historial.
 */
bookingsRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const existing = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }
    if (existing.status === "Cancelada") {
      return res.status(409).json({ success: false, error: "La reserva ya estaba cancelada" });
    }

    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: "Cancelada", active: null },
    });

    return res.json({ success: true, message: "Reserva cancelada", booking });
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res.status(500).json({ success: false, error: "Error al cancelar la reserva" });
  }
});
