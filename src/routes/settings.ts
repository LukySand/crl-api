import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../lib/auth";
import { ajustesPatchSchema, aplicarCambio, errorDeCoherencia } from "../lib/settings";
import { getAjustes, guardarAjustes } from "../lib/settings-db";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((issue) => {
    const field = issue.path[0]?.toString() ?? "_form";
    if (!errors[field]) errors[field] = issue.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

/**
 * GET /api/settings — los ajustes vigentes. Los puede leer cualquier sesión: el
 * socio necesita saber cuánto antes cancela y con cuánta anticipación reserva. No hay nada sensible.
 */
settingsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, ajustes: await getAjustes() });
  } catch (error) {
    console.error("Get settings error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener los ajustes" });
  }
});

/**
 * PATCH /api/settings — cambia ajustes. Sólo gestión. Se manda únicamente lo que se
 * quiere cambiar. Rige para lo que viene: las reservas hechas y las cuotas ya
 * generadas conservan lo que tenían.
 */
settingsRouter.patch("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = ajustesPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);

    const incoherente = errorDeCoherencia(aplicarCambio(await getAjustes(), parsed.data));
    if (incoherente) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: { [incoherente.campo]: incoherente.mensaje },
      });
    }

    return res.json({ success: true, ajustes: await guardarAjustes(parsed.data, req.user!.id) });
  } catch (error) {
    console.error("Update settings error:", error);
    return res.status(500).json({ success: false, error: "Error al guardar los ajustes" });
  }
});
