/**
 * Períodos y vencimientos de las cuotas.
 *
 * Mismo criterio que booking-date.ts: las reglas temporales viven acá y nunca
 * sueltas en un handler. Y por las mismas razones de huso — "hoy" se calcula en
 * el huso del club, así que un server en UTC no adelanta el vencimiento un día.
 *
 * Un período es un mes calendario escrito "YYYY-MM". Se guarda como string y no
 * como fecha a propósito: es exactamente lo que la clave de idempotencia (`ref`)
 * necesita concatenar, y su orden lexicográfico ya es el cronológico, así que
 * ordenar y comparar períodos no necesita parsearlos.
 */

import { CLUB_TZ, parseDate, todayInClub } from "./booking-date";

/**
 * Día del mes en que vence una cuota.
 *
 * El 10 sale del mockup del front (CuotasScreen muestra "Vence 10/08"). Si el
 * mes no llega a ese día el vencimiento cae en el último — ver vencimientoDe().
 */
export const DIA_VENCIMIENTO = 10;

/** Formato de período. Acepta 1900-2199 para no dejar pasar un año tipeado mal. */
const PERIODO_RE = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/;

/** ¿Es un "YYYY-MM" válido? */
export function esPeriodoValido(periodo: string): boolean {
  return PERIODO_RE.test(periodo);
}

/** El período del mes corriente en el club, como "YYYY-MM". */
export function periodoActual(): string {
  return todayInClub().slice(0, 7);
}

/**
 * "YYYY-MM" → { year, month }, con `month` 1-12 (no el 0-11 de Date).
 * Tira si el período no es válido: el llamador valida antes con esPeriodoValido.
 */
export function parsePeriodo(periodo: string): { year: number; month: number } {
  if (!esPeriodoValido(periodo)) {
    throw new Error(`Período inválido: ${periodo}`);
  }
  return {
    year: Number(periodo.slice(0, 4)),
    month: Number(periodo.slice(5, 7)),
  };
}

/** Cantidad de días del mes de un período. */
function diasDelMes(year: number, month: number): number {
  // Día 0 del mes siguiente = último día de este. Todo en UTC para que no se
  // corra por huso.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Fecha de vencimiento de un período, como medianoche UTC (igual que
 * Booking.date, que también es un día sin hora).
 *
 * Si el mes no llega al DIA_VENCIMIENTO el vencimiento cae en el último día:
 * con día 31 configurado, febrero vencería el 3 de marzo si se dejara desbordar
 * — y una cuota no puede vencer en el período siguiente.
 */
export function vencimientoDe(periodo: string): Date {
  const { year, month } = parsePeriodo(periodo);
  const dia = Math.min(DIA_VENCIMIENTO, diasDelMes(year, month));
  return new Date(Date.UTC(year, month - 1, dia));
}

/** El período siguiente. "2026-12" → "2027-01". */
export function periodoSiguiente(periodo: string): string {
  const { year, month } = parsePeriodo(periodo);
  const siguiente = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return `${siguiente.y}-${String(siguiente.m).padStart(2, "0")}`;
}

/** El período al que pertenece una fecha. */
export function periodoDe(fecha: Date): string {
  return fecha.toISOString().slice(0, 7);
}

/**
 * ¿Ya pasó el vencimiento?
 *
 * Deriva el estado "vencido" en vez de guardarlo (ver el comentario en el modelo
 * Payment): comparar strings "YYYY-MM-DD" alcanza porque en ese formato el orden
 * lexicográfico es el cronológico, el mismo truco que todayInClub().
 *
 * El día del vencimiento todavía NO está vencido: se vence al día siguiente.
 *
 * `hoy` entra por parámetro para poder testear sin tocar el reloj del sistema.
 */
export function estaVencido(dueDate: Date, hoy: string = todayInClub()): boolean {
  return dueDate.toISOString().slice(0, 10) < hoy;
}

/**
 * ¿La inscripción estuvo activa en algún momento del período?
 *
 * Decide si a un socio le corresponde la cuota de ese mes: se cobra si cursó
 * aunque sea parte del mes. `createdAt` es el alta del período y `leftAt` la
 * baja (null mientras sigue cursando).
 *
 * Se compara contra los bordes del mes y no contra el día del alta porque el
 * club cobra el mes completo, no prorrateado.
 */
export function cursoEnPeriodo(
  createdAt: Date,
  leftAt: Date | null,
  periodo: string,
): boolean {
  const { year, month } = parsePeriodo(periodo);
  const inicioMes = Date.UTC(year, month - 1, 1);
  const finMes = Date.UTC(year, month, 1) - 1; // último instante del mes

  if (createdAt.getTime() > finMes) return false; // se inscribió después
  if (leftAt && leftAt.getTime() < inicioMes) return false; // se fue antes
  return true;
}

