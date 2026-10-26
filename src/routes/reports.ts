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
import { requireAuth, requireAdmin } from "../lib/auth";
import { todayInClub } from "../lib/booking-date";
import { BUCKETS, esBucketValido, ventanaPorDefecto } from "../lib/payment-period";
import {
  AGRUPACIONES,
  CONCEPTOS,
  DIMENSIONES,
  FECHA_RE,
  calcularIngresos,
  calcularMorosos,
  calcularSerie,
  errorDeRango,
  type Agrupacion,
  type Dimension,
} from "../lib/report-data";
import { aPdf, aXlsx, armarReporte, fechaHoraClub, listaDeQuery } from "../lib/report-export";

export const reportsRouter = Router();

// Los reportes son de gestión: muestran la plata del club entero.
reportsRouter.use(requireAuth, requireAdmin);

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

    const resultado = await calcularIngresos({
      from: typeof from === "string" ? from : undefined,
      to: typeof to === "string" ? to : undefined,
      group: group as Agrupacion,
      concept: concept || undefined,
    });

    return res.json({
      success: true,
      rango: { from: from ?? null, to: to ?? null },
      group,
      ...resultado,
    });
  } catch (error) {
    console.error("Revenue report error:", error);
    return res.status(500).json({ success: false, error: "Error al generar el reporte" });
  }
});

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
    const demasiado = errorDeRango(bucket, desde, hasta);
    if (demasiado) return res.status(400).json({ success: false, error: demasiado });

    const resultado = await calcularSerie({
      bucket,
      by: by as Dimension | undefined,
      from: desde,
      to: hasta,
    });

    return res.json({ success: true, ...resultado });
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
    return res.json({ success: true, ...(await calcularMorosos()) });
  } catch (error) {
    console.error("Overdue report error:", error);
    return res.status(500).json({ success: false, error: "Error al generar el reporte" });
  }
});

const FORMATOS_EXPORT = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;
type FormatoExport = keyof typeof FORMATOS_EXPORT;

/**
 * GET /api/reports/export?format=xlsx|pdf&bucket=dia|semana|mes&from=&to=&canchas=&disciplinas=
 *
 * Descarga lo mismo que muestra la pantalla de reportes: resumen, ingresos por
 * cancha y por disciplina, y morosos. `from` y `to` acotan el período (sin ellos,
 * la ventana por defecto del corte); el resumen cobrado también se acota. `canchas` y `disciplinas` son las series que
 * la gestión tiene tildadas (se repite el parámetro, uno por nombre); sin el
 * parámetro van todas, y con el parámetro vacío va ninguna.
 */
reportsRouter.get("/export", async (req: Request, res: Response) => {
  try {
    const format = req.query.format as string | undefined;
    const bucket = (req.query.bucket as string | undefined) ?? "mes";
    const { from, to } = req.query;

    if (!format || !(format in FORMATOS_EXPORT)) {
      return res.status(400).json({
        success: false,
        error: `format tiene que ser uno de: ${Object.keys(FORMATOS_EXPORT).join(", ")}`,
      });
    }
    if (!esBucketValido(bucket)) {
      return res.status(400).json({
        success: false,
        error: `bucket tiene que ser uno de: ${BUCKETS.join(", ")}`,
      });
    }
    for (const [nombre, valor] of [["from", from], ["to", to]] as const) {
      if (typeof valor === "string" && !FECHA_RE.test(valor)) {
        return res
          .status(400)
          .json({ success: false, error: `${nombre} debe ser YYYY-MM-DD` });
      }
    }

    const porDefecto = ventanaPorDefecto(bucket);
    const desde = typeof from === "string" ? from : porDefecto.from;
    const hasta = typeof to === "string" ? to : porDefecto.to;
    if (desde > hasta) {
      return res
        .status(400)
        .json({ success: false, error: "from no puede ser posterior a to" });
    }
    const demasiado = errorDeRango(bucket, desde, hasta);
    if (demasiado) return res.status(400).json({ success: false, error: demasiado });

    // Sin período elegido los totales son del histórico completo, igual que las
    // tarjetas de la pantalla; con período, el cobrado es el de ese período.
    const periodoElegido = typeof from === "string" || typeof to === "string";

    const [ingresos, canchas, disciplinas, morosos] = await Promise.all([
      calcularIngresos({
        group: "concepto",
        from: typeof from === "string" ? from : undefined,
        to: typeof to === "string" ? to : undefined,
      }),
      calcularSerie({ bucket, by: "espacio", from: desde, to: hasta }),
      calcularSerie({ bucket, by: "disciplina", from: desde, to: hasta }),
      calcularMorosos(),
    ]);

    const reporte = armarReporte({
      bucket,
      rango: { from: desde, to: hasta },
      periodoElegido,
      totales: ingresos.totales,
      canchas,
      disciplinas,
      canchasElegidas: listaDeQuery(req.query.canchas),
      disciplinasElegidas: listaDeQuery(req.query.disciplinas),
      morosos: morosos.morosos,
      totalVencido: morosos.total_vencido,
      generadoEn: fechaHoraClub(),
    });

    const archivo =
      (format as FormatoExport) === "xlsx" ? await aXlsx(reporte) : await aPdf(reporte);

    res.setHeader("Content-Type", FORMATOS_EXPORT[format as FormatoExport]);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reporte-ingresos-${todayInClub()}.${format}"`,
    );
    return res.send(archivo);
  } catch (error) {
    console.error("Export report error:", error);
    return res.status(500).json({ success: false, error: "Error al exportar el reporte" });
  }
});
