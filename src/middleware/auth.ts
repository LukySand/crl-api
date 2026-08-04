import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

export interface AuthUser {
  id: number;
  dni: string;
  email: string;
  role: string;
  name: string;
  last_name: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

/** Toma el token del header Authorization: Bearer o de la cookie auth_token. */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (let cookie of cookieHeader.split(";")) {
      cookie = cookie.trim();
      const [key, value] = cookie.split("=");
      if (key === "auth_token" && value) return decodeURIComponent(value);
    }
  }
  return null;
}

/** Verifica el JWT y adjunta req.user. 401 si falta o es inválido. */
export function authenticate(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: "No autenticado" });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET) as AuthUser;
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, error: "Token inválido o expirado" });
  }
}

/** Exige que req.user tenga uno de los roles dados. Usar después de authenticate. */
export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }
    next();
  };
}
