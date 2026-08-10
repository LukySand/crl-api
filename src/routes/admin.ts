import { Router, type Response } from "express";
import prisma from "../lib/prisma";
import {
  authenticate,
  requireRole,
  type AuthedRequest,
} from "../middleware/auth";
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
} from "../lib/validation";
import type { ZodError } from "zod";

export const adminRouter = Router();

// Todo /api/admin requiere sesión y rol de gestión.
adminRouter.use(authenticate, requireRole("SuperAdmin", "Administrador"));

// Campos que devolvemos de un usuario (nunca la password).
const userSelect = {
  id: true,
  name: true,
  last_name: true,
  email: true,
  dni: true,
  celular: true,
  birth_date: true,
  role: { select: { name: true } },
} as const;

// Aplana role.name → role en la respuesta.
const flatten = (u: { role: { name: string } }) => ({ ...u, role: u.role.name });

// Convierte los errores de Zod en { campo: mensaje }.
function zodErrors(err: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of err.issues) errors[issue.path[0] as string] = issue.message;
  return errors;
}

/**
 * GET /api/admin/users — listado de usuarios (sin password).
 * ponytail: sin paginación ni filtros server-side. Dataset tamaño club;
 * la búsqueda y el filtro por rol se hacen en el front.
 */
adminRouter.get("/users", async (_req: AuthedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: [{ last_name: "asc" }, { name: "asc" }],
      select: userSelect,
    });
    res.json({ success: true, users: users.map(flatten) });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ success: false, error: "Error al listar usuarios" });
  }
});

/**
 * POST /api/admin/users — alta de usuario con rol.
 * Solo un SuperAdmin puede crear otro SuperAdmin.
 */
adminRouter.post("/users", async (req: AuthedRequest, res: Response) => {
  try {
    const parsed = adminCreateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: zodErrors(parsed.error),
      });
    }
    const { role, password, celular, birth_date, ...rest } = parsed.data;

    if (role === "SuperAdmin" && req.user?.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        error: "Solo un SuperAdmin puede asignar el rol SuperAdmin",
      });
    }
    if (await prisma.user.findFirst({ where: { dni: rest.dni } })) {
      return res
        .status(409)
        .json({ success: false, error: "El DNI ya está registrado" });
    }
    const roleRow = await prisma.role.findFirst({ where: { name: role } });
    if (!roleRow) {
      return res.status(400).json({ success: false, error: "Rol inválido" });
    }

    const user = await prisma.user.create({
      data: {
        ...rest,
        celular: celular ?? null,
        birth_date: new Date(birth_date),
        password: await Bun.password.hash(password),
        role_id: roleRow.id,
      },
      select: userSelect,
    });
    res.status(201).json({ success: true, user: flatten(user) });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ success: false, error: "Error al crear usuario" });
  }
});

/**
 * PUT /api/admin/users/:id — edición. La contraseña es opcional (vacío = no cambia).
 * Solo un SuperAdmin puede tocar cuentas SuperAdmin (existentes o de destino).
 */
adminRouter.put("/users/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string") {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const parsed = adminUpdateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: zodErrors(parsed.error),
      });
    }
    const { role, password, celular, birth_date, ...rest } = parsed.data;

    const target = await prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "Usuario no encontrado" });
    }
    const tocaSuperAdmin = role === "SuperAdmin" || target.role.name === "SuperAdmin";
    if (tocaSuperAdmin && req.user?.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        error: "Solo un SuperAdmin puede gestionar cuentas SuperAdmin",
      });
    }
    const dup = await prisma.user.findFirst({
      where: { dni: rest.dni, NOT: { id } },
    });
    if (dup) {
      return res
        .status(409)
        .json({ success: false, error: "El DNI ya está registrado" });
    }
    const roleRow = await prisma.role.findFirst({ where: { name: role } });
    if (!roleRow) {
      return res.status(400).json({ success: false, error: "Rol inválido" });
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...rest,
        celular: celular ?? null,
        birth_date: new Date(birth_date),
        role_id: roleRow.id,
        ...(password ? { password: await Bun.password.hash(password) } : {}),
      },
      select: userSelect,
    });
    res.json({ success: true, user: flatten(user) });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ success: false, error: "Error al editar usuario" });
  }
});

/**
 * DELETE /api/admin/users/:id — baja definitiva.
 * No podés borrarte a vos mismo; solo un SuperAdmin borra cuentas SuperAdmin.
 * ponytail: baja física. La baja lógica con reactivación es la issue #46
 * (necesita un campo `active`/`deleted_at` en el schema).
 */
adminRouter.delete("/users/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string") {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    if (req.user?.id === id) {
      return res
        .status(400)
        .json({ success: false, error: "No podés eliminar tu propia cuenta" });
    }
    const target = await prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "Usuario no encontrado" });
    }
    if (target.role.name === "SuperAdmin" && req.user?.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        error: "Solo un SuperAdmin puede eliminar cuentas SuperAdmin",
      });
    }

    try {
      await prisma.user.delete({ where: { id } });
    } catch {
      // FK: el usuario tiene registros asociados (ej. familias)
      return res.status(409).json({
        success: false,
        error: "No se puede eliminar: el usuario tiene registros asociados",
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ success: false, error: "Error al eliminar usuario" });
  }
});
