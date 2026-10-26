import { expect, test } from "bun:test";
import {
  accionesPermitidas,
  aCentavos,
  bloqueantesDeOrden,
  credencialBloqueada,
  cuotasSocialesVencidas,
  estadoCuota,
  totalCentavos,
} from "./payment-rules";

const HOY = "2026-10-15";

test("estadoCuota: null nunca vence; vencida, por_vencer y al_dia", () => {
  expect(estadoCuota({ status: "Pendiente", due_date: null }, HOY)).toBe("al_dia");
  expect(estadoCuota({ status: "Pendiente", due_date: "2026-10-14" }, HOY)).toBe("vencida");
  expect(estadoCuota({ status: "Pendiente", due_date: "2026-10-15" }, HOY)).toBe("por_vencer");
  expect(estadoCuota({ status: "Pendiente", due_date: "2026-10-22" }, HOY)).toBe("por_vencer");
  expect(estadoCuota({ status: "Pendiente", due_date: "2026-10-23" }, HOY)).toBe("al_dia");
});

test("estadoCuota: estados no pendientes ignoran el vencimiento", () => {
  const vencida = "2020-01-01";
  expect(estadoCuota({ status: "EnRevision", due_date: vencida }, HOY)).toBe("en_revision");
  expect(estadoCuota({ status: "Pagado", due_date: vencida }, HOY)).toBe("pagada");
  expect(estadoCuota({ status: "Anulado", due_date: vencida }, HOY)).toBe("anulada");
  expect(estadoCuota({ status: "Condonado", due_date: vencida }, HOY)).toBe("condonada");
});

test("credencial: sólo Socio + Pendiente + vencimiento pasado no nulo", () => {
  const v = "2026-10-01";
  expect(credencialBloqueada([{ concept: "Socio", status: "Pendiente", due_date: v }], HOY)).toBe(true);
  expect(credencialBloqueada([{ concept: "Disciplina", status: "Pendiente", due_date: v }], HOY)).toBe(false);
  expect(credencialBloqueada([{ concept: "Socio", status: "EnRevision", due_date: v }], HOY)).toBe(false);
  expect(credencialBloqueada([{ concept: "Socio", status: "Pendiente", due_date: null }], HOY)).toBe(false);
  expect(credencialBloqueada([{ concept: "Socio", status: "Pendiente", due_date: HOY }], HOY)).toBe(false);
  expect(
    cuotasSocialesVencidas(
      [
        { concept: "Socio", status: "Pendiente", due_date: v },
        { concept: "Socio", status: "Pendiente", due_date: "2026-09-01" },
        { concept: "Socio", status: "Pagado", due_date: v },
      ],
      HOY,
    ),
  ).toBe(2);
});

const fila = (id: string, concept: string, iso: string) => ({
  id,
  concept,
  created_at: new Date(iso),
});

test("orden de pago: una anterior bloquea, juntas pasan, una posterior no", () => {
  const vieja = fila("a", "Socio", "2026-08-01T00:00:00Z");
  const nueva = fila("b", "Socio", "2026-09-01T00:00:00Z");
  expect(bloqueantesDeOrden([nueva], [vieja])).toEqual({ cuota_social_id: "b", bloqueantes: ["a"] });
  expect(bloqueantesDeOrden([nueva, vieja], [vieja, nueva])).toBeNull();
  expect(bloqueantesDeOrden([vieja], [nueva])).toBeNull();
});

test("orden de pago: no social n/a, simultáneas y Reserva no bloquean", () => {
  const t = "2026-09-01T00:00:00Z";
  const vieja = fila("a", "Socio", "2026-08-01T00:00:00Z");
  expect(bloqueantesDeOrden([fila("d", "Disciplina", t)], [vieja])).toBeNull();
  expect(bloqueantesDeOrden([fila("s", "Socio", t)], [fila("d", "Disciplina", t)])).toBeNull();
  expect(bloqueantesDeOrden([fila("s", "Socio", t)], [fila("r", "Reserva", "2026-08-01T00:00:00Z")])).toBeNull();
});

const base = {
  concept: "Disciplina",
  eliminado: false,
  liquidacion_viva: false,
  liquidacion: null,
} as const;

test("acciones: pendiente, en revisión (sin confirmar/rechazar) y reserva", () => {
  expect(accionesPermitidas({ ...base, status: "Pendiente" })).toEqual([
    "cobrar", "editar", "anular", "condonar", "eliminar",
  ]);
  const rev = accionesPermitidas({ ...base, status: "EnRevision" });
  expect(rev).toEqual(["cobrar", "editar", "anular", "condonar"]);
  expect(rev as string[]).not.toContain("confirmar");
  expect(accionesPermitidas({ ...base, concept: "Reserva", status: "Pendiente" })).toEqual(["cobrar"]);
});

test("acciones: pagada según la liquidación; viva o eliminada bloquea todo", () => {
  const man = { method: "Efectivo", status: "Aprobado", con_reserva: false } as const;
  const mp = { method: "MercadoPago", status: "Aprobado", con_reserva: false } as const;
  expect(accionesPermitidas({ ...base, status: "Pagado", liquidacion: man })).toEqual(["revertir"]);
  expect(accionesPermitidas({ ...base, status: "Pagado", liquidacion: { ...man, con_reserva: true } })).toEqual([]);
  expect(accionesPermitidas({ ...base, status: "Pagado", liquidacion: mp })).toEqual(["reembolsar"]);
  expect(accionesPermitidas({ ...base, concept: "Reserva", status: "Pagado", liquidacion: mp })).toEqual(["reembolsar"]);
  expect(accionesPermitidas({ ...base, status: "Pagado", liquidacion: null })).toEqual([]);
  expect(accionesPermitidas({ ...base, status: "Anulado" })).toEqual([]);
  expect(accionesPermitidas({ ...base, status: "Pendiente", liquidacion_viva: true })).toEqual([]);
  expect(accionesPermitidas({ ...base, status: "Pendiente", eliminado: true })).toEqual([]);
});

test("centavos: sin error de coma flotante", () => {
  expect(aCentavos("19.99")).toBe(1999);
  expect(aCentavos(0.1 + 0.2)).toBe(30);
  expect(totalCentavos([{ amount: "10.10" }, { amount: 20.2 }, { amount: "0.01" }])).toBe(3031);
  expect(totalCentavos([])).toBe(0);
});
