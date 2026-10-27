/**
 * Exportación de los reportes a Excel y PDF.
 *
 * Dos pasos a propósito: `armarReporte` convierte los datos de los reportes en un
 * documento neutro (secciones con columnas y filas) y los escritores `aXlsx` /
 * `aPdf` lo dibujan. Toda la decisión de qué columnas y qué números lleva el
 * archivo está en el primer paso, que es puro y se testea sin generar archivos.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { CLUB_TZ } from "./booking-date";
import type { Bucket } from "./payment-period";

export type TipoColumna = "texto" | "moneda" | "numero";
export type Celda = string | number | null;

export interface Columna {
  encabezado: string;
  tipo: TipoColumna;
  /** Peso relativo del ancho de la columna. */
  ancho: number;
}

export interface Seccion {
  /** Nombre de la hoja de Excel (máx. 31 caracteres, sin `[]:*?/\`). */
  hoja: string;
  titulo: string;
  columnas: Columna[];
  filas: Celda[][];
  totales?: Celda[];
  /** Texto en lugar de la tabla cuando no hay filas. */
  vacio?: string;
}

export interface Reporte {
  /** Hoja del PDF. Por defecto apaisada, que es la que entra con varias columnas. */
  orientacion?: "vertical" | "horizontal";
  titulo: string;
  subtitulo: string;
  generadoEn: string;
  secciones: Seccion[];
}

export interface SerieExport {
  clave: string;
  total: number;
  puntos: number[];
}

export interface SerieRespuesta {
  buckets: string[];
  series: SerieExport[];
  /** Reembolsos por bucket (D22). Ausente: no se agrega la columna. */
  reembolsos?: number[];
}

export interface Totales {
  cobrado: number;
  cobros: number;
  pendiente: number;
  cantidad_pendiente: number;
  vencido: number;
  cantidad_vencida: number;
  /** Egresos por reembolso y neto (D22). Ausentes: el resumen no los muestra. */
  reembolsado?: number;
  reembolsos?: number;
  neto?: number;
}

export interface MorosoExport {
  user: { name: string; last_name: string; dni: string };
  vencido: number;
  cuotas_vencidas: number;
  vencimiento_mas_viejo: Date | null;
}

/** Fecha y hora de ahora en el huso del club, para el "Generado el" de los archivos. */
export function fechaHoraClub(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: CLUB_TZ,
  }).format(ahora);
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/**
 * Etiqueta legible de un bucket. Se parsea el string y no se construye un Date:
 * ya viene en el huso del club y un Date lo reinterpretaría corriéndolo un día.
 */
export function etiquetaBucket(label: string, bucket: Bucket): string {
  const [anio, mes, dia] = label.split("-");
  if (bucket === "mes") return `${MESES[Number(mes) - 1] ?? "?"} ${anio}`;
  const fecha = `${Number(dia)}/${Number(mes)}/${anio}`;
  return bucket === "semana" ? `Semana del ${fecha}` : fecha;
}

/** `null` = todas; una lista = sólo esas, en el orden en que vienen las series. */
export function filtrarSeries(series: SerieExport[], claves: string[] | null): SerieExport[] {
  if (claves === null) return series;
  const elegidas = new Set(claves);
  return series.filter((s) => elegidas.has(s.clave));
}

/**
 * Lee una lista de nombres de la query, uno por parámetro repetido. Ausente →
 * `null` (todas); presente pero vacía → `[]` (ninguna, que es lo que ve el admin
 * cuando destilda todo). No se separa por comas: un nombre puede tenerlas.
 */
export function listaDeQuery(valor: unknown): string[] | null {
  if (valor === undefined) return null;
  const partes = Array.isArray(valor) ? valor : [valor];
  return partes.map((p) => String(p).trim()).filter(Boolean);
}

function fechaDe(d: Date | null): string {
  if (!d) return "";
  const [anio, mes, dia] = d.toISOString().slice(0, 10).split("-");
  return `${dia}/${mes}/${anio}`;
}

