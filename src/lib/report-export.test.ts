import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import {
  aPdf,
  aXlsx,
  armarReporte,
  etiquetaBucket,
  filtrarSeries,
  listaDeQuery,
} from "./report-export";

const canchas = {
  buckets: ["2026-08", "2026-09"],
  series: [
    { clave: "Cancha 1", total: 5000, puntos: [2000, 3000] },
    { clave: "Cancha 2", total: 1000, puntos: [0, 1000] },
  ],
};
const disciplinas = {
  buckets: ["2026-08", "2026-09"],
  series: [{ clave: "Fútbol", total: 4000, puntos: [1500, 2500] }],
};

function entrada(extra: Partial<Parameters<typeof armarReporte>[0]> = {}) {
  return {
    bucket: "mes" as const,
    rango: { from: "2026-08-01", to: "2026-09-30" },
    periodoElegido: false,
    totales: {
      cobrado: 10000,
      cobros: 7,
      pendiente: 3000,
      cantidad_pendiente: 2,
      vencido: 1500,
      cantidad_vencida: 1,
    },
    canchas,
    disciplinas,
    canchasElegidas: null,
    disciplinasElegidas: null,
    morosos: [
      {
        user: { name: "Juan", last_name: "Pérez", dni: "30111222" },
        vencido: 1500,
        cuotas_vencidas: 1,
        vencimiento_mas_viejo: new Date("2026-09-10T00:00:00Z"),
      },
    ],
    totalVencido: 1500,
    generadoEn: "26/10/26 12:00",
    ...extra,
  };
}

describe("etiquetaBucket", () => {
  test("mes, semana y día sin correr la fecha por el huso", () => {
    expect(etiquetaBucket("2026-09", "mes")).toBe("Septiembre 2026");
    expect(etiquetaBucket("2026-09-14", "semana")).toBe("Semana del 14/9/2026");
    expect(etiquetaBucket("2026-09-01", "dia")).toBe("1/9/2026");
  });
});

describe("listaDeQuery", () => {
  test("ausente es todas, vacío es ninguna", () => {
    expect(listaDeQuery(undefined)).toBeNull();
    expect(listaDeQuery("")).toEqual([]);
  });

  test("acepta valores repetidos y no parte los nombres con coma", () => {
    expect(listaDeQuery(["Cancha 1", "Cancha 2"])).toEqual(["Cancha 1", "Cancha 2"]);
    expect(listaDeQuery("Cancha 1, techada")).toEqual(["Cancha 1, techada"]);
  });
});

describe("filtrarSeries", () => {
  test("null deja todas y una lista deja sólo esas", () => {
    expect(filtrarSeries(canchas.series, null)).toHaveLength(2);
    expect(filtrarSeries(canchas.series, ["Cancha 2"]).map((s) => s.clave)).toEqual(["Cancha 2"]);
    expect(filtrarSeries(canchas.series, [])).toEqual([]);
  });
});

