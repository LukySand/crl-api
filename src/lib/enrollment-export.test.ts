import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { aPdf, aXlsx } from "./report-export";
import { armarListaInscriptos, ordenarInscriptos, slugDe } from "./enrollment-export";

const disciplina = { name: "Vóley", place: "Cancha 2", professors: ["Diego Ferreyra"] };
const inscriptos = [
  { name: "Lucía", last_name: "Benítez", dni: "37845220", created_at: new Date("2026-03-05T15:00:00Z") },
  { name: "Martín", last_name: "Aguirre", dni: "35112908", created_at: new Date("2026-02-10T15:00:00Z") },
  { name: "Ana", last_name: "Álvarez", dni: "30111222", created_at: new Date("2026-04-01T15:00:00Z") },
];

describe("ordenarInscriptos", () => {
  test("alfabético por apellido y nombre, sin que las tildes lo desordenen", () => {
    expect(ordenarInscriptos(inscriptos).map((i) => i.last_name)).toEqual(["Aguirre", "Álvarez", "Benítez"]);
  });

  test("no modifica la lista original", () => {
    const copia = [...inscriptos];
    ordenarInscriptos(inscriptos);
    expect(inscriptos).toEqual(copia);
  });
});

describe("armarListaInscriptos", () => {
  const lista = armarListaInscriptos({ disciplina, inscriptos, generadoEn: "26/10/26 12:00" });

  test("es una hoja vertical con el nombre de la disciplina en el título", () => {
    expect(lista.orientacion).toBe("vertical");
    expect(lista.titulo).toBe("Inscriptos — Vóley");
    expect(lista.subtitulo).toBe("Profesor: Diego Ferreyra · Espacio: Cancha 2");
  });

  test("numera, ordena y da apellido primero con fecha corta", () => {
    expect(lista.secciones[0]!.filas).toEqual([
      [1, "Aguirre, Martín", "35112908", "10/02/2026"],
      [2, "Álvarez, Ana", "30111222", "01/04/2026"],
      [3, "Benítez, Lucía", "37845220", "05/03/2026"],
    ]);
  });

  test("cuenta los inscriptos en singular y plural", () => {
    expect(lista.secciones[0]!.titulo).toBe("3 inscriptos");
    const uno = armarListaInscriptos({ disciplina, inscriptos: inscriptos.slice(0, 1), generadoEn: "x" });
    expect(uno.secciones[0]!.titulo).toBe("1 inscripto");
  });

  test("no lleva celular ni email", () => {
    const encabezados = lista.secciones[0]!.columnas.map((c) => c.encabezado);
    expect(encabezados).toEqual(["N°", "Apellido y nombre", "DNI", "Inscripto desde"]);
  });

  test("varios profesores en plural, y sin profesor ni espacio usa el nombre del club", () => {
    expect(
      armarListaInscriptos({ disciplina: { ...disciplina, professors: ["A B", "C D"] }, inscriptos: [], generadoEn: "x" })
        .subtitulo,
    ).toBe("Profesores: A B, C D · Espacio: Cancha 2");
    expect(
      armarListaInscriptos({ disciplina: { name: "X", place: null, professors: [] }, inscriptos: [], generadoEn: "x" })
        .subtitulo,
    ).toBe("Club Recreativo Libertador");
  });

  test("sin inscriptos queda el mensaje y ninguna fila", () => {
    const vacia = armarListaInscriptos({ disciplina, inscriptos: [], generadoEn: "x" });
    expect(vacia.secciones[0]!.filas).toEqual([]);
    expect(vacia.secciones[0]!.vacio).toBe("Todavía no hay socios inscriptos.");
  });
});

describe("archivos", () => {
  const lista = armarListaInscriptos({ disciplina, inscriptos, generadoEn: "26/10/26 12:00" });

  test("el Excel se vuelve a leer con los inscriptos", async () => {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load((await aXlsx(lista)) as unknown as ExcelJS.Buffer);
    const hoja = libro.getWorksheet("Inscriptos")!;
    const filas = hoja.getRows(5, 4)!.map((f) => f.values);
    expect(filas[0]).toEqual([undefined, "N°", "Apellido y nombre", "DNI", "Inscripto desde"]);
    expect(filas[1]).toEqual([undefined, 1, "Aguirre, Martín", "35112908", "10/02/2026"]);
  });

  test("el PDF de una lista vertical es un PDF", async () => {
    const pdf = await aPdf(lista);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("slugDe", () => {
  test("ASCII, minúsculas y con guiones", () => {
    expect(slugDe("Vóley Femenino")).toBe("voley-femenino");
    expect(slugDe("  Hockey / Patín  ")).toBe("hockey-patin");
  });

  test("un nombre que no deja nada usa uno por defecto", () => {
    expect(slugDe("¿¿??")).toBe("disciplina");
  });
});
