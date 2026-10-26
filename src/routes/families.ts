import { Router, type Request, type Response } from "express";
import { z, type ZodError } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { requireAuth } from "../lib/auth";
import { addChildSchema, setChildCredentialsSchema } from "../lib/validation";

const setChildPhotoSchema = z.object({
  file_id: z.string().min(1, "file_id es requerido"),
});

export const familiesRouter = Router();

// Todo /api/families requiere sesión: el padre siempre sale del token, nunca
// de un id que mande el cliente.
familiesRouter.use(requireAuth);

function zodErrors(err: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of err.issues) errors[issue.path[0] as string] = issue.message;
  return errors;
}

// Email placeholder de un hijo sin credenciales propias todavía: nadie puede
// loguearse con él (la password también es random), solo cumple el
// NOT NULL/unique de User.email hasta que se cargue uno real.
const placeholderEmail = (dni: string) => `menor.${dni}@sin-email.crl-api.local`;

const childSelect = {
  id: true,
  name: true,
  last_name: true,
  dni: true,
  email: true,
  birth_date: true,
  active: true, // baja lógica del socio (club), no confundir con Family.active
  has_credentials: true,
  file_id: true,
} as const;

const familySelect = {
  id: true,
  responsible: true,
  active: true,
  created_at: true,
  child: { select: childSelect },
} as const;

/**
 * GET /api/families - hijos a cargo del usuario logueado.
 * Por default solo los vínculos activos (los desvinculados dejan de
 * "aparecer", como pide el flujo); ?all=true trae también los desvinculados.
 */
familiesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const includeAll = req.query.all === "true";
    const families = await prisma.family.findMany({
      where: { parent_id: req.user!.id, ...(includeAll ? {} : { active: true }) },
      select: familySelect,
      orderBy: { created_at: "asc" },
    });
    return res.json({ success: true, families });
  } catch (error) {
    console.error("List families error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al listar los hijos vinculados" });
  }
});

/**
 * POST /api/families/children - el padre da de alta a un hijo y queda
 * vinculado (Family.active = true). El hijo se crea sin credenciales propias:
 * no puede loguearse hasta que se le carguen credenciales reales
 * (PATCH /:id/credentials).
 */
familiesRouter.post("/children", async (req: Request, res: Response) => {
  try {
    const parsed = addChildSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: "Validación fallida", errors: zodErrors(parsed.error) });
    }
    const { name, last_name, dni, birth_date, file_id } = parsed.data;

    if (await prisma.user.findFirst({ where: { dni } })) {
      return res.status(409).json({ success: false, error: "El DNI ya está registrado" });
    }

    const socioRole = await prisma.role.findFirst({ where: { name: "Socio" } });
    if (!socioRole) {
      return res.status(500).json({
        success: false,
        error: "Error de configuración: rol Socio no encontrado",
      });
    }

    const password = await Bun.password.hash(crypto.randomUUID());

    const childId = crypto.randomUUID();

    const [, family] = await prisma.$transaction([
      prisma.user.create({
        data: {
          id: childId,
          name,
          last_name,
          dni,
          email: placeholderEmail(dni),
          password,
          birth_date: new Date(birth_date),
          roles: { create: { role_id: socioRole.id } },
          has_credentials: false,
          file_id: file_id ?? null,
        },
      }),
      prisma.family.create({
        data: { parent_id: req.user!.id, child_id: childId, responsible: true },
        select: familySelect,
      }),
    ]);

    return res.status(201).json({ success: true, family });
  } catch (error: any) {
    // El email placeholder sale del DNI: si choca, es porque el DNI ya se usó.
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "El DNI ya está registrado" });
    }
    if (error?.code === "P2003") {
      return res.status(400).json({ success: false, error: "El archivo indicado no existe" });
    }
    console.error("Add child error:", error);
    return res.status(500).json({ success: false, error: "Error al vincular al hijo" });
  }
});

