import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireRole } from "../lib/auth";
import { TIME, toTime } from "../lib/time";

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

// Horario de clase: día de la semana + rango horario. Mismas reglas que el turno
// reservable de un espacio (`routes/schedules.ts`), sin cuota ni lugar propios.
const classScheduleSchema = z
  .object({
    day_of_week: z.number().int().min(0, "0=domingo").max(6, "6=sábado"),
    start_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)"),
    end_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)"),
  })
  .refine((s) => s.start_time < s.end_time, {
    message: "La hora de fin debe ser posterior a la de inicio",
    path: ["end_time"],
  });

const classScheduleUpdateSchema = z
  .object({
    day_of_week: z.number().int().min(0, "0=domingo").max(6, "6=sábado").optional(),
    start_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)").optional(),
    end_time: z.string().regex(TIME, "Formato de hora inválido (HH:MM)").optional(),
  })
  .refine((s) => !s.start_time || !s.end_time || s.start_time < s.end_time, {
    message: "La hora de fin debe ser posterior a la de inicio",
    path: ["end_time"],
  });

// Los horarios vienen ordenados como se muestran (domingo primero, y dentro del
// día de la más temprana a la más tardía), así ni el front ni el admin los
// reordenan. Sin `as const` en el array: Prisma pide un orderBy mutable.
const ordenHorarios = [{ day_of_week: "asc" as const }, { start_time: "asc" as const }];

const schedulesInclude = { orderBy: ordenHorarios };

// Nombres relacionados que devolvemos (no el objeto entero de cada relación).
const disciplineInclude = {
  professor: { select: { id: true, name: true, last_name: true } },
  fee: { select: { id: true, name: true, amount: true } },
  place: { select: { id: true, name: true } },
  schedules: schedulesInclude,
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
  requireRole("Administrador"),
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
  requireRole("Administrador"),
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
  requireRole("Administrador"),
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
  requireRole("Administrador"),
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

/* ──────────────────────────────────────────────────────────────────────────
 * Horarios de clase (DisciplineSchedule), como sub-recurso de la disciplina.
 * Los lee cualquiera (el socio ve su próxima clase en la tarjeta); los edita
 * el Administrador o el profesor a cargo de esa disciplina.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ¿Puede este usuario tocar los horarios de esta disciplina? Devuelve el rechazo
 * a devolver, o null si está habilitado. No alcanza con `requireRole`: son dos
 * roles con condiciones distintas (el profesor, solo las que dicta).
 */
async function denyScheduleEdit(
  req: Request,
  disciplineId: number,
): Promise<{ status: number; error: string } | null> {
  const discipline = await prisma.discipline.findUnique({
    where: { id: disciplineId },
    select: { professor_id: true },
  });
  if (!discipline) return { status: 404, error: "Disciplina no encontrada" };
  if (req.user?.role === "Administrador") return null;
  if (req.user?.role === "Profesor" && discipline.professor_id === req.user.id) return null;
  return { status: 403, error: "No podés editar los horarios de esta disciplina" };
}

/** GET /api/disciplines/:id/schedules — horarios de la clase. Abierto, como el listado. */
disciplinesRouter.get("/:id/schedules", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const discipline = await prisma.discipline.findUnique({ where: { id }, select: { id: true } });
    if (!discipline) {
      return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
    }
    const schedules = await prisma.disciplineSchedule.findMany({
      where: { discipline_id: id },
      ...schedulesInclude,
    });
    return res.json({ success: true, schedules });
  } catch (error) {
    console.error("List discipline schedules error:", error);
    return res.status(500).json({ success: false, error: "Error al listar los horarios" });
  }
});

/** POST /api/disciplines/:id/schedules — agrega un horario. Admin o profesor a cargo. */
disciplinesRouter.post("/:id/schedules", requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }
    const denied = await denyScheduleEdit(req, id);
    if (denied) return res.status(denied.status).json({ success: false, error: denied.error });

    const parsed = classScheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);

    const { day_of_week, start_time, end_time } = parsed.data;
    const schedule = await prisma.disciplineSchedule.create({
      data: {
        discipline_id: id,
        day_of_week,
        start_time: toTime(start_time),
        end_time: toTime(end_time),
      },
    });
    return res.status(201).json({ success: true, schedule });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res
        .status(409)
        .json({ success: false, error: "Ya hay una clase ese día a esa hora" });
    }
    console.error("Create discipline schedule error:", error);
    return res.status(500).json({ success: false, error: "Error al crear el horario" });
  }
});

/** PATCH /api/disciplines/:id/schedules/:sid — edita un horario. Admin o profesor a cargo. */
disciplinesRouter.patch(
  "/:id/schedules/:sid",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(id) || !Number.isInteger(sid)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const denied = await denyScheduleEdit(req, id);
      if (denied) return res.status(denied.status).json({ success: false, error: denied.error });

      const parsed = classScheduleUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      // El horario tiene que ser de *esta* disciplina: con el id suelto se
      // editaría el de otra pasando un :id sobre el que sí se tiene permiso.
      const actual = await prisma.disciplineSchedule.findFirst({
        where: { id: sid, discipline_id: id },
      });
      if (!actual) {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }

      const { day_of_week, start_time, end_time } = parsed.data;
      const schedule = await prisma.disciplineSchedule.update({
        where: { id: sid },
        data: {
          ...(day_of_week !== undefined && { day_of_week }),
          ...(start_time !== undefined && { start_time: toTime(start_time) }),
          ...(end_time !== undefined && { end_time: toTime(end_time) }),
        },
      });
      return res.json({ success: true, schedule });
    } catch (error: any) {
      if (error?.code === "P2002") {
        return res
          .status(409)
          .json({ success: false, error: "Ya hay una clase ese día a esa hora" });
      }
      console.error("Update discipline schedule error:", error);
      return res.status(500).json({ success: false, error: "Error al actualizar el horario" });
    }
  },
);

/** DELETE /api/disciplines/:id/schedules/:sid — borra un horario. Admin o profesor a cargo. */
disciplinesRouter.delete(
  "/:id/schedules/:sid",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(id) || !Number.isInteger(sid)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const denied = await denyScheduleEdit(req, id);
      if (denied) return res.status(denied.status).json({ success: false, error: denied.error });

      // Borrado físico: un horario no tiene historial que preservar (a diferencia
      // de la disciplina, que se da de baja lógica porque cuelga inscripciones).
      const { count } = await prisma.disciplineSchedule.deleteMany({
        where: { id: sid, discipline_id: id },
      });
      if (count === 0) {
        return res.status(404).json({ success: false, error: "Horario no encontrado" });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error("Delete discipline schedule error:", error);
      return res.status(500).json({ success: false, error: "Error al borrar el horario" });
    }
  },
);