// ── Buckets de tiempo (para los reportes) ────────────────────────────────
//
// Un bucket es el cajón temporal en el que se agrupan los cobros de una serie.
// Se identifica siempre por un string cuyo orden lexicográfico es el
// cronológico, igual que el período: "2026-09-14" (día), "2026-09-14" (la
// semana, etiquetada por su lunes) y "2026-09" (mes). Así ordenar y comparar
// buckets no necesita parsearlos.

export const BUCKETS = ["dia", "semana", "mes"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** ¿Es un bucket conocido? */
export function esBucketValido(b: string): b is Bucket {
  return (BUCKETS as readonly string[]).includes(b);
}

/** "YYYY-MM-DD" de una fecha, en UTC. */
function isoDia(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/**
 * El lunes de la semana de una fecha, como "YYYY-MM-DD".
 *
 * La semana arranca el lunes (ISO), no el domingo: es lo que espera alguien que
 * mira "la semana del 14/9" en Argentina. `getUTCDay()` da 0 para domingo, así
 * que el domingo retrocede 6 días y no 0 — si no, cada domingo abriría una
 * semana propia de un día.
 */
export function lunesDe(fecha: Date): string {
  const dia = fecha.getUTCDay();
  const retroceso = dia === 0 ? 6 : dia - 1;
  return isoDia(new Date(fecha.getTime() - retroceso * 86_400_000));
}

/** La etiqueta de bucket que le corresponde a una fecha. */
export function bucketDe(fecha: Date, bucket: Bucket): string {
  switch (bucket) {
    case "dia":
      return isoDia(fecha);
    case "semana":
      return lunesDe(fecha);
    case "mes":
      return fecha.toISOString().slice(0, 7);
  }
}

/** Cuántos buckets de cada tipo se muestran por defecto. */
const VENTANA_POR_DEFECTO: Record<Bucket, number> = {
  dia: 30,
  semana: 12,
  mes: 12,
};

/**
 * El rango por defecto de un bucket, como { from, to } en "YYYY-MM-DD".
 *
 * Existe porque sin tope `bucket=dia` sobre todo el historial devuelve cientos
 * de columnas y el gráfico no se lee. Termina hoy y arranca tantos buckets
 * atrás como diga VENTANA_POR_DEFECTO.
 */
export function ventanaPorDefecto(
  bucket: Bucket,
  hoy: string = todayInClub(),
): { from: string; to: string } {
  const fin = parseDate(hoy);
  const cantidad = VENTANA_POR_DEFECTO[bucket];

  if (bucket === "mes") {
    const inicio = new Date(
      Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - (cantidad - 1), 1),
    );
    return { from: isoDia(inicio), to: hoy };
  }

  const paso = bucket === "dia" ? 1 : 7;
  const desde = bucket === "semana" ? parseDate(lunesDe(fin)) : fin;
  return {
    from: isoDia(new Date(desde.getTime() - (cantidad - 1) * paso * 86_400_000)),
    to: hoy,
  };
}

/**
 * Todas las etiquetas de bucket entre dos fechas, en orden y **sin huecos**.
 *
 * ponytail: los huecos son la razón de ser de esta función. Agrupando sólo los
 * cobros que existen, un día sin ingresos no aparece — y el gráfico miente sobre
 * su propia forma: una semana muerta se dibuja igual de apretada que una llena,
 * porque las columnas se corren para tapar el vacío. Acá se emiten todos los
 * cajones y el handler los llena con cero.
 */
export function rangoBuckets(from: string, to: string, bucket: Bucket): string[] {
  const inicio = parseDate(from);
  const fin = parseDate(to);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) return [];
  if (inicio > fin) return [];

  const etiquetas: string[] = [];

  if (bucket === "mes") {
    // Se avanza mes a mes con Date.UTC y no sumando días: los meses no miden lo
    // mismo y sumar 30 días se saltearía febrero.
    let y = inicio.getUTCFullYear();
    let m = inicio.getUTCMonth();
    const ultimo = fin.toISOString().slice(0, 7);
    for (;;) {
      const etiqueta = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
      etiquetas.push(etiqueta);
      if (etiqueta >= ultimo) break;
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
    return etiquetas;
  }

  const paso = bucket === "dia" ? 86_400_000 : 7 * 86_400_000;
  // La semana se ancla en su lunes para que el primer cajón no quede cortado.
  let cursor = bucket === "semana" ? parseDate(lunesDe(inicio)) : inicio;
  while (cursor <= fin) {
    etiquetas.push(isoDia(cursor));
    cursor = new Date(cursor.getTime() + paso);
  }
  return etiquetas;
}

/** Re-exportados para que quien maneje cuotas no tenga que importar de dos lados. */
export { CLUB_TZ, parseDate, todayInClub };
