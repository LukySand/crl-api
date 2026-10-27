/**
 * Periodicidad de las plantillas recurrentes (D5). Puro: fechas "YYYY-MM-DD" en el
 * huso del club, `hoy` por parámetro.
 *
 * Los meses se calculan siempre desde `inicio` (inicio + k·N, día recortado al
 * último del mes), nunca acumulando: 31-ene + 1 mes = 28/29-feb y a marzo vuelve el 31.
 * Días/semanas: k = floor(días(inicio, hoy) / paso).
 */

import type { DueRule } from "../../prisma/generated/client";
import { vencimientoDe } from "./payment-period";

export type Periodicidad =
  | { modo: "DiaDelMes"; dia: number; inicio: string; fin: string | null }
  | {
      modo: "CadaN";
      n: number;
      unidad: "Dias" | "Semanas" | "Meses";
      inicio: string;
      fin: string | null;
    };

const MS_DIA = 86_400_000;

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Día `dia` del mes (índice absoluto año*12+mes0), recortado al último día. */
function diaDeMes(mesAbs: number, dia: number): string {
  const y = Math.floor(mesAbs / 12);
  const m = mesAbs % 12;
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(dia, ultimo)));
}

const mesAbs = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Emisión del ciclo k (k ≥ 0) y una función para ubicar el k vigente a `hoy`.
 * `kPrimero` es el primer k cuya emisión cae dentro de la plantilla (≥ inicio).
 */
function motor(p: Periodicidad) {
  if (p.modo === "DiaDelMes") {
    const base = mesAbs(p.inicio);
    const kPrimero = diaDeMes(base, p.dia) >= p.inicio ? 0 : 1;
    return {
      kPrimero,
      emision: (k: number) => diaDeMes(base + k, p.dia),
      kHasta: (hoy: string) => {
        const k = mesAbs(hoy) - base;
        return diaDeMes(base + k, p.dia) <= hoy ? k : k - 1;
      },
    };
  }
  if (p.unidad === "Meses") {
    const base = mesAbs(p.inicio);
    const dia = Number(p.inicio.slice(8, 10));
    const emision = (k: number) => diaDeMes(base + k * p.n, dia);
    return {
      kPrimero: 0,
      emision,
      kHasta: (hoy: string) => {
        let k = Math.floor((mesAbs(hoy) - base) / p.n);
        if (k >= 0 && emision(k) > hoy) k -= 1;
        return k;
      },
    };
  }
  const paso = p.unidad === "Semanas" ? 7 * p.n : p.n;
  return {
    kPrimero: 0,
    emision: (k: number) => iso(ms(p.inicio) + k * paso * MS_DIA),
    kHasta: (hoy: string) => Math.floor((ms(hoy) - ms(p.inicio)) / (paso * MS_DIA)),
  };
}

const periodoDeEmision = (p: Periodicidad, emision: string) =>
  p.modo === "CadaN" && p.unidad !== "Meses" ? emision : emision.slice(0, 7);

/**
 * Último ciclo con emisión ≤ hoy dentro de [inicio, fin]. Un ciclo perdido entero no
 * se recupera (sin back-fill). Pasado `fin` la plantilla terminó: `null`.
 */
export function cicloVigente(
  p: Periodicidad,
  hoy: string,
): { period: string; emision: string } | null {
  if (hoy < p.inicio || (p.fin !== null && hoy > p.fin)) return null;
  const m = motor(p);
  const k = m.kHasta(hoy);
  if (k < m.kPrimero) return null;
  const emision = m.emision(k);
  return { period: periodoDeEmision(p, emision), emision };
}

/** Fecha de la próxima emisión estrictamente posterior a `hoy`, o `null` si ya terminó. */
export function proximoCiclo(p: Periodicidad, hoy: string): string | null {
  const m = motor(p);
  const k = Math.max(m.kHasta(hoy) + 1, m.kPrimero);
  const emision = m.emision(k);
  if (emision <= hoy) return null; // defensivo: no debería pasar
  return p.fin !== null && emision > p.fin ? null : emision;
}

/**
 * Vencimiento de un cargo emitido (D5). Nunca nace vencido: si la fecha calculada
 * es anterior a `creadoEl` (alta o corrida tardía) se corre al mismo día del mes
 * siguiente. `DiaDelMes` con valor NULL usa el ajuste del club (`diaAjustes`).
 */
export function vencimientoPara(
  r: { regla: DueRule; valor: number | null },
  period: string | null,
  creadoEl: string,
  diaAjustes: number,
): string | null {
  if (r.regla === "Ninguna") return null;
  if (r.regla === "DiasDesdeEmision") return iso(ms(creadoEl) + (r.valor ?? 0) * MS_DIA);

  const dia = r.valor ?? diaAjustes;
  // mensual: parte del mes del período (alineado con vencimientoDe); si no, del mes de creación
  const mensual = period !== null && period.length === 7;
  let mes = mesAbs(mensual ? `${period}-01` : creadoEl);
  for (;;) {
    const v = mensual
      ? vencimientoDe(`${Math.floor(mes / 12)}-${String((mes % 12) + 1).padStart(2, "0")}`, dia)
          .toISOString()
          .slice(0, 10)
      : diaDeMes(mes, dia);
    if (v >= creadoEl) return v;
    mes += 1;
  }
}