function seccionDeSerie(
  hoja: string,
  titulo: string,
  respuesta: SerieRespuesta,
  claves: string[] | null,
  bucket: Bucket,
  sinElegir: string,
): Seccion {
  const series = filtrarSeries(respuesta.series, claves);
  // Los reembolsos van por bucket y no por serie: con series tildadas a mano no
  // se pueden atribuir, así que sólo se muestran (y restan) cuando va todo.
  const reembolsos = claves === null ? respuesta.reembolsos : undefined;
  const columnas: Columna[] = [
    { encabezado: "Período", tipo: "texto", ancho: 2 },
    ...series.map((s): Columna => ({ encabezado: s.clave, tipo: "moneda", ancho: 1.5 })),
    ...(reembolsos ? [{ encabezado: "Reembolsos", tipo: "moneda", ancho: 1.5 } as Columna] : []),
    { encabezado: reembolsos ? "Total neto" : "Total", tipo: "moneda", ancho: 1.5 },
  ];

  if (series.length === 0) {
    return {
      hoja,
      titulo,
      columnas,
      filas: [],
      vacio: claves !== null && claves.length === 0 ? sinElegir : "No hay cobros en el período.",
    };
  }

  const filas = respuesta.buckets.map((b, i): Celda[] => {
    const montos = series.map((s) => s.puntos[i] ?? 0);
    const reembolsado = reembolsos?.[i] ?? 0;
    const neto = montos.reduce((t, n) => t + n, 0) - reembolsado;
    return [etiquetaBucket(b, bucket), ...montos, ...(reembolsos ? [reembolsado] : []), neto];
  });
  const totalReembolsos = reembolsos?.reduce((t, n) => t + n, 0) ?? 0;
  const totales: Celda[] = [
    "Total",
    ...series.map((s) => s.total),
    ...(reembolsos ? [totalReembolsos] : []),
    series.reduce((t, s) => t + s.total, 0) - totalReembolsos,
  ];
  return { hoja, titulo, columnas, filas, totales };
}

/** Arma el documento del reporte con lo mismo que ve la gestión en pantalla. */
export function armarReporte(entrada: {
  bucket: Bucket;
  rango: { from: string; to: string };
  /** ¿La gestión eligió un período? Si no, el cobrado del resumen es el histórico. */
  periodoElegido: boolean;
  totales: Totales;
  canchas: SerieRespuesta;
  disciplinas: SerieRespuesta;
  /** Nombres elegidos; `null` = todos. */
  canchasElegidas: string[] | null;
  disciplinasElegidas: string[] | null;
  morosos: MorosoExport[];
  totalVencido: number;
  generadoEn: string;
}): Reporte {
  const { bucket, totales } = entrada;
  const corte = { dia: "por día", semana: "por semana", mes: "por mes" }[bucket];

  const resumen: Seccion = {
    hoja: "Resumen",
    titulo: entrada.periodoElegido
      ? `Resumen (cobrado del ${entrada.rango.from} al ${entrada.rango.to}; deuda a hoy)`
      : "Resumen (cobrado histórico; deuda a hoy)",
    columnas: [
      { encabezado: "Concepto", tipo: "texto", ancho: 3 },
      { encabezado: "Cantidad", tipo: "numero", ancho: 1 },
      { encabezado: "Monto", tipo: "moneda", ancho: 2 },
    ],
    filas: [
      ["Cobrado", totales.cobros, totales.cobrado],
      ...(totales.reembolsado === undefined
        ? []
        : [
            ["Reembolsado", totales.reembolsos ?? 0, totales.reembolsado] as Celda[],
            ["Ingreso neto", null, totales.neto ?? totales.cobrado - totales.reembolsado] as Celda[],
          ]),
      ["Pendiente de cobro", totales.cantidad_pendiente, totales.pendiente],
      ["Vencido", totales.cantidad_vencida, totales.vencido],
    ],
  };

  const morosos: Seccion = {
    hoja: "Morosos",
    titulo: "Morosos",
    columnas: [
      { encabezado: "Socio", tipo: "texto", ancho: 3 },
      { encabezado: "DNI", tipo: "texto", ancho: 1.5 },
      { encabezado: "Cuotas vencidas", tipo: "numero", ancho: 1.5 },
      { encabezado: "Monto vencido", tipo: "moneda", ancho: 2 },
      { encabezado: "Vence desde", tipo: "texto", ancho: 1.5 },
    ],
    filas: entrada.morosos.map((m): Celda[] => [
      `${m.user.last_name}, ${m.user.name}`,
      m.user.dni,
      m.cuotas_vencidas,
      m.vencido,
      fechaDe(m.vencimiento_mas_viejo),
    ]),
    totales:
      entrada.morosos.length > 0
        ? [
            "Total",
            null,
            entrada.morosos.reduce((t, m) => t + m.cuotas_vencidas, 0),
            entrada.totalVencido,
            null,
          ]
        : undefined,
    vacio: "No hay socios con cuotas vencidas.",
  };

  return {
    titulo: "Reporte de ingresos — Club Recreativo Libertador",
    subtitulo: `Ingresos ${corte}, del ${entrada.rango.from} al ${entrada.rango.to}`,
    generadoEn: entrada.generadoEn,
    secciones: [
      resumen,
      seccionDeSerie(
        "Canchas",
        `Ingresos por cancha (${corte})`,
        entrada.canchas,
        entrada.canchasElegidas,
        bucket,
        "No se eligió ninguna cancha.",
      ),
      seccionDeSerie(
        "Disciplinas",
        `Ingresos por disciplina (${corte})`,
        entrada.disciplinas,
        entrada.disciplinasElegidas,
        bucket,
        "No se eligió ninguna disciplina.",
      ),
      morosos,
    ],
  };
}

