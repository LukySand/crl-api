/**
 * Postulación de sponsors: validación y reglas, puro (sin Prisma) para testearlo
 * sin base. El formulario es **público**, así que todo lo que llega se valida acá
 * y nada se cree de palabra.
 *
 * Está duplicado en el front (`crl-web/src/app/utils/sponsors.ts`), igual que
 * `validation.ts` y `ajustes.ts`: el front avisa antes de mandar, este rechaza.
 * La autoridad es esta copia. **Si tocás una, tocá la otra.**
 */
import { z } from "zod";

/** El orden importa: es el que usa el panel para listar (pendientes primero). */
export const SPONSOR_STATUS = ["Pendiente", "Aprobada", "Rechazada", "Finalizada"] as const;
export type SponsorStatus = (typeof SPONSOR_STATUS)[number];

/** Largos máximos, espejo de los `@db.VarChar` del schema. */
export const LARGOS = {
  business_name: 150,
  contact_name: 100,
  email: 255,
  phone: 30,
  sector: 100,
  contribution: 100,
  message: 2_000,
  rejection_reason: 1_000,
} as const;

/**
 * Las formas de aportar al club.
 *
 * **No llevan monto a propósito.** Un número en pesos escrito acá envejece solo:
 * con la inflación de 2026 (~1,9% mensual) una cifra fija pierde un tercio de su
 * valor en un año, y además ningún club de este tamaño publica tarifa — se
 * arregla hablando. Las opciones describen **qué** se aporta, no cuánto; el monto
 * lo acuerda la gestión en cada caso.
 *
 * `aConfirmar` marca lo que el club todavía está definiendo: se muestra, para que
 * se vea que la idea existe, pero avisando que no está cerrado.
 */
export const TIPOS_DE_APORTE = [
  {
    id: "cuota",
    titulo: "Apadrinar una cuota",
    detalle:
      "Bancás la cuota mensual de un chico que no la puede pagar. El club define a quién y por cuánto tiempo.",
    aConfirmar: true,
  },
  {
    id: "temporada",
    titulo: "Apadrinar una temporada",
    detalle: "Lo mismo, pero el año entero de un chico, en vez de mes a mes.",
    aConfirmar: true,
  },
  {
    id: "equipo",
    titulo: "Equipar un equipo",
    detalle: "Camisetas, pecheras, pelotas o equipamiento para una categoría.",
    aConfirmar: false,
  },
  {
    id: "disciplina",
    titulo: "Sponsor de una disciplina",
    detalle: "Tu logo acompaña a una disciplina —fútbol, vóley, hockey o patín— toda la temporada.",
    aConfirmar: false,
  },
  {
    // El `id` sigue siendo "especie" aunque el rótulo cambie: en la columna se
    // guarda el id, así que renombrar la opción no toca la base ni deja
    // ilegibles las postulaciones viejas.
    id: "especie",
    titulo: "Aportar productos o servicios",
    detalle: "Mercadería, impresiones, traslados: lo que puedas dar en vez de plata.",
    aConfirmar: false,
  },
  {
    id: "otro",
    titulo: "Otra cosa",
    detalle: "Tenés otra idea o querés combinar varias. Contanos cuál en el mensaje.",
    aConfirmar: false,
  },
] as const;

export type TipoDeAporte = (typeof TIPOS_DE_APORTE)[number]["id"];

export const APORTE_IDS = TIPOS_DE_APORTE.map((t) => t.id) as [TipoDeAporte, ...TipoDeAporte[]];

/**
 * El rótulo de un aporte guardado. Cae al valor crudo si la opción ya no existe:
 * una postulación vieja no tiene por qué quedar ilegible porque el club cambió la
 * lista, y en la columna se guarda el `id`, no el texto.
 */
export function tituloDeAporte(id: string): string {
  return TIPOS_DE_APORTE.find((t) => t.id === id)?.titulo ?? id;
}

/**
 * Tope de postulaciones pendientes. Es lo que acota el daño de que el formulario
 * sea público: pasado el tope la API responde 503 y no se escribe nada más (ni
 * filas ni logos en disco) hasta que la gestión despeje la cola.
 *
 * ponytail: un límite por IP no serviría. El front proxea `/api/*`, así que todas
 * las postulaciones llegan con la IP del proxy — limitar por IP taparía a todo el
 * mundo o a nadie.
 */
export const LIMITE_PENDIENTES = 100;

/**
 * Campo trampa. Va escondido en el formulario, ninguna persona lo ve ni lo puede
 * tipear, y los bots que completan todo lo llenan igual: si viene con algo, la
 * postulación se descarta.
 *
 * Existe porque el CUIT, que era el filtro de basura barato (dígito verificador),
 * se sacó del formulario para pedirle menos datos al que se postula. Sin esto, la
 * única defensa de un endpoint público de escritura sería el tope de la cola.
 */
export const CAMPO_TRAMPA = "_gotcha";

