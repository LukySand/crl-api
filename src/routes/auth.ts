import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

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
    const { name, last_name, dni, email, password, birth_date } =
      req.body ?? {};

    if (!name || !last_name || !dni || !email || !password || !birth_date) {
      return res
        .status(400)
        .json({ success: false, error: "Todos los campos son requeridos" });
    }

    if (await prisma.user.findFirst({ where: { dni } })) {
      return res
        .status(409)
        .json({ success: false, error: "El DNI ya está registrado" });
    }
    if (await prisma.user.findFirst({ where: { email } })) {
      return res
        .status(409)
        .json({ success: false, error: "El email ya está registrado" });
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
