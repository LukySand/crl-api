import { Readable } from "node:stream";
import type { Request } from "express";

/**
 * El `FormData` de un multipart, leído del stream de Express.
 *
 * ponytail: esta función estaba copiada igual en `routes/files.ts`,
 * `routes/socio.ts` y `routes/payments.ts`. Acá vive una sola vez para no sumar
 * una cuarta copia; las tres viejas se pueden migrar a este import cuando se
 * toque cada archivo (no se hace ahora para no meter ruido en el diff).
 */
export async function readFormData(req: Request) {
  const request = new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "" },
    body: Readable.toWeb(req as never),
    duplex: "half",
  } as RequestInit);

  return request.formData();
}
