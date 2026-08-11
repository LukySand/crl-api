import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";

export const disciplinesRouter = Router();

// ponytail: schema acá y no en lib/validation.ts — ese archivo está duplicado con
// el front y solo sincroniza lo que ambos validan. Acá el front manda y el server valida.
// Los FK van opcionales: una disciplina puede existir sin profe/cuota/espacio asignado.
const disciplineSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(100),
  professor_id: z.string().min(1).optional().nullable(),
  fee_id: z.coerce.number().int().positive().optional().nullable(),
  place_id: z.coerce.number().int().positive().optional().nullable(),
});

const disciplineUpdateSchema = disciplineSchema.partial();

// Nombres relacionados que devolvemos (no el objeto entero de cada relación).
const disciplineInclude = {
  professor: { select: { id: true, name: true, last_name: true } },
  fee: { select: { id: true, name: true, amount: true } },
  place: { select: { id: true, name: true } },
} as const;

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

// El profesor asignado tiene que ser un User con rol Profesor (no un Socio/Admin).
// Devuelve un mensaje de error si no es válido, o null si está ok / no se asignó.
async function invalidProfessor(professor_id: string | null | undefined): Promise<string | null> {
  if (!professor_id) return null;
  const prof = await prisma.user.findUnique({
    where: { id: professor_id },
    include: { role: true },
  });
  if (!prof) return "El profesor asignado no existe";
  if (prof.role.name !== "Profesor") return "El usuario asignado no es un profesor";
  return null;
}

/** GET /api/disciplines — lista de disciplinas. Abierto: socios/profes/visitante ven la oferta. */
disciplinesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const disciplines = await prisma.discipline.findMany({
      orderBy: { name: "asc" },
      include: disciplineInclude,
    });
    return res.json({ success: true, disciplines });
  } catch (error) {
    console.error("List disciplines error:", error);
    return res.status(500).json({ success: false, error: "Error al listar disciplinas" });
  }
});

/** GET /api/disciplines/:id */
disciplinesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const discipline = await prisma.discipline.findUnique({
      where: { id },
      include: disciplineInclude,
    });
    if (!discipline) {
      return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
    }
    return res.json({ success: true, discipline });
  } catch (error) {
    console.error("Get discipline error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener la disciplina" });
  }
});

/** POST /api/disciplines — crea una disciplina. Solo Administrador. */
disciplinesRouter.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = disciplineSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const { name, professor_id, fee_id, place_id } = parsed.data;
      const profError = await invalidProfessor(professor_id);
      if (profError) {
        return res.status(400).json({ success: false, error: profError, errors: { professor_id: profError } });
      }

      const discipline = await prisma.discipline.create({
        data: {
          name,
          professor_id: professor_id ?? null,
          fee_id: fee_id ?? null,
          place_id: place_id ?? null,
        },
        include: disciplineInclude,
      });
      return res.status(201).json({ success: true, discipline });
    } catch (error: any) {
      // FK: la cuota o el espacio indicado no existe
      if (error?.code === "P2003") {
        return res.status(400).json({ success: false, error: "La cuota o el espacio indicado no existe" });
      }
      console.error("Create discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al crear la disciplina" });
    }
  },
);

/** PATCH /api/disciplines/:id — edita una disciplina. Solo Administrador. */
disciplinesRouter.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const parsed = disciplineUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      if ("professor_id" in parsed.data) {
        const profError = await invalidProfessor(parsed.data.professor_id);
        if (profError) {
          return res.status(400).json({ success: false, error: profError, errors: { professor_id: profError } });
        }
      }

      const discipline = await prisma.discipline.update({
        where: { id },
        data: parsed.data,
        include: disciplineInclude,
      });
      return res.json({ success: true, discipline });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      if (error?.code === "P2003") {
        return res.status(400).json({ success: false, error: "La cuota o el espacio indicado no existe" });
      }
      console.error("Update discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al actualizar la disciplina" });
    }
  },
);

/**
 * DELETE /api/disciplines/:id — baja lógica (active=false). No se borra: conserva
 * el registro y no orfana horarios/reservas. Se reactiva con PATCH /:id/reactivate.
 */
disciplinesRouter.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const discipline = await prisma.discipline.update({
        where: { id },
        data: { active: false },
        include: disciplineInclude,
      });
      return res.json({ success: true, discipline });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      console.error("Deactivate discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al dar de baja la disciplina" });
    }
  },
);

/** PATCH /api/disciplines/:id/reactivate — reactiva una disciplina dada de baja. Solo Administrador. */
disciplinesRouter.patch(
  "/:id/reactivate",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const discipline = await prisma.discipline.update({
        where: { id },
        data: { active: true },
        include: disciplineInclude,
      });
      return res.json({ success: true, discipline });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      console.error("Reactivate discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al reactivar la disciplina" });
    }
  },
);
