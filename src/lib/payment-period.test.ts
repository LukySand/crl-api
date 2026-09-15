// ponytail: igual que booking-date.test.ts, acá los bichos reales son de borde:
// meses que no llegan al día de vencimiento, cambio de año, y decidir si a una
// inscripción le corresponde la cuota de un mes que cursó a medias. Se testea
// eso, no los getters.
import { expect, test } from "bun:test";
import {
  DIA_VENCIMIENTO,
  bucketDe,
  cursoEnPeriodo,
  esBucketValido,
  esPeriodoValido,
  estaVencido,
  lunesDe,
  parsePeriodo,
  periodoActual,
  periodoDe,
  periodoSiguiente,
  rangoBuckets,
  vencimientoDe,
  ventanaPorDefecto,
} from "./payment-period";

test("acepta períodos bien formados y rechaza el resto", () => {
  expect(esPeriodoValido("2026-09")).toBe(true);
  expect(esPeriodoValido("2026-01")).toBe(true);
  expect(esPeriodoValido("2026-12")).toBe(true);

  expect(esPeriodoValido("2026-13")).toBe(false); // mes que no existe
  expect(esPeriodoValido("2026-00")).toBe(false);
  expect(esPeriodoValido("2026-9")).toBe(false); // sin cero adelante
  expect(esPeriodoValido("26-09")).toBe(false);
  expect(esPeriodoValido("2026-09-01")).toBe(false); // eso es una fecha
  expect(esPeriodoValido("")).toBe(false);
});

test("parsePeriodo devuelve el mes 1-12, no el 0-11 de Date", () => {
  expect(parsePeriodo("2026-01")).toEqual({ year: 2026, month: 1 });
  expect(parsePeriodo("2026-12")).toEqual({ year: 2026, month: 12 });
});

test("parsePeriodo tira con un período inválido en vez de devolver NaN", () => {
  expect(() => parsePeriodo("2026-13")).toThrow();
});

test("el vencimiento cae el día configurado, a medianoche UTC", () => {
  // Medianoche UTC como Booking.date: es un día sin hora.
  expect(vencimientoDe("2026-09").toISOString()).toBe("2026-09-10T00:00:00.000Z");
  expect(DIA_VENCIMIENTO).toBe(10);
});

test("si el mes no llega al día de vencimiento, cae en el último", () => {
  // Con DIA_VENCIMIENTO = 10 esto no se dispara nunca, pero el tope tiene que
  // estar igual: subirlo a 31 no puede hacer que febrero venza en marzo.
  const feb = vencimientoDe("2026-02");
  expect(feb.getUTCMonth()).toBe(1); // sigue siendo febrero
  expect(feb.getUTCDate()).toBeLessThanOrEqual(28);
});

test("periodoSiguiente cruza el año", () => {
  expect(periodoSiguiente("2026-01")).toBe("2026-02");
  expect(periodoSiguiente("2026-11")).toBe("2026-12");
  expect(periodoSiguiente("2026-12")).toBe("2027-01");
});

test("periodoSiguiente siempre deja el mes con dos dígitos", () => {
  expect(periodoSiguiente("2026-12")).toBe("2027-01");
  expect(periodoSiguiente("2026-08")).toBe("2026-09");
});

test("el orden lexicográfico de los períodos es el cronológico", () => {
  // De esto depende poder ordenar y comparar períodos sin parsearlos.
  const desordenados = ["2026-12", "2026-02", "2027-01", "2026-09"];
  expect([...desordenados].sort()).toEqual([
    "2026-02",
    "2026-09",
    "2026-12",
    "2027-01",
  ]);
});

