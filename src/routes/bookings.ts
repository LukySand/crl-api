import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, isAdmin, veComoGestion } from "../lib/auth";
import { findOrCreateFeeForPlace } from "../lib/fee";
import { METODOS_MANUALES } from "../lib/cobro";
import { refReserva } from "../lib/payment";
import { crearLiquidacionMP, liquidacionViva, PagoEnCurso, saldarItems } from "../lib/settlement";
import { accessToken, createPreference } from "../lib/mercadopago";
import { liberarReservasVencidas, reembolsarReservaPagada } from "../lib/booking-hold";
import { bloqueaTurno } from "../lib/schedule-block";
import { getAjustes } from "../lib/settings-db";
import { bloqueoQueCierra, bloqueosDelDia } from "../lib/schedule-block-db";
import {
  parseDate,
  matchesDayOfWeek,
  todayInClub,
  nowTimeInClub,
  timeToHHMM,
  ultimaFechaReservable,
  dentroDeVentanaCancelacion,
  hayTiempoParaPagar,
  limiteDeCancelacion,
  MINUTOS_PARA_PAGAR_RESERVA,
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
  // Para avisar antes de cancelar que una reserva cobrada por MP se reembolsa sola.
  payment: { select: { status: true, method: true, amount: true } },
} as const;

// Igual que en schedules.ts: se manda el monto, no un fee_id — quien reserva no
// tiene por qué pensar en tarifas, piensa en plata. findOrCreateFeeForPlace
// resuelve la fila.
// nonnegative, no positive: una reserva puede ser gratuita (evento, cortesía),
// a diferencia de un turno (schedules.ts), que siempre cobra algo.
const amountSchema = z.coerce
  .number()
  .nonnegative("El precio no puede ser negativo")
  .max(99_999_999.99, "El precio es demasiado grande");

const createSchema = z.object({
  schedule_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD"),
  notes: z.string().max(1000).optional(),

  // Campos de gestión. Si los manda un socio se responde 403, no se ignoran en
  // silencio: mandarlos es un intento de reservar a nombre de otro o de fijarse
  // el precio, y eso tiene que fallar fuerte.
  user_id: z.uuid("user_id inválido").optional(),
  amount: amountSchema.optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
  // Cómo cobró la gestión al confirmar en el acto. Sólo se mira si status es
  // Confirmada; si no viene, se asume efectivo (es el mostrador del club).
  method: z.enum(METODOS_MANUALES).optional(),
});

const updateSchema = z.object({
  notes: z.string().max(1000).optional(),
  status: z.enum(["Pendiente", "Confirmada"]).optional(),
  // Precio puntual de esta reserva. No toca Schedule.fee_id: las próximas
  // reservas de ese turno siguen saliendo al precio del turno.
  amount: amountSchema.optional(),
  // Medio de cobro, sólo se mira al confirmar. Como en el POST.
  method: z.enum(METODOS_MANUALES).optional(),
});


