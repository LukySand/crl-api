/**
 * Ocupación de los espacios en un día (#44): qué turno está libre, reservado,
 * tomado por una clase o cerrado por un bloqueo.
 *
 * Lógica pura, sin Prisma: la ruta (`GET /api/places/occupancy`) junta las filas
 * y esto las cruza. La usan el indicador de la pantalla Espacios (hoy, cada 15 s)
 * y la grilla hora × espacio (cualquier día).
 *
 * Todas las horas van como "HH:MM" con cero adelante: comparan bien como string.
 */

import { bloqueaTurno, franjasSePisan, type BloqueoNormalizado } from "./schedule-block";

export type MotivoOcupado = "bloqueo" | "reserva" | "clase";

export interface TurnoIn {
  id: number;
  place_id: number;
  start: string;
  end: string;
}

export interface ReservaIn {
  id: string;
  schedule_id: number;
  status: string;
  socio: string;
}

export interface ClaseIn {
  place_id: number;
  disciplina: string;
  start: string;
  end: string;
}

export interface BloqueoIn extends BloqueoNormalizado {
  place_id: number;
  reason: string;
}

export interface TurnoOcupacion {
  id: number;
  start: string;
  end: string;
  /** null = libre. */
  motivo: MotivoOcupado | null;
  /** Motivo del bloqueo, nombre de la disciplina o del socio que reservó. */
  detalle: string | null;
  reserva: { id: string; status: string; socio: string } | null;
}

export interface OcupacionEspacio {
  place_id: number;
  total: number;
  reservados: number;
  clases: number;
  bloqueados: number;
  /** Turnos que no se pueden tomar, por el motivo que sea: el número de pantalla. */
  ocupados: number;
  ocupado_ahora: boolean;
  turno_actual: {
    start: string;
    end: string;
    reservado: boolean;
    motivo: MotivoOcupado | null;
    detalle: string | null;
  } | null;
  turnos: TurnoOcupacion[];
}

/**
 * Cruza los turnos del día con reservas, clases y bloqueos.
 *
 * Prioridad cuando coinciden: bloqueo > reserva > clase. Un bloqueo cierra el
 * espacio aunque haya una reserva (es lo que ve el socio en /availability), y
 * una reserva real pesa más que una clase que comparte la franja.
 *
 * `ahora` es "HH:MM" sólo si `fecha` es hoy; si no, null y no hay turno actual.
 */
export function calcularOcupacion(
  fecha: string,
  ahora: string | null,
  datos: { turnos: TurnoIn[]; reservas: ReservaIn[]; clases: ClaseIn[]; bloqueos: BloqueoIn[] },
): OcupacionEspacio[] {
  const reservaPorTurno = new Map(datos.reservas.map((r) => [r.schedule_id, r]));
  const porEspacio = new Map<number, OcupacionEspacio>();

  const turnos = [...datos.turnos].sort((a, b) => a.start.localeCompare(b.start));
  for (const t of turnos) {
    const fila: OcupacionEspacio = porEspacio.get(t.place_id) ?? {
      place_id: t.place_id,
      total: 0,
      reservados: 0,
      clases: 0,
      bloqueados: 0,
      ocupados: 0,
      ocupado_ahora: false,
      turno_actual: null,
      turnos: [],
    };

    const franja = { start: t.start, end: t.end };
    const bloqueo = datos.bloqueos.find((b) => b.place_id === t.place_id && bloqueaTurno(b, fecha, franja));
    const reserva = reservaPorTurno.get(t.id) ?? null;
    const clase = datos.clases.find(
      (c) => c.place_id === t.place_id && franjasSePisan(c.start, c.end, t.start, t.end),
    );

    let motivo: MotivoOcupado | null = null;
    let detalle: string | null = null;
    if (bloqueo) [motivo, detalle] = ["bloqueo", bloqueo.reason];
    else if (reserva) [motivo, detalle] = ["reserva", reserva.socio];
    else if (clase) [motivo, detalle] = ["clase", clase.disciplina];

    fila.total += 1;
    if (motivo === "bloqueo") fila.bloqueados += 1;
    if (motivo === "reserva") fila.reservados += 1;
    if (motivo === "clase") fila.clases += 1;
    if (motivo) fila.ocupados += 1;

    if (ahora && t.start <= ahora && ahora < t.end) {
      fila.turno_actual = { start: t.start, end: t.end, reservado: motivo === "reserva", motivo, detalle };
      fila.ocupado_ahora = motivo !== null;
    }

    fila.turnos.push({
      id: t.id,
      start: t.start,
      end: t.end,
      motivo,
      detalle,
      reserva: reserva ? { id: reserva.id, status: reserva.status, socio: reserva.socio } : null,
    });
    porEspacio.set(t.place_id, fila);
  }

  return [...porEspacio.values()];
}
