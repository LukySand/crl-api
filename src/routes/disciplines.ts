import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../lib/auth";
import { TIME, toTime } from "../lib/time";

export const disciplinesRouter = Router();

// ponytail: schema acá y no en lib/validation.ts — ese archivo está duplicado con
// el front y solo sincroniza lo que ambos validan. Acá el front manda y el server valida.
// Los FK van opcionales: una disciplina puede existir sin profe/cuota/espacio asignado.
const disciplineSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(100),
  // #6: una disciplina puede tener varios profes. `professor_id` (uno solo) se
  // sigue aceptando para no romper a los clientes viejos mientras migran.
  professor_ids: z.array(z.string().min(1)).optional(),
  professor_id: z.string().min(1).optional().nullable(),
  fee_id: z.coerce.number().int().positive().optional().nullable(),
  place_id: z.coerce.number().int().positive().optional().nullable(),
});

const disciplineUpdateSchema = disciplineSchema.partial();

/**
 * Normaliza las dos formas de mandar profesores a una sola lista sin repetidos.
 * Devuelve `undefined` cuando el request no menciona profesores (en un PATCH eso
 * significa "no los toques"), y `[]` cuando pide dejarla sin ninguno.
 */
function profesoresPedidos(data: {
  professor_ids?: string[];
  professor_id?: string | null;
}): string[] | undefined {
  if (data.professor_ids !== undefined) return [...new Set(data.professor_ids)];
  if (data.professor_id !== undefined) return data.professor_id ? [data.professor_id] : [];
  return undefined;
}

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
  professors: {
    select: { professor: { select: { id: true, name: true, last_name: true } } },
    orderBy: { created_at: "asc" as const }, // el primero es el que estaba asignado antes de #6
  },
  fee: { select: { id: true, name: true, amount: true } },
  place: { select: { id: true, name: true } },
  schedules: schedulesInclude,
} as const;

/**
 * Aplana la tabla puente a una lista de profesores y, además, deja `professor`
 * (el primero) en la respuesta.
 *
 * ponytail: `professor` es compatibilidad hacia atrás — las pantallas que todavía
 * esperan un solo profe siguen andando mientras migran a `professors`. Se saca
 * cuando no queden lectores (buscar `\.professor\b` en el front).
 */
function serialize<T extends { professors: { professor: unknown }[] }>(d: T) {
  const professors = d.professors.map((p) => p.professor);
  return { ...d, professors, professor: professors[0] ?? null };
}

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

// Los profesores asignados tienen que ser Users con rol Profesor (no Socios/Admins).
// Devuelve un mensaje de error si alguno no sirve, o null si están todos bien.
async function invalidProfessors(ids: string[] | undefined): Promise<string | null> {
  if (!ids?.length) return null;
  const encontrados = await prisma.user.findMany({
    where: { id: { in: ids } },
    include: { role: true },
  });
  if (encontrados.length !== ids.length) {
    return ids.length === 1 ? "El profesor asignado no existe" : "Alguno de los profesores no existe";
  }
  const noProfe = encontrados.find((u) => u.role.name !== "Profesor");
  if (noProfe) {
    return `${noProfe.name} ${noProfe.last_name} no es un profesor`;
  }
  return null;
}