/**
 * GET /api/bookings — reservas. El Administrador ve todas; el resto, las propias.
 * Con `?propias=true` sólo las propias, también para gestión.
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
        // Sale del token, nunca de la query: nadie mira las reservas de otro.
        // Gestión ve todas salvo que pida `?propias=true` (ver veComoGestion).
        ...(veComoGestion(req) ? {} : { user_id: req.user!.id }),
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

/** Por qué un turno no se puede reservar ese día. `detalle` trae el motivo de un bloqueo. */
interface SlotDisponibilidad {
  id: number;
  ocupado: true;
  motivo: "reserva" | "bloqueo";
  detalle: string | null;
}

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

    const dia = parseDate(date);
    if (Number.isNaN(dia.getTime())) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }

    // Si el cron estuvo caído, el primero que mira la grilla suelta los holds vencidos.
    await liberarReservasVencidas();

    const [rows, turnos, bloqueos] = await Promise.all([
      prisma.booking.findMany({
        // active: true deja afuera las canceladas (que quedan en null y liberan el turno)
        where: { date: dia, active: true, schedule: { place_id: placeId } },
        select: { schedule_id: true },
      }),
      // Los turnos que caen ese día de la semana: son los únicos que un bloqueo
      // puede cerrar ese día.
      prisma.schedule.findMany({
        where: { place_id: placeId, day_of_week: dia.getUTCDay() },
        select: { id: true, start_time: true, end_time: true },
      }),
      bloqueosDelDia(placeId, date),
    ]);

    const reservados = new Set(rows.map((r) => r.schedule_id));

    // Por qué está ocupado cada turno. Un bloqueo manda sobre una reserva: si los
    // dos coinciden, lo que ve el socio es que el espacio está cerrado.
    const slots = turnos.flatMap((t): SlotDisponibilidad[] => {
      const cierre = bloqueos.find((b) =>
        bloqueaTurno(b, date, { start: timeToHHMM(t.start_time), end: timeToHHMM(t.end_time) }),
      );
      if (cierre) return [{ id: t.id, ocupado: true, motivo: "bloqueo", detalle: cierre.reason }];
      if (reservados.has(t.id)) return [{ id: t.id, ocupado: true, motivo: "reserva", detalle: null }];
      return [];
    });

    // `taken` sigue siendo la lista plana de ids no reservables (bloqueados incluidos),
    // para las pantallas que sólo necesitan saber qué turnos no se pueden tomar.
    const taken = [...new Set([...rows.map((r) => r.schedule_id), ...slots.map((x) => x.id)])];

    return res.json({ success: true, taken, slots });
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
 * POST /api/bookings/:id/checkout — retoma el pago de una reserva pendiente.
 *
 * Sólo el dueño (la gestión no paga por otro). Con liquidación viva devuelve su `checkout_url`.
 * Sin liquidación: si la reserva tuvo hold (`hold_until`) ya venció; si no (la asignó la
 * gestión) se crea el pago acá, con vigencia hasta el límite para cancelar.
 */