describe("armarReporte", () => {
  test("arma las cuatro secciones con el resumen", () => {
    const reporte = armarReporte(entrada());
    expect(reporte.secciones.map((s) => s.hoja)).toEqual(["Resumen", "Canchas", "Disciplinas", "Morosos"]);
    expect(reporte.secciones[0]!.filas).toEqual([
      ["Cobrado", 7, 10000],
      ["Pendiente de cobro", 2, 3000],
      ["Vencido", 1, 1500],
    ]);
  });

  test("el resumen dice si el cobrado es del período elegido o el histórico", () => {
    expect(armarReporte(entrada()).secciones[0]!.titulo).toContain("histórico");
    const elegido = armarReporte(entrada({ periodoElegido: true })).secciones[0]!.titulo;
    expect(elegido).toContain("2026-08-01");
    expect(elegido).toContain("2026-09-30");
  });

  test("una fila por período con una columna por serie y el total al final", () => {
    const { columnas, filas, totales } = armarReporte(entrada()).secciones[1]!;
    expect(columnas.map((c) => c.encabezado)).toEqual(["Período", "Cancha 1", "Cancha 2", "Total"]);
    expect(filas).toEqual([
      ["Agosto 2026", 2000, 0, 2000],
      ["Septiembre 2026", 3000, 1000, 4000],
    ]);
    expect(totales).toEqual(["Total", 5000, 1000, 6000]);
  });

  test("sólo exporta las series elegidas y el total las respeta", () => {
    const { columnas, totales } = armarReporte(entrada({ canchasElegidas: ["Cancha 2"] })).secciones[1]!;
    expect(columnas.map((c) => c.encabezado)).toEqual(["Período", "Cancha 2", "Total"]);
    expect(totales).toEqual(["Total", 1000, 1000]);
  });

  test("si no se eligió ninguna serie lo dice en vez de una tabla vacía", () => {
    const seccion = armarReporte(entrada({ disciplinasElegidas: [] })).secciones[2]!;
    expect(seccion.filas).toEqual([]);
    expect(seccion.vacio).toBe("No se eligió ninguna disciplina.");
  });

  test("morosos con apellido primero, fecha corta y total", () => {
    const { filas, totales } = armarReporte(entrada()).secciones[3]!;
    expect(filas).toEqual([["Pérez, Juan", "30111222", 1, 1500, "10/09/2026"]]);
    expect(totales).toEqual(["Total", null, 1, 1500, null]);
  });

  test("sin morosos no hay fila de total", () => {
    const seccion = armarReporte(entrada({ morosos: [], totalVencido: 0 })).secciones[3]!;
    expect(seccion.totales).toBeUndefined();
    expect(seccion.vacio).toBe("No hay socios con cuotas vencidas.");
  });
});

describe("escritores", () => {
  test("el Excel se puede volver a leer y trae una hoja por sección", async () => {
    const buffer = await aXlsx(armarReporte(entrada()));
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(libro.worksheets.map((h) => h.name)).toEqual(["Resumen", "Canchas", "Disciplinas", "Morosos"]);

    const hoja = libro.getWorksheet("Canchas")!;
    const valores = hoja.getRows(5, 4)!.map((f) => f.values);
    expect(valores[0]).toEqual([undefined, "Período", "Cancha 1", "Cancha 2", "Total"]);
    expect(valores[2]).toEqual([undefined, "Septiembre 2026", 3000, 1000, 4000]);
  });

  test("el PDF es un PDF", async () => {
    const buffer = await aPdf(armarReporte(entrada()));
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  test("el PDF aguanta muchas filas y varias páginas", async () => {
    const muchos = Array.from({ length: 120 }, (_, i) => ({
      user: { name: `Socio ${i}`, last_name: "Apellido", dni: String(30000000 + i) },
      vencido: 1000 + i,
      cuotas_vencidas: 1,
      vencimiento_mas_viejo: new Date("2026-09-10T00:00:00Z"),
    }));
    const buffer = await aPdf(armarReporte(entrada({ morosos: muchos, totalVencido: 130000 })));
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("reembolsos en el export (D22)", () => {
  const conReembolsos = { ...canchas, reembolsos: [500, 0] };

  test("columna Reembolsos y total neto cuando van todas las series", () => {
    const { columnas, filas, totales } = armarReporte(entrada({ canchas: conReembolsos })).secciones[1]!;
    expect(columnas.map((c) => c.encabezado)).toEqual(["Período", "Cancha 1", "Cancha 2", "Reembolsos", "Total neto"]);
    expect(filas).toEqual([
      ["Agosto 2026", 2000, 0, 500, 1500],
      ["Septiembre 2026", 3000, 1000, 0, 4000],
    ]);
    expect(totales).toEqual(["Total", 5000, 1000, 500, 5500]);
  });

  test("con series tildadas a mano no se atribuyen los reembolsos", () => {
    const { columnas } = armarReporte(entrada({ canchas: conReembolsos, canchasElegidas: ["Cancha 1"] })).secciones[1]!;
    expect(columnas.map((c) => c.encabezado)).toEqual(["Período", "Cancha 1", "Total"]);
  });

  test("el resumen suma reembolsado e ingreso neto sólo si vienen", () => {
    const totales = { ...entrada().totales, reembolsado: 500, reembolsos: 1, neto: 9500 };
    expect(armarReporte(entrada({ totales })).secciones[0]!.filas.slice(0, 3)).toEqual([
      ["Cobrado", 7, 10000],
      ["Reembolsado", 1, 500],
      ["Ingreso neto", null, 9500],
    ]);
  });
});