/** GET /api/disciplines — lista de disciplinas. Abierto: socios/profes/visitante ven la oferta. */
disciplinesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const disciplines = await prisma.discipline.findMany({
      orderBy: { name: "asc" },
      include: disciplineInclude,
    });
    return res.json({ success: true, disciplines: disciplines.map(serialize) });
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
    return res.json({ success: true, discipline: serialize(discipline) });
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

      const { name, fee_id, place_id } = parsed.data;
      const profesores = profesoresPedidos(parsed.data) ?? [];
      const profError = await invalidProfessors(profesores);
      if (profError) {
        return res.status(400).json({ success: false, error: profError, errors: { professor_ids: profError } });
      }

      const discipline = await prisma.discipline.create({
        data: {
          name,
          fee_id: fee_id ?? null,
          place_id: place_id ?? null,
          professors: { create: profesores.map((professor_id) => ({ professor_id })) },
        },
        include: disciplineInclude,
      });
      return res.status(201).json({ success: true, discipline: serialize(discipline) });
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

      // Los profesores no son una columna: van aparte, en la tabla puente.
      const { professor_ids: _pi, professor_id: _p, ...campos } = parsed.data;
      const profesores = profesoresPedidos(parsed.data);

      const profError = await invalidProfessors(profesores);
      if (profError) {
        return res.status(400).json({ success: false, error: profError, errors: { professor_ids: profError } });
      }

      const discipline = await prisma.discipline.update({
        where: { id },
        data: {
          ...campos,
          // Reemplazo completo: la lista que llega es la que queda. Si el request
          // no menciona profesores, no se tocan.
          ...(profesores !== undefined && {
            professors: {
              deleteMany: {},
              create: profesores.map((professor_id) => ({ professor_id })),
            },
          }),
        },
        include: disciplineInclude,
      });
      return res.json({ success: true, discipline: serialize(discipline) });
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
 *
 * Al darla de baja se **desinscribe a todos los socios** (baja lógica de la
 * inscripción: active=null + left_at), porque la disciplina deja de estar
 * disponible. El aviso a los socios se maneja por fuera de la app. Va en una
 * transacción junto con la baja. Reactivar la disciplina NO los re-inscribe.
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
      const [discipline, desinscriptos] = await prisma.$transaction([
        prisma.discipline.update({
          where: { id },
          data: { active: false },
          include: disciplineInclude,
        }),
        prisma.enrollment.updateMany({
          where: { discipline_id: id, active: true },
          data: { active: null, left_at: new Date() },
        }),
      ]);
      return res.json({
        success: true,
        discipline: serialize(discipline),
        desinscriptos: desinscriptos.count,
      });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      console.error("Deactivate discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al dar de baja la disciplina" });
    }
  },
);

/**
 * PATCH /api/disciplines/:id/full — marca/desmarca el cupo lleno (#5). Lo puede
 * tocar el **profesor asignado** a la disciplina o un **Administrador**; con el
 * cupo lleno el back rechaza nuevas inscripciones (ver enrollments.ts).
 */
disciplinesRouter.patch(
  "/:id/full",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: "ID inválido" });
      }
      const parsed = z.object({ full: z.boolean() }).safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const disc = await prisma.discipline.findUnique({
        where: { id },
        select: { professors: { select: { professor_id: true } } },
      });
      if (!disc) {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      const esAdmin = req.user!.role === "Administrador";
      // Cualquiera de los profes que la dicta puede marcar el cupo (#6).
      const esProfeAsignado =
        req.user!.role === "Profesor" && disc.professors.some((p) => p.professor_id === req.user!.id);
      if (!esAdmin && !esProfeAsignado) {
        return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
      }

      const discipline = await prisma.discipline.update({
        where: { id },
        data: { full: parsed.data.full },
        include: disciplineInclude,
      });
      return res.json({ success: true, discipline: serialize(discipline) });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ success: false, error: "Disciplina no encontrada" });
      }
      console.error("Toggle full discipline error:", error);
      return res.status(500).json({ success: false, error: "Error al cambiar el cupo" });
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
      return res.json({ success: true, discipline: serialize(discipline) });
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
    select: { professors: { select: { professor_id: true } } },
  });
  if (!discipline) return { status: 404, error: "Disciplina no encontrada" };
  if (req.user?.role === "Administrador") return null;
  // Cualquiera de los profes que la dicta (#6), no solo el primero.
  if (
    req.user?.role === "Profesor" &&
    discipline.professors.some((p) => p.professor_id === req.user!.id)
  ) {
    return null;
  }
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
