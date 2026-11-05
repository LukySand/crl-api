import { describe, expect, test } from "bun:test";
import { calcularOcupacion, type BloqueoIn, type ClaseIn, type ReservaIn, type TurnoIn } from "./occupancy";

const FECHA = "2026-11-04";

const turno = (id: number, place_id: number, start: string, end: string): TurnoIn => ({
  id,
  place_id,
  start,
  end,
});

const vacio = { turnos: [] as TurnoIn[], reservas: [] as ReservaIn[], clases: [] as ClaseIn[], bloqueos: [] as BloqueoIn[] };

describe("calcularOcupacion", () => {
  test("sin turnos no hay espacios", () => {
    expect(calcularOcupacion(FECHA, null, vacio)).toEqual([]);
  });

  test("cuenta turnos libres y reservados por espacio, ordenados por hora", () => {
    const [cancha] = calcularOcupacion(FECHA, null, {
      ...vacio,
      turnos: [turno(2, 1, "19:00", "20:00"), turno(1, 1, "18:00", "19:00")],
      reservas: [{ id: "r1", schedule_id: 2, status: "Confirmada", socio: "Martín Aguirre" }],
    });
    expect(cancha!.total).toBe(2);
    expect(cancha!.reservados).toBe(1);
    expect(cancha!.ocupados).toBe(1);
    expect(cancha!.turnos.map((t) => [t.start, t.motivo, t.detalle])).toEqual([
      ["18:00", null, null],
      ["19:00", "reserva", "Martín Aguirre"],
    ]);
  });

  test("una clase que pisa el turno lo ocupa; una de otro espacio no", () => {
    const [cancha] = calcularOcupacion(FECHA, null, {
      ...vacio,
      turnos: [turno(1, 1, "18:00", "19:00"), turno(2, 1, "20:00", "21:00")],
      clases: [
        { place_id: 1, disciplina: "Fútbol", start: "18:00", end: "19:30" },
        { place_id: 2, disciplina: "Vóley", start: "20:00", end: "21:00" },
      ],
    });
    expect(cancha!.clases).toBe(1);
    expect(cancha!.turnos.map((t) => t.motivo)).toEqual(["clase", null]);
  });

  test("prioridad: bloqueo > reserva > clase", () => {
    const [cancha] = calcularOcupacion(FECHA, null, {
      turnos: [turno(1, 1, "18:00", "19:00"), turno(2, 1, "19:00", "20:00")],
      reservas: [
        { id: "r1", schedule_id: 1, status: "Confirmada", socio: "A" },
        { id: "r2", schedule_id: 2, status: "Pendiente", socio: "B" },
      ],
      clases: [{ place_id: 1, disciplina: "Fútbol", start: "18:00", end: "20:00" }],
      bloqueos: [
        {
          place_id: 1,
          date_from: FECHA,
          date_to: FECHA,
          start_time: "18:00",
          end_time: "19:00",
          reason: "Pintura",
        },
      ],
    });
    expect(cancha!.turnos.map((t) => [t.motivo, t.detalle])).toEqual([
      ["bloqueo", "Pintura"],
      ["reserva", "B"],
    ]);
    // La reserva tapada por el bloqueo igual viaja, para que la gestión la vea.
    expect(cancha!.turnos[0]!.reserva?.id).toBe("r1");
    expect([cancha!.bloqueados, cancha!.reservados, cancha!.clases, cancha!.ocupados]).toEqual([1, 1, 0, 2]);
  });

  test("un bloqueo de otra fecha no cierra el turno", () => {
    const [cancha] = calcularOcupacion(FECHA, null, {
      ...vacio,
      turnos: [turno(1, 1, "18:00", "19:00")],
      bloqueos: [
        { place_id: 1, date_from: "2026-11-05", date_to: "2026-11-05", start_time: null, end_time: null, reason: "X" },
      ],
    });
    expect(cancha!.turnos[0]!.motivo).toBeNull();
  });

  test("turno actual sólo si viene la hora (es hoy)", () => {
    const datos = {
      ...vacio,
      turnos: [turno(1, 1, "18:00", "19:00")],
      reservas: [{ id: "r1", schedule_id: 1, status: "Confirmada", socio: "A" }],
    };
    const [hoy] = calcularOcupacion(FECHA, "18:30", datos);
    expect(hoy!.ocupado_ahora).toBe(true);
    expect(hoy!.turno_actual).toEqual({ start: "18:00", end: "19:00", reservado: true, motivo: "reserva", detalle: "A" });

    const [otroDia] = calcularOcupacion(FECHA, null, datos);
    expect(otroDia!.turno_actual).toBeNull();
    expect(otroDia!.ocupado_ahora).toBe(false);

    // El fin del turno es exclusivo: a las 19:00 ya no está en curso.
    const [justo] = calcularOcupacion(FECHA, "19:00", datos);
    expect(justo!.turno_actual).toBeNull();
  });
});