const FORMATO_MONEDA = '"$"#,##0';

/** Excel: una hoja por sección, encabezado destacado y montos con formato de moneda. */
export async function aXlsx(reporte: Reporte): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = "Club Recreativo Libertador";
  libro.created = new Date();

  for (const seccion of reporte.secciones) {
    const hoja = libro.addWorksheet(seccion.hoja);
    const ultima = Math.max(seccion.columnas.length, 1);

    hoja.addRow([reporte.titulo]).font = { bold: true, size: 14 };
    hoja.addRow([`${reporte.subtitulo} · Generado el ${reporte.generadoEn}`]).font = {
      color: { argb: "FF666666" },
    };
    hoja.addRow([seccion.titulo]).font = { bold: true, size: 12 };
    hoja.addRow([]);
    for (const n of [1, 2, 3]) hoja.mergeCells(n, 1, n, ultima);

    seccion.columnas.forEach((c, i) => {
      hoja.getColumn(i + 1).width = Math.max(12, Math.round(c.ancho * 12));
    });

    if (seccion.filas.length === 0) {
      hoja.addRow([seccion.vacio ?? "Sin datos."]);
      continue;
    }

    const encabezado = hoja.addRow(seccion.columnas.map((c) => c.encabezado));
    encabezado.font = { bold: true, color: { argb: "FFFFFFFF" } };
    encabezado.alignment = { vertical: "middle", wrapText: true };
    encabezado.eachCell((celda) => {
      celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC81E1E" } };
    });
    hoja.views = [{ state: "frozen", ySplit: encabezado.number }];

    const dar = (fila: ExcelJS.Row) => {
      seccion.columnas.forEach((c, i) => {
        const celda = fila.getCell(i + 1);
        if (c.tipo === "moneda") celda.numFmt = FORMATO_MONEDA;
        if (c.tipo === "numero") celda.numFmt = "#,##0";
        if (c.tipo !== "texto") celda.alignment = { horizontal: "right" };
      });
    };

    for (const fila of seccion.filas) dar(hoja.addRow(fila));
    if (seccion.totales) {
      const total = hoja.addRow(seccion.totales);
      total.font = { bold: true };
      dar(total);
      total.eachCell((celda) => {
        celda.border = { top: { style: "thin" } };
      });
    }
  }

  return Buffer.from(await libro.xlsx.writeBuffer());
}