const texto = (campo: keyof typeof LARGOS, nombre: string) =>
  z
    .string({ error: `${nombre} es requerido` })
    .trim()
    .min(1, `${nombre} es requerido`)
    .max(LARGOS[campo], `${nombre} debe tener máximo ${LARGOS[campo]} caracteres`);

/**
 * Lo que manda el formulario público.
 *
 * No pide CUIT: a quien recién está averiguando, pedirle la identidad fiscal es
 * fricción, y ese dato no hace falta hasta que hay acuerdo. Por eso tampoco es
 * sólo para comercios — `business_name` es el nombre del comercio **o** de la
 * persona.
 *
 * El rubro sigue siendo texto libre: el club no sabe todavía qué le van a
 * ofrecer, y una lista cerrada hoy dejaría afuera la mitad de los casos.
 */
export const sponsorApplicationSchema = z
  .object({
    business_name: texto("business_name", "El nombre"),
    contact_name: texto("contact_name", "El nombre de contacto"),
    email: texto("email", "El email").pipe(z.email("El email no es válido")),
    phone: texto("phone", "El teléfono"),
    sector: texto("sector", "El rubro"),
    contribution: z.enum(APORTE_IDS, { error: "Elegí una forma de aportar" }),
    message: texto("message", "El mensaje"),
  })
  .strict();

export type SponsorApplicationInput = z.infer<typeof sponsorApplicationSchema>;

/**
 * Corrección de los datos de contacto. La usa **la gestión** sobre una
 * postulación pendiente: el caso real es el email tipeado mal, que es justo el
 * dato con el que iban a contestar.
 *
 * Deliberadamente **no** incluye el rubro, el aporte ni el mensaje: eso es lo que
 * la persona propuso, y la gestión no reescribe propuestas ajenas. Para cambiar
 * eso, lo edita quien la mandó (si tiene cuenta) o se postula de nuevo.
 */
export const sponsorContactoSchema = z
  .object({
    contact_name: texto("contact_name", "El nombre de contacto"),
    email: texto("email", "El email").pipe(z.email("El email no es válido")),
    phone: texto("phone", "El teléfono"),
  })
  .strict();

/**
 * ¿Se pueden corregir los datos de la que está en `actual`? Devuelve el error o null.
 *
 * Sólo mientras esté pendiente. Una resuelta es el registro de lo que se decidió
 * sobre **esos** datos; cambiarlos después dejaría una decisión colgada de
 * información que ya no es la que se miró.
 */
export function denyEdicion(actual: SponsorStatus): string | null {
  return actual === "Pendiente"
    ? null
    : "Sólo se pueden corregir los datos de una postulación pendiente";
}

/** Lo que manda la gestión al resolver una postulación. */
export const sponsorReviewSchema = z
  .object({
    action: z.enum(["aprobar", "rechazar"], { error: "Acción inválida" }),
    rejection_reason: z
      .string()
      .trim()
      .max(
        LARGOS.rejection_reason,
        `El motivo debe tener máximo ${LARGOS.rejection_reason} caracteres`,
      )
      .optional(),
  })
  .strict()
  .refine((d) => d.action !== "rechazar" || !!d.rejection_reason, {
    error: "El motivo del rechazo es requerido",
    path: ["rejection_reason"],
  });

/**
 * ¿Se puede resolver una postulación que está en `actual`? Devuelve el error o null.
 *
 * Una vez resuelta no se vuelve a tocar: la decisión es el registro de lo que se
 * acordó, y pisarla borraría el motivo del rechazo sin dejar rastro.
 */
export function denyRevision(actual: SponsorStatus): string | null {
  if (actual === "Pendiente") return null;
  return `La postulación ya está ${actual.toLowerCase()}`;
}

/**
 * ¿Se puede dar de baja la que está en `actual`? Devuelve el error o null.
 *
 * Sólo se baja una vigente. Dar de baja no es rechazar: el trato existió y se
 * cumplió, así que el sponsor sale de la vitrina pero la fila queda con todo su
 * historial, y puede volver la temporada que viene.
 */
export function denyBaja(actual: SponsorStatus): string | null {
  if (actual === "Aprobada") return null;
  return actual === "Finalizada"
    ? "El auspicio ya está finalizado"
    : "Sólo se puede dar de baja un sponsor vigente";
}

/** ¿Se puede reactivar la que está en `actual`? Devuelve el error o null. */
export function denyReactivar(actual: SponsorStatus): string | null {
  if (actual === "Finalizada") return null;
  return actual === "Aprobada"
    ? "El auspicio ya está vigente"
    : "Sólo se puede reactivar un auspicio finalizado";
}

/** El estado pedido por querystring, o null si no filtra. */
export function statusFiltro(valor: unknown): SponsorStatus | null {
  return typeof valor === "string" && SPONSOR_STATUS.includes(valor as SponsorStatus)
    ? (valor as SponsorStatus)
    : null;
}
