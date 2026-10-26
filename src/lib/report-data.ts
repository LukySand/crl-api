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

/** Conceptos por los que se puede filtrar. Espeja el enum FeeKind del schema. */
export const CONCEPTOS = ["Reserva", "Disciplina", "Socio"] as const;

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
  enrollment: { select: { discipline: { select: { name: true } } } },
  booking: {
    select: { schedule: { select: { place: { select: { name: true } } } } },
  },
} as const;

/**
 * Totales del período y una serie agrupada. `from`/`to` son inclusivos y
 * opcionales; sin ellos toma todo el histórico. `concept` acota todo —cobrado,
 * pendiente y vencido— a un solo concepto.
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

  const rangoPago =
    desde || hasta
      ? { paid_at: { ...(desde && { gte: desde }), ...(hasta && { lt: hasta }) } }
      : {};

  // Filtro de concepto, compartido por lo cobrado y lo adeudado: si el tablero
  // muestra canchas, la deuda que muestra también tiene que ser la de canchas.
  const filtroConcepto = concept ? { concept: concept as any } : {};

  const cobrados = await prisma.payment.findMany({
    where: { status: "Pagado", ...filtroConcepto, ...rangoPago },
    select: SELECT_COBRO,
  });

  // La deuda no se filtra por el rango de cobro: se debe hoy, sin importar qué
  // ventana esté mirando la gestión.
  const pendientes = await prisma.payment.findMany({
    where: { status: { in: ["Pendiente", "EnRevision"] }, ...filtroConcepto },
    select: { amount: true, due_date: true },
  });

  const hoy = todayInClub();
  const vencidos = pendientes.filter((p) => p.due_date != null && p.due_date.toISOString().slice(0, 10) < hoy);

  const serie = (() => {
    switch (group) {
      case "mes":
        // Ordenado cronológicamente y no por monto: es una serie de tiempo.
        return agrupar(
          cobrados,
          (p) => p.paid_at?.toISOString().slice(0, 7) ?? null,
          (p) => toNumber(p.amount),
        ).sort((a, b) => a.clave.localeCompare(b.clave));
      case "concepto":
        return agrupar(cobrados, (p) => p.concept, (p) => toNumber(p.amount));
      case "metodo":
        return agrupar(cobrados, (p) => p.method, (p) => toNumber(p.amount));
      case "disciplina":
        return agrupar(
          cobrados.filter((p) => p.concept === "Disciplina"),
          (p) => p.enrollment?.discipline.name ?? null,
          (p) => toNumber(p.amount),
        );
      case "espacio":
        return agrupar(
          cobrados.filter((p) => p.concept === "Reserva"),
          (p) => p.booking?.schedule.place.name ?? null,
          (p) => toNumber(p.amount),
        );
    }
  })();

  return {
    totales: {
      cobrado: sumar(cobrados),
      cobros: cobrados.length,
      pendiente: sumar(pendientes),
      // Cuántas cuotas faltan cobrar, no sólo cuánta plata: el tablero muestra
      // las dos cosas y "11 cuotas" dice algo que "$98.000" solo no dice.
      cantidad_pendiente: pendientes.length,
      vencido: sumar(vencidos),
      cantidad_vencida: vencidos.length,
    },
    serie,
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

  const cobrados = await prisma.payment.findMany({
    where: {
      status: "Pagado",
      paid_at: {
        gte: new Date(`${desde}T00:00:00Z`),
        // `to` inclusivo: se pide "hasta el 30" y el 30 tiene que entrar.
        lt: finDeDia(hasta),
      },
    },
    select: SELECT_COBRO,
  });

  // El eje X completo, sin huecos: un día sin cobros tiene que existir igual
  // con cero, si no el gráfico corre las columnas y miente sobre su forma.
  const buckets = rangoBuckets(desde, hasta, bucket);
  const indice = new Map(buckets.map((b, i) => [b, i]));

  const claveDe = (p: (typeof cobrados)[number]): string | null => {
    switch (by) {
      case "espacio":
        return p.booking?.schedule.place.name ?? null;
      case "disciplina":
        return p.enrollment?.discipline.name ?? null;
      case "concepto":
        return p.concept;
      case "metodo":
        return p.method;
      default:
        return "Total";
    }
  };

  // clave → array de montos alineado con `buckets`.
  const acumulado = new Map<string, number[]>();
  for (const p of cobrados) {
    if (!p.paid_at) continue;
    const i = indice.get(bucketDe(p.paid_at, bucket));
    // Un cobro fuera del eje no debería existir (la query ya filtró por rango),
    // pero si el bucket no cae en la grilla se saltea antes que romper el array.
    if (i === undefined) continue;

    // Filtrar por dimensión y no mapear a "Sin definir" cuando `by` la excluye:
    // una reserva no tiene disciplina, y meterla en un cajón "Sin definir"
    // inflaría el gráfico de disciplinas con plata de canchas.
    if (by === "espacio" && p.concept !== "Reserva") continue;
    if (by === "disciplina" && p.concept !== "Disciplina") continue;

    const clave = claveDe(p) ?? "Sin definir";
    let puntos = acumulado.get(clave);
    if (!puntos) {
      puntos = new Array(buckets.length).fill(0);
      acumulado.set(clave, puntos);
    }
    puntos[i]! += toNumber(p.amount);
  }

  const series = [...acumulado.entries()]
    .map(([clave, puntos]) => ({
      clave,
      total: puntos.reduce((t, n) => t + n, 0),
      puntos,
    }))
    // De mayor a menor: el orden decide el apilado, y la cancha que más factura
    // queda abajo, que es donde se lee mejor.
    .sort((a, b) => b.total - a.total);

  return {
    bucket,
    by: by ?? null,
    rango: { from: desde, to: hasta },
    buckets,
    series,
    total: series.reduce((t, s) => t + s.total, 0),
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
