/**
 * Lista de inscriptos de una disciplina para bajar o imprimir.
 *
 * Arma el mismo documento neutro (`Reporte`) que usan los reportes de ingresos, así
 * Excel y PDF salen del generador de `report-export.ts`. Va en hoja vertical porque
 * es una lista para tener en la mano, no una tabla ancha.
 *
 * No lleva celular ni email a propósito: el profesor ve nombre y DNI de sus
 * alumnos, y un archivo que se imprime y se pasa de mano en mano no es el lugar
 * para ampliar qué datos de contacto se reparten.
 */
import { CLUB_TZ } from "./booking-date";
import type { Reporte } from "./report-export";

export interface InscriptoExport {
  name: string;
  last_name: string;
  dni: string;
  /** Cuándo se inscribió. */
  created_at: Date;
}

export interface DisciplinaExport {
  name: string;
  place: string | null;
  professors: string[];
}

const fechaCorta = (fecha: Date) =>
  fecha.toLocaleDateString("es-AR", { timeZone: CLUB_TZ, day: "2-digit", month: "2-digit", year: "numeric" });

/** Orden alfabético por apellido y nombre, sin que importen tildes ni mayúsculas. */
export function ordenarInscriptos<T extends { name: string; last_name: string }>(lista: T[]): T[] {
  return [...lista].sort((a, b) =>
    `${a.last_name} ${a.name}`.localeCompare(`${b.last_name} ${b.name}`, "es", { sensitivity: "base" }),
  );
}

export function armarListaInscriptos(entrada: {
  disciplina: DisciplinaExport;
  inscriptos: InscriptoExport[];
  generadoEn: string;
}): Reporte {
  const { disciplina, generadoEn } = entrada;
  const inscriptos = ordenarInscriptos(entrada.inscriptos);

  const detalle = [
    disciplina.professors.length > 0
      ? `${disciplina.professors.length === 1 ? "Profesor" : "Profesores"}: ${disciplina.professors.join(", ")}`
      : null,
    disciplina.place ? `Espacio: ${disciplina.place}` : null,
  ].filter(Boolean);

  return {
    orientacion: "vertical",
    titulo: `Inscriptos — ${disciplina.name}`,
    subtitulo: detalle.length > 0 ? detalle.join(" · ") : "Club Recreativo Libertador",
    generadoEn,
    secciones: [
      {
        hoja: "Inscriptos",
        titulo: `${inscriptos.length} ${inscriptos.length === 1 ? "inscripto" : "inscriptos"}`,
        columnas: [
          { encabezado: "N°", tipo: "numero", ancho: 0.7 },
          { encabezado: "Apellido y nombre", tipo: "texto", ancho: 4 },
          { encabezado: "DNI", tipo: "texto", ancho: 1.8 },
          { encabezado: "Inscripto desde", tipo: "texto", ancho: 1.8 },
        ],
        filas: inscriptos.map((i, n) => [
          n + 1,
          `${i.last_name}, ${i.name}`,
          i.dni,
          fechaCorta(i.created_at),
        ]),
        vacio: "Todavía no hay socios inscriptos.",
      },
    ],
  };
}

/**
 * Nombre de archivo seguro (ASCII, sin espacios) a partir del nombre de una
 * disciplina: va en `Content-Disposition`, que no admite tildes sin codificar.
 */
export function slugDe(nombre: string): string {
  const slug = nombre
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "disciplina";
}
