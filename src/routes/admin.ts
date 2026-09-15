import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
  roleSchema,
} from "../lib/validation";
import {
  denyCambioDeRoles,
  nombresDeRoles,
  ordenarRoles,
  rolesInclude,
  rolesParaGuardar,
  rolPrincipal,
  validarRoles,
} from "../lib/roles";
import { parseDate, todayInClub } from "../lib/booking-date";
import type { ZodError } from "zod";

export const adminRouter = Router();

// Todo /api/admin requiere sesión y rol de gestión.
adminRouter.use(requireAuth, requireAdmin);

// Campos que devolvemos de un usuario (nunca la password).
const userSelect = {
  id: true,
  name: true,
  last_name: true,
  email: true,
  dni: true,
  celular: true,
  birth_date: true,
  active: true,
  file_id: true, // para mostrar la foto en los listados y buscadores
  ...rolesInclude,
} as const;

/**
 * Aplana los roles: `roles` es la lista y `role` el principal, que va por
 * compatibilidad con las pantallas que todavía esperan uno solo.
 */
const flatten = <T extends { role: { name: string }; roles: { role: { name: string } }[] }>(u: T) => {
  const roles = nombresDeRoles(u);
  return { ...u, roles, role: rolPrincipal(roles) };
};

/**
 * Los roles vienen como `roles: [...]`, ordenados y sin repetidos al parsear. El
 * `role` suelto se sigue aceptando (se pasa a `roles`) mientras el front de
 * gestión no mande la lista.
 *
 * Se validan dentro del schema y no después, para que un formulario con varios
 * errores los reciba todos juntos, el de roles incluido.
 *
 * ponytail: se extiende acá y no en `validation.ts` porque ese archivo está
 * duplicado con el front y el front todavía no manda `roles`. Pasa allá (en los
 * dos repos) cuando la pantalla de Usuarios elija varios roles.
 */
const rolesField = z
  .array(roleSchema, "Elegí al menos un rol")
  .transform(ordenarRoles)
  .superRefine((roles, ctx) => {
    const error = validarRoles(roles);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

/** `role` suelto → `roles: [role]`, si no vino la lista. */
const roleSueltoALista = (body: unknown) =>
  body && typeof body === "object" && !("roles" in body) && "role" in body
    ? { ...body, roles: [(body as { role: unknown }).role] }
    : body;

const conRoles = { role: roleSchema.optional(), roles: rolesField };
const createSchema = z.preprocess(roleSueltoALista, adminCreateUserSchema.extend(conRoles));
const updateSchema = z.preprocess(roleSueltoALista, adminUpdateUserSchema.extend(conRoles));

/** Ids de los roles, en el mismo orden. null si alguno no existe en la tabla. */
async function idsDeRoles(roles: string[]) {
  const filas = await prisma.role.findMany({ where: { name: { in: roles as any } } });
  if (filas.length !== roles.length) return null;
  return roles.map((r) => filas.find((f) => f.name === r)!.id);
}

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
adminRouter.get("/users", async (_req: Request, res: Response) => {
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
adminRouter.post("/users", async (req: Request, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: zodErrors(parsed.error),
      });
    }
    const { role: _role, roles, password, celular, birth_date, ...rest } = parsed.data;

    if (roles.includes("SuperAdmin") && !req.user!.roles.includes("SuperAdmin")) {
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
    if (await prisma.user.findFirst({ where: { email: rest.email } })) {
      return res
        .status(409)
        .json({ success: false, error: "El email ya está registrado" });
    }
    const roleIds = await idsDeRoles(roles);
    if (!roleIds) {
      return res.status(400).json({ success: false, error: "Rol inválido" });
    }

    const user = await prisma.user.create({
      data: {
        ...rest,
        celular: celular ?? null,
        birth_date: new Date(birth_date),
        password: await Bun.password.hash(password),
        role_id: roleIds[0]!, // espejo del principal (DEPRECADO)
        roles: { create: roleIds.map((role_id) => ({ role_id })) },
      },
      select: userSelect,
    });
    res.status(201).json({ success: true, user: flatten(user) });
  } catch (error: any) {
    // Red de seguridad ante una carrera: el @unique de email también corta acá.
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "El email ya está registrado" });
    }
    console.error("Create user error:", error);
    res.status(500).json({ success: false, error: "Error al crear usuario" });
  }
});

/**
 * PUT /api/admin/users/:id — edición. La contraseña es opcional (vacío = no cambia).
 * Los roles se reemplazan por los que vienen. Solo un SuperAdmin puede tocar
 * cuentas SuperAdmin (existentes o de destino), y nadie se saca a sí mismo el
 * rol de gestión.
 */
