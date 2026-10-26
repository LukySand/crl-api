/**
 * Lectura y escritura de los ajustes del club en la base. Aparte de `settings.ts`
 * para que ése siga siendo puro.
 *
 * Los ajustes se leen en cada reserva y cada cancelación, y casi nunca cambian: se
 * guardan en memoria unos segundos. Al actualizar se descarta, así el cambio rige
 * en el acto en este proceso.
 */
import prisma from "./prisma";
import { AJUSTES_POR_DEFECTO, aplicarCambio, type Ajustes, type AjustesPatch } from "./settings";

export const AJUSTES_ID = 1;

const TTL_MS = 30_000;
let cache: { at: number; valor: Ajustes } | null = null;

/** Descarta lo cacheado. */
export function invalidarAjustes() {
  cache = null;
}

/** Los ajustes vigentes; los por defecto si todavía no se guardó ninguno. */
export async function getAjustes(): Promise<Ajustes> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.valor;
  const fila = await prisma.clubSettings.findUnique({ where: { id: AJUSTES_ID } });
  const valor: Ajustes = fila
    ? {
        cancel_hours_before: fila.cancel_hours_before,
        days_ahead_member: fila.days_ahead_member,
        days_ahead_admin: fila.days_ahead_admin,
        payment_due_day: fila.payment_due_day,
      }
    : AJUSTES_POR_DEFECTO;
  cache = { at: Date.now(), valor };
  return valor;
}

/** Guarda el resultado de aplicar un cambio sobre los ajustes vigentes y lo devuelve. */
export async function guardarAjustes(patch: AjustesPatch, userId: string): Promise<Ajustes> {
  const nuevo = aplicarCambio(await getAjustes(), patch);
  await prisma.clubSettings.upsert({
    where: { id: AJUSTES_ID },
    create: { id: AJUSTES_ID, ...nuevo, updated_by: userId },
    update: { ...nuevo, updated_by: userId },
  });
  invalidarAjustes();
  return nuevo;
}
