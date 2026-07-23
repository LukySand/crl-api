import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import prisma from "../lib/prisma";
import { registerSchema } from "../lib/validation";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

const GOOGLE_CLIENT_ID = process.env.OAUTH_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Solo dni + birth_date (name/last_name vienen de Google, no hay password del cliente)
const googleProfileSchema = registerSchema.pick({ dni: true, birth_date: true });

interface JWTPayload {
  id: number;
  dni: string;
  email: string;
  role: string;
  name: string;
  last_name: string;
}

/** Obtener valor de una cookie desde el header */
function getCookieFromHeader(
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

export const authRouter = Router();

/**
 * POST /api/auth/login  — autentica con DNI y contraseña.
 * 200 { success, token, user } | 401 credenciales inválidas
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { dni, password } = req.body ?? {};

    if (!dni || !password) {
      return res
        .status(400)
        .json({ success: false, error: "DNI y contraseña son requeridos" });
    }

    const user = await prisma.user.findFirst({
      where: { dni },
      include: { role: true },
    });

    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    const passwordMatch = await Bun.password.verify(password, user.password);
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Contraseña incorrecta" });
    }

    const jwtPayload: JWTPayload = {
      id: user.id,
      dni: user.dni,
      email: user.email,
      role: user.role.name,
      name: user.name,
      last_name: user.last_name,
    };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "24h" });

    return res.status(200).json({ success: true, token, user: jwtPayload });
  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al iniciar sesión" });
  }
});

/**
 * GET /api/auth/verify — valida el token (header Authorization o cookie auth_token).
 * 200 { success, user } | 401 token inválido
 */
authRouter.get("/verify", (req: Request, res: Response) => {
  try {
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
    if (!token) {
      token = getCookieFromHeader(req.headers.cookie, "auth_token");
    }

    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: "No token provided" });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as JWTPayload;
      return res.status(200).json({
        success: true,
        user: {
          id: payload.id,
          dni: payload.dni,
          email: payload.email,
          role: payload.role,
          name: payload.name,
          last_name: payload.last_name,
        },
      });
    } catch {
      return res
        .status(401)
        .json({ success: false, error: "Invalid or expired token" });
    }
  } catch (error) {
    console.error("Verify token error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error verifying token" });
  }
});

/**
 * POST /api/auth/register — crea usuario con rol "Socio" y lo auto-loguea.
 * 201 { success, token, user } | 409 DNI/email duplicado
 */
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    const validationResult = registerSchema.safeParse(req.body ?? {});

    if (!validationResult.success) {
      const errors: Record<string, string> = {};
      validationResult.error.issues.forEach((err) => {
        const path = err.path[0] as string;
        errors[path] = err.message;
      });
      return res
        .status(400)
        .json({ success: false, error: "Validación fallida", errors });
    }

    const { name, last_name, dni, email, password, birth_date } =
      validationResult.data;

    // ponytail: solo se valida DNI duplicado (espeja a main). email no tiene @unique
    // en el schema; si se quiere unicidad, agregar constraint + check acá.
    if (await prisma.user.findFirst({ where: { dni } })) {
      return res
        .status(409)
        .json({ success: false, error: "El DNI ya está registrado" });
    }

    const socioRole = await prisma.role.findFirst({ where: { name: "Socio" } });
    if (!socioRole) {
      return res.status(500).json({
        success: false,
        error: "Error de configuración: rol Socio no encontrado",
      });
    }

    const hashedPassword = await Bun.password.hash(password);

    const newUser = await prisma.user.create({
      data: {
        name,
        last_name,
        dni,
        email,
        password: hashedPassword,
        birth_date: new Date(birth_date),
        role_id: socioRole.id,
      },
      include: { role: true },
    });

    const jwtPayload: JWTPayload = {
      id: newUser.id,
      dni: newUser.dni,
      email: newUser.email,
      role: newUser.role.name,
      name: newUser.name,
      last_name: newUser.last_name,
    };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "24h" });

    return res.status(201).json({ success: true, token, user: jwtPayload });
  } catch (error) {
    console.error("Register error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al registrar usuario" });
  }
});

