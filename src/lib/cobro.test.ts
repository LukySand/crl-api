import { describe, expect, test } from "bun:test";
import { decidirCobro, palabrasDeBusqueda, type PagoACobrar } from "./cobro";

const gestion = { esGestion: true, esProfesor: false };
const profe = { esGestion: false, esProfesor: true };
const socio = { esGestion: false, esProfesor: false };

const cuota = (extra: Partial<PagoACobrar> = {}): PagoACobrar => ({
  concept: "Disciplina",
  status: "Pendiente",
  esDeSuDisciplina: true,
  ...extra,
});

describe("decidirCobro — gestión", () => {
  test("cobra en efectivo si no declara medio", () => {
    expect(decidirCobro(gestion, cuota(), undefined)).toEqual({ ok: true, method: "Efectivo" });
  });

  test("puede elegir transferencia", () => {
    expect(decidirCobro(gestion, cuota(), "Transferencia")).toEqual({ ok: true, method: "Transferencia" });
  });

  test("cobra cualquier concepto, aunque no sea de una disciplina", () => {
    expect(decidirCobro(gestion, cuota({ concept: "Reserva", esDeSuDisciplina: false }), undefined).ok).toBe(true);
    expect(decidirCobro(gestion, cuota({ concept: "Socio", esDeSuDisciplina: false }), undefined).ok).toBe(true);
  });

  test("también una cuota con comprobante en revisión", () => {
    expect(decidirCobro(gestion, cuota({ status: "EnRevision" }), undefined).ok).toBe(true);
  });
});

describe("decidirCobro — profesor", () => {
  test("cobra en efectivo la cuota de su disciplina", () => {
    expect(decidirCobro(profe, cuota(), undefined)).toEqual({ ok: true, method: "Efectivo" });
    expect(decidirCobro(profe, cuota(), "Efectivo")).toEqual({ ok: true, method: "Efectivo" });
  });

  test("no puede elegir otro medio", () => {
    const r = decidirCobro(profe, cuota(), "Transferencia");
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  test("no cobra la cuota de una disciplina que no dicta", () => {
    expect(decidirCobro(profe, cuota({ esDeSuDisciplina: false }), undefined)).toMatchObject({ ok: false, status: 403 });
  });

  test("no cobra reservas ni cuota social, aunque diga que es 'suya'", () => {
    expect(decidirCobro(profe, cuota({ concept: "Reserva" }), undefined)).toMatchObject({ ok: false, status: 403 });
    expect(decidirCobro(profe, cuota({ concept: "Socio" }), undefined)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("decidirCobro — socio y estados", () => {
  test("un socio no cobra nada", () => {
    expect(decidirCobro(socio, cuota(), "Efectivo")).toMatchObject({ ok: false, status: 403 });
  });

  test("una cuota paga o anulada no se vuelve a cobrar", () => {
    expect(decidirCobro(gestion, cuota({ status: "Pagado" }), undefined)).toMatchObject({ ok: false, status: 409 });
    expect(decidirCobro(gestion, cuota({ status: "Anulado" }), undefined)).toMatchObject({ ok: false, status: 409 });
    expect(decidirCobro(profe, cuota({ status: "Pagado" }), undefined)).toMatchObject({ ok: false, status: 409 });
  });

  test("el mensaje de una cuota paga dice que ya está paga", () => {
    const r = decidirCobro(gestion, cuota({ status: "Pagado" }), undefined);
    expect(r.ok === false && r.error).toBe("Esa cuota ya está paga");
  });
});

describe("palabrasDeBusqueda", () => {
  test("parte en palabras y recorta", () => {
    expect(palabrasDeBusqueda("  juan   pérez ")).toEqual(["juan", "pérez"]);
    expect(palabrasDeBusqueda("30111222")).toEqual(["30111222"]);
  });

  test("menos de dos letras o algo que no es texto no filtra", () => {
    expect(palabrasDeBusqueda("a")).toEqual([]);
    expect(palabrasDeBusqueda("   ")).toEqual([]);
    expect(palabrasDeBusqueda(undefined)).toEqual([]);
    expect(palabrasDeBusqueda(["juan"])).toEqual([]);
  });

  test("tope de palabras", () => {
    expect(palabrasDeBusqueda("a1 b2 c3 d4 e5 f6")).toHaveLength(4);
  });
});
