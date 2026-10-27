/**
 * Cuentas de los reportes de ingresos.
 *
 * Viven acá y no en los handlers de `routes/reports.ts` porque las usan dos
 * lugares: los endpoints JSON que dibujan la pantalla y la exportación a
 * Excel/PDF. Así el archivo descargado sale del mismo cálculo que ve la gestión
 * y no pueden diferir.
 */
import prisma from "./prisma";
import { toNumber } from "./payment";
import { bucketDe, rangoBuckets, todayInClub, type Bucket } from "./payment-period";

export const AGRUPACIONES = ["mes", "concepto", "metodo", "disciplina", "espacio"] as const;
export type Agrupacion = (typeof AGRUPACIONES)[number];

/** Forma de la `key` de un tipo de cargo (la misma de `charge-catalog.ts`). `concept` se valida por esto, no por una lista fija. */
export const CONCEPTO_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;

/** Dimensiones por las que se puede abrir una serie. */
export const DIMENSIONES = ["espacio", "disciplina", "concepto", "metodo"] as const;
export type Dimension = (typeof DIMENSIONES)[number];

export const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tope de columnas por corte: más que esto las barras quedan tan finas que el
 * gráfico no se lee. Día: 62 (dos meses). Semana: 54 (un año: 53 o 54 lunes según el año). Mes: 72
 * (seis años, que es lo que ofrece el selector de años del front). Están
 * duplicados en `CRL/src/app/pages/admin/reportes.ts` (`LIMITES`): el front avisa
 * antes de pedir y este tope es la red de seguridad. Si cambia uno, cambia el otro.
 */
export const LIMITE_COLUMNAS: Record<Bucket, number> = { dia: 62, semana: 54, mes: 72 };

const LIMITE_HUMANO: Record<Bucket, string> = { dia: "2 meses", semana: "1 año", mes: "6 años" };
const UNIDAD: Record<Bucket, string> = { dia: "días", semana: "semanas", mes: "meses" };
const CORTE: Record<Bucket, string> = { dia: "día", semana: "semana", mes: "mes" };

/** Mensaje si el rango da demasiadas columnas para el corte pedido; `null` si entra. */
export function errorDeRango(bucket: Bucket, from: string, to: string): string | null {
  const columnas = rangoBuckets(from, to, bucket).length;
  if (columnas <= LIMITE_COLUMNAS[bucket]) return null;
  return (
    `El período tiene ${columnas} ${UNIDAD[bucket]} y por ${CORTE[bucket]} ` +
    `se lee bien hasta ${LIMITE_HUMANO[bucket]}. Probá con un período más corto o agrupando por un corte más grande.`
  );
}

/** Suma montos de una lista de filas con `amount`. */
function sumar(filas: { amount: unknown }[]): number {
  return filas.reduce((total, f) => total + toNumber(f.amount as any), 0);
}

/**
 * Acumula { clave → total, cantidad } y devuelve la serie ordenada de mayor a
 * menor. Se hace en JS y no con groupBy porque agrupar por disciplina o espacio
 * necesita navegar relaciones (enrollment → discipline, booking → schedule →
 * place) y `groupBy` de Prisma no hace joins. A escala de un club son unos miles
 * de filas por año; si algún día molesta, es el momento de bajar a $queryRaw.
 */
function agrupar<T>(
  filas: T[],
  clave: (fila: T) => string | null,
  monto: (fila: T) => number,
) {
  const acc = new Map<string, { total: number; cantidad: number }>();
  for (const fila of filas) {
    const k = clave(fila) ?? "Sin definir";
    const actual = acc.get(k) ?? { total: 0, cantidad: 0 };
    actual.total += monto(fila);
    actual.cantidad += 1;
    acc.set(k, actual);
  }
  return [...acc.entries()]
    .map(([clave, v]) => ({ clave, ...v }))
    .sort((a, b) => b.total - a.total);
}

/** Medianoche UTC del día siguiente: `to` es inclusivo y `paid_at` trae hora. */
function finDeDia(dia: string): Date {
  return new Date(new Date(`${dia}T00:00:00Z`).getTime() + 86_400_000);
}

const SELECT_COBRO = {
  amount: true,
  paid_at: true,
  concept: true,
  method: true,
  type: { select: { name: true } },
  enrollment: { select: { discipline: { select: { name: true } } } },
  booking: {
    select: { schedule: { select: { place: { select: { name: true } } } } },
  },
} as const;

