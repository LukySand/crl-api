// ponytail: extraído de routes/auth.ts para que las rutas protegidas (reservas)
// no dupliquen la lectura/verificación del token. Una sola fuente de verdad.
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { ADMIN_ROLES, esGestion, nombresDeRoles, rolPrincipal, tieneRol } from "./roles";

export { ADMIN_ROLES };

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

export interface JWTPayload {
  id: string;
  dni: string;
  email: string;
  /** Todos sus roles, de más a menos acceso. Los permisos se chequean contra esta lista. */
  roles: string[];
  /**
   * DEPRECADO: el rol principal (`roles[0]`). Sigue viajando para el código que
   * todavía lee uno solo; se saca en el PR de limpieza.
   */
  role: string;
  name: string;
  last_name: string;
  file_id: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/** Arma el payload de sesión de un usuario traído con `rolesInclude`. */
export function sessionPayload(user: {
  id: string;
  dni: string;
  email: string;
  name: string;
  last_name: string;
  file_id: string | null;
  role: { name: string };
  roles: { role: { name: string } }[];
}): JWTPayload {
  const roles = nombresDeRoles(user);
  return {
    id: user.id,
    dni: user.dni,
    email: user.email,
    roles,
    role: rolPrincipal(roles),
    name: user.name,
    last_name: user.last_name,
    file_id: user.file_id ?? null,
  };
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
    // Los tokens emitidos antes de los varios roles traen sólo `role` y viven 24h:
    // se completan acá, en un solo lugar, para que ningún chequeo tenga que
    // acordarse de ese caso.
    if (!Array.isArray(payload.roles)) payload.roles = [payload.role];
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
    if (!tieneRol(req.user.roles, ...roles)) {
      return res
        .status(403)
        .json({ success: false, error: "No tenés permisos para esta acción" });
    }
    next();
  };
}

/**
 * Exige rol de gestión. Usar siempre después de requireAuth.
 *
 * `ADMIN_ROLES` (en `roles.ts`) está en un solo lugar porque estaba escrito a mano
 * en 11 rutas como `requireRole("Administrador")` — que dejaba afuera a
 * SuperAdmin — mientras /api/admin sí lo aceptaba. Un rol nuevo con permisos de
 * gestión se agrega una vez, no once.
 */
export const requireAdmin = requireRole(...ADMIN_ROLES);

/** ¿El usuario del token tiene permisos de gestión? Para ramas dentro de un handler. */
export const isAdmin = (req: Request) => !!req.user && esGestion(req.user.roles);

/** ¿El usuario del token tiene alguno de estos roles? Para ramas dentro de un handler. */
export const hasRole = (req: Request, ...roles: string[]) =>
  !!req.user && tieneRol(req.user.roles, ...roles);

/**
 * ¿Este listado se arma con la mirada de gestión (todo el club)? Sí si es admin,
 * salvo que pida `?propias=true`.
 *
 * Existe por los varios roles: un Administrador que además es Socio abre "Mis
 * reservas" en la app de socio y, sin esto, le llegarían las de todo el club. La
 * app de socio manda `propias=true`; el panel de gestión no manda nada.
 */
export const veComoGestion = (req: Request) =>
  isAdmin(req) && req.query.propias !== "true";
