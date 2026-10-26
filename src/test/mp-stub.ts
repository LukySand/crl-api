/**
 * Mercado Pago de mentira para los tests (D13). `Bun.serve` en un puerto libre; el
 * código bajo prueba lo usa por `MP_API_URL`. Nunca se pisa el `fetch` global.
 */
type Json = Record<string, any>;

export function startMpStub() {
  const pagos = new Map<string, Json>();
  const preferencias: Json[] = [];
  const reembolsos: { paymentId: string; key: string | null; body: Json }[] = [];
  let fallarPreferencia = false;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const ruta = url.pathname;
      const json = (b: unknown, status = 200) => Response.json(b, { status });

      if (req.method === "POST" && ruta === "/checkout/preferences") {
        if (fallarPreferencia) return json({ message: "boom" }, 500);
        const body = (await req.json()) as Json;
        preferencias.push(body);
        const id = `pref-${preferencias.length}`;
        return json({ id, init_point: `https://mp.test/checkout/${id}` });
      }
      if (req.method === "GET" && ruta === "/v1/payments/search") {
        const ref = url.searchParams.get("external_reference");
        return json({ results: [...pagos.values()].filter((p) => p.external_reference === ref) });
      }
      const refunds = ruta.match(/^\/v1\/payments\/([^/]+)\/refunds$/);
      if (refunds) {
        const paymentId = decodeURIComponent(refunds[1]!);
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Json;
          reembolsos.push({ paymentId, key: req.headers.get("x-idempotency-key"), body });
          return json({ id: reembolsos.length, status: "approved", amount: body.amount ?? null });
        }
        return json(reembolsos.filter((r) => r.paymentId === paymentId).map((r, i) => ({ id: i + 1, ...r.body })));
      }
      const pago = ruta.match(/^\/v1\/payments\/([^/]+)$/);
      if (req.method === "GET" && pago) {
        const p = pagos.get(decodeURIComponent(pago[1]!));
        return p ? json(p) : json({ message: "not found" }, 404);
      }
      return json({ message: "ruta desconocida" }, 404);
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  process.env.MP_API_URL = base;

  return {
    url: base,
    preferencias,
    reembolsos,
    /** Registra (o reemplaza) el pago que MP "tiene" con ese id. */
    setPago(id: string | number, datos: Json) {
      pagos.set(String(id), { id, ...datos });
    },
    fallarPreferencias(v = true) {
      fallarPreferencia = v;
    },
    async close() {
      delete process.env.MP_API_URL;
      await server.stop(true);
    },
  };
}