/** Egreso: un reembolso con las dimensiones de la fila que revierte (D22). */
const SELECT_REEMBOLSO = {
  amount: true,
  refunded_at: true,
  payment: { select: SELECT_COBRO },
} as const;

/**
 * Ingreso: tiene `paid_at` y quedó `Pagado` o `Anulado`. Un reembolso deja la
 * fila `Anulado` pero conserva `paid_at`: el ingreso sigue en su mes y el egreso
 * va aparte (D22). Una reversión manual borra `paid_at`, así que esa fila ya no
 * entra acá aunque su mes esté cerrado (D22b).
 */
const ESTADOS_INGRESO = ["Pagado", "Anulado"] as const;

type Rango = { gte?: Date; lt?: Date };

/** Reembolsos que son egreso: aprobados o devueltos en mano (`refunded_at`) y que descuentan ingreso. */
function whereEgreso(rango: Rango, concept?: string) {
  return {
    refunded_at: { not: null, ...rango },
    income_reversal: true,
    ...(concept ? { payment: { is: { concept } } } : {}),
  };
}

type FilaDimension = {
  concept: string;
  method: string | null;
  enrollment: { discipline: { name: string } } | null;
  booking: { schedule: { place: { name: string } } } | null;
};

/**
 * Clave de una fila en una dimensión. `undefined` = la fila no pertenece a esa
 * dimensión (una reserva no tiene disciplina: meterla en "Sin definir" inflaría
 * el gráfico de disciplinas con plata de canchas); `null` = pertenece pero sin dato.
 */
export function claveDe(by: Dimension | "total", p: FilaDimension): string | null | undefined {
  switch (by) {
    case "espacio":
      return p.concept === "Reserva" ? (p.booking?.schedule.place.name ?? null) : undefined;
    case "disciplina":
      return p.concept === "Disciplina" ? (p.enrollment?.discipline.name ?? null) : undefined;
    case "concepto":
      return p.concept;
    case "metodo":
      return p.method;
    case "total":
      return "Total";
  }
}

/** Misma clave para un reembolso: sin fila asignada va a "Sin definir" (D22). */
export function claveDeEgreso(by: Dimension | "total", p: FilaDimension | null): string | null | undefined {
  if (!p) return by === "total" ? "Total" : null;
  return claveDe(by, p);
}

export interface Movimiento {
  clave: string | null;
  fecha: Date;
  monto: number;
}

/**
 * Ingresos y egresos por clave. `total` es neto (cobrado − reembolsado); `cantidad`
 * cuenta sólo los cobros. Una clave con sólo reembolsos aparece con total negativo.
 */
