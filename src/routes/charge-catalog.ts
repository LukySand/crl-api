/**
 * Catálogo de cargos (D2, D3, D5): tipos de cargo y plantillas recurrentes.
 * Sólo gestión. Cada alta o edición se audita con antes/después (D17).
 *
 * Editar una plantilla o un tipo nunca toca las filas ya emitidas: el monto, el
 * nombre y el vencimiento se copian al emitir.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";
import { auditar } from "../lib/audit";
import { toNumber } from "../lib/payment";
import { todayInClub } from "../lib/payment-period";
import { CONCEPTO_CUOTA_SOCIAL } from "../lib/payment-rules";
import { periodicidadDe, previsualizarEmision } from "../lib/emission";
import { proximoCiclo } from "../lib/recurrence";
import type { ChargeType, Prisma, RecurringTemplate } from "../../prisma/generated/client";

// Dos routers (uno por recurso) para que el guard de admin no atrape otras rutas de /api.
export const chargeTypesRouter = Router();
export const recurringTemplatesRouter = Router();
chargeTypesRouter.use(requireAuth, requireAdmin);
recurringTemplatesRouter.use(requireAuth, requireAdmin);

function formatErrors(issues: z.ZodIssue[]) {
  const errors: Record<string, string> = {};
  for (const i of issues) errors[String(i.path[0] ?? "_")] = i.message;
  return errors;
}

const invalido = (res: Response, issues: z.ZodIssue[]) =>
  res.status(400).json({ success: false, error: "Validación fallida", errors: formatErrors(issues) });

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha YYYY-MM-DD");
const monto = z.number().min(0).max(99_999_999.99);
const dueRule = z.enum(["Ninguna", "DiasDesdeEmision", "DiaDelMes"]);
const dueValue = z.number().int().min(0).max(65_535);

// ── Tipos de cargo ───────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;

// `.strict()`: `bloquea_credencial` no se escribe nunca (se deriva, D3); `key` no se edita.
const tipoCreate = z
  .object({
    key: z.string().regex(KEY_RE, "Letras, números y _ (2 a 40, empieza con letra)"),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).nullable().optional(),
    suggested_amount: monto.nullable().optional(),
    due_rule: dueRule.default("Ninguna"),
    due_value: dueValue.nullable().optional(),
  })
  .strict();

const tipoPatch = tipoCreate.omit({ key: true }).partial().extend({ active: z.boolean().optional() }).strict();

function reglaDeVencimiento(
  v: { due_rule?: string; due_value?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.due_rule === "DiasDesdeEmision" && (v.due_value === null || v.due_value === undefined)) {
    ctx.addIssue({ code: "custom", path: ["due_value"], message: "Obligatorio con DiasDesdeEmision" });
  }
  if (v.due_rule === "DiaDelMes" && v.due_value != null && (v.due_value < 1 || v.due_value > 31)) {
    ctx.addIssue({ code: "custom", path: ["due_value"], message: "Día del mes entre 1 y 31" });
  }
}

const tipoDto = (t: ChargeType) => ({
  id: t.id,
  key: t.key,
  name: t.name,
  description: t.description,
  suggested_amount: t.suggested_amount === null ? null : toNumber(t.suggested_amount),
  due_rule: t.due_rule,
  due_value: t.due_value,
  system: t.system,
  active: t.active,
  // Derivado y de sólo lectura: lo único que bloquea la credencial es la cuota social.
  bloquea_credencial: t.key === CONCEPTO_CUOTA_SOCIAL,
});

chargeTypesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const tipos = await prisma.chargeType.findMany({ orderBy: [{ system: "desc" }, { name: "asc" }] });
    return res.json({ success: true, charge_types: tipos.map(tipoDto) });
  } catch (error) {
    console.error("List charge types error:", error);
    return res.status(500).json({ success: false, error: "Error al listar los tipos" });
  }
});

chargeTypesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = tipoCreate.superRefine(reglaDeVencimiento).safeParse(req.body ?? {});
    if (!parsed.success) return invalido(res, parsed.error.issues);
    // La base compara sin distinguir mayúsculas: "extra" choca con "Extra".
    if (await prisma.chargeType.findFirst({ where: { key: parsed.data.key } })) {
      return res.status(409).json({ success: false, error: "Ya existe un tipo con esa clave" });
    }
    const tipo = await prisma.chargeType.create({ data: parsed.data });
    auditar(req, "create", "charge_type", tipo.id, { despues: tipoDto(tipo) });
    return res.status(201).json({ success: true, charge_type: tipoDto(tipo) });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "Ya existe un tipo con esa clave" });
    }
    console.error("Create charge type error:", error);
    return res.status(500).json({ success: false, error: "Error al crear el tipo" });
  }
});

chargeTypesRouter.patch("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: "ID inválido" });
    const parsed = tipoPatch.safeParse(req.body ?? {});
    if (!parsed.success) return invalido(res, parsed.error.issues);

    const antes = await prisma.chargeType.findUnique({ where: { id } });
    if (!antes) return res.status(404).json({ success: false, error: "Tipo no encontrado" });
    // Los tipos del sistema no se desactivan: el resto del sistema depende de ellos.
    if (antes.system && parsed.data.active !== undefined) {
      return res.status(400).json({ success: false, error: "Un tipo del sistema no se puede desactivar" });
    }
    // La regla se valida sobre el resultado de aplicar el cambio.
    const fusion = { due_rule: antes.due_rule, due_value: antes.due_value, ...parsed.data };
    const regla = z.object({}).passthrough().superRefine((_, ctx) => reglaDeVencimiento(fusion, ctx));
    const r = regla.safeParse({});
    if (!r.success) return invalido(res, r.error.issues);

    const despues = await prisma.chargeType.update({ where: { id }, data: parsed.data });
    auditar(req, "update", "charge_type", id, { antes: tipoDto(antes), despues: tipoDto(despues) });
    return res.json({ success: true, charge_type: tipoDto(despues) });
  } catch (error) {
    console.error("Update charge type error:", error);
    return res.status(500).json({ success: false, error: "Error al editar el tipo" });
  }
});

// ── Plantillas recurrentes ───────────────────────────────────────────────

const plantillaCreate = z
  .object({
    concept: z.string().regex(KEY_RE),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    amount: monto.nullable().default(null),
    period_mode: z.enum(["DiaDelMes", "CadaN"]),
    day_of_month: z.number().int().min(1).max(31).nullable().optional(),
    every_n: z.number().int().min(1).max(65_535).nullable().optional(),
    unit: z.enum(["Dias", "Semanas", "Meses"]).nullable().optional(),
    start_date: fecha,
    end_date: fecha.nullable().optional(),
    due_rule: dueRule.nullable().optional(),
    due_value: dueValue.nullable().optional(),
    target_mode: z.enum(["Todos", "Disciplina", "Lista", "Socio"]),
    discipline_id: z.number().int().positive().nullable().optional(),
    targets: z.array(z.string().min(1)).default([]),
    active: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    const mal = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.period_mode === "DiaDelMes" && !v.day_of_month) mal("day_of_month", "Obligatorio (1 a 31)");
    if (v.period_mode === "CadaN") {
      if (!v.every_n) mal("every_n", "Obligatorio (mínimo 1)");
      if (!v.unit) mal("unit", "Obligatorio");
    }
    if (v.end_date && v.end_date < v.start_date) mal("end_date", "No puede ser anterior al inicio");
    if (v.target_mode === "Socio" && v.targets.length !== 1) mal("targets", "Exactamente un socio");
    if (v.target_mode === "Lista" && v.targets.length < 1) mal("targets", "Al menos un socio");
    if (v.amount === null && v.target_mode !== "Disciplina") mal("amount", "Obligatorio salvo para Disciplina");
    if (v.due_rule === "DiasDesdeEmision" && v.due_value == null) mal("due_value", "Obligatorio");
    if (v.due_rule === "DiaDelMes" && v.due_value != null && (v.due_value < 1 || v.due_value > 31)) {
      mal("due_value", "Día del mes entre 1 y 31");
    }
  });

type PlantillaConTargets = RecurringTemplate & { targets: { user_id: string }[] };
const incluir = { targets: { select: { user_id: true } } } as const;

const plantillaDto = (t: PlantillaConTargets) => ({
  id: t.id,
  concept: t.concept,
  name: t.name,
  description: t.description,
  amount: t.amount === null ? null : toNumber(t.amount),
  period_mode: t.period_mode,
  day_of_month: t.day_of_month,
  every_n: t.every_n,
  unit: t.unit,
  start_date: t.start_date.toISOString().slice(0, 10),
  end_date: t.end_date ? t.end_date.toISOString().slice(0, 10) : null,
  due_rule: t.due_rule,
  due_value: t.due_value,
  target_mode: t.target_mode,
  discipline_id: t.discipline_id,
  targets: t.targets.map((x) => x.user_id),
  active: t.active,
  proximo_ciclo: t.active ? proximoCiclo(periodicidadDe(t), todayInClub()) : null,
});

/** Campos de la fila a partir del cuerpo ya validado. */
function datosDePlantilla(v: z.infer<typeof plantillaCreate>): Prisma.RecurringTemplateUncheckedCreateInput {
  const { targets: _t, start_date, end_date, ...resto } = v;
  return {
    ...resto,
    start_date: new Date(`${start_date}T00:00:00Z`),
    end_date: end_date ? new Date(`${end_date}T00:00:00Z`) : null,
    // Los destinos de otro modo no se guardan: el modo manda.
    discipline_id: v.target_mode === "Disciplina" ? (v.discipline_id ?? null) : null,
    created_by: "",
  };
}