/**
 * PATCH /api/families/:id/credentials - el padre carga email + contraseña
 * reales para el hijo vinculado, para que pueda entrar con su propia cuenta
 */
familiesRouter.patch("/:id/credentials", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = setChildCredentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: "Validación fallida", errors: zodErrors(parsed.error) });
    }
    const { email, password } = parsed.data;

    const family = await prisma.family.findUnique({ where: { id: req.params.id } });
    if (!family) {
      return res.status(404).json({ success: false, error: "Vínculo no encontrado" });
    }
    if (family.parent_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }
    if (!family.active) {
      return res.status(409).json({ success: false, error: "El hijo ya se desvinculó" });
    }

    const dupEmail = await prisma.user.findFirst({
      where: { email, NOT: { id: family.child_id } },
    });
    if (dupEmail) {
      return res.status(409).json({ success: false, error: "El email ya está registrado" });
    }

    const child = await prisma.user.update({
      where: { id: family.child_id },
      data: { email, password: await Bun.password.hash(password), has_credentials: true },
      select: childSelect,
    });

    return res.json({ success: true, child });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "El email ya está registrado" });
    }
    console.error("Set child credentials error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al cargar las credenciales del hijo" });
  }
});

/**
 * PATCH /api/families/:id/unlink — el padre desvincula al hijo
 * (Family.active = false). Deja de "aparecer" en el dashboard del padre; si ya
 * tiene credenciales propias, sigue entrando con su cuenta igual que antes.
 * Baja lógica, no se borra la fila (queda el historial del vínculo).
 */
familiesRouter.patch("/:id/unlink", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const family = await prisma.family.findUnique({ where: { id: req.params.id } });
    if (!family) {
      return res.status(404).json({ success: false, error: "Vínculo no encontrado" });
    }
    if (family.parent_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    // Doble tap en paralelo: la condición va en el UPDATE y gana el primero.
    const { count } = await prisma.family.updateMany({
      where: { id: family.id, active: true },
      data: { active: false },
    });
    if (count === 0) {
      return res.status(409).json({ success: false, error: "El hijo ya estaba desvinculado" });
    }

    return res.json({ success: true, message: "Hijo desvinculado" });
  } catch (error) {
    console.error("Unlink family error:", error);
    return res.status(500).json({ success: false, error: "Error al desvincular al hijo" });
  }
});

/**
 * PATCH /api/families/:id/photo — asocia al hijo un archivo ya subido con
 * PUT /api/files (esto no sube nada, solo lo asigna). Mismo criterio que
 * /credentials: solo el padre del vínculo, y solo mientras sigue activo.
 */
familiesRouter.patch("/:id/photo", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = setChildPhotoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: "Validación fallida", errors: zodErrors(parsed.error) });
    }
    const { file_id } = parsed.data;

    const family = await prisma.family.findUnique({
      where: { id: req.params.id },
      include: { child: { select: { file_id: true } } },
    });
    if (!family) {
      return res.status(404).json({ success: false, error: "Vínculo no encontrado" });
    }
    if (family.parent_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }
    if (!family.active) {
      return res.status(409).json({ success: false, error: "El hijo ya se desvinculó" });
    }

    const oldFileId = family.child.file_id;
    const child = await prisma.user.update({
      where: { id: family.child_id },
      data: { file_id },
      select: childSelect,
    });

    // Igual que PATCH /api/socio/profile-image: no deja el archivo viejo huérfano.
    if (oldFileId && oldFileId !== file_id) {
      try {
        await Storage.remove(oldFileId);
      } catch (err) {
        console.error("Error removing old child photo.", { error: err, oldFileId });
      }
    }

    return res.json({ success: true, child });
  } catch (error: any) {
    if (error?.code === "P2003") {
      return res.status(400).json({ success: false, error: "El archivo indicado no existe" });
    }
    console.error("Set child photo error:", error);
    return res.status(500).json({ success: false, error: "Error al actualizar la foto del hijo" });
  }
});
