/**
 * Auditoría de operaciones de gestión (D17): una entrada `audit` por operación,
 * con quién, qué y el antes/después. El logger es best-effort (flush cada 5 s);
 * el hecho durable vive además en la propia fila (`created_by`, `resolved_*`...).
 *
 * `Log.user_id` es Int y los usuarios son UUID, así que el actor viaja en `metadata`.
 */
import type { Request } from "express";
import { logger, type AuditAction } from "./logger";

export function auditar(
  req: Request,
  operacion: AuditAction,
  entidad: string,
  id: string | number,
  extra: { motivo?: string; antes?: unknown; despues?: unknown } = {},
): void {
  logger.audit(
    operacion,
    {
      requestUrl: req.originalUrl,
      metadata: {
        operacion,
        entidad,
        entidad_id: String(id),
        actor_id: req.user?.id ?? null,
        actor_roles: req.user?.roles ?? [],
        motivo: extra.motivo ?? null,
        antes: extra.antes ?? null,
        despues: extra.despues ?? null,
      },
    },
    `${entidad} ${operacion}`,
  );
}
