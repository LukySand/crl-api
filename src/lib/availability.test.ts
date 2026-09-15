// ponytail: overlaps es la base de dos bugs de negocio (turnos que se pisan,
// clases que no bloquean reservas), así que se testea el borde de comparación
// (tocarse no es superponerse) y la precedencia clase > reserva, no getters.
import { expect, test } from "bun:test";
import { overlaps } from "./time";
import {
  buildAvailability,
  buildOccupancy,
  claseQuePisa,
  turnoQuePisa,
  type SlotSchedule,
  type SlotBooking,
  type SlotDisciplineSchedule,
} from "./availability";

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

test("overlaps: tocarse en el borde no es superponerse", () => {
  // 19:00–20:00 y 20:00–21:00 tienen que poder coexistir en el mismo espacio
  expect(overlaps(t("19:00"), t("20:00"), t("20:00"), t("21:00"))).toBe(false);
});

test("overlaps: un rango contenido dentro de otro sí se pisa", () => {
  expect(overlaps(t("19:00"), t("21:00"), t("19:30"), t("20:00"))).toBe(true);
  // y en el otro orden de argumentos también (la función es simétrica)
  expect(overlaps(t("19:30"), t("20:00"), t("19:00"), t("21:00"))).toBe(true);
});

test("overlaps: superposición parcial de cualquier lado", () => {
  expect(overlaps(t("19:00"), t("20:30"), t("19:15"), t("21:00"))).toBe(true); // el bug del enunciado
  expect(overlaps(t("19:15"), t("21:00"), t("19:00"), t("20:30"))).toBe(true);
});

test("overlaps: rangos idénticos se pisan", () => {
  expect(overlaps(t("19:00"), t("20:00"), t("19:00"), t("20:00"))).toBe(true);
});

test("overlaps: rangos disjuntos no se pisan", () => {
  expect(overlaps(t("08:00"), t("09:00"), t("10:00"), t("11:00"))).toBe(false);
});

const schedule = (id: number, start: string, end: string): SlotSchedule => ({
  id,
  start_time: t(start),
  end_time: t(end),
});

test("buildAvailability: turno sin reserva ni clase queda libre", () => {
  const slot = buildAvailability([schedule(1, "08:00", "09:00")], [], [])[0]!;
  expect(slot.ocupado).toBe(false);
  expect(slot.motivo).toBeNull();
});

test("buildAvailability: una reserva activa ocupa el turno como 'reserva'", () => {
  const bookings: SlotBooking[] = [{ schedule_id: 1 }];
  const slot = buildAvailability([schedule(1, "08:00", "09:00")], bookings, [])[0]!;
  expect(slot.ocupado).toBe(true);
  expect(slot.motivo).toBe("reserva");
});

test("buildAvailability: una clase en el mismo horario ocupa el turno como 'clase'", () => {
  const clases: SlotDisciplineSchedule[] = [
    { start_time: t("19:00"), end_time: t("20:30"), discipline: { name: "Vóley" } },
  ];
  const slot = buildAvailability([schedule(1, "19:00", "20:00")], [], clases)[0]!;
  expect(slot.ocupado).toBe(true);
  expect(slot.motivo).toBe("clase");
  expect(slot.detalle).toBe("Vóley");
});

test("buildAvailability: turno con reserva Y clase — gana la clase (bloqueo estructural)", () => {
  const bookings: SlotBooking[] = [{ schedule_id: 1 }];
  const clases: SlotDisciplineSchedule[] = [
    { start_time: t("19:00"), end_time: t("20:30"), discipline: { name: "Hockey" } },
  ];
  const slot = buildAvailability([schedule(1, "19:00", "20:00")], bookings, clases)[0]!;
  expect(slot.motivo).toBe("clase");
  expect(slot.detalle).toBe("Hockey");
});

test("buildAvailability: una reserva cancelada (no llega en `bookings`) no ocupa el turno", () => {
  // El caller sólo manda reservas active=true; acá simulamos que la cancelada
  // directamente no está en el array — si el filtro del caller se rompiera,
  // este test no lo vería, pero deja documentado el contrato.
  const slot = buildAvailability([schedule(1, "08:00", "09:00")], [], [])[0]!;
  expect(slot.ocupado).toBe(false);
});

// ---------------------------------------------------------------------------
// buildOccupancy — el bug real acá era que el dashboard mostraba un espacio
// como libre mientras se estaba dictando una clase adentro.
// ---------------------------------------------------------------------------

test("separa reservas de clases y suma las dos en ocupados", () => {
  const [cancha] = buildOccupancy(
    [
      { id: 1, place_id: 7, start_time: t("18:00"), end_time: t("19:00") },
      { id: 2, place_id: 7, start_time: t("19:00"), end_time: t("20:00") },
      { id: 3, place_id: 7, start_time: t("20:00"), end_time: t("21:00") },
    ],
    [{ schedule_id: 1 }],
    [
      {
        place_id: 7,
        start_time: t("19:00"),
        end_time: t("20:00"),
        discipline: { name: "Vóley" },
      },
    ],
    "15:00",
  );

  expect(cancha!.total).toBe(3);
  expect(cancha!.reservados).toBe(1);
  expect(cancha!.clases).toBe(1);
  expect(cancha!.ocupados).toBe(2);
});

test("una clase en curso deja el espacio ocupado_ahora (el bug que se arregló)", () => {
  const [cancha] = buildOccupancy(
    [{ id: 1, place_id: 7, start_time: t("19:00"), end_time: t("20:30") }],
    [], // sin ninguna reserva: antes esto daba ocupado_ahora=false
    [
      {
        place_id: 7,
        start_time: t("19:00"),
        end_time: t("20:30"),
        discipline: { name: "Vóley" },
      },
    ],
    "19:45",
  );

  expect(cancha!.ocupado_ahora).toBe(true);
  expect(cancha!.turno_actual).toEqual({
    start: "19:00",
    end: "20:30",
    reservado: false, // no es una reserva, y el front viejo sigue leyendo este campo
    motivo: "clase",
    detalle: "Vóley",
  });
});

