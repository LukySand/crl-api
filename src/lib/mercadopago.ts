/**
 * Cliente de Mercado Pago.
 *
 * ponytail: `fetch` nativo, sin el SDK `mercadopago`.
 *
 * Son tres llamadas HTTP (crear preferencia, leer un pago, reembolsar) y el SDK
 * declara soporte para Node ≥20, no para Bun. Pero sobre todo: el SDK no
 * resuelve lo único difícil de esta integración, que es la validación de firma
 * y la idempotencia del webhook — eso hay que escribirlo a mano igual. No se
 * agrega una dependencia para ahorrarse tres `fetch`.
 *
 * Docs: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/landing
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionStatus } from "../../prisma/generated/client";

/** Base de la API; `MP_API_URL` la reemplaza (stub de tests). Se lee en cada llamada. */
const apiBase = () => (process.env.MP_API_URL || "https://api.mercadopago.com").replace(/\/$/, "");

/** El access token de la aplicación. Privado: nunca sale del backend. */
export function accessToken(): string {
  return process.env.MP_ACCESS_TOKEN ?? "";
}

/**
 * ¿Valida la firma `x-signature` de una notificación? (S7.1, DEC-4)
 *
 * Mercado Pago manda `x-signature: ts=<epoch>,v1=<hmac-sha256-hex>` y
 * `x-request-id`. El HMAC se calcula sobre el manifest:
 *
 *     id:{data.id};request-id:{x-request-id};ts:{ts};
 *
 * Los tres campos entran a propósito: el `data.id` impide reusar la firma de un
 * pago para acreditar otro, y el `ts` impide reusar una vieja.
 *
 * ⚠️ El template NO es literal, y la doc en español no lo aclara. El SDK oficial
 * (github.com/mercadopago/sdk-go/pkg/webhook) agrega tres reglas:
 *
 *   1. el par que no vino en la notificación se OMITE entero del manifest,
 *      no se manda vacío;
 *   2. el `data.id` sale de la QUERY STRING, nunca del body;
 *   3. el `data.id` alfanumérico va en minúsculas.
 *
 * Implementar el template al pie de la letra hace que la firma nunca valide
 * cuando falta una pieza — que es justo lo que manda el simulador del panel.
 *
 * ponytail: el manifest usa SÓLO headers, nunca los bytes del body. Por eso el
 * `express.json()` global de `server.ts` no molesta y no hizo falta un
 * `express.raw()` para esta ruta — que es lo que sí exige Stripe.
 *
 * Todo camino de error devuelve `false`, nunca lanza: `timingSafeEqual` explota
 * si los buffers miden distinto, y un throw acá sería un 500 en vez de un 401.
 */
export function verifySignature(
  xSignature: string,
  xRequestId: string,
  dataId: string,
  secret: string,
): boolean {
  if (!secret || !xSignature) return false;

  // "ts=123,v1=abc" → { ts: "123", v1: "abc" }
  const partes = new Map<string, string>();
  for (const parte of xSignature.split(",")) {
    const [clave, valor] = parte.split("=");
    if (clave && valor) partes.set(clave.trim(), valor.trim());
  }

  const ts = partes.get("ts");
  const v1 = partes.get("v1");
  if (!ts || !v1) return false;

  // Cada par entra sólo si su valor vino. Ver las tres reglas del encabezado.
  const manifest =
    (dataId ? `id:${dataId.toLowerCase()};` : "") +
    (xRequestId ? `request-id:${xRequestId};` : "") +
    `ts:${ts};`;
  const esperado = createHmac("sha256", secret).update(manifest).digest();

  // Buffer.from con "hex" ignora en silencio lo que no sea hexadecimal, así que
  // un v1 basura da un buffer más corto. La comparación de longitud lo corta
  // antes de llegar a timingSafeEqual, que tiraría RangeError.
  const recibido = Buffer.from(v1, "hex");
  if (recibido.length !== esperado.length) return false;

  // Comparación en tiempo constante, nunca `===`. Un `===` corta en el primer
  // byte distinto, y esa diferencia de microsegundos deja adivinar el hash byte
  // por byte.
  return timingSafeEqual(recibido, esperado);
}