test("periodoDe saca el mes de una fecha", () => {
  expect(periodoDe(new Date("2026-09-30T00:00:00Z"))).toBe("2026-09");
  expect(periodoDe(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
});

test("periodoActual tiene formato de período", () => {
  expect(esPeriodoValido(periodoActual())).toBe(true);
});

test("el día del vencimiento todavía no está vencido", () => {
  const vence = vencimientoDe("2026-09"); // 2026-09-10
  expect(estaVencido(vence, "2026-09-10")).toBe(false); // vence hoy: al día
  expect(estaVencido(vence, "2026-09-11")).toBe(true); // recién ahora
  expect(estaVencido(vence, "2026-09-09")).toBe(false);
});

test("estaVencido cruza el año sin confundirse", () => {
  const vence = vencimientoDe("2026-12"); // 2026-12-10
  expect(estaVencido(vence, "2027-01-02")).toBe(true);
  expect(estaVencido(vence, "2026-12-01")).toBe(false);
});

// ── A quién le corresponde la cuota del mes ──────────────────────────────

test("cobra el mes si cursó aunque sea un día", () => {
  // Se inscribió el 28 de septiembre: le corresponde la cuota de septiembre
  // igual, porque el club cobra el mes completo y no prorratea.
  const alta = new Date("2026-09-28T00:00:00Z");
  expect(cursoEnPeriodo(alta, null, "2026-09")).toBe(true);
});

test("no cobra meses anteriores al alta", () => {
  const alta = new Date("2026-09-01T00:00:00Z");
  expect(cursoEnPeriodo(alta, null, "2026-08")).toBe(false);
  expect(cursoEnPeriodo(alta, null, "2026-07")).toBe(false);
});

test("no cobra meses posteriores a la baja", () => {
  const alta = new Date("2026-03-01T00:00:00Z");
  const baja = new Date("2026-06-15T00:00:00Z");
  expect(cursoEnPeriodo(alta, baja, "2026-06")).toBe(true); // cursó medio junio
  expect(cursoEnPeriodo(alta, baja, "2026-07")).toBe(false);
});

test("una inscripción que abarca el mes entero lo cobra", () => {
  const alta = new Date("2026-03-01T00:00:00Z");
  expect(cursoEnPeriodo(alta, null, "2026-09")).toBe(true);
});

test("un período que empieza y termina dentro del mismo mes se cobra una vez", () => {
  const alta = new Date("2026-05-05T00:00:00Z");
  const baja = new Date("2026-05-20T00:00:00Z");
  expect(cursoEnPeriodo(alta, baja, "2026-05")).toBe(true);
  expect(cursoEnPeriodo(alta, baja, "2026-04")).toBe(false);
  expect(cursoEnPeriodo(alta, baja, "2026-06")).toBe(false);
});

test("el último instante del mes todavía cuenta", () => {
  // Alta 23:59:59 del 30 de septiembre: entró en septiembre, se cobra septiembre.
  const alta = new Date("2026-09-30T23:59:59Z");
  expect(cursoEnPeriodo(alta, null, "2026-09")).toBe(true);
  // Y un segundo después ya es octubre.
  const octubre = new Date("2026-10-01T00:00:00Z");
  expect(cursoEnPeriodo(octubre, null, "2026-09")).toBe(false);
});

// ── Buckets de tiempo ────────────────────────────────────────────────────

test("reconoce los buckets válidos", () => {
  expect(esBucketValido("dia")).toBe(true);
  expect(esBucketValido("semana")).toBe(true);
  expect(esBucketValido("mes")).toBe(true);
  expect(esBucketValido("año")).toBe(false);
  expect(esBucketValido("")).toBe(false);
});

test("la semana arranca el lunes, y el domingo pertenece a la que termina", () => {
  // 2026-09-14 es lunes.
  expect(lunesDe(new Date("2026-09-14T00:00:00Z"))).toBe("2026-09-14");
  expect(lunesDe(new Date("2026-09-17T00:00:00Z"))).toBe("2026-09-14"); // jueves
  // El domingo es el bicho: getUTCDay() lo da como 0, y sin el caso especial
  // abriría una semana propia de un solo día en vez de cerrar la anterior.
  expect(lunesDe(new Date("2026-09-20T00:00:00Z"))).toBe("2026-09-14");
  expect(lunesDe(new Date("2026-09-21T00:00:00Z"))).toBe("2026-09-21"); // lunes siguiente
});

test("lunesDe cruza el fin de mes y el de año", () => {
  expect(lunesDe(new Date("2026-10-01T00:00:00Z"))).toBe("2026-09-28");
  expect(lunesDe(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12-28");
});

test("bucketDe etiqueta según el tipo", () => {
  const jueves = new Date("2026-09-17T13:45:00Z");
  expect(bucketDe(jueves, "dia")).toBe("2026-09-17");
  expect(bucketDe(jueves, "semana")).toBe("2026-09-14");
  expect(bucketDe(jueves, "mes")).toBe("2026-09");
});

test("bucketDe ignora la hora: dos cobros del mismo día caen en el mismo cajón", () => {
  const manana = new Date("2026-09-17T08:00:00Z");
  const noche = new Date("2026-09-17T23:30:00Z");
  expect(bucketDe(manana, "dia")).toBe(bucketDe(noche, "dia"));
});

test("rangoBuckets no deja huecos: emite los días sin cobros también", () => {
  // Esta es la razón de ser de la función: si faltaran los días vacíos, el
  // gráfico correría las columnas y una semana muerta se vería llena.
  const dias = rangoBuckets("2026-09-14", "2026-09-20", "dia");
  expect(dias).toEqual([
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-19",
    "2026-09-20",
  ]);
});

test("rangoBuckets de semanas ancla el primer cajón en su lunes", () => {
  // Arranca un miércoles: el primer bucket igual tiene que ser el lunes previo,
  // si no el cajón queda cortado y no compara contra los siguientes.
  expect(rangoBuckets("2026-09-16", "2026-10-04", "semana")).toEqual([
    "2026-09-14",
    "2026-09-21",
    "2026-09-28",
  ]);
});

test("rangoBuckets de meses no se saltea febrero", () => {
  // Avanzar sumando 30 días se comería un mes corto; por eso va con Date.UTC.
  expect(rangoBuckets("2027-01-15", "2027-04-02", "mes")).toEqual([
    "2027-01",
    "2027-02",
    "2027-03",
    "2027-04",
  ]);
});

test("rangoBuckets cruza el año", () => {
  expect(rangoBuckets("2026-11-01", "2027-02-01", "mes")).toEqual([
    "2026-11",
    "2026-12",
    "2027-01",
    "2027-02",
  ]);
});

test("rangoBuckets de un solo día devuelve un bucket, no cero", () => {
  expect(rangoBuckets("2026-09-14", "2026-09-14", "dia")).toEqual(["2026-09-14"]);
  expect(rangoBuckets("2026-09-14", "2026-09-14", "mes")).toEqual(["2026-09"]);
});

test("rangoBuckets con el rango al revés devuelve vacío en vez de colgarse", () => {
  // Sin el guard, el while nunca termina.
  expect(rangoBuckets("2026-09-20", "2026-09-14", "dia")).toEqual([]);
  expect(rangoBuckets("no-es-fecha", "2026-09-14", "dia")).toEqual([]);
});

test("la ventana por defecto tapa el rango completo y no más", () => {
  // 30 días contando hoy = hoy y los 29 anteriores.
  const dia = ventanaPorDefecto("dia", "2026-09-14");
  expect(dia.to).toBe("2026-09-14");
  expect(rangoBuckets(dia.from, dia.to, "dia")).toHaveLength(30);

  const semana = ventanaPorDefecto("semana", "2026-09-14");
  expect(rangoBuckets(semana.from, semana.to, "semana")).toHaveLength(12);

  const mes = ventanaPorDefecto("mes", "2026-09-14");
  expect(rangoBuckets(mes.from, mes.to, "mes")).toHaveLength(12);
});

test("la ventana de meses arranca el día 1, no a mitad de mes", () => {
  expect(ventanaPorDefecto("mes", "2026-09-14").from).toBe("2025-10-01");
});
