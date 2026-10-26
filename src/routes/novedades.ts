import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAdmin, requireAuth } from "../lib/auth";
import { INSTAGRAM_CONFIG_ID, clearFeedCache, getFeed, isValidToken } from "../lib/instagram";
import {
  embedUrl,
  instagramTokenSchema,
  maskToken,
  novedadLinkCreateSchema,
  novedadLinkOrderSchema,
  novedadLinkUpdateSchema,
  parseInstagramUrl,
  permalink,
  type NovedadKind,
} from "../lib/novedades";

export const novedadesRouter = Router();

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

function linkId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ success: false, error: "ID inválido" });
    return null;
  }
  return id;
}

/** Fijados primero; dentro de cada grupo, por `position`. */
const LINK_ORDER = [{ pinned: "desc" }, { position: "asc" }, { id: "asc" }] as const;

function serializeLink(link: { id: number; code: string; kind: string; pinned: boolean }) {
  const ref = { code: link.code, kind: link.kind as NovedadKind };
  return {
    id: link.id,
    code: link.code,
    kind: link.kind,
    pinned: link.pinned,
    permalink: permalink(ref),
    embedUrl: embedUrl(ref),
  };
}

async function listLinks() {
  const links = await prisma.novedadLink.findMany({ orderBy: [...LINK_ORDER] });
  return links.map(serializeLink);
}

/**
 * GET /api/novedades — público. Si hay token de Instagram, devuelve los últimos
 * posts de la cuenta (`modo: "token"`). Sin token, o si Instagram falla y no hay
 * nada cacheado, devuelve los links cargados a mano (`modo: "links"`).
 */
novedadesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const config = await prisma.instagramConfig.findUnique({
      where: { id: INSTAGRAM_CONFIG_ID },
    });
    if (config?.access_token) {
      try {
        const items = await getFeed({
          access_token: config.access_token,
          token_updated_at: config.token_updated_at,
        });
        return res.json({ success: true, modo: "token", items });
      } catch (error) {
        console.error("Instagram feed error:", error);
      }
    }
    return res.json({ success: true, modo: "links", items: await listLinks() });
  } catch (error) {
    console.error("List novedades error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al listar las novedades" });
  }
});

/**
 * GET /api/novedades/config — configuración para gestión. El token nunca sale
 * completo: solo si está cargado y una máscara con sus últimos 4 caracteres.
 */
novedadesRouter.get(
  "/config",
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const config = await prisma.instagramConfig.findUnique({
        where: { id: INSTAGRAM_CONFIG_ID },
      });
      return res.json({
        success: true,
        token: {
          configurado: !!config?.access_token,
          mascara: config?.access_token ? maskToken(config.access_token) : null,
          actualizadoEn: config?.token_updated_at ?? null,
        },
        links: await listLinks(),
      });
    } catch (error) {
      console.error("Get novedades config error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al obtener la configuración" });
    }
  },
);

/** PUT /api/novedades/config/token — guarda el token, previa verificación contra Instagram. */
novedadesRouter.put(
  "/config/token",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = instagramTokenSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const { token } = parsed.data;
      if (!(await isValidToken(token))) {
        return res.status(400).json({
          success: false,
          error: "Validación fallida",
          errors: { token: "Instagram no aceptó el token. Revisá que esté completo y vigente" },
        });
      }

      const now = new Date();
      await prisma.instagramConfig.upsert({
        where: { id: INSTAGRAM_CONFIG_ID },
        create: { id: INSTAGRAM_CONFIG_ID, access_token: token, token_updated_at: now },
        update: { access_token: token, token_updated_at: now },
      });
      clearFeedCache();
      return res.json({
        success: true,
        token: { configurado: true, mascara: maskToken(token), actualizadoEn: now },
      });
    } catch (error) {
      console.error("Save instagram token error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al guardar el token" });
    }
  },
);

/** DELETE /api/novedades/config/token — quita el token y vuelve a mostrar los links. */
novedadesRouter.delete(
  "/config/token",
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      await prisma.instagramConfig.updateMany({
        where: { id: INSTAGRAM_CONFIG_ID },
        data: { access_token: null, token_updated_at: null },
      });
      clearFeedCache();
      return res.json({
        success: true,
        token: { configurado: false, mascara: null, actualizadoEn: null },
      });
    } catch (error) {
      console.error("Delete instagram token error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al quitar el token" });
    }
  },
);

/** POST /api/novedades/links — agrega un post por su link. Queda primero en su grupo. */
novedadesRouter.post(
  "/links",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = novedadLinkCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const ref = parseInstagramUrl(parsed.data.url)!;
      const existing = await prisma.novedadLink.findUnique({ where: { code: ref.code } });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "Validación fallida",
          errors: { url: "Ese post ya está cargado" },
        });
      }

      const first = await prisma.novedadLink.aggregate({ _min: { position: true } });
      const link = await prisma.novedadLink.create({
        data: {
          code: ref.code,
          kind: ref.kind,
          pinned: parsed.data.pinned ?? false,
          position: (first._min.position ?? 1) - 1,
        },
      });
      return res.status(201).json({ success: true, link: serializeLink(link) });
    } catch (error) {
      console.error("Create novedad link error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al agregar el post" });
    }
  },
);

/** POST /api/novedades/links/reorder — fija el orden con la lista completa de ids. */
novedadesRouter.post(
  "/links/reorder",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = novedadLinkOrderSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const { ids } = parsed.data;
      const count = await prisma.novedadLink.count({ where: { id: { in: ids } } });
      if (count !== ids.length) {
        return res.status(400).json({
          success: false,
          error: "Validación fallida",
          errors: { ids: "La lista tiene posts que no existen" },
        });
      }

      await prisma.$transaction(
        ids.map((id, position) =>
          prisma.novedadLink.update({ where: { id }, data: { position } }),
        ),
      );
      return res.json({ success: true, links: await listLinks() });
    } catch (error) {
      console.error("Reorder novedad links error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al reordenar los posts" });
    }
  },
);

/** PATCH /api/novedades/links/:id — fija o desfija un post. */
novedadesRouter.patch(
  "/links/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = linkId(req, res);
      if (id === null) return;

      const parsed = novedadLinkUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const link = await prisma.novedadLink.update({ where: { id }, data: parsed.data });
      return res.json({ success: true, link: serializeLink(link) });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Post no encontrado" });
      }
      console.error("Update novedad link error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al actualizar el post" });
    }
  },
);

/** DELETE /api/novedades/links/:id — quita el post de la vitrina. */
novedadesRouter.delete(
  "/links/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = linkId(req, res);
      if (id === null) return;

      await prisma.novedadLink.delete({ where: { id } });
      return res.json({ success: true });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Post no encontrado" });
      }
      console.error("Delete novedad link error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al quitar el post" });
    }
  },
);