/**
 * Traduce el `status` de Mercado Pago a nuestro enum.
 *
 * El string crudo se guarda igual en `PaymentTransaction.mp_status` y `mp_status_detail`:
 * si mañana agregan un estado, el dominio no se entera pero el dato no se
 * pierde.
 *
 * Estados: https://www.mercadopago.com.ar/developers/en/docs/checkout-api-orders/payment-management/status/transaction-status
 */
export function mapEstadoMP(status: string): TransactionStatus {
  switch (status) {
    case "approved":
      return "Aprobado";
    case "rejected":
      return "Rechazado";
    case "cancelled":
      return "Cancelado";
    case "refunded":
      return "Reembolsado";
    case "charged_back":
      return "Contracargo";
    // `authorized` es plata retenida pero no acreditada, e `in_mediation` es una
    // disputa abierta. Ninguno es "cobrado".
    case "pending":
    case "in_process":
    case "authorized":
    case "in_mediation":
      return "Pendiente";
    default:
      // ponytail: el default NUNCA puede ser Aprobado. Si Mercado Pago agrega un
      // estado, dar la cuota por pagada sería el peor error posible; dejarla
      // pendiente es recuperable.
      return "Pendiente";
  }
}

/** Error de la API de Mercado Pago, con el status HTTP para poder decidir arriba. */
export class MercadoPagoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "MercadoPagoError";
  }
}

async function mpFetch(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const { idempotencyKey, ...rest } = init;

  const res = await fetch(`${apiBase()}${path}`, {
    ...rest,
    // ponytail: `fetch` sin timeout espera para siempre, y el webhook llama a
    // getPayment() ANTES de responder. Un fetch colgado se come los 22 segundos
    // que espera Mercado Pago y la notificación muere con "timeout of 22000ms
    // exceeded" — sin un solo error en nuestro log, que es lo peor de todo.
    //
    // 10s deja margen de sobra para devolver el 500 dentro de la ventana, y el
    // 500 es lo que hace que Mercado Pago reintente.
    signal: rest.signal ?? AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      ...rest.headers,
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new MercadoPagoError(
      `Mercado Pago respondió ${res.status} en ${path}`,
      res.status,
      body,
    );
  }
  return body as Record<string, any>;
}

/**
 * ¿La URL apunta a la propia máquina? Mercado Pago no acepta back_urls locales
 * junto con `auto_return`, así que en desarrollo hay que omitirlo.
 */
export function esLocal(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url.trim());
}

export type PreferenceItem = {
  title: string;
  quantity: number;
  unit_price: number;
};

export type PreferenceOpts = {
  externalReference: string;
  items: PreferenceItem[];
  payerEmail?: string;
  backUrlBase: string;
  notificationUrl?: string;
  expiresAt?: Date;
};

/**
 * Arma el body de `/checkout/preferences`. Separada de `createPreference` para
 * poder testear la forma exacta del body sin pegarle a la red (S9, unit test).
 *
 * ponytail: `MP_TEST_PAYER_EMAIL` pisa el email del socio, UN solo lugar para
 * las dos rutas que arman una preferencia (reservas y cuotas). Con
 * credenciales de prueba (`APP_USR...` de test), Mercado Pago rechaza el pago
 * con "una de las partes es de prueba" si el `payer.email` es una cuenta real
 * — tiene que ser el email del comprador de prueba. Vacía en producción, la
 * variable no hace nada y sigue mandando el email real del socio.
 */