/** Comprueba que el tipo y los socios existan. Devuelve el mensaje de error o null. */
async function referenciasInvalidas(v: z.infer<typeof plantillaCreate>): Promise<string | null> {
  const tipo = await prisma.chargeType.findUnique({ where: { key: v.concept } });
  if (!tipo || !tipo.active) return "El tipo de cargo no existe o está inactivo";
  if (v.target_mode === "Disciplina" && v.discipline_id) {
    if (!(await prisma.discipline.findUnique({ where: { id: v.discipline_id } }))) {
      return "La disciplina no existe";
    }
  }
  if (v.targets.length > 0 && v.target_mode !== "Todos" && v.target_mode !== "Disciplina") {
    const n = await prisma.user.count({ where: { id: { in: v.targets } } });
    if (n !== new Set(v.targets).size) return "Algún socio indicado no existe";
  }
  return null;
}

recurringTemplatesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const plantillas = await prisma.recurringTemplate.findMany({
      include: incluir,
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
    return res.json({ success: true, templates: plantillas.map(plantillaDto) });
  } catch (error) {
    console.error("List templates error:", error);
    return res.status(500).json({ success: false, error: "Error al listar las plantillas" });
  }
});

recurringTemplatesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = plantillaCreate.safeParse(req.body ?? {});
    if (!parsed.success) return invalido(res, parsed.error.issues);
    const v = parsed.data;
    const falla = await referenciasInvalidas(v);
    if (falla) return res.status(400).json({ success: false, error: falla });

    const solo = v.target_mode === "Socio" || v.target_mode === "Lista";
    const t = await prisma.recurringTemplate.create({
      data: {
        ...datosDePlantilla(v),
        created_by: req.user!.id,
        targets: solo ? { create: [...new Set(v.targets)].map((user_id) => ({ user_id })) } : undefined,
      },
      include: incluir,
    });
    auditar(req, "create", "recurring_template", t.id, { despues: plantillaDto(t) });
    return res.status(201).json({ success: true, template: plantillaDto(t) });
  } catch (error) {
    console.error("Create template error:", error);
    return res.status(500).json({ success: false, error: "Error al crear la plantilla" });
  }
});