test("no mezcla las clases de un espacio con los turnos de otro", () => {
  const filas = buildOccupancy(
    [
      { id: 1, place_id: 7, start_time: t("19:00"), end_time: t("20:00") },
      { id: 2, place_id: 8, start_time: t("19:00"), end_time: t("20:00") },
    ],
    [],
    [
      {
        place_id: 7,
        start_time: t("19:00"),
        end_time: t("20:00"),
        discipline: { name: "Vóley" },
      },
    ],
    "19:30",
  );

  expect(filas.find((f) => f.place_id === 7)!.ocupados).toBe(1);
  expect(filas.find((f) => f.place_id === 8)!.ocupados).toBe(0);
  expect(filas.find((f) => f.place_id === 8)!.ocupado_ahora).toBe(false);
});

test("fuera de todo turno no hay turno_actual", () => {
  const [cancha] = buildOccupancy(
    [{ id: 1, place_id: 7, start_time: t("19:00"), end_time: t("20:00") }],
    [{ schedule_id: 1 }],
    [],
    "08:00",
  );

  expect(cancha!.turno_actual).toBeNull();
  expect(cancha!.ocupado_ahora).toBe(false);
  expect(cancha!.reservados).toBe(1); // sigue contando para el resumen del día
});

test("el borde del turno: a la hora de fin ya no está en curso", () => {
  const enCurso = buildOccupancy(
    [{ id: 1, place_id: 7, start_time: t("19:00"), end_time: t("20:00") }],
    [{ schedule_id: 1 }],
    [],
    "20:00",
  );

  expect(enCurso[0]!.turno_actual).toBeNull();
});

// ---------------------------------------------------------------------------
// claseQuePisa — la misma regla la usan tres lugares (mostrar disponibilidad,
// crear un turno y reservarlo). Si acá cambia algo, cambia en los tres.
// ---------------------------------------------------------------------------

const clase = (desde: string, hasta: string, name = "Vóley") => ({
  start_time: t(desde),
  end_time: t(hasta),
  discipline: { name },
});

test("devuelve la clase que se pisa, con su nombre", () => {
  const encontrada = claseQuePisa(t("19:00"), t("20:00"), [clase("19:30", "21:00", "Hockey")]);
  expect(encontrada?.discipline.name).toBe("Hockey");
});

test("null cuando no hay ninguna clase", () => {
  expect(claseQuePisa(t("19:00"), t("20:00"), [])).toBeNull();
});

test("null si sólo se tocan en el borde: la clase termina cuando el turno empieza", () => {
  expect(claseQuePisa(t("19:00"), t("20:00"), [clase("18:00", "19:00")])).toBeNull();
  expect(claseQuePisa(t("19:00"), t("20:00"), [clase("20:00", "21:00")])).toBeNull();
});

test("detecta la clase aunque esté contenida dentro del turno", () => {
  expect(claseQuePisa(t("18:00"), t("22:00"), [clase("19:00", "20:00")])).not.toBeNull();
});

test("ignora las clases que no se pisan y encuentra la que sí", () => {
  const encontrada = claseQuePisa(t("19:00"), t("20:00"), [
    clase("08:00", "09:00", "Patín"),
    clase("19:45", "21:00", "Básquet"),
  ]);
  expect(encontrada?.discipline.name).toBe("Básquet");
});

// ---------------------------------------------------------------------------
// turnoQuePisa — espejo de claseQuePisa. Los tests son deliberadamente
// paralelos a los de arriba: si las dos direcciones de la regla se
// desincronizan, la diferencia tiene que saltar leyendo el archivo.
// ---------------------------------------------------------------------------

test("turnoQuePisa: devuelve el turno que se pisa", () => {
  const encontrado = turnoQuePisa(t("19:00"), t("20:30"), [schedule(4, "19:00", "20:00")]);
  expect(encontrado?.id).toBe(4);
});

test("turnoQuePisa: null cuando no hay ningún turno", () => {
  expect(turnoQuePisa(t("19:00"), t("20:00"), [])).toBeNull();
});

test("turnoQuePisa: null si sólo se tocan en el borde", () => {
  // S5.3 — una clase 20:00-21:00 sobre un turno que termina 20:00 es legal
  expect(turnoQuePisa(t("20:00"), t("21:00"), [schedule(1, "19:00", "20:00")])).toBeNull();
  expect(turnoQuePisa(t("19:00"), t("20:00"), [schedule(1, "20:00", "21:00")])).toBeNull();
});

test("turnoQuePisa: detecta el turno contenido dentro del rango de la clase", () => {
  expect(turnoQuePisa(t("18:00"), t("22:00"), [schedule(1, "19:00", "20:00")])).not.toBeNull();
});

test("turnoQuePisa: ignora los que no se pisan y encuentra el que sí", () => {
  const encontrado = turnoQuePisa(t("19:00"), t("20:30"), [
    schedule(1, "08:00", "09:00"),
    schedule(2, "17:00", "18:00"),
    schedule(3, "20:00", "21:00"),
  ]);
  expect(encontrado?.id).toBe(3);
});

test("turnoQuePisa: el caller filtra los dados de baja, así que una lista vacía no bloquea", () => {
  // S5.7 — un turno con active=null nunca llega acá; el where del caller lo saca.
  // Este test fija el contrato: la función no sabe de `active`, sólo de rangos.
  expect(turnoQuePisa(t("19:00"), t("20:00"), [])).toBeNull();
});