export function preferenceBody(opts: PreferenceOpts): Record<string, unknown> {
  const payerEmail = process.env.MP_TEST_PAYER_EMAIL || opts.payerEmail;
  return {
    items: opts.items,
    external_reference: opts.externalReference,
    ...(payerEmail ? { payer: { email: payerEmail } } : {}),
    back_urls: {
      success: `${opts.backUrlBase}/pagos/exito`,
      failure: `${opts.backUrlBase}/pagos/error`,
      pending: `${opts.backUrlBase}/pagos/pendiente`,
    },
    // ponytail: `auto_return` sólo si la URL de vuelta es pública.
    //
    // Mercado Pago rechaza la preferencia entera con
    // `invalid_auto_return: "back_url.success must be defined"` cuando
    // auto_return viene con una back_url a localhost. El mensaje miente —
    // la back_url SÍ está definida, lo que no le gusta es que sea local.
    //
    // Sin auto_return el flujo funciona igual: en vez de redirigir solo al
    // aprobar, el socio aprieta "Volver al sitio". Es comodidad, no el cobro.
    ...(esLocal(opts.backUrlBase) ? {} : { auto_return: "approved" }),
    ...(opts.notificationUrl ? { notification_url: opts.notificationUrl } : {}),
    ...(opts.expiresAt
      ? { expires: true, expiration_date_to: opts.expiresAt.toISOString() }
      : {}),
    // Toda preferencia ofrece sólo métodos instantáneos (decisión P9,
    // administracion-de-pagos). El hold de una reserva dura
    // MINUTOS_PARA_PAGAR_RESERVA (5 minutos): un Rapipago/Pago Fácil se
    // acredita días después, el turno ya se soltó y el pago vuelve
    // reembolsado. Va acá y no sólo en el front porque la elige Mercado Pago
    // en SU checkout, no nosotros.
    payment_methods: {
      excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
    },
  };
}

/**
 * Crea una preferencia de Checkout Pro y devuelve el link al que redirigir.
 *
 * `external_reference` es **nuestro** `Payment.id`: es el puente de vuelta desde
 * el webhook, porque la notificación sólo trae el id de Mercado Pago.
 */
export async function createPreference(
  opts: PreferenceOpts,
): Promise<{ id: string; init_point: string }> {
  const body = await mpFetch("/checkout/preferences", {
    method: "POST",
    body: JSON.stringify(preferenceBody(opts)),
  });

  // ponytail: `sandbox_init_point` NO se devuelve a propósito. Mercado Pago lo
  // deprecó y `sandbox.mercadopago.com.ar` quedó en un loop de redirects
  // (ERR_TOO_MANY_REDIRECTS). El ambiente lo define el ACCESS TOKEN, no la URL:
  // con credenciales de prueba, `init_point` YA es el checkout de prueba.
  return {
    id: body.id,
    init_point: body.init_point,
  };
}

/**
 * Lee un pago de Mercado Pago.
 *
 * Se llama SIEMPRE al recibir una notificación, aunque el body traiga datos: el
 * body de un webhook es input de internet, la respuesta autenticada de esta
 * llamada es la fuente de verdad (S7.5).
 */
export function getPayment(paymentId: string) {
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Reembolsa un pago: total si no se pasa monto, parcial si se pasa.
 *
 * `X-Idempotency-Key` es obligatoria para Mercado Pago, y además es lo que hace
 * que reintentar un reembolso que falló por red no devuelva la plata dos veces.
 * Por eso se guarda en `Refund.idempotency_key`: el reintento tiene que mandar
 * la MISMA clave, no una nueva.
 *
 * Docs: https://www.mercadopago.com.ar/developers/es/reference/chargebacks/_payments_id_refunds/post
 */
export function refundPayment(paymentId: string, idempotencyKey: string, amount?: number) {
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: "POST",
    idempotencyKey,
    body: JSON.stringify(amount === undefined ? {} : { amount }),
  });
}

/** Reembolsos de un pago (conciliación de devoluciones hechas fuera de la app). */
export async function listRefunds(paymentId: string) {
  const body = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`);
  return (Array.isArray(body) ? body : []) as Record<string, any>[];
}

/**
 * Busca los pagos de una preferencia por nuestro `external_reference`.
 *
 * Es la vuelta que permite reconciliar sin webhook: nosotros sabemos nuestro
 * `Payment.id`, Mercado Pago sabe el suyo, y este endpoint los une.
 */
export async function searchPaymentsByExternalReference(ref: string) {
  const body = await mpFetch(
    `/v1/payments/search?external_reference=${encodeURIComponent(ref)}`,
  );
  return (body?.results ?? []) as Record<string, any>[];
}