/**
 * POST /api/auth/logout — limpia la cookie del cliente.
 */
authRouter.post("/logout", (_req: Request, res: Response) => {
  res.setHeader(
    "Set-Cookie",
    "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;",
  );
  return res
    .status(200)
    .json({ success: true, message: "Logout successful" });
});

/**
 * GET /api/auth/google/config — expone el Client ID (público) para que el front
 * inicialice Google Identity Services. Así el ID vive solo en el .env del backend.
 */
authRouter.get("/google/config", (_req: Request, res: Response) => {
  res.json({ clientId: GOOGLE_CLIENT_ID });
});

/**
 * POST /api/auth/google — login/alta con Google (ID token de Google Identity Services).
 * Body: { credential, dni?, birth_date? }
 *  - usuario existente (match por email) → 200 { token, user }
 *  - usuario nuevo sin dni/birth_date     → 200 { needsProfile: true, profile }
 *  - usuario nuevo con dni/birth_date      → 201 { token, user } (crea con password random, solo entra por Google)
 */
authRouter.post("/google", async (req: Request, res: Response) => {
  try {
    const { credential, dni, birth_date } = req.body ?? {};
    if (!credential) {
      return res
        .status(400)
        .json({ success: false, error: "Falta el credential de Google" });
    }

    // Verifica firma + audience contra nuestro Client ID (nunca confiar en el cliente)
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res
        .status(401)
        .json({ success: false, error: "Token de Google inválido" });
    }
    // Solo confiamos en el email si Google lo verificó (evita reclamar email ajeno)
    if (!payload.email_verified) {
      return res
        .status(401)
        .json({ success: false, error: "El email de Google no está verificado" });
    }

    const email = payload.email;
    const name = payload.given_name ?? payload.name ?? "";
    const last_name = payload.family_name ?? "";

    let user = await prisma.user.findFirst({
      where: { email },
      include: { role: true },
    });
    let created = false;

    if (!user) {
      // Alta: faltan dni/birth_date → el front los pide y reintenta con el mismo credential
      if (!dni || !birth_date) {
        return res
          .status(200)
          .json({ success: true, needsProfile: true, profile: { email, name, last_name } });
      }

      const parsed = googleProfileSchema.safeParse({ dni, birth_date });
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        parsed.error.issues.forEach((err) => {
          errors[err.path[0] as string] = err.message;
        });
        return res
          .status(400)
          .json({ success: false, error: "Validación fallida", errors });
      }

      if (await prisma.user.findFirst({ where: { dni: parsed.data.dni } })) {
        return res
          .status(409)
          .json({ success: false, error: "El DNI ya está registrado" });
      }

      const socioRole = await prisma.role.findFirst({ where: { name: "Socio" } });
      if (!socioRole) {
        return res.status(500).json({
          success: false,
          error: "Error de configuración: rol Socio no encontrado",
        });
      }

      // ponytail: password random solo para cumplir el NOT NULL — nadie la conoce,
      // no se puede loguear con dni+password. Estos usuarios entran solo por Google.
      const password = await Bun.password.hash(crypto.randomUUID());

      user = await prisma.user.create({
        data: {
          name,
          last_name,
          dni: parsed.data.dni,
          email,
          password,
          birth_date: new Date(parsed.data.birth_date),
          role_id: socioRole.id,
        },
        include: { role: true },
      });
      created = true;
    }

    const jwtPayload: JWTPayload = {
      id: user.id,
      dni: user.dni,
      email: user.email,
      role: user.role.name,
      name: user.name,
      last_name: user.last_name,
    };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "24h" });

    return res
      .status(created ? 201 : 200)
      .json({ success: true, token, user: jwtPayload });
  } catch (error) {
    console.error("Google auth error:", error);
    return res
      .status(401)
      .json({ success: false, error: "No se pudo autenticar con Google" });
  }
});
