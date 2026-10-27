/**
 * Cobro manual: la gestión o un profesor registran que un socio pagó en mano.
 *
 * Es el cobro del mostrador, aparte de los que hace el socio por su cuenta. Todo
 * acá es puro; las consultas y el UPDATE viven en `routes/payments.ts`.
 *
 * Quién puede cobrar qué:
 *  - La gestión cobra cualquier cuota pendiente, por cualquiera de los cuatro medios manuales (nunca MercadoPago).
 *  - Un profesor cobra sólo cuotas de **disciplina** de **su** disciplina, y
 *    siempre en efectivo. No registra reservas, cuota social ni otros cargos, ni
 *    elige el medio: es quien recibe la plata en la clase.
 *  - Un socio no cobra: quien debe no decide si pagó.
 */

export const METODOS_MANUALES = ["Efectivo", "Transferencia", "MPFueraDeApp", "TarjetaConPosnet"] as const;
export type MetodoManual = (typeof METODOS_MANUALES)[number];

/** Cuántos resultados devuelve como mucho el listado "por cobrar". */
export const LIMITE_POR_COBRAR = 50;

export interface QuienCobra {
  esGestion: boolean;
  esProfesor: boolean;
}

export interface PagoACobrar {
  concept: string;
  status: string;
  /** ¿El profesor que cobra dicta la disciplina de esta cuota? */
  esDeSuDisciplina: boolean;
}

export type DecisionCobro =
  | { ok: true; method: MetodoManual }
  | { ok: false; status: 403 | 409; error: string };

/**
 * Qué se hace con un intento de cobro: se permite (y con qué medio) o se rechaza
 * con el código y el mensaje que corresponden.
 */
export function decidirCobro(
  quien: QuienCobra,
  pago: PagoACobrar,
  metodoPedido: MetodoManual | undefined,
): DecisionCobro {
  if (!quien.esGestion && !quien.esProfesor) {
    return { ok: false, status: 403, error: "No tenés permisos para registrar cobros" };
  }

  if (pago.status !== "Pendiente" && pago.status !== "EnRevision") {
    return {
      ok: false,
      status: 409,
      error: pago.status === "Pagado" ? "Esa cuota ya está paga" : "Esa cuota está anulada",
    };
  }

  if (quien.esGestion) {
    // Sin medio declarado se asume efectivo: es el mostrador del club.
    return { ok: true, method: metodoPedido ?? "Efectivo" };
  }

  if (pago.status === "EnRevision") {
    // Comprobante presentado: la cierra la gestión (D10/D23).
    return { ok: false, status: 403, error: "Esa cuota tiene un comprobante en revisión: la cobra la gestión" };
  }
  if (pago.concept !== "Disciplina" || !pago.esDeSuDisciplina) {
    return {
      ok: false,
      status: 403,
      error: "Sólo podés registrar cobros de las cuotas de las disciplinas que dictás",
    };
  }
  if (metodoPedido !== undefined && metodoPedido !== "Efectivo") {
    return { ok: false, status: 403, error: "Un profesor sólo registra cobros en efectivo" };
  }
  return { ok: true, method: "Efectivo" };
}

/**
 * Palabras de una búsqueda de socio. Cada una tiene que aparecer en el nombre, el
 * apellido o el DNI, así "juan pérez" y "pérez juan" encuentran a la misma
 * persona. Una búsqueda de menos de dos letras no filtra: tantos resultados no
 * ayudan, y el listado ya trae lo más urgente.
 */
export function palabrasDeBusqueda(texto: unknown): string[] {
  if (typeof texto !== "string") return [];
  const limpio = texto.trim();
  if (limpio.length < 2) return [];
  return limpio.split(/\s+/).slice(0, 4);
}
