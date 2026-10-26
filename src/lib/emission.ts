/**
 * Motor de emisión de cargos recurrentes (D5).
 *
 * Para cada plantilla activa calcula el ciclo vigente a `hoy` (recurrence.ts),
 * resuelve los destinatarios y crea las filas con `createMany({ skipDuplicates })`
 * sobre `ref`: correrlo dos veces no duplica nada, y los `ref` conservan los
 * formatos de dev (`disciplina:<enrollment>:<YYYY-MM>`, `socio:<user>:<YYYY-MM>`).
 *
 * Invariante: como máximo un cargo recurrente por tipo, socio y ciclo (por
 * inscripción en `Disciplina`); una segunda plantilla igual no emite.
 */
import prisma from "./prisma";
import { logger } from "./logger";
import { getAjustes } from "./settings-db";
import { cursoEnPeriodo, todayInClub } from "./payment-period";
import { refDisciplina, refRecurrente } from "./payment";
import { cicloVigente, vencimientoPara, type Periodicidad } from "./recurrence";
import type { Prisma } from "../../prisma/generated/client";

const dia = (d: Date) => d.toISOString().slice(0, 10);

type Plantilla = Prisma.RecurringTemplateGetPayload<{
  include: { type: true; targets: { include: { user: { select: { active: true } } } } };
}>;

export function periodicidadDe(t: {
  period_mode: "DiaDelMes" | "CadaN";
  day_of_month: number | null;
  every_n: number | null;
  unit: "Dias" | "Semanas" | "Meses" | null;
  start_date: Date;
  end_date: Date | null;
}): Periodicidad {
  const inicio = dia(t.start_date);
  const fin = t.end_date ? dia(t.end_date) : null;
  return t.period_mode === "DiaDelMes"
    ? { modo: "DiaDelMes", dia: t.day_of_month ?? 1, inicio, fin }
    : { modo: "CadaN", n: t.every_n ?? 1, unidad: t.unit ?? "Meses", inicio, fin };
}

/** Un destinatario de un ciclo: a quién, con qué ref y (si es por inscripción) cuál. */
type Destino = {
  user_id: string;
  ref: string;
  enrollment_id?: number;
  nombre: string;
  monto: Prisma.Decimal | number | null;
  fee_id?: number;
};

async function destinatarios(
  t: Plantilla,
  period: string,
  emision: string,
  userId: string | undefined,
): Promise<Destino[]> {
  const nombre = `${t.name} ${period}`;
  const porUsuario = (ids: string[]): Destino[] =>
    ids.map((user_id) => ({
      user_id,
      ref: refRecurrente(t.concept, user_id, period),
      nombre,
      monto: t.amount,
    }));

  switch (t.target_mode) {
    case "Todos": {
      const socios = await prisma.user.findMany({
        where: {
          active: true,
          roles: { some: { role: { name: "Socio" } } },
          ...(userId ? { id: userId } : {}),
        },
        select: { id: true },
      });
      return porUsuario(socios.map((s) => s.id));
    }
    case "Socio":
    case "Lista":
      return porUsuario(
        t.targets
          .filter((x) => x.user.active && (!userId || x.user_id === userId))
          .map((x) => x.user_id),
      );
    case "Disciplina": {
      const mensual = period.length === 7;
      const inscripciones = await prisma.enrollment.findMany({
        where: {
          ...(t.discipline_id ? { discipline_id: t.discipline_id } : {}),
          ...(userId ? { user_id: userId } : {}),
        },
        select: {
          id: true,
          user_id: true,
          created_at: true,
          left_at: true,
          discipline: { select: { name: true, fee: { select: { id: true, amount: true } } } },
        },
      });
      const out: Destino[] = [];
      for (const e of inscripciones) {
        const vigente = mensual
          ? cursoEnPeriodo(e.created_at, e.left_at, period)
          : dia(e.created_at) <= emision && (!e.left_at || dia(e.left_at) >= emision);
        if (!vigente) continue;
        const monto = t.amount ?? e.discipline.fee?.amount ?? null;
        if (monto === null) continue; // sin tarifa vigente: se saltea, igual que /generate
        out.push({
          user_id: e.user_id,
          enrollment_id: e.id,
          ref:
            t.concept === "Disciplina"
              ? refDisciplina(e.id, period)
              : refRecurrente(t.concept, e.user_id, period),
          nombre: t.concept === "Disciplina" ? `Cuota de ${e.discipline.name} ${period}` : nombre,
          monto,
          fee_id: t.amount === null ? e.discipline.fee?.id : undefined,
        });
      }
      return out;
    }
  }
}

/**
 * Emite los cargos del ciclo vigente de cada plantilla activa. Con `userId` sólo
 * para ese socio (alta de inscripción, lectura de cuenta). `hoy` en el huso del club.
 */
export async function emitirCargos(
  { userId, hoy = todayInClub() }: { userId?: string; hoy?: string } = {},
): Promise<{ generadas: number; candidatas: number }> {
  const plantillas = await prisma.recurringTemplate.findMany({
    where: { active: true, type: { active: true } },
    include: { type: true, targets: { include: { user: { select: { active: true } } } } },
  });
  const { payment_due_day } = await getAjustes();
  const ahora = new Date(); // mismo created_at para toda la corrida (regla de orden D9)
  let generadas = 0;
  let candidatas = 0;

  for (const t of plantillas) {
    try {
      const ciclo = cicloVigente(periodicidadDe(t), hoy);
      if (!ciclo) continue;
      const regla = t.due_rule ?? t.type.due_rule;
      const valor = t.due_rule ? t.due_value : t.type.due_value;
      const vence = vencimientoPara({ regla, valor }, ciclo.period, hoy, payment_due_day);

      const porRef = new Map<string, Prisma.PaymentCreateManyInput>();
      for (const d of await destinatarios(t, ciclo.period, ciclo.emision, userId)) {
        if (porRef.has(d.ref)) continue;
        const gratis = Number(d.monto) === 0;
        porRef.set(d.ref, {
          user_id: d.user_id,
          concept: t.concept,
          name: d.nombre,
          description: t.description,
          enrollment_id: d.enrollment_id,
          fee_id: d.fee_id,
          amount: d.monto ?? 0,
          period: ciclo.period,
          due_date: vence ? new Date(`${vence}T00:00:00Z`) : null,
          ref: d.ref,
          template_id: t.id,
          created_at: ahora,
          ...(gratis ? { status: "Pagado" as const, paid_at: ahora } : {}),
        });
      }
      if (porRef.size === 0) continue;
      const { count } = await prisma.payment.createMany({
        data: [...porRef.values()],
        skipDuplicates: true,
      });
      generadas += count;
      candidatas += porRef.size;
    } catch (error) {
      // Una plantilla rota no frena a las demás.
      logger.error(error, `Emisión de la plantilla ${t.id} falló`);
    }
  }
  return { generadas, candidatas };
}
