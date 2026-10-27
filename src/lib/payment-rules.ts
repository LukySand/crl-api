/**
 * Reglas puras de cobros (D3, D6, D9, acciones, centavos).
 *
 * Sin base de datos ni reloj implícito: `hoy` entra por parámetro para testear.
 * Las fechas de día viajan como "YYYY-MM-DD" (orden lexicográfico = cronológico).
 */

import type { PaymentMethod, PaymentStatus, TransactionStatus } from "../../prisma/generated/client";
import { todayInClub } from "./booking-date";

export type Metodo = PaymentMethod;
export type EstadoCuota =
  | "al_dia"
  | "por_vencer"
  | "vencida"
  | "en_revision"
  | "pagada"
  | "anulada"
  | "condonada";
export type Accion =
  | "cobrar"
  | "editar"
  | "anular"
  | "condonar"
  | "eliminar"
  | "revertir"
  | "reembolsar";

/** Única cuota que bloquea la credencial y que protege la regla de orden (D3). */
export const CONCEPTO_CUOTA_SOCIAL = "Socio";

const DIAS_POR_VENCER = 7;
const MS_DIA = 86_400_000;

function diasHasta(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / MS_DIA);
}

/** Estado derivado de una cuota (D6). No existe un estado "vencido" guardado. */
export function estadoCuota(
  f: { status: PaymentStatus; due_date: string | null },
  hoy: string = todayInClub(),
): EstadoCuota {
  switch (f.status) {
    case "EnRevision":
      return "en_revision";
    case "Pagado":
      return "pagada";
    case "Anulado":
      return "anulada";
    case "Condonado":
      return "condonada";
    case "Pendiente":
      if (f.due_date === null) return "al_dia";
      if (f.due_date < hoy) return "vencida";
      return diasHasta(hoy, f.due_date) <= DIAS_POR_VENCER ? "por_vencer" : "al_dia";
  }
}

type FilaCredencial = { concept: string; status: PaymentStatus; due_date: string | null };

/** Cuotas sociales vencidas: sólo `Socio` + `Pendiente` + vencimiento no nulo ya pasado. */
export function cuotasSocialesVencidas(f: FilaCredencial[], hoy: string = todayInClub()): number {
  return f.filter(
    (x) =>
      x.concept === CONCEPTO_CUOTA_SOCIAL &&
      x.status === "Pendiente" &&
      x.due_date !== null &&
      x.due_date < hoy,
  ).length;
}

export function credencialBloqueada(f: FilaCredencial[], hoy: string = todayInClub()): boolean {
  return cuotasSocialesVencidas(f, hoy) > 0;
}

type FilaOrden = { id: string; concept: string; created_at: Date };

/**
 * Regla de orden de pago (D9). Una cuota social de la selección queda bloqueada por
 * toda pendiente anterior (estricto) del mismo socio que no esté en la selección.
 * Las `Reserva` nunca bloquean. El llamador pasa sólo filas `Pendiente`
 * (`EnRevision` queda afuera por construcción). Devuelve la primera bloqueada.
 */
export function bloqueantesDeOrden(
  seleccion: FilaOrden[],
  pendientes: FilaOrden[],
): { cuota_social_id: string; bloqueantes: string[] } | null {
  const enSeleccion = new Set(seleccion.map((s) => s.id));
  for (const x of seleccion) {
    if (x.concept !== CONCEPTO_CUOTA_SOCIAL) continue;
    const bloqueantes = pendientes
      .filter(
        (y) =>
          y.concept !== "Reserva" &&
          !enSeleccion.has(y.id) &&
          y.created_at.getTime() < x.created_at.getTime(),
      )
      .map((y) => y.id);
    if (bloqueantes.length > 0) return { cuota_social_id: x.id, bloqueantes };
  }
  return null;
}

/**
 * Acciones que la UI puede ofrecer (pista: la autoridad es cada endpoint).
 * Una liquidación de MP viva bloquea toda mutación (D8). `Reserva` ⊆ cobrar/reembolsar.
 */
export function accionesPermitidas(f: {
  concept: string;
  status: PaymentStatus;
  eliminado: boolean;
  liquidacion_viva: boolean;
  liquidacion: { method: Metodo; status: TransactionStatus; con_reserva: boolean } | null;
}): Accion[] {
  if (f.eliminado || f.liquidacion_viva) return [];
  const esReserva = f.concept === "Reserva";
  const l = f.liquidacion;

  switch (f.status) {
    case "Pendiente":
      return esReserva ? ["cobrar"] : ["cobrar", "editar", "anular", "condonar", "eliminar"];
    case "EnRevision": // legado (D23): la gestión lo cobra, anula o condona (editar: sólo Pendiente)
      return esReserva ? [] : ["cobrar", "anular", "condonar"];
    case "Pagado": {
      if (!l) return [];
      if (l.method === "MercadoPago") {
        return l.status === "Aprobado" || l.status === "ReembolsadoParcial" ? ["reembolsar"] : [];
      }
      // cobro manual: se revierte, salvo que incluya una reserva (se cancela la reserva)
      if (esReserva) return [];
      return l.status === "Aprobado" && !l.con_reserva ? ["revertir"] : [];
    }
    default:
      return [];
  }
}

/** "1234.56" | 1234.56 → 123456. Redondea para absorber el error de coma flotante. */
export function aCentavos(m: number | string): number {
  return Math.round(Number(m) * 100);
}

export function totalCentavos(f: { amount: number | string }[]): number {
  return f.reduce((acc, x) => acc + aCentavos(x.amount), 0);
}