// Antes de los /:id. Sólo calcula: no guarda nada.
recurringTemplatesRouter.post("/preview", async (req: Request, res: Response) => {
  try {
    const parsed = plantillaCreate.safeParse(req.body ?? {});
    if (!parsed.success) return invalido(res, parsed.error.issues);
    const falla = await referenciasInvalidas(parsed.data);
    if (falla) return res.status(400).json({ success: false, error: falla });
    const { start_date, end_date, ...v } = parsed.data;
    const preview = await previsualizarEmision({
      ...v,
      day_of_month: v.day_of_month ?? null,
      every_n: v.every_n ?? null,
      unit: v.unit ?? null,
      start_date: new Date(`${start_date}T00:00:00Z`),
      end_date: end_date ? new Date(`${end_date}T00:00:00Z`) : null,
    });
    return res.json({ success: true, preview });
  } catch (error) {
    console.error("Preview template error:", error);
    return res.status(500).json({ success: false, error: "Error al calcular la vista previa" });
  }
});

recurringTemplatesRouter.patch("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: "ID inválido" });
    const antes = await prisma.recurringTemplate.findUnique({ where: { id }, include: incluir });
    if (!antes) return res.status(404).json({ success: false, error: "Plantilla no encontrada" });

    const body = req.body ?? {};
    if ("concept" in body && body.concept !== antes.concept) {
      return res.status(400).json({ success: false, error: "El tipo de cargo no se puede cambiar" });
    }
    // Se fusiona el cambio sobre lo guardado y se valida el resultado completo.
    const { id: _id, proximo_ciclo: _pc, ...actual } = plantillaDto(antes);
    const parsed = plantillaCreate.safeParse({ ...actual, ...body });
    if (!parsed.success) return invalido(res, parsed.error.issues);
    const v = parsed.data;
    const falla = await referenciasInvalidas(v);
    if (falla) return res.status(400).json({ success: false, error: falla });

    const solo = v.target_mode === "Socio" || v.target_mode === "Lista";
    const despues = await prisma.$transaction(async (tx) => {
      await tx.recurringTemplateTarget.deleteMany({ where: { template_id: id } });
      const { created_by: _c, ...datos } = datosDePlantilla(v);
      return tx.recurringTemplate.update({
        where: { id },
        data: {
          ...datos,
          targets: solo ? { create: [...new Set(v.targets)].map((user_id) => ({ user_id })) } : undefined,
        },
        include: incluir,
      });
    });
    auditar(req, "update", "recurring_template", id, { antes: plantillaDto(antes), despues: plantillaDto(despues) });
    return res.json({ success: true, template: plantillaDto(despues) });
  } catch (error) {
    console.error("Update template error:", error);
    return res.status(500).json({ success: false, error: "Error al editar la plantilla" });
  }
});

