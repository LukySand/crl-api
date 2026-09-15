import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import {
  partnerStoreCreateSchema,
  partnerStoreUpdateSchema,
} from "../lib/partner-store";

export const partnerStoresRouter = Router();

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((issue) => {
    const field = issue.path[0]?.toString() ?? "_form";
    errors[field] = issue.message;
  });
  return res
    .status(400)
    .json({ success: false, error: "Validación fallida", errors });
}

function partnerStoreId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ success: false, error: "ID inválido" });
    return null;
  }
  return id;
}

/**
 * GET /api/partner-stores — requiere sesión y lista los locales adheridos.
 * Por defecto devuelve sólo activos. `?all=true` incluye inactivos únicamente
 * para gestión; para los demás roles se ignora silenciosamente.
 */
partnerStoresRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const showAll = req.query.all === "true" && isAdmin(req);
    const partnerStores = await prisma.partnerStore.findMany({
      where: showAll ? undefined : { active: true },
      orderBy: { name: "asc" },
    });
    return res.json({ success: true, partnerStores });
  } catch (error) {
    console.error("List partner stores error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al listar los locales adheridos" });
  }
});

/** POST /api/partner-stores — crea un local adherido. Solo gestión. */
partnerStoresRouter.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = partnerStoreCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const partnerStore = await prisma.partnerStore.create({ data: parsed.data });
      return res.status(201).json({ success: true, partnerStore });
    } catch (error) {
      console.error("Create partner store error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al crear el local adherido" });
    }
  },
);

/** PATCH /api/partner-stores/:id/reactivate — reactiva un local. Solo gestión. */
partnerStoresRouter.patch(
  "/:id/reactivate",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = partnerStoreId(req, res);
      if (id === null) return;

      const partnerStore = await prisma.partnerStore.update({
        where: { id },
        data: { active: true },
      });
      return res.json({ success: true, partnerStore });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res
          .status(404)
          .json({ success: false, error: "Local adherido no encontrado" });
      }
      console.error("Reactivate partner store error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al reactivar el local adherido" });
    }
  },
);

/** PATCH /api/partner-stores/:id — edita sólo los textos. Solo gestión. */
partnerStoresRouter.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = partnerStoreId(req, res);
      if (id === null) return;

      const parsed = partnerStoreUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const partnerStore = await prisma.partnerStore.update({
        where: { id },
        data: parsed.data,
      });
      return res.json({ success: true, partnerStore });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res
          .status(404)
          .json({ success: false, error: "Local adherido no encontrado" });
      }
      console.error("Update partner store error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al actualizar el local adherido" });
    }
  },
);

/** DELETE /api/partner-stores/:id — baja lógica. Solo gestión. */
partnerStoresRouter.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = partnerStoreId(req, res);
      if (id === null) return;

      const partnerStore = await prisma.partnerStore.update({
        where: { id },
        data: { active: false },
      });
      return res.json({ success: true, partnerStore });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res
          .status(404)
          .json({ success: false, error: "Local adherido no encontrado" });
      }
      console.error("Deactivate partner store error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al dar de baja el local adherido" });
    }
  },
);
