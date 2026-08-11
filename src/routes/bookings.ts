import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, isAdmin } from "../lib/auth";
import {
  parseDate,
  matchesDayOfWeek,
  todayInClub,
  nowTimeInClub,
  timeToHHMM,
  ultimaFechaReservable,
  DIAS_ADELANTE_SOCIO,
  DIAS_ADELANTE_ADMIN,
} from "../lib/booking-date";

export const bookingsRouter = Router();

// Todo lo de acá exige sesión: no se reserva sin estar logueado.
bookingsRouter.use(requireAuth);

/**
 * Lo que se devuelve de cada reserva.
 *
 * `user` va con select y no con `true`: el modelo User tiene `password`, y un
 * include plano la mandaría en cada respuesta. Sólo lo necesario para que la
 * gestión sepa de quién es la reserva.
 */
const bookingInclude = {
  schedule: { include: { place: true } },
  fee: true,
  user: {
    select: { id: true, name: true, last_name: true, dni: true, email: true, celular: true },
  },
} as const;

const createSchema = z.object({
  schedule_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD"),
  notes: z.string().max(1000).optional(),

  // Campos de gestión. Si los manda un socio se responde 403, no se ignoran en
  // silencio: mandarlos es un intento de reservar a nombre de otro o de fijarse
  // el precio, y eso tiene que fallar fuerte.
  user_id: z.uuid("user_id inválido").optional(),
  fee_id: z.number().int().positive().optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
});

const updateSchema = z.object({
  notes: z.string().max(1000).optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
});


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
      include: bookingInclude,
      orderBy: [{ date: "desc" }],
    });

    return res.json({ success: true, bookings });
  } catch (error) {
    console.error("List bookings error:", error);
    return res.status(500).json({ success: false, error: "Error al listar reservas" });
  }
});

/**
 * GET /api/bookings/availability?place_id=1&date=2026-08-17 — qué turnos están
 * tomados ese día. Devuelve sólo ids, sin datos de quién reservó: el socio
 * necesita saber qué está ocupado, no de quién es.
 *
 * Va antes de "/:id" a propósito: Express matchea por orden y si no, tomaría
 * "availability" como un id.
 */
bookingsRouter.get("/availability", async (req: Request, res: Response) => {
  try {
    const { place_id, date } = req.query;

    const placeId = Number(place_id);
    if (!Number.isInteger(placeId)) {
      return res.status(400).json({ success: false, error: "place_id inválido" });
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: "La fecha debe ser YYYY-MM-DD" });
    }

    const rows = await prisma.booking.findMany({
      // active: true deja afuera las canceladas (que quedan en null y liberan el turno)
      where: { date: parseDate(date), active: true, schedule: { place_id: placeId } },
      select: { schedule_id: true },
    });

    return res.json({ success: true, taken: rows.map((r) => r.schedule_id) });
  } catch (error) {
    console.error("Availability error:", error);
    return res.status(500).json({ success: false, error: "Error al consultar disponibilidad" });
  }
});

/** GET /api/bookings/:id — propia, o cualquiera si es Administrador. */
bookingsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingInclude,
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