export function agruparNeto(ingresos: Movimiento[], egresos: Movimiento[]) {
  const acc = new Map<string, { cobrado: number; reembolsado: number; cantidad: number }>();
  const de = (clave: string | null) => {
    const k = clave ?? "Sin definir";
    let v = acc.get(k);
    if (!v) acc.set(k, (v = { cobrado: 0, reembolsado: 0, cantidad: 0 }));
    return v;
  };
  for (const i of ingresos) {
    const v = de(i.clave);
    v.cobrado += i.monto;
    v.cantidad += 1;
  }
  for (const e of egresos) de(e.clave).reembolsado += e.monto;
  return [...acc.entries()]
    .map(([clave, v]) => ({ clave, ...v, total: v.cobrado - v.reembolsado }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Series por bucket: ingreso bruto por clave (`series`, alineadas con `buckets`),
 * reembolsos por bucket (`reembolsos`) y `total` neto. Lo que cae fuera de la
 * grilla se saltea antes que romper el array.
 */
export function armarSerie(ingresos: Movimiento[], egresos: Movimiento[], buckets: string[], bucket: Bucket) {
  const indice = new Map(buckets.map((b, i) => [b, i]));
  const acumulado = new Map<string, number[]>();
  for (const m of ingresos) {
    const i = indice.get(bucketDe(m.fecha, bucket));
    if (i === undefined) continue;
    const clave = m.clave ?? "Sin definir";
    let puntos = acumulado.get(clave);
    if (!puntos) acumulado.set(clave, (puntos = new Array(buckets.length).fill(0)));
    puntos[i]! += m.monto;
  }
  const reembolsos: number[] = new Array(buckets.length).fill(0);
  for (const m of egresos) {
    const i = indice.get(bucketDe(m.fecha, bucket));
    if (i !== undefined) reembolsos[i]! += m.monto;
  }
  const series = [...acumulado.entries()]
    .map(([clave, puntos]) => ({ clave, total: puntos.reduce((t, n) => t + n, 0), puntos }))
    // De mayor a menor: el orden decide el apilado, y la cancha que más factura
    // queda abajo, que es donde se lee mejor.
    .sort((a, b) => b.total - a.total);
  const bruto = series.reduce((t, s) => t + s.total, 0);
  return { series, reembolsos, total: bruto - reembolsos.reduce((t, n) => t + n, 0) };
}

/**
 * Totales del período y una serie agrupada. `from`/`to` son inclusivos y
 * opcionales; sin ellos toma todo el histórico. `concept` acota todo —cobrado,
 * reembolsado, pendiente y vencido— a un solo concepto (la `key` de un tipo de cargo).
 */
export async function calcularIngresos(opts: {
  from?: string;
  to?: string;
  group: Agrupacion;
  concept?: string;
}) {
  const { from, to, group, concept } = opts;

  const desde = from ? new Date(`${from}T00:00:00Z`) : undefined;
  const hasta = to ? finDeDia(to) : undefined;
  const rango: Rango = { ...(desde && { gte: desde }), ...(hasta && { lt: hasta }) };

  // Filtro de concepto, compartido por lo cobrado y lo adeudado: si el tablero
  // muestra canchas, la deuda que muestra también tiene que ser la de canchas.
  const filtroConcepto = concept ? { concept } : {};

  const cobrados = await prisma.payment.findMany({
    where: { status: { in: [...ESTADOS_INGRESO] }, ...filtroConcepto, paid_at: { not: null, ...rango } },
    select: SELECT_COBRO,
  });
  const reembolsos = await prisma.refund.findMany({
    where: whereEgreso(rango, concept),
    select: SELECT_REEMBOLSO,
  });

  // La deuda no se filtra por el rango de cobro: se debe hoy, sin importar qué
  // ventana esté mirando la gestión.
  const pendientes = await prisma.payment.findMany({
    where: { status: { in: ["Pendiente", "EnRevision"] }, ...filtroConcepto },
    select: { amount: true, due_date: true },
  });

  const hoy = todayInClub();
  const vencidos = pendientes.filter((p) => p.due_date != null && p.due_date.toISOString().slice(0, 10) < hoy);

  const claveGrupo = (g: Agrupacion, p: FilaDimension | null, fecha: Date, egreso: boolean) =>
    g === "mes"
      ? fecha.toISOString().slice(0, 7)
      : egreso
        ? claveDeEgreso(g, p)
        : claveDe(g, p!);

  const aMov = (egreso: boolean) => (f: any): Movimiento | null => {
    const p = egreso ? f.payment : f;
    const fecha: Date | null = egreso ? f.refunded_at : f.paid_at;
    const clave = fecha && claveGrupo(group, p, fecha, egreso);
    if (!fecha || clave === undefined) return null;
    return { clave, fecha, monto: toNumber(f.amount) };
  };
  const quitarNulos = (m: (Movimiento | null)[]) => m.filter((x): x is Movimiento => x !== null);

  const serie = agruparNeto(quitarNulos(cobrados.map(aMov(false))), quitarNulos(reembolsos.map(aMov(true))));
  // Ordenado cronológicamente y no por monto: es una serie de tiempo.
  if (group === "mes") serie.sort((a, b) => a.clave.localeCompare(b.clave));

  // El nombre del tipo para `group=concepto`: la clave es estable pero no se lee.
  const nombres = new Map<string, string>();
  for (const p of [...cobrados, ...reembolsos.flatMap((r) => (r.payment ? [r.payment] : []))]) {
    nombres.set(p.concept, p.type.name);
  }

  const cobrado = sumar(cobrados);
  const reembolsado = sumar(reembolsos);

  return {
    totales: {
      cobrado,
      cobros: cobrados.length,
      reembolsado,
      reembolsos: reembolsos.length,
      neto: cobrado - reembolsado,
      pendiente: sumar(pendientes),
      // Cuántas cuotas faltan cobrar, no sólo cuánta plata: el tablero muestra
      // las dos cosas y "11 cuotas" dice algo que "$98.000" solo no dice.
      cantidad_pendiente: pendientes.length,
      vencido: sumar(vencidos),
      cantidad_vencida: vencidos.length,
    },
    serie:
      group === "concepto"
        ? serie.map((s) => ({ ...s, etiqueta: nombres.get(s.clave) ?? s.clave }))
        : serie,
  };
}

/**
 * La serie temporal de ingresos, opcionalmente abierta por dimensión. `from` y
 * `to` ya vienen resueltos (con la ventana por defecto del bucket aplicada).
 */
export async function calcularSerie(opts: {
  bucket: Bucket;
  by?: Dimension;
  from: string;
  to: string;
}) {
  const { bucket, by, from: desde, to: hasta } = opts;

  // `to` inclusivo: se pide "hasta el 30" y el 30 tiene que entrar.
  const rango: Rango = { gte: new Date(`${desde}T00:00:00Z`), lt: finDeDia(hasta) };

  const cobrados = await prisma.payment.findMany({
    where: { status: { in: [...ESTADOS_INGRESO] }, paid_at: rango },
    select: SELECT_COBRO,
  });
  const reembolsos = await prisma.refund.findMany({ where: whereEgreso(rango), select: SELECT_REEMBOLSO });

  // El eje X completo, sin huecos: un día sin cobros tiene que existir igual
  // con cero, si no el gráfico corre las columnas y miente sobre su forma.
  const buckets = rangoBuckets(desde, hasta, bucket);
  const dim = by ?? "total";

  const ingresos: Movimiento[] = [];
  for (const p of cobrados) {
    const clave = claveDe(dim, p);
    if (p.paid_at && clave !== undefined) ingresos.push({ clave, fecha: p.paid_at, monto: toNumber(p.amount) });
  }
  const egresos: Movimiento[] = [];
  for (const r of reembolsos) {
    const clave = claveDeEgreso(dim, r.payment);
    if (r.refunded_at && clave !== undefined) {
      egresos.push({ clave, fecha: r.refunded_at, monto: toNumber(r.amount) });
    }
  }

  return {
    bucket,
    by: by ?? null,
    rango: { from: desde, to: hasta },
    buckets,
    ...armarSerie(ingresos, egresos, buckets, bucket),
  };
}

/** Quién debe y cuánto, de mayor a menor. */
export async function calcularMorosos() {
  const pendientes = await prisma.payment.findMany({
    where: { status: { in: ["Pendiente", "EnRevision"] } },
    select: {
      amount: true,
      due_date: true,
      status: true,
      user: {
        select: { id: true, name: true, last_name: true, dni: true, email: true, celular: true },
      },
    },
    orderBy: { due_date: { sort: "asc", nulls: "last" } },
  });

  const hoy = todayInClub();

  const porSocio = new Map<
    string,
    {
      user: (typeof pendientes)[number]["user"];
      total: number;
      vencido: number;
      cuotas: number;
      cuotas_vencidas: number;
      vencimiento_mas_viejo: Date | null;
    }
  >();

  for (const p of pendientes) {
    const actual = porSocio.get(p.user.id) ?? {
      user: p.user,
      total: 0,
      vencido: 0,
      cuotas: 0,
      cuotas_vencidas: 0,
      vencimiento_mas_viejo: null,
    };
    const monto = toNumber(p.amount);
    actual.total += monto;
    actual.cuotas += 1;
    if (p.due_date && p.due_date.toISOString().slice(0, 10) < hoy) {
      actual.vencido += monto;
      actual.cuotas_vencidas += 1;
      // Las filas vienen ordenadas por vencimiento, así que la primera vencida
      // que aparece de cada socio ya es la más vieja.
      actual.vencimiento_mas_viejo ??= p.due_date;
    }
    porSocio.set(p.user.id, actual);
  }

  const morosos = [...porSocio.values()]
    .filter((m) => m.vencido > 0)
    .sort((a, b) => b.vencido - a.vencido);

  return {
    morosos,
    total_vencido: morosos.reduce((t, m) => t + m.vencido, 0),
  };
}
