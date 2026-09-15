/**
 * Reportes de ingresos para la gestión.
 *
 * Todo sale de `Payment`, que es la única tabla que sabe qué se cobró de verdad.
 * Antes de esto sólo se podía calcular lo *facturable* (reservas confirmadas ×
 * su tarifa), que no es lo mismo: no distingue lo cobrado de lo adeudado ni sabe
 * por qué medio entró la plata.
 *
 * Los totales filtran por `paid_at` (cuándo entró la plata) y no por `due_date`:
 * una cuota de agosto pagada en septiembre es ingreso de septiembre.
 */
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";
import { toNumber } from "../lib/payment";
import {
  BUCKETS,
  bucketDe,
  esBucketValido,
  rangoBuckets,
  todayInClub,
  ventanaPorDefecto,
} from "../lib/payment-period";

export const reportsRouter = Router();

// Los reportes son de gestión: muestran la plata del club entero.
reportsRouter.use(requireAuth, requireAdmin);

const AGRUPACIONES = ["mes", "concepto", "metodo", "disciplina", "espacio"] as const;
type Agrupacion = (typeof AGRUPACIONES)[number];

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

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
): { clave: string; total: number; cantidad: number }[] {
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

/** Conceptos por los que se puede filtrar. Espeja el enum FeeKind del schema. */
const CONCEPTOS = ["Reserva", "Disciplina", "Socio"] as const;

/**
 * GET /api/reports/ingresos?from=&to=&group=mes|concepto|metodo|disciplina|espacio&concept=
 *
 * Devuelve los totales del período y una serie agrupada. `from`/`to` son
 * inclusivos y opcionales; sin ellos toma todo el histórico. `concept` acota
 * todo —cobrado, pendiente y vencido— a un solo concepto.
 */
reportsRouter.get("/ingresos", async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query;
    const group = (req.query.group as string | undefined) ?? "mes";
    const concept = req.query.concept as string | undefined;

    if (!AGRUPACIONES.includes(group as Agrupacion)) {
      return res.status(400).json({
        success: false,
        error: `group tiene que ser uno de: ${AGRUPACIONES.join(", ")}`,
      });
    }
    if (concept !== undefined && concept !== "" && !CONCEPTOS.includes(concept as any)) {
      return res.status(400).json({
        success: false,
        error: `concept tiene que ser uno de: ${CONCEPTOS.join(", ")}`,
      });
    }
    for (const [nombre, valor] of [["from", from], ["to", to]] as const) {
      if (typeof valor === "string" && !FECHA_RE.test(valor)) {
        return res
          .status(400)
          .json({ success: false, error: `${nombre} debe ser YYYY-MM-DD` });
      }
    }
    if (typeof from === "string" && typeof to === "string" && from > to) {
      return res
        .status(400)
        .json({ success: false, error: "from no puede ser posterior a to" });
    }

    // `to` es inclusivo: el usuario pide "hasta el 30" y espera que el 30 entre.
    // Como paid_at tiene hora, se compara contra el día siguiente a medianoche.
    const desde = typeof from === "string" ? new Date(`${from}T00:00:00Z`) : undefined;
    const hasta =
      typeof to === "string"
        ? new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000)
        : undefined;

    const rangoPago =
      desde || hasta
        ? { paid_at: { ...(desde && { gte: desde }), ...(hasta && { lt: hasta }) } }
        : {};

    // Filtro de concepto, compartido por lo cobrado y lo adeudado: si el tablero
    // muestra canchas, la deuda que muestra también tiene que ser la de canchas.
    const filtroConcepto = concept ? { concept: concept as any } : {};

    const cobrados = await prisma.payment.findMany({
      where: { status: "Pagado", ...filtroConcepto, ...rangoPago },
      select: {
        amount: true,
        paid_at: true,
        concept: true,
        method: true,
        enrollment: { select: { discipline: { select: { name: true } } } },
        booking: {
          select: { schedule: { select: { place: { select: { name: true } } } } },
        },
      },
    });

    // La deuda no se filtra por el rango de cobro: se debe hoy, sin importar qué
    // ventana esté mirando la gestión.
    const pendientes = await prisma.payment.findMany({
      where: { status: { in: ["Pendiente", "EnRevision"] }, ...filtroConcepto },
      select: { amount: true, due_date: true },
    });

    const hoy = todayInClub();
    const vencidos = pendientes.filter(
      (p) => p.due_date.toISOString().slice(0, 10) < hoy,
    );

    const serie = (() => {
      switch (group as Agrupacion) {
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

    return res.json({
      success: true,
      rango: { from: from ?? null, to: to ?? null },
      group,
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
    });
  } catch (error) {
    console.error("Revenue report error:", error);
    return res.status(500).json({ success: false, error: "Error al generar el reporte" });
  }
});

/** Dimensiones por las que se puede abrir una serie. */
const DIMENSIONES = ["espacio", "disciplina", "concepto", "metodo"] as const;
type Dimension = (typeof DIMENSIONES)[number];

/**
 * GET /api/reports/series?bucket=dia|semana|mes&by=espacio|disciplina|concepto|metodo&from=&to=
 *
 * La serie temporal de ingresos, opcionalmente abierta por dimensión. Sin `by`
 * devuelve una sola serie con el total.
 *
 * Es el endpoint de dos dimensiones (tiempo × algo) que /ingresos no puede dar:
 * aquel agrupa por una sola cosa, así que "cuánto hizo cada cancha por día" no
 * salía de ahí.
 */
reportsRouter.get("/series", async (req: Request, res: Response) => {
  try {
    const bucket = (req.query.bucket as string | undefined) ?? "mes";
    const by = req.query.by as string | undefined;
    const { from, to } = req.query;

    if (!esBucketValido(bucket)) {
      return res.status(400).json({
        success: false,
        error: `bucket tiene que ser uno de: ${BUCKETS.join(", ")}`,
      });
    }
    if (by !== undefined && !DIMENSIONES.includes(by as Dimension)) {
      return res.status(400).json({
        success: false,
        error: `by tiene que ser uno de: ${DIMENSIONES.join(", ")}`,
      });
    }
    for (const [nombre, valor] of [["from", from], ["to", to]] as const) {
      if (typeof valor === "string" && !FECHA_RE.test(valor)) {
        return res
          .status(400)
          .json({ success: false, error: `${nombre} debe ser YYYY-MM-DD` });
      }
    }

    // Sin rango explícito se usa la ventana por defecto del bucket. El tope
    // existe porque `bucket=dia` sobre todo el historial son cientos de columnas.
    const porDefecto = ventanaPorDefecto(bucket);
    const desde = typeof from === "string" ? from : porDefecto.from;
    const hasta = typeof to === "string" ? to : porDefecto.to;
    if (desde > hasta) {
      return res
        .status(400)
        .json({ success: false, error: "from no puede ser posterior a to" });
    }

    const cobrados = await prisma.payment.findMany({
      where: {
        status: "Pagado",
        paid_at: {
          gte: new Date(`${desde}T00:00:00Z`),
          // `to` inclusivo: se pide "hasta el 30" y el 30 tiene que entrar.
          lt: new Date(new Date(`${hasta}T00:00:00Z`).getTime() + 86_400_000),
        },
      },
      select: {
        amount: true,
        paid_at: true,
        concept: true,
        method: true,
        enrollment: { select: { discipline: { select: { name: true } } } },
        booking: {
          select: { schedule: { select: { place: { select: { name: true } } } } },
        },
      },
    });

    // El eje X completo, sin huecos: un día sin cobros tiene que existir igual
    // con cero, si no el gráfico corre las columnas y miente sobre su forma.
    const buckets = rangoBuckets(desde, hasta, bucket);
    const indice = new Map(buckets.map((b, i) => [b, i]));

    const claveDe = (p: (typeof cobrados)[number]): string | null => {
      switch (by as Dimension | undefined) {
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

    return res.json({
      success: true,
      bucket,
      by: by ?? null,
      rango: { from: desde, to: hasta },
      buckets,
      series,
      total: series.reduce((t, s) => t + s.total, 0),
    });
  } catch (error) {
    console.error("Revenue series error:", error);
    return res.status(500).json({ success: false, error: "Error al generar la serie" });
  }
});

/**
 * GET /api/reports/morosos — quién debe y cuánto, de mayor a menor.
 *
 * Es la otra mitad de los ingresos: sin esto la gestión ve cuánta plata entró
 * pero no a quién hay que ir a buscar.
 */
reportsRouter.get("/morosos", async (_req: Request, res: Response) => {
  try {
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
      orderBy: { due_date: "asc" },
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
      if (p.due_date.toISOString().slice(0, 10) < hoy) {
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

    return res.json({
      success: true,
      morosos,
      total_vencido: morosos.reduce((t, m) => t + m.vencido, 0),
    });
  } catch (error) {
    console.error("Overdue report error:", error);
    return res.status(500).json({ success: false, error: "Error al generar el reporte" });
  }
});
