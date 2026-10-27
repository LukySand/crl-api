import { expect, test } from "bun:test";
import { MercadoPagoError } from "./mercadopago";
import { errorSeguroMP } from "./refunds";

const mpError = (status: number, body: unknown) => new MercadoPagoError("mensaje con juan@mail.com", status, body);

test("errorSeguroMP: status + codigo de maquina de un 4xx", () => {
  expect(errorSeguroMP(mpError(400, { error: "bad_request", message: "x" }))).toBe("HTTP 400 bad_request");
});

test("errorSeguroMP: sin codigo usa cause[].code; sin ninguno queda solo el status", () => {
  expect(errorSeguroMP(mpError(400, { cause: [{ code: 2000, description: "x" }] }))).toBe("HTTP 400 2000");
  expect(errorSeguroMP(mpError(503, null))).toBe("HTTP 503");
});

test("errorSeguroMP: nunca devuelve mensaje, email ni tarjeta del cuerpo", () => {
  const out = errorSeguroMP(
    mpError(400, {
      error: "juan@mail.com paga con 4509 9535 6623 3704",
      message: "payer juan@mail.com",
      cause: [{ code: "tarjeta 4509 9535 6623 3704" }],
    }),
  );
  expect(out).toBe("HTTP 400");
  expect(out).not.toMatch(/@|4509/);
});

test("errorSeguroMP: timeout y red", () => {
  expect(errorSeguroMP(new DOMException("agotado", "TimeoutError"))).toBe("timeout");
  expect(errorSeguroMP(new DOMException("cortado", "AbortError"))).toBe("timeout");
  expect(errorSeguroMP(new TypeError("fetch failed"))).toBe("red");
  expect(errorSeguroMP("cualquier cosa")).toBe("red");
});

test("errorSeguroMP: corta a 200", () => {
  expect(errorSeguroMP(mpError(400, { error: "a".repeat(64) })).length).toBeLessThanOrEqual(200);
});