function textoDeCelda(celda: Celda, tipo: TipoColumna): string {
  if (celda === null || celda === "") return "";
  if (typeof celda === "string") return celda;
  const n = celda.toLocaleString("es-AR", { maximumFractionDigits: 0 });
  return tipo === "moneda" ? `$${n}` : n;
}

/** PDF apaisado: título, y cada sección como una tabla que continúa en la hoja siguiente. */
export function aPdf(reporte: Reporte): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: reporte.orientacion === "vertical" ? "portrait" : "landscape",
      margin: 36,
      bufferPages: true,
    });
    const partes: Buffer[] = [];
    doc.on("data", (parte: Buffer) => partes.push(parte));
    doc.on("end", () => resolver(Buffer.concat(partes)));
    doc.on("error", rechazar);

    const ROJO = "#C81E1E";
    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const alto = 20;
    const fondoPagina = () => doc.page.height - doc.page.margins.bottom;

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#141414").text(reporte.titulo);
    doc.font("Helvetica").fontSize(10).fillColor("#666666");
    doc.text(`${reporte.subtitulo} · Generado el ${reporte.generadoEn}`);
    doc.moveDown(1);

    for (const seccion of reporte.secciones) {
      if (doc.y + alto * 3 > fondoPagina()) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#141414").text(seccion.titulo);
      doc.moveDown(0.4);

      if (seccion.filas.length === 0) {
        doc.font("Helvetica").fontSize(10).fillColor("#666666").text(seccion.vacio ?? "Sin datos.");
        doc.moveDown(1);
        continue;
      }

      const pesoTotal = seccion.columnas.reduce((t, c) => t + c.ancho, 0);
      const anchos = seccion.columnas.map((c) => (c.ancho / pesoTotal) * ancho);
      const fuente = seccion.columnas.length > 8 ? 7 : 9;

      const dibujarFila = (
        celdas: Celda[],
        opciones: { negrita?: boolean; encabezado?: boolean; zebra?: boolean },
      ) => {
        if (doc.y + alto > fondoPagina()) {
          doc.addPage();
          dibujarFila(seccion.columnas.map((c) => c.encabezado), { encabezado: true });
        }
        const y = doc.y;
        if (opciones.encabezado) doc.rect(doc.page.margins.left, y, ancho, alto).fill(ROJO);
        else if (opciones.zebra) doc.rect(doc.page.margins.left, y, ancho, alto).fill("#F6F4EF");
        doc
          .font(opciones.negrita || opciones.encabezado ? "Helvetica-Bold" : "Helvetica")
          .fontSize(fuente)
          .fillColor(opciones.encabezado ? "#FFFFFF" : "#141414");
        let x = doc.page.margins.left;
        seccion.columnas.forEach((c, i) => {
          const texto = opciones.encabezado
            ? c.encabezado
            : textoDeCelda(celdas[i] ?? null, c.tipo);
          doc.text(texto, x + 4, y + 6, {
            width: anchos[i]! - 8,
            height: alto - 6,
            align: c.tipo === "texto" ? "left" : "right",
            lineBreak: false,
            ellipsis: true,
          });
          x += anchos[i]!;
        });
        doc.y = y + alto;
      };

      dibujarFila(seccion.columnas.map((c) => c.encabezado), { encabezado: true });
      seccion.filas.forEach((fila, i) => dibujarFila(fila, { zebra: i % 2 === 1 }));
      if (seccion.totales) dibujarFila(seccion.totales, { negrita: true });
      doc.moveDown(1.2);
    }

    const paginas = doc.bufferedPageRange();
    for (let i = 0; i < paginas.count; i++) {
      doc.switchToPage(paginas.start + i);
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#999999")
        .text(`Página ${i + 1} de ${paginas.count}`, doc.page.margins.left, doc.page.height - 26, {
          width: ancho,
          align: "right",
          lineBreak: false,
        });
    }
    doc.end();
  });
}
