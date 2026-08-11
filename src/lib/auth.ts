// ponytail: extraído de routes/auth.ts para que las rutas protegidas (reservas)
// no dupliquen la lectura/verificación del token. Una sola fuente de verdad.
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

export interface JWTPayload {
  id: string;
  dni: string;
  email: string;
  role: string;
  name: string;
  last_name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/** Obtener valor de una cookie desde el header */
export function getCookieFromHeader(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (let cookie of cookieHeader.split(";")) {
    cookie = cookie.trim();
    const [key, value] = cookie.split("=");
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

/**
 * Lee el token del header Authorization o de la cookie. null si falta, es
 * inválido o quedó viejo.
 *
 * El `id` se valida en runtime a propósito: `jwt.verify` devuelve lo que haya
 * adentro del token y un `as JWTPayload` le miente al compilador. Los tokens
 * emitidos antes de migrar los ids a UUID traen `id` numérico, viven 24h y
 * sobreviven al cambio de schema — sin este chequeo ese número viaja hasta
 * Prisma y revienta en la query en vez de dar un 401 acá.
 */
export function readToken(req: Request): JWTPayload | null {
  let token: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  if (!token) token = getCookieFromHeader(req.headers.cookie, "auth_token");
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JWTPayload;
    if (typeof payload?.id !== "string" || !payload.id) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Exige sesión. Deja el payload en req.user. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = readToken(req);
  if (!user) {
    return res
      .status(401)
      .json({ success: false, error: "Necesitás iniciar sesión" });
  }
  req.user = user;
  next();
}

/** Exige uno de los roles. Usar siempre después de requireAuth. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, error: "Necesitás iniciar sesión" });
    }
    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, error: "No tenés permisos para esta acción" });
    }
    next();
  };
}

/**
 * Roles con permisos de gestión. Definido acá y en un solo lugar porque estaba
 * escrito a mano en 11 rutas como `requireRole("Administrador")` — que dejaba
 * afuera a SuperAdmin — mientras /api/admin sí lo aceptaba. Un rol nuevo con
 * permisos de gestión se agrega una vez, no once.
 */
export const ADMIN_ROLES = ["SuperAdmin", "Administrador"] as const;

/** Exige rol de gestión. Usar siempre después de requireAuth. */
export const requireAdmin = requireRole(...ADMIN_ROLES);

/** ¿El usuario del token tiene permisos de gestión? Para ramas dentro de un handler. */
export const isAdmin = (req: Request) =>
  !!req.user && (ADMIN_ROLES as readonly string[]).includes(req.user.role);
