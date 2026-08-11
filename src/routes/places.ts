import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireRole } from "../lib/auth";

export const placesRouter = Router();

// ponytail: schemas acá y no en lib/validation.ts — ese archivo está duplicado con
// el front y solo tiene sentido sincronizar lo que ambos usan. Cuando el front
// tenga formulario de espacios, mover los campos compartidos allá.
const placeSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(255),
  address: z.string().max(170).optional(),
  capacity: z.number().int().positive().max(32767).optional(),
  description: z.string().optional(),
  file_id: z.string().optional(),
});

const placeUpdateSchema = placeSchema.partial();

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

/** GET /api/places — lista de espacios. Público: el visitante ve qué hay. */
placesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const places = await prisma.place.findMany({ orderBy: { name: "asc" } });
    return res.json({ success: true, places });
  } catch (error) {
    console.error("List places error:", error);
    return res.status(500).json({ success: false, error: "Error al listar espacios" });
  }
});

/** GET /api/places/:id — un espacio con sus horarios y tarifas. */
placesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }

    const place = await prisma.place.findUnique({
      where: { id },
      include: {
        schedules: { include: { fee: true }, orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }] },
      },
    });

    if (!place) {
      return res.status(404).json({ success: false, error: "Espacio no encontrado" });
    }
    return res.json({ success: true, place });
  } catch (error) {
    console.error("Get place error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener el espacio" });
  }
});

/** POST /api/places — crea un espacio. Solo Administrador. */
placesRouter.post(
  "/",
  requireAuth,
  requireRole("Administrador"),
  async (req: Request, res: Response) => {
    try {
      const parsed = placeSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const place = await prisma.place.create({ data: parsed.data });
      return res.status(201).json({ success: true, place });
    } catch (error: any) {
      if (error?.code === "P2003") {
        return res.status(400).json({ success: false, error: "El archivo indicado no existe" });
      }
      console.error("Create place error:", error);
      return res.status(500).json({ success: false, error: "Error al crear el espacio" });
    }
  },
);

/** PATCH /api/places/:id — edita un espacio. Solo Administrador. */
placesRouter.patch(
  "/:id",
  requireAuth,
  requireRole("Administrador"),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      const parsed = placeUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const place = await prisma.place.update({ where: { id }, data: parsed.data });
      return res.json({ success: true, place });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Espacio no encontrado" });
      }
      console.error("Update place error:", error);
      return res.status(500).json({ success: false, error: "Error al actualizar el espacio" });
    }
  },
);

/** DELETE /api/places/:id — borra un espacio. Solo Administrador. */
placesRouter.delete(
  "/:id",
  requireAuth,
  requireRole("Administrador"),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }

      await prisma.place.delete({ where: { id } });
      return res.json({ success: true, message: "Espacio eliminado" });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Espacio no encontrado" });
      }
      // FK: tiene horarios (y por ende posibles reservas) colgando
      if (error?.code === "P2003") {
        return res.status(409).json({
          success: false,
          error: "No se puede eliminar: el espacio tiene horarios cargados",
        });
      }
      console.error("Delete place error:", error);
      return res.status(500).json({ success: false, error: "Error al eliminar el espacio" });
    }
  },
);
