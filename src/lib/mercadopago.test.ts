// ponytail: el webhook es la ÚNICA ruta pública de todo el API que escribe en la
// base. Si la firma no se valida bien, cualquiera marca sus cuotas como pagas
// mandando un POST. Es la superficie de ataque de todo el cambio, así que estos
// tests se escribieron ANTES que la implementación (T5.1 → T5.2).
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature, mapEstadoMP, esLocal, preferenceBody, listRefunds } from "./mercadopago";

const SECRET = "clave-de-webhook-de-prueba";
const DATA_ID = "123456789";
const REQUEST_ID = "d1f2e3a4-0000-4000-8000-000000000001";
const TS = "1789000000";

/** Firma legítima, armada igual que la arma Mercado Pago. */
function firmar(dataId = DATA_ID, requestId = REQUEST_ID, ts = TS, secret = SECRET): string {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

// ─── lo que tiene que pasar (S7.1) ───────────────────────────────────────────

test("acepta una firma legítima", () => {
  expect(verifySignature(firmar(), REQUEST_ID, DATA_ID, SECRET)).toBe(true);
});

test("rechaza una firma falsificada", () => {
  const forjada = `ts=${TS},v1=${"a".repeat(64)}`;
  expect(verifySignature(forjada, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("rechaza una firma hecha con otra clave", () => {
  // El atacante conoce el formato del manifest — está en la documentación
  // pública. Lo único que no tiene es el secreto.
  const otraClave = firmar(DATA_ID, REQUEST_ID, TS, "clave-que-no-es");
  expect(verifySignature(otraClave, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("una firma válida NO sirve para otro pago", () => {
  // Replay: interceptar la notificación de un pago de $100 y reusarla para
  // acreditar otro. El data.id entra en el manifest justamente para esto.
  const firmaDeOtroPago = firmar("999999999");
  expect(verifySignature(firmaDeOtroPago, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("una firma válida NO sirve con otro request-id", () => {
  const firmaDeOtroRequest = firmar(DATA_ID, "00000000-0000-4000-8000-000000000999");
  expect(verifySignature(firmaDeOtroRequest, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("cambiar el ts invalida la firma", () => {
  const conOtroTs = firmar(DATA_ID, REQUEST_ID, "1700000000");
  // Se manda el v1 viejo pero el ts nuevo: el manifest ya no coincide.
  const mezclada = `ts=999,v1=${conOtroTs.split("v1=")[1]}`;
  expect(verifySignature(mezclada, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

// ─── manifest parcial: el simulador del panel (bug real) ─────────────────────
// El template de la doc NO es literal. El SDK oficial omite el par entero
// cuando el valor no vino, y pasa el data.id a minúsculas. El simulador manda
// el data.id sólo en el body, así que por query no llega nada y Mercado Pago
// firma un manifest SIN el par `id:`. Armar el template al pie de la letra daba
// 401 con el simulador y funcionaba con las notificaciones reales, que sí
// mandan data.id por query — por eso el bug estaba escondido.

/** Firma un manifest armado a mano, para imitar lo que arma Mercado Pago. */
function firmarManifest(manifest: string, ts = TS, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

test("sin data.id, el par `id:` se omite del manifest", () => {
  const firma = firmarManifest(`request-id:${REQUEST_ID};ts:${TS};`);
  expect(verifySignature(firma, REQUEST_ID, "", SECRET)).toBe(true);
});

test("sin x-request-id, el par `request-id:` se omite del manifest", () => {
  const firma = firmarManifest(`id:${DATA_ID};ts:${TS};`);
  expect(verifySignature(firma, "", DATA_ID, SECRET)).toBe(true);
});

test("el data.id alfanumérico entra al manifest en minúsculas", () => {
  const firma = firmarManifest(`id:abc-def;request-id:${REQUEST_ID};ts:${TS};`);
  expect(verifySignature(firma, REQUEST_ID, "ABC-DEF", SECRET)).toBe(true);
});

test("omitir un par NO afloja la firma: sigue haciendo falta el secreto", () => {
  // Lo importante del cambio: aceptamos un manifest más corto, no una firma
  // más débil. Sin el secreto no entra igual.
  const firma = firmarManifest(`request-id:${REQUEST_ID};ts:${TS};`, TS, "clave-que-no-es");
  expect(verifySignature(firma, REQUEST_ID, "", SECRET)).toBe(false);
});

// ─── headers rotos: tienen que devolver false, NO tirar excepción ────────────
// crypto.timingSafeEqual explota si los buffers miden distinto. Una firma corta
// haría un throw sin atrapar: 500 en vez de 401, y el atacante aprende que ese
// input es especial.

test("un header vacío o ausente no pasa y no explota", () => {
  expect(verifySignature("", REQUEST_ID, DATA_ID, SECRET)).toBe(false);
  expect(verifySignature(undefined as unknown as string, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("un header sin v1 no pasa y no explota", () => {
  expect(verifySignature(`ts=${TS}`, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("un header sin ts no pasa y no explota", () => {
  expect(verifySignature("v1=abc123", REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("un v1 más corto que el hash no explota, devuelve false", () => {
  // Este es el que rompe una implementación ingenua con timingSafeEqual.
  expect(verifySignature(`ts=${TS},v1=abc`, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("un v1 que no es hexadecimal no explota, devuelve false", () => {
  expect(verifySignature(`ts=${TS},v1=${"z".repeat(64)}`, REQUEST_ID, DATA_ID, SECRET)).toBe(false);
});

test("sin clave secreta configurada NUNCA valida", () => {
  // Si MP_WEBHOOK_SECRET falta en el .env, la respuesta segura es rechazar
  // todo, no aceptar todo.
  expect(verifySignature(firmar(), REQUEST_ID, DATA_ID, "")).toBe(false);
});

// ─── mapeo de estados (T5.3) ─────────────────────────────────────────────────

test("mapea los estados de Mercado Pago a los nuestros", () => {
  expect(mapEstadoMP("approved")).toBe("Aprobado");
  expect(mapEstadoMP("rejected")).toBe("Rechazado");
  expect(mapEstadoMP("cancelled")).toBe("Cancelado");
  expect(mapEstadoMP("refunded")).toBe("Reembolsado");
  expect(mapEstadoMP("charged_back")).toBe("Contracargo");
});

test("los estados en curso quedan pendientes", () => {
  expect(mapEstadoMP("pending")).toBe("Pendiente");
  expect(mapEstadoMP("in_process")).toBe("Pendiente");
  // authorized es plata retenida, todavía no acreditada: no es Aprobado.
  expect(mapEstadoMP("authorized")).toBe("Pendiente");
  // in_mediation es una disputa abierta. Nuestro enum no la tiene; el string
  // crudo se guarda en mp_status para no perder el dato.
  expect(mapEstadoMP("in_mediation")).toBe("Pendiente");
});

test("un estado desconocido NUNCA se toma como aprobado", () => {
  // Si Mercado Pago agrega un estado mañana, el peor default posible sería dar
  // la cuota por pagada. Ante la duda, pendiente.
  expect(mapEstadoMP("un_estado_que_no_existe")).toBe("Pendiente");
  expect(mapEstadoMP("")).toBe("Pendiente");
});

// ─── back_urls locales (bug real: invalid_auto_return) ───────────────────────
// Mercado Pago rechaza la preferencia ENTERA si mandás auto_return con una
// back_url a localhost, y el mensaje de error miente: dice que back_url.success
// no está definida cuando en realidad sí está, sólo que es local.

test("reconoce las URLs locales, que son las que rompen auto_return", () => {
  expect(esLocal("http://localhost:3000")).toBe(true);
  expect(esLocal("http://localhost:3000/pagos/exito")).toBe(true);
  expect(esLocal("http://127.0.0.1:3000")).toBe(true);
  expect(esLocal("https://localhost")).toBe(true);
  expect(esLocal("http://0.0.0.0:8080")).toBe(true);
});

test("no confunde un dominio público que apenas empieza parecido", () => {
  // Si esto diera true, en producción se perdería el auto_return para siempre
  // y nadie sabría por qué.
  expect(esLocal("https://localhost.miclub.com.ar")).toBe(false);
  expect(esLocal("https://clublibertador.com.ar")).toBe(false);
  expect(esLocal("https://catapult-decent-whisking.ngrok-free.dev")).toBe(false);
  expect(esLocal("https://127.0.0.1.evil.com")).toBe(false);
});

// ─── métodos de pago excluidos (bug real: hold de 5 min vs. Rapipago) ────────
// Un Rapipago/Pago Fácil se acredita días después de generado. El hold de una
// reserva dura MINUTOS_PARA_PAGAR_RESERVA (5 minutos): si el pago no llegara
// nunca a tiempo, el turno ya se soltó y Mercado Pago acredita un pago que
// termina reembolsado. Toda preferencia excluye los medios offline.

const OPTS_BASE = {
  externalReference: "pago-1",
  items: [{ title: "Reserva", quantity: 1, unit_price: 1000 }],
  backUrlBase: "https://clublibertador.com.ar",
};

test("el body de la preferencia excluye ticket y atm", () => {
  const body = preferenceBody(OPTS_BASE);
  expect(body.payment_methods).toEqual({
    excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
  });
});

test("la exclusión va en toda preferencia, tenga o no vencimiento", () => {
  const conVencimiento = preferenceBody({ ...OPTS_BASE, expiresAt: new Date("2026-09-30") });
  expect(conVencimiento.payment_methods).toEqual({
    excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
  });
});

// ─── MP_TEST_PAYER_EMAIL (bug real: "una de las partes es de prueba") ───────
// Con credenciales de prueba, Mercado Pago rechaza el pago si el payer es una
// cuenta real. La variable pisa el email del socio por el de la cuenta
// compradora de prueba; vacía, no cambia nada.

test("sin MP_TEST_PAYER_EMAIL, manda el email real del socio", () => {
  delete process.env.MP_TEST_PAYER_EMAIL;
  const body = preferenceBody({ ...OPTS_BASE, payerEmail: "socio@real.com" });
  expect(body.payer).toEqual({ email: "socio@real.com" });
});

test("con MP_TEST_PAYER_EMAIL, pisa el email del socio por el del comprador de prueba", () => {
  process.env.MP_TEST_PAYER_EMAIL = "test_user_12345@testuser.com";
  try {
    const body = preferenceBody({ ...OPTS_BASE, payerEmail: "socio@real.com" });
    expect(body.payer).toEqual({ email: "test_user_12345@testuser.com" });
  } finally {
    delete process.env.MP_TEST_PAYER_EMAIL;
  }
});

test("sin payerEmail ni MP_TEST_PAYER_EMAIL, no manda payer", () => {
  delete process.env.MP_TEST_PAYER_EMAIL;
  const body = preferenceBody(OPTS_BASE);
  expect(body.payer).toBeUndefined();
});

// ─── MP_API_URL (stub de tests) ──────────────────────────────────────────────

test("MP_API_URL redirige las llamadas y listRefunds devuelve la lista", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/v1/payments/77/refunds"
        ? Response.json([{ id: 1, amount: 50 }])
        : Response.json({}, { status: 404 }),
  });
  process.env.MP_API_URL = `http://127.0.0.1:${server.port}/`;
  try {
    expect(await listRefunds("77")).toEqual([{ id: 1, amount: 50 }]);
  } finally {
    delete process.env.MP_API_URL;
    await server.stop(true);
  }
});