adminRouter.put("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string") {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: zodErrors(parsed.error),
      });
    }
    const { role: _role, roles: pedidos, password, celular, birth_date, ...rest } = parsed.data;

    const target = await prisma.user.findUnique({
      where: { id },
      include: rolesInclude,
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "Usuario no encontrado" });
    }
    const antes = nombresDeRoles(target);
    const roles = rolesParaGuardar({
      pedidos,
      antes,
      vinoRolSuelto: !("roles" in req.body) && "role" in req.body,
    });
    const deny = denyCambioDeRoles({
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
      targetId: id,
      antes,
      despues: roles,
    });
    if (deny) {
      return res.status(deny.status).json({ success: false, error: deny.error });
    }
    const dup = await prisma.user.findFirst({
      where: { dni: rest.dni, NOT: { id } },
    });
    if (dup) {
      return res
        .status(409)
        .json({ success: false, error: "El DNI ya está registrado" });
    }
    const dupEmail = await prisma.user.findFirst({
      where: { email: rest.email, NOT: { id } },
    });
    if (dupEmail) {
      return res
        .status(409)
        .json({ success: false, error: "El email ya está registrado" });
    }
    const roleIds = await idsDeRoles(roles);
    if (!roleIds) {
      return res.status(400).json({ success: false, error: "Rol inválido" });
    }

    // Borrar y volver a crear los roles va en el mismo update: Prisma lo corre en
    // una transacción, así que el usuario nunca queda sin roles a mitad de camino.
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...rest,
        celular: celular ?? null,
        birth_date: new Date(birth_date),
        role_id: roleIds[0]!, // espejo del principal (DEPRECADO)
        roles: { deleteMany: {}, create: roleIds.map((role_id) => ({ role_id })) },
        ...(password ? { password: await Bun.password.hash(password) } : {}),
      },
      select: userSelect,
    });
    res.json({ success: true, user: flatten(user) });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "El email ya está registrado" });
    }
    console.error("Update user error:", error);
    res.status(500).json({ success: false, error: "Error al editar usuario" });
  }
});

/**
 * DELETE /api/admin/users/:id — baja lógica (active = false), conserva el registro
 * y su historial. No podés darte de baja a vos mismo; solo un SuperAdmin da de baja
 * cuentas SuperAdmin. Se reactiva con PATCH /users/:id/reactivate.
 *
 * Además, al dar de baja se le cancelan las reservas de hoy en adelante (mismo
 * criterio que cancelar una reserva: status = Cancelada y active = null, así se
 * libera el turno pero queda el historial). Las pasadas no se tocan. Va todo en
 * una transacción para que no quede a medias.
 */
adminRouter.delete("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string") {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    if (req.user?.id === id) {
      return res
        .status(400)
        .json({ success: false, error: "No podés darte de baja a vos mismo" });
    }
    const target = await prisma.user.findUnique({
      where: { id },
      include: rolesInclude,
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "Usuario no encontrado" });
    }
    if (nombresDeRoles(target).includes("SuperAdmin") && !req.user!.roles.includes("SuperAdmin")) {
      return res.status(403).json({
        success: false,
        error: "Solo un SuperAdmin puede dar de baja cuentas SuperAdmin",
      });
    }

    const hoy = parseDate(todayInClub());
    const [user, canceladas, anuladas] = await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: { active: false },
        select: userSelect,
      }),
      // Cancela las reservas de hoy en adelante que sigan vivas.
      prisma.booking.updateMany({
        where: { user_id: id, date: { gte: hoy }, status: { not: "Cancelada" } },
        data: { status: "Cancelada", active: null },
      }),
      // Y anula el cobro de esas reservas, en la misma transacción: una cancha
      // que ya no va a usar no se le cobra. Se acota por `due_date` (que en una
      // reserva es el día del turno) para no tocar la deuda vieja: lo que quedó
      // debiendo antes de la baja se sigue debiendo.
      //
      // Lo ya pagado no se toca, igual que al cancelar una reserva suelta: la
      // plata entró y borrarla falsearía los ingresos.
      prisma.payment.updateMany({
        where: {
          user_id: id,
          concept: "Reserva",
          due_date: { gte: hoy },
          status: { in: ["Pendiente", "EnRevision"] },
        },
        data: { status: "Anulado" },
      }),
    ]);
    res.json({
      success: true,
      user: flatten(user),
      reservasCanceladas: canceladas.count,
      cuotasAnuladas: anuladas.count,
    });
  } catch (error) {
    console.error("Deactivate user error:", error);
    res.status(500).json({ success: false, error: "Error al dar de baja al usuario" });
  }
});

/**
 * PATCH /api/admin/users/:id/reactivate — reactiva una cuenta dada de baja.
 * Solo un SuperAdmin puede reactivar cuentas SuperAdmin.
 */
adminRouter.patch("/users/:id/reactivate", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string") {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const target = await prisma.user.findUnique({
      where: { id },
      include: rolesInclude,
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "Usuario no encontrado" });
    }
    if (nombresDeRoles(target).includes("SuperAdmin") && !req.user!.roles.includes("SuperAdmin")) {
      return res.status(403).json({
        success: false,
        error: "Solo un SuperAdmin puede reactivar cuentas SuperAdmin",
      });
    }

    const user = await prisma.user.update({
      where: { id },
      data: { active: true },
      select: userSelect,
    });
    res.json({ success: true, user: flatten(user) });
  } catch (error) {
    console.error("Reactivate user error:", error);
    res.status(500).json({ success: false, error: "Error al reactivar al usuario" });
  }
});