/** Carga la plantilla y valida que sea de tipo Lista. Devuelve el error ya respondido o la plantilla. */
async function plantillaLista(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ success: false, error: "ID inválido" });
  const t = await prisma.recurringTemplate.findUnique({ where: { id }, include: incluir });
  if (!t) return void res.status(404).json({ success: false, error: "Plantilla no encontrada" });
  if (t.target_mode !== "Lista") {
    return void res.status(400).json({ success: false, error: "Sólo se pueden asignar socios a plantillas de tipo Lista." });
  }
  return t;
}

// Alta/baja de un socio en una plantilla Lista. No emite en el acto: cobra desde el próximo ciclo.
recurringTemplatesRouter.post("/:id/targets", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = z.object({ user_id: z.string().min(1) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return invalido(res, parsed.error.issues);
    const antes = await plantillaLista(req, res);
    if (!antes) return;
    const { user_id } = parsed.data;
    if (antes.targets.some((x) => x.user_id === user_id)) {
      return res.json({ success: true, template: plantillaDto(antes) });
    }
    const u = await prisma.user.findUnique({ where: { id: user_id }, select: { active: true } });
    if (!u || !u.active) return res.status(400).json({ success: false, error: "El socio no existe o está inactivo" });

    await prisma.recurringTemplateTarget.create({ data: { template_id: antes.id, user_id } });
    const despues = (await prisma.recurringTemplate.findUnique({ where: { id: antes.id }, include: incluir }))!;
    auditar(req, "update", "recurring_template", antes.id, { antes: plantillaDto(antes), despues: plantillaDto(despues) });
    return res.json({ success: true, template: plantillaDto(despues) });
  } catch (error) {
    console.error("Add template target error:", error);
    return res.status(500).json({ success: false, error: "Error al asignar el socio" });
  }
});

recurringTemplatesRouter.delete(
  "/:id/targets/:userId",
  async (req: Request<{ id: string; userId: string }>, res: Response) => {
    try {
      const antes = await plantillaLista(req, res);
      if (!antes) return;
      const { userId } = req.params;
      if (!antes.targets.some((x) => x.user_id === userId)) {
        return res.status(404).json({ success: false, error: "El socio no está en la plantilla" });
      }
      if (antes.targets.length <= 1) {
        return res.status(409).json({ success: false, error: "La plantilla tiene que tener al menos un socio." });
      }
      await prisma.recurringTemplateTarget.delete({
        where: { template_id_user_id: { template_id: antes.id, user_id: userId } },
      });
      const despues = (await prisma.recurringTemplate.findUnique({ where: { id: antes.id }, include: incluir }))!;
      auditar(req, "update", "recurring_template", antes.id, { antes: plantillaDto(antes), despues: plantillaDto(despues) });
      return res.json({ success: true, template: plantillaDto(despues) });
    } catch (error) {
      console.error("Remove template target error:", error);
      return res.status(500).json({ success: false, error: "Error al quitar el socio" });
    }
  },
);
