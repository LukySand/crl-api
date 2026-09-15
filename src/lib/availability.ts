/**
 * Cruza los turnos reservables de un espacio con lo que los ocupa ese día:
 * reservas activas y clases de disciplina que caen en el mismo horario.
 *
 * Función pura a propósito — sin Prisma, sin fechas del sistema — para poder
 * testearla sin base de datos. Los datos ya vienen filtrados por place_id +
 * day_of_week desde el caller (routes/bookings.ts).
 *
 * `overlaps` vive en lib/time.ts (junto a TIME y toTime, los otros helpers de
 * horario) y no acá: esta función solo arma el resultado, la comparación de
 * rangos es un concepto de tiempo, no de disponibilidad.
 */
import { overlaps } from "./time";
import { timeToHHMM } from "./booking-date";

export type SlotSchedule = {
  id: number;
  start_time: Date;
  end_time: Date;
};

export type SlotBooking = {
  schedule_id: number;
};

export type SlotDisciplineSchedule = {
  start_time: Date;
  end_time: Date;
  discipline: { name: string };
};

export type Motivo = "reserva" | "clase";

/**
 * La clase que se pisa con el rango [start,end), o null si está libre.
 *
 * Es la regla "una clase bloquea el espacio" en un solo lugar: la usan
 * buildAvailability (mostrar), POST /api/schedules (no crear un turno que nace
 * muerto) y POST /api/bookings (no reservar sobre una clase). Las tres tienen
 * que responder igual, si no el front muestra una cosa y la API hace otra.
 *
 * `clases` ya viene filtrada por espacio y día de semana desde el caller.
 */
export function claseQuePisa(
  start: Date,
  end: Date,
  clases: SlotDisciplineSchedule[],
): SlotDisciplineSchedule | null {
  return clases.find((c) => overlaps(start, end, c.start_time, c.end_time)) ?? null;
}

/**
 * El turno reservable vivo que se pisa con el rango [start,end), o null.
 *
 * Es el espejo de claseQuePisa y vive al lado a propósito: son las dos
 * direcciones de la misma regla (un espacio no se puede estar usando para dos
 * cosas a la vez) y tienen que quedar simétricas. Si una cambia, la otra
 * también.
 *
 * `turnos` ya viene filtrada por espacio, día de semana y active=true desde el
 * caller: un turno dado de baja no bloquea nada.
 */
export function turnoQuePisa(
  start: Date,
  end: Date,
  turnos: SlotSchedule[],
): SlotSchedule | null {
  return turnos.find((t) => overlaps(start, end, t.start_time, t.end_time)) ?? null;
}

export type SlotDisponibilidad = SlotSchedule & {
  ocupado: boolean;
  motivo: Motivo | null;
  detalle: string | null; // nombre de la disciplina si motivo es "clase", si no null
};

/**
 * Arma la disponibilidad de cada turno.
 *
 * `bookings` ya viene filtrado a las activas (active=true) del día — una
 * reserva cancelada no bloquea, así que no debería llegar acá.
 *
 * Cuando un turno cae dentro del horario de una clase Y tiene una reserva
 * activa (caso raro: la clase se agregó después de reservar, o la reserva es
 * vieja), gana "clase" como motivo: la clase es el bloqueo estructural del
 * espacio, la reserva quedó ahí de forma inconsistente y no es lo que el
 * frontend debería mostrarle al socio como razón.
 */
export function buildAvailability(
  schedules: SlotSchedule[],
  bookings: SlotBooking[],
  disciplineSchedules: SlotDisciplineSchedule[],
): SlotDisponibilidad[] {
  const reservados = new Set(bookings.map((b) => b.schedule_id));

  return schedules.map((s) => {
    const clase = claseQuePisa(s.start_time, s.end_time, disciplineSchedules);
    if (clase) {
      return { ...s, ocupado: true, motivo: "clase", detalle: clase.discipline.name };
    }
    if (reservados.has(s.id)) {
      return { ...s, ocupado: true, motivo: "reserva", detalle: null };
    }
    return { ...s, ocupado: false, motivo: null, detalle: null };
  });
}

// ---------------------------------------------------------------------------
// Ocupación del día de TODOS los espacios (dashboard de gestión).
// ---------------------------------------------------------------------------

export type OccupancySchedule = SlotSchedule & { place_id: number };
export type OccupancyDisciplineSchedule = SlotDisciplineSchedule & { place_id: number };

export type OccupancyRow = {
  place_id: number;
  total: number; // turnos del día en ese espacio
  reservados: number; // bloqueados por una reserva activa
  clases: number; // bloqueados por una clase de disciplina
  ocupados: number; // reservados + clases (lo que no se puede reservar)
  ocupado_ahora: boolean;
  turno_actual: {
    start: string;
    end: string;
    reservado: boolean; // se mantiene por compatibilidad con el front
    motivo: Motivo | null;
    detalle: string | null;
  } | null;
};

/**
 * Agrupa por espacio y resume el día. Reusa buildAvailability para no tener dos
 * criterios distintos de "qué bloquea un turno" — si mañana cambia la
 * precedencia reserva/clase, cambia en un solo lugar.
 *
 * `now` entra por parámetro ("HH:MM") en vez de leer el reloj acá: así la
 * función sigue siendo pura y testeable. El huso del club lo resuelve el caller
 * (lib/booking-date.ts).
 *
 * `bookings` puede venir sin filtrar por espacio: buildAvailability las cruza
 * por schedule_id, que es único en toda la tabla.
 */
export function buildOccupancy(
  schedules: OccupancySchedule[],
  bookings: SlotBooking[],
  disciplineSchedules: OccupancyDisciplineSchedule[],
  now: string,
): OccupancyRow[] {
  const clasesPorEspacio = new Map<number, OccupancyDisciplineSchedule[]>();
  for (const d of disciplineSchedules) {
    const acumuladas = clasesPorEspacio.get(d.place_id) ?? [];
    acumuladas.push(d);
    clasesPorEspacio.set(d.place_id, acumuladas);
  }

  const turnosPorEspacio = new Map<number, OccupancySchedule[]>();
  for (const s of schedules) {
    const acumulados = turnosPorEspacio.get(s.place_id) ?? [];
    acumulados.push(s);
    turnosPorEspacio.set(s.place_id, acumulados);
  }

  const filas: OccupancyRow[] = [];

  for (const [place_id, turnos] of turnosPorEspacio) {
    const slots = buildAvailability(turnos, bookings, clasesPorEspacio.get(place_id) ?? []);

    const fila: OccupancyRow = {
      place_id,
      total: slots.length,
      reservados: 0,
      clases: 0,
      ocupados: 0,
      ocupado_ahora: false,
      turno_actual: null,
    };

    for (const slot of slots) {
      if (slot.motivo === "reserva") fila.reservados += 1;
      if (slot.motivo === "clase") fila.clases += 1;
      if (slot.ocupado) fila.ocupados += 1;

      const start = timeToHHMM(slot.start_time);
      const end = timeToHHMM(slot.end_time);

      // "HH:MM" con cero adelante compara bien como string, no hace falta parsear.
      if (start <= now && now < end) {
        fila.turno_actual = {
          start,
          end,
          reservado: slot.motivo === "reserva",
          motivo: slot.motivo,
          detalle: slot.detalle,
        };
        fila.ocupado_ahora = slot.ocupado;
      }
    }

    filas.push(fila);
  }

  return filas;
}