/**
 * POST /api/bookings — reserva un turno para una fecha.
 *
 * El socio reserva para sí mismo, a la tarifa del turno y siempre en Pendiente.
 * La gestión puede además: reservar a nombre de otro (`user_id`), fijar una tarifa
 * distinta (`fee_id`) y dejarla ya paga (`status`). Los tres campos se rechazan
 * con 403 si los manda alguien sin rol de gestión.
 */
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
    const admin = isAdmin(req);
    const when = parseDate(date);

    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }

    // ── Campos de gestión ────────────────────────────────────────────────
    // Un socio que manda cualquiera de los tres recibe 403. No se ignoran en
    // silencio: es un intento de reservar por otro o de elegirse el precio.
    if (!admin) {
      if (parsed.data.user_id && parsed.data.user_id !== req.user!.id) {
        return res
          .status(403)
          .json({ success: false, error: "No podés reservar a nombre de otro socio" });
      }
      if (parsed.data.fee_id !== undefined) {
        return res
          .status(403)
          .json({ success: false, error: "No podés elegir la tarifa de la reserva" });
      }
      if (parsed.data.status !== undefined) {
        return res
          .status(403)
          .json({ success: false, error: "No podés fijar el estado de la reserva" });
      }
    }

    let userId = req.user!.id;
    if (admin && parsed.data.user_id) {
      const socio = await prisma.user.findUnique({
        where: { id: parsed.data.user_id },
        select: { id: true, active: true },
      });
      if (!socio) {
        return res.status(404).json({ success: false, error: "El socio indicado no existe" });
      }
      if (!socio.active) {
        return res
          .status(409)
          .json({ success: false, error: "El socio está dado de baja" });
      }
      userId = socio.id;
    }

    const hoy = todayInClub();
    if (date < hoy) {
      return res.status(400).json({ success: false, error: "No se puede reservar una fecha pasada" });
    }

    // Tope hacia adelante: 3 semanas para el socio, 6 meses para la gestión.
    const tope = ultimaFechaReservable(
      admin ? DIAS_ADELANTE_ADMIN : DIAS_ADELANTE_SOCIO,
    );
    if (date > tope) {
      return res.status(400).json({
        success: false,
        error: admin
          ? "No se puede reservar con más de 6 meses de anticipación"
          : "No se puede reservar con más de 3 semanas de anticipación",
      });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: schedule_id },
      include: { place: { select: { active: true } } },
    });
    if (!schedule) {
      return res.status(404).json({ success: false, error: "El horario no existe" });
    }
    // Un espacio dado de baja no se puede reservar (las reservas viejas siguen ahí)
    if (!schedule.place.active) {
      return res
        .status(409)
        .json({ success: false, error: "El espacio no está disponible" });
    }

    // Hoy a las 16:00 no se puede reservar el turno de las 08:00. Va acá y no sólo
    // en la UI: es una regla del negocio, no un detalle de presentación.
    if (date === hoy && timeToHHMM(schedule.start_time) <= nowTimeInClub()) {
      return res
        .status(400)
        .json({ success: false, error: "Ese horario ya pasó" });
    }

    // El schema no puede validar esto: la fecha tiene que caer en el día de semana del turno
    if (!matchesDayOfWeek(when, schedule.day_of_week)) {
      const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      return res.status(400).json({
        success: false,
        error: `Ese turno es los ${dias[schedule.day_of_week]}, y la fecha elegida es ${dias[when.getUTCDay()]}`,
      });
    }

    // Snapshot de la tarifa. Por defecto sale del turno, no del cliente: si no,
    // cualquiera reservaría el salón a precio de cancha. La gestión sí puede
    // pisarla (tarifa especial, evento, socio con descuento).
    let feeId = schedule.fee_id;
    if (admin && parsed.data.fee_id !== undefined) {
      const fee = await prisma.fee.findUnique({
        where: { id: parsed.data.fee_id },
        select: { id: true },
      });
      if (!fee) {
        return res.status(400).json({ success: false, error: "La tarifa indicada no existe" });
      }
      feeId = fee.id;
    }

    const booking = await prisma.booking.create({
      data: {
        schedule_id,
        fee_id: feeId,
        user_id: userId,
        date: when,
        notes,
        // La gestión puede darla por paga en el acto (cobró en el club).
        ...(admin && parsed.data.status ? { status: parsed.data.status } : {}),
        active: true,
      },
      include: bookingInclude,
    });

    return res.status(201).json({ success: true, booking });
  } catch (error: any) {
    /*
     * Control de concurrencia: lo hace el índice único (schedule_id, date, active)
     * de InnoDB, no un lock nuestro. Dos POST simultáneos del mismo turno entran a
     * INSERT los dos; MySQL serializa sobre la entrada del índice y el segundo sale
     * por duplicado → 409. Es el candado más fino posible (bloquea ese turno en esa
     * fecha, nada más): un SELECT ... FOR UPDATE sobre el schedule sería más grueso
     * porque frenaría todas las fechas de ese turno a la vez.
     *
     * ponytail: queda una ventana teórica — si un admin edita el day_of_week del
     * turno entre la validación y el INSERT, la reserva entra con el día viejo.
     * Cerrarla pide bloquear el schedule en cada reserva; no vale el costo hasta
     * que alguien edite horarios con gente reservando.
     */
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "Ese turno ya está reservado" });
    }
    // El turno se borró entre que lo validamos y el insert
    if (error?.code === "P2003") {
      return res.status(409).json({ success: false, error: "El horario ya no está disponible" });
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
    // El dueño no cambia sola, así que este chequeo sí puede ir sobre la lectura.
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    const { notes, status } = parsed.data;
    if (status && !isAdmin(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Solo un administrador puede cambiar el estado" });
    }

    // El estado sí puede cambiar entre la lectura y la escritura (otra pestaña
    // cancelando). Va como condición del UPDATE, no como if previo: si alguien
    // canceló en el medio, count sale 0 y no se pisa nada.
    const { count } = await prisma.booking.updateMany({
      where: { id: req.params.id, status: { not: "Cancelada" } },
      data: {
        ...(notes !== undefined && { notes }),
        ...(status !== undefined && { status }),
      },
    });
    if (count === 0) {
      return res.status(409).json({ success: false, error: "La reserva está cancelada" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingInclude,
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

    // Cancelar dos veces en paralelo (doble tap, dos pestañas) tiene que dejar
    // una sola cancelación: la condición va en el UPDATE y gana el primero.
    const { count } = await prisma.booking.updateMany({
      where: { id: req.params.id, status: { not: "Cancelada" } },
      data: { status: "Cancelada", active: null },
    });
    if (count === 0) {
      return res.status(409).json({ success: false, error: "La reserva ya estaba cancelada" });
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });

    return res.json({ success: true, message: "Reserva cancelada", booking });
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res.status(500).json({ success: false, error: "Error al cancelar la reserva" });
  }
});