bookingsRouter.post("/:id/checkout", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: {
        user_id: true,
        status: true,
        active: true,
        date: true,
        created_at: true,
        hold_until: true,
        schedule: { select: { start_time: true, place: { select: { name: true } } } },
        payment: { select: { id: true, status: true, amount: true } },
      },
    });
    if (!booking) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (booking.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }
    if (booking.status !== "Pendiente" || !booking.active || !booking.payment) {
      return res.status(409).json({ success: false, error: "Esta reserva no tiene un pago pendiente" });
    }

    const devolver = (v: { checkout_url: string | null; expires_at: Date | null }) =>
      v.checkout_url
        ? res.json({ success: true, checkout_url: v.checkout_url, vence: v.expires_at?.toISOString() ?? null })
        : res.status(409).json({
            success: false,
            error: "No se pudo recuperar el link de pago. Cancelá la reserva e intentá de nuevo.",
          });

    const viva = await liquidacionViva([booking.payment.id]);
    if (viva) return devolver(viva);
    if (booking.hold_until) {
      return res.status(409).json({ success: false, error: "El plazo para pagar esta reserva ya venció" });
    }

    // Asignada por la gestión: sin liquidación viva se crea una. Vence en el límite para cancelar
    // (el barrido la suelta ahí); si nació dentro de esa ventana nunca se cancela sola y vence al iniciar el turno.
    const { cancel_hours_before: horas } = await getAjustes();
    const nacioDentro = !dentroDeVentanaCancelacion(booking.date, booking.schedule.start_time, booking.created_at, horas);
    const expiresAt = limiteDeCancelacion(booking.date, booking.schedule.start_time, nacioDentro ? 0 : horas);
    if (booking.payment.status !== "Pendiente" || expiresAt <= new Date()) {
      return res.status(409).json({ success: false, error: "El plazo para pagar esta reserva ya venció" });
    }
    if (!accessToken()) {
      return res.status(502).json({ success: false, error: "El pago con Mercado Pago no está disponible" });
    }

    let liq: { id: string };
    try {
      liq = await crearLiquidacionMP({
        userId: booking.user_id,
        filas: [{ id: booking.payment.id, amount: booking.payment.amount }],
        expiresAt,
      });
    } catch (error) {
      if (error instanceof PagoEnCurso) return devolver(error.viva);
      throw error;
    }

    try {
      const socio = await prisma.user.findUnique({ where: { id: booking.user_id }, select: { email: true } });
      const pref = await createPreference({
        externalReference: liq.id,
        items: [
          {
            title: `Reserva ${booking.schedule.place.name ?? "espacio"} — ${booking.date.toISOString().slice(0, 10)} ${timeToHHMM(booking.schedule.start_time)}`,
            quantity: 1,
            unit_price: Number(booking.payment.amount),
          },
        ],
        payerEmail: socio?.email,
        backUrlBase: process.env.MP_BACK_URL_BASE || "http://localhost:3000",
        notificationUrl: process.env.MP_NOTIFICATION_URL || undefined,
        expiresAt,
      });
      await prisma.paymentTransaction.update({
        where: { id: liq.id },
        data: { mp_preference_id: pref.id, checkout_url: pref.init_point },
      });
      return res.json({ success: true, checkout_url: pref.init_point, vence: expiresAt.toISOString() });
    } catch (error) {
      // La reserva sigue Pendiente (no hay hold que soltar): se cancela la liquidación y se reintenta.
      console.error("Resume booking payment error:", error);
      await prisma.paymentTransaction.updateMany({ where: { id: liq.id, status: "Pendiente" }, data: { status: "Cancelado" } }).catch(() => {});
      return res.status(502).json({ success: false, error: "No se pudo iniciar el pago, probá de nuevo." });
    }
  } catch (error) {
    console.error("Resume booking checkout error:", error);
    return res.status(500).json({ success: false, error: "Error al retomar el pago" });
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
      if (parsed.data.amount !== undefined) {
        return res
          .status(403)
          .json({ success: false, error: "No podés elegir el precio de la reserva" });
      }
      if (parsed.data.status !== undefined) {
        return res
          .status(403)
          .json({ success: false, error: "No podés fijar el estado de la reserva" });
      }
      if (parsed.data.method !== undefined) {
        return res
          .status(403)
          .json({ success: false, error: "No podés registrar el cobro de la reserva" });
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

    // Tope hacia adelante: lo fija el club en los ajustes (por defecto 3 semanas
    // para el socio y 6 meses para la gestión).
    const ajustes = await getAjustes();
    const diasAdelante = admin ? ajustes.days_ahead_admin : ajustes.days_ahead_member;
    if (date > ultimaFechaReservable(diasAdelante)) {
      return res.status(400).json({
        success: false,
        error: `No se puede reservar con más de ${diasAdelante} días de anticipación`,
      });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: schedule_id },
      include: {
        place: { select: { active: true, name: true } },
        // El monto se congela en el pago, así que hace falta acá y no sólo el fee_id.
        fee: { select: { amount: true } },
      },
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

    // Un bloqueo temporal (mantenimiento, evento…) cierra el turno en esa fecha
    // para todos, también para la gestión: si hace falta usarlo, se levanta antes.
    const bloqueo = await bloqueoQueCierra(schedule.place_id, date, {
      start: timeToHHMM(schedule.start_time),
      end: timeToHHMM(schedule.end_time),
    });
    if (bloqueo) {
      return res
        .status(409)
        .json({ success: false, error: `Ese horario está bloqueado: ${bloqueo.reason}` });
    }

    // Snapshot del precio. Por defecto sale del turno, no del cliente: si no,
    // cualquiera reservaría el salón a precio de cancha. La gestión sí puede
    // pisarlo (precio especial, evento, socio con descuento) — reusa una tarifa
    // existente de ese espacio con ese monto, o crea una nueva. No toca
    // Schedule.fee_id: es el precio de ESTA reserva, no del turno en general.
    const feeId =
      admin && parsed.data.amount !== undefined
        ? await findOrCreateFeeForPlace(parsed.data.amount, schedule.place_id)
        : schedule.fee_id;

    // Monto congelado del cobro. Sale del mismo lado que el fee_id: el override
    // de la gestión si lo hay, si no el precio del turno.
    const monto =
      admin && parsed.data.amount !== undefined
        ? parsed.data.amount
        : schedule.fee.amount;

    // La gestión puede darla por paga en el acto (cobró en el club).
    const cobrada = admin && parsed.data.status === "Confirmada";

    // Pago en el acto (D14): la reserva de la app de socio (o de la gestión con `?propias=true`),
    // para sí mismo y sin `status`. Con monto > 0 retiene el turno MINUTOS_PARA_PAGAR_RESERVA
    // mientras paga por MP; con monto 0 nace confirmada y paga. El mostrador no pasa por acá.
    const propia = !veComoGestion(req) && userId === req.user!.id && parsed.data.status === undefined;
    const gratis = propia && Number(monto) === 0;
    const pagaEnElActo = propia && Number(monto) > 0;

    if (pagaEnElActo) {
      if (!hayTiempoParaPagar(when, schedule.start_time)) {
        return res.status(400).json({
          success: false,
          error: `Faltan menos de ${MINUTOS_PARA_PAGAR_RESERVA} minutos para el turno: ya no alcanza el tiempo para pagarlo`,
        });
      }
      if (!accessToken()) {
        return res.status(502).json({ success: false, error: "El pago con Mercado Pago no está disponible" });
      }
    }

    // Un hold vencido que el cron todavía no soltó no puede frenar esta reserva.
    await liberarReservasVencidas();

    // La reserva y su cobro nacen juntos o no nace ninguno: si el INSERT del
    // pago fallara aparte, quedaría una cancha ocupada que no le figura a nadie
    // como deuda. El P2002 del turno duplicado sigue saliendo del create de
    // abajo y se maneja en el catch igual que antes.
    const vence = new Date(Date.now() + MINUTOS_PARA_PAGAR_RESERVA * 60_000);
    const { booking, pago, liquidacionId } = await prisma.$transaction(async (tx) => {
      const creada = await tx.booking.create({
        data: {
          schedule_id,
          fee_id: feeId,
          user_id: userId,
          date: when,
          notes,
          ...(admin && parsed.data.status ? { status: parsed.data.status } : {}),
          ...(gratis ? { status: "Confirmada" as const } : {}),
          // Sólo la pagada en el acto retiene el turno 5 minutos; la de la gestión no tiene plazo propio.
          ...(pagaEnElActo ? { hold_until: vence } : {}),
          active: true,
        },
        include: bookingInclude,
      });

      const pagoCreado = await tx.payment.create({
        data: {
          user_id: userId,
          concept: "Reserva",
          name: `Reserva ${when.toISOString().slice(8, 10)}/${when.toISOString().slice(5, 7)}/${when.getUTCFullYear()}`,
          booking_id: creada.id,
          fee_id: feeId,
          amount: monto,
          // Sin período: la reserva no es mensual, se paga una sola vez.
          period: null,
          // Vence el día del turno: se juega pagando.
          due_date: when,
          ref: refReserva(creada.id),
          ...(gratis ? { status: "Pagado" as const, paid_at: new Date() } : {}),
        },
      });

      // Cobrada en el acto: liquidación manual por el helper (D4/D10).
      if (cobrada) {
        await saldarItems(tx, {
          userId,
          method: parsed.data.method ?? "Efectivo",
          registeredBy: req.user!.id,
          filas: [{ id: pagoCreado.id, amount: monto }],
        });
      }

      // El hold: liquidación de MP `Pendiente` que vence a los 5 minutos. La fila es nueva, así
      // que no hay otra liquidación viva con la que competir (no hace falta `crearLiquidacionMP`).
      const liq = pagaEnElActo
        ? await tx.paymentTransaction.create({
            data: {
              user_id: userId,
              method: "MercadoPago",
              status: "Pendiente",
              amount: monto,
              expires_at: vence,
              items: { create: [{ payment_id: pagoCreado.id, amount: monto as never }] },
            },
            select: { id: true },
          })
        : null;

      return { booking: creada, pago: pagoCreado, liquidacionId: liq?.id ?? null };
    });

    if (liquidacionId) {
      try {
        const socio = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        // El link vence junto con el hold: pasado el plazo MP no deja pagar, así que no hay que
        // devolver. La doc no pone mínimo a `expiration_date_to` (el 1-30 días es de
        // `date_of_expiration`, medios offline). Un pago empezado antes del corte y aprobado
        // después igual llega: lo resuelve `resolverReserva`.
        const pref = await createPreference({
          externalReference: liquidacionId,
          items: [
            {
              title: `Reserva ${schedule.place.name ?? "espacio"} — ${date} ${timeToHHMM(schedule.start_time)}`,
              quantity: 1,
              unit_price: Number(monto),
            },
          ],
          payerEmail: socio?.email,
          backUrlBase: process.env.MP_BACK_URL_BASE || "http://localhost:3000",
          notificationUrl: process.env.MP_NOTIFICATION_URL || undefined,
          expiresAt: vence,
        });
        await prisma.paymentTransaction.update({
          where: { id: liquidacionId },
          data: { mp_preference_id: pref.id, checkout_url: pref.init_point },
        });
        return res.status(201).json({
          success: true,
          booking,
          pago: { id: liquidacionId, monto: Number(monto).toFixed(2), vence: vence.toISOString() },
          checkout_url: pref.init_point,
        });
      } catch (error) {
        // Sin MP no hay cómo cobrar, y una reserva que no se puede cobrar no retiene el turno.
        console.error("Create booking payment error:", error);
        try {
          await prisma.$transaction([
            prisma.paymentTransaction.update({ where: { id: liquidacionId }, data: { status: "Cancelado" } }),
            prisma.payment.updateMany({
              where: { id: pago.id, status: "Pendiente" },
              data: { status: "Anulado", resolved_by: "sistema", resolved_reason: "No se pudo iniciar el pago", resolved_at: new Date() },
            }),
            prisma.booking.updateMany({ where: { id: booking.id }, data: { status: "Cancelada", active: null } }),
          ]);
        } catch (e) {
          // El barrido del hold la suelta igual al vencer el plazo.
          console.error("Release booking after MP failure error:", e);
        }
        return res.status(502).json({
          success: false,
          error: "No se pudo iniciar el pago. La reserva no se tomó, probá de nuevo.",
        });
      }
    }

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
 * PATCH /api/bookings/:id — el dueño edita sus notas; el Administrador confirma,
 * cambia el precio puntual de esta reserva, o ambos. Cancelar no se hace acá, va
 * por DELETE.
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

    const existing = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { user_id: true, schedule: { select: { place_id: true } } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    // El dueño no cambia sola, así que este chequeo sí puede ir sobre la lectura.
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    const { notes, status, amount } = parsed.data;
    if (status && !isAdmin(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Solo un administrador puede cambiar el estado" });
    }
    if (amount !== undefined && !isAdmin(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Solo un administrador puede cambiar el precio" });
    }
    if (parsed.data.method !== undefined && !isAdmin(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Solo un administrador puede registrar el cobro" });
    }

    // Con un pago de MP en curso, confirmar o repuntear la reserva lo desalinearía con lo que el
    // socio está pagando (D14): se espera a que pague o venza.
    if (status === "Confirmada" || amount !== undefined) {
      const fila = await prisma.payment.findUnique({ where: { booking_id: req.params.id }, select: { id: true } });
      const viva = fila ? await liquidacionViva([fila.id]) : null;
      if (viva) {
        return res.status(409).json({
          success: false,
          error: "Hay un pago en curso para esta reserva",
          pago_en_curso: { id: viva.id, vence: viva.expires_at?.toISOString() ?? null },
        });
      }
    }

    // No toca Schedule.fee_id: el resto de las reservas de ese turno sigue
    // saliendo al precio del turno, esto sólo repuntea ESTA reserva.
    const feeId =
      amount !== undefined
        ? await findOrCreateFeeForPlace(amount, existing.schedule.place_id)
        : undefined;

    // El estado sí puede cambiar entre la lectura y la escritura (otra pestaña
    // cancelando). Va como condición del UPDATE, no como if previo: si alguien
    // canceló en el medio, count sale 0 y no se pisa nada.
    const count = await prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({
        where: { id: req.params.id, status: { not: "Cancelada" } },
        data: {
          ...(notes !== undefined && { notes }),
          ...(status !== undefined && { status }),
          ...(feeId !== undefined && { fee_id: feeId }),
        },
      });
      if (count === 0) return 0;

      // El cobro acompaña a la reserva en la misma transacción, igual que en la
      // cancelación: si no, confirmar dejaría la reserva paga y la deuda viva.
      if (amount !== undefined) {
        // Repreciar sólo sirve mientras no se cobró: si ya se pagó, el monto que
        // entró a la caja es el que entró y no se reescribe.
        await tx.payment.updateMany({
          where: { booking_id: req.params.id, status: { not: "Pagado" } },
          data: { amount, fee_id: feeId },
        });
      }
      if (status === "Confirmada") {
        const pendiente = await tx.payment.findFirst({
          where: { booking_id: req.params.id, status: { in: ["Pendiente", "EnRevision"] } },
          select: { id: true, user_id: true, amount: true },
        });
        if (pendiente) {
          await saldarItems(tx, {
            userId: pendiente.user_id,
            method: parsed.data.method ?? "Efectivo",
            registeredBy: req.user!.id,
            filas: [pendiente],
          });
        }
      }
      return count;
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
 *
 * El socio tiene ventana: hasta las horas que fije el club (ajustes) antes de que arranque el turno.
 * La gestión no.
 */
bookingsRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    // Trae el turno porque la ventana de cancelación necesita la hora de inicio:
    // la reserva sola sólo sabe el día.
    const existing = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { schedule: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    // La gestión cancela siempre; el socio, hasta las horas que fije el club en los
    // ajustes antes del turno. Va en el backend y no sólo en el front: escondiendo
    // el botón, un DELETE a mano seguiría liberando la cancha cinco minutos antes.
    // La ventana rige sólo para una reserva `Confirmada`: una `Pendiente` (en hold, sin pagar)
    // el socio la suelta siempre (D14).
    if (!isAdmin(req) && existing.status === "Confirmada") {
      const { cancel_hours_before } = await getAjustes();
      if (
        !dentroDeVentanaCancelacion(
          existing.date,
          existing.schedule.start_time,
          new Date(),
          cancel_hours_before,
        )
      ) {
        return res.status(409).json({
          success: false,
          error: `Las reservas se cancelan hasta ${cancel_hours_before} horas antes del turno. Comunicate con el club.`,
        });
      }
    }

    // Cancelar dos veces en paralelo (doble tap, dos pestañas) tiene que dejar
    // una sola cancelación: la condición va en el UPDATE y gana el primero.
    const count = await prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({
        where: { id: req.params.id, status: { not: "Cancelada" } },
        data: { status: "Cancelada", active: null },
      });
      if (count === 0) return 0;

      // El pago se anula en la misma transacción que la cancelación, por lo
      // mismo que `status` y `active` viajan juntos (ver el comentario del
      // modelo Booking): si se separan, un fallo entre medio deja una reserva
      // cancelada con la deuda todavía viva.
      //
      // Un pago ya cobrado NO se anula acá: la plata entró de verdad y borrarla del
      // ledger falsearía los ingresos del mes. Queda Pagado contra una reserva
      // cancelada; si fue por MP, el reembolso (abajo) la deja Anulado cuando sale.
      //
      // Una liquidación de MP viva (el socio todavía puede estar pagando) queda `voided_*`: su
      // status no cambia, la sigue mirando la conciliación, y una aprobación posterior reembolsa
      // en vez de retomar el turno (D14). Va antes de anular la fila, que es lo que la identifica.
      const ahora = new Date();
      await tx.paymentTransaction.updateMany({
        where: {
          method: "MercadoPago",
          status: "Pendiente",
          voided_at: null,
          items: { some: { payment: { booking_id: req.params.id, status: { not: "Pagado" } } } },
        },
        data: { voided_by: req.user!.id, voided_reason: "Reserva cancelada", voided_at: ahora },
      });
      await tx.payment.updateMany({
        where: { booking_id: req.params.id, status: { not: "Pagado" } },
        data: { status: "Anulado", resolved_by: req.user!.id, resolved_reason: "Reserva cancelada", resolved_at: ahora },
      });
      return count;
    });
    if (count === 0) {
      return res.status(409).json({ success: false, error: "La reserva ya estaba cancelada" });
    }

    // Pagada por MP (el socio dentro de la ventana, o la gestión siempre): la cancelación ya está
    // commiteada y recién ahora se pide el reembolso. Si MP no contesta la reserva sigue cancelada,
    // la fila `Pagado` y el barrido reintenta. Una reserva cobrada en mano no se reembolsa sola.
    const reembolso = await reembolsarReservaPagada(req.params.id, req.user!.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });

    return res.json({ success: true, message: "Reserva cancelada", booking, ...(reembolso && { reembolso }) });
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res.status(500).json({ success: false, error: "Error al cancelar la reserva" });
  }
});
