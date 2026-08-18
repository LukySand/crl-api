import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { requireAuth, isAdmin } from "../lib/auth";

export const enrollmentsRouter = Router();

// Toda la ruta exige sesión: nadie se inscribe (ni consulta inscripciones) sin loguearse.
enrollmentsRouter.use(requireAuth);

const enrollSchema = z.object({
  discipline_id: z.number().int().positive(),
  // Solo lo usa un admin para inscribir a otro socio. El socio común se saca del token.
  user_id: z.string().min(1).optional(),
});

// Sin `as const` en el array: Prisma pide un orderBy mutable.
const ordenHorarios = [{ day_of_week: "asc" as const }, { start_time: "asc" as const }];

// Qué devolvemos de cada inscripción: nombre de la disciplina y datos del socio.
const enrollmentInclude = {
  discipline: {
    select: {
      id: true,
      name: true,
      active: true,
      full: true,
      fee: { select: { id: true, name: true, amount: true } },
      place: { select: { id: true, name: true } },
      professors: {
        select: { professor: { select: { id: true, name: true, last_name: true } } },
        orderBy: { created_at: "asc" as const },
      },
      // Los horarios viajan acá para que el socio saque su próxima clase de este
      // mismo GET, sin pedir un endpoint aparte por cada disciplina.
      schedules: {
        select: { id: true, day_of_week: true, start_time: true, end_time: true },
        orderBy: ordenHorarios,
      },
    },
  },
  user: { select: { id: true, name: true, last_name: true, dni: true } },
} as const;

/**
 * Aplana los profesores de la disciplina, igual que en `routes/disciplines.ts`.
 * `professor` (el primero) va por compatibilidad con las pantallas que todavía
 * esperan uno solo; se saca cuando todas lean `professors`.
 */
function serialize<T extends { discipline: { professors: { professor: unknown }[] } }>(e: T) {
  const professors = e.discipline.professors.map((p) => p.professor);
  return {
    ...e,
    discipline: { ...e.discipline, professors, professor: professors[0] ?? null },
  };
}

function validationError(res: Response, error: z.ZodError) {
  const errors: Record<string, string> = {};
  error.issues.forEach((e) => {
    errors[e.path[0] as string] = e.message;
  });
  return res.status(400).json({ success: false, error: "Validación fallida", errors });
}

/**
 * GET /api/enrollments — inscripciones, filtradas por rol:
 *  - Administrador → todas (o las de `?discipline_id=` si viene).
 *  - Profesor      → solo las de las disciplinas que dicta.
 *  - Socio         → solo las propias.
 * Una sola query cubre las vistas de admin, profesor y socio.
 */
enrollmentsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { discipline_id } = req.query;
    const disciplineId = discipline_id !== undefined ? Number(discipline_id) : undefined;
    if (disciplineId !== undefined && !Number.isInteger(disciplineId)) {
      return res.status(400).json({ success: false, error: "discipline_id inválido" });
    }

    // El scope sale del token (rol + id), nunca de la query: nadie ve inscripciones ajenas.
    let scope: Record<string, unknown> = {};
    if (isAdmin(req)) {
      scope = {};
    } else if (req.user!.role === "Profesor") {
      // Las disciplinas que dicta: ahora puede ser uno de varios profes (#6).
      scope = { discipline: { professors: { some: { professor_id: req.user!.id } } } };
    } else {
      scope = { user_id: req.user!.id };
    }

    const enrollments = await prisma.enrollment.findMany({
      where: {
        active: true, // solo las inscripciones vigentes; el historial (bajas) no se lista acá
        ...scope,
        ...(disciplineId !== undefined && { discipline_id: disciplineId }),
      },
      include: enrollmentInclude,
      orderBy: { created_at: "desc" },
    });

    return res.json({ success: true, enrollments: enrollments.map(serialize) });
  } catch (error) {
    console.error("List enrollments error:", error);
    return res.status(500).json({ success: false, error: "Error al listar inscripciones" });
  }
});

/**
 * POST /api/enrollments — inscribe un socio a una disciplina.
 *  - Sin `user_id` → a sí mismo (id del token).
 *  - Con `user_id` → solo Administrador, a ese socio.
 * El inscripto siempre tiene que ser un Socio.
 */
enrollmentsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = enrollSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);

    const { discipline_id, user_id } = parsed.data;

    // Inscribir a otro solo lo puede un admin. El socio común se ignora si manda user_id ajeno.
    let targetId = req.user!.id;
    if (user_id && user_id !== req.user!.id) {
      if (!isAdmin(req)) {
        return res.status(403).json({
          success: false,
          error: "Solo un administrador puede inscribir a otro socio",
        });
      }
      targetId = user_id;
    }

    // El inscripto debe existir y ser Socio (los profes/admin no cursan disciplinas).
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      include: { role: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, error: "El socio no existe" });
    }
    if (target.role.name !== "Socio") {
      return res.status(400).json({ success: false, error: "Solo un socio puede inscribirse a una disciplina" });
    }

    const discipline = await prisma.discipline.findUnique({ where: { id: discipline_id } });
    if (!discipline) {
      return res.status(404).json({ success: false, error: "La disciplina no existe" });
    }
    if (!discipline.active) {
      return res.status(400).json({ success: false, error: "La disciplina está dada de baja" });
    }
    // Cupo lleno (lo marca el profe/admin): no se aceptan nuevas inscripciones (#5).
    if (discipline.full) {
      return res.status(409).json({ success: false, error: "La disciplina tiene el cupo lleno" });
    }

    const enrollment = await prisma.enrollment.create({
      data: { user_id: targetId, discipline_id },
      include: enrollmentInclude,
    });
    return res.status(201).json({ success: true, enrollment: serialize(enrollment) });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, error: "Ya está inscripto en esta disciplina" });
    }
    if (error?.code === "P2003") {
      return res.status(400).json({ success: false, error: "El socio o la disciplina indicada no existe" });
    }
    console.error("Create enrollment error:", error);
    return res.status(500).json({ success: false, error: "Error al inscribir" });
  }
});

/**
 * DELETE /api/enrollments/:id — da de baja la inscripción (no borra). El dueño
 * la suya; el Administrador cualquiera. Baja lógica: active=null + left_at=now,
 * así el null libera el par en el unique y queda el período en el historial.
 */
enrollmentsRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "ID inválido" });
    }

    const existing = await prisma.enrollment.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Inscripción no encontrada" });
    }
    if (!isAdmin(req) && existing.user_id !== req.user!.id) {
      return res.status(403).json({ success: false, error: "No tenés permisos para esta acción" });
    }

    // Solo si sigue activa: dos bajas en paralelo (doble tap) dejan una sola.
    const { count } = await prisma.enrollment.updateMany({
      where: { id, active: true },
      data: { active: null, left_at: new Date() },
    });
    if (count === 0) {
      return res.status(409).json({ success: false, error: "La inscripción ya estaba dada de baja" });
    }
    return res.json({ success: true, message: "Inscripción dada de baja" });
  } catch (error) {
    console.error("Delete enrollment error:", error);
    return res.status(500).json({ success: false, error: "Error al dar de baja la inscripción" });
  }
});
