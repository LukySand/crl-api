/**
 * Cuotas y cobros.
 *
 * Una fila de `Payment` es un período adeudado que además registra cómo se
 * saldó. Cubre las cuotas de disciplina (mensuales) y las reservas de cancha
 * (pago único, creadas desde bookings.ts junto con la reserva).
 *
 * El ciclo de una cuota de transferencia es: Pendiente → el socio sube el
 * comprobante (EnRevision) → la gestión lo confirma (Pagado) o lo rechaza
 * (vuelve a Pendiente). En efectivo la gestión la marca Pagado directo.
 */
import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { getAjustes } from "../lib/settings-db";
import { requireAuth, requireAdmin, isAdmin, hasRole, veComoGestion } from "../lib/auth";
import {
  decidirCobro,
  LIMITE_POR_COBRAR,
  METODOS_MANUALES,
  palabrasDeBusqueda,
  type QuienCobra,
} from "../lib/cobro";
import { auditar } from "../lib/audit";
import { accionesPermitidas, CONCEPTO_CUOTA_SOCIAL, estadoCuota, type Accion } from "../lib/payment-rules";
import {
  crearLiquidacionMP,
  esConflictoDeEscritura,
  liquidacionViva,
  PagoEnCurso,
  puedePagarPor,
  registrarCobroManual,
  verificarOrdenDePago,
} from "../lib/settlement";
import { accessToken, createPreference } from "../lib/mercadopago";
import { reembolsarItem } from "../lib/refunds";
import type { PaymentMethod, PaymentStatus, Prisma, TransactionStatus } from "../../prisma/generated/client";
import { emitirCargos } from "../lib/emission";
import { refUnico, serializePayment, serializePayments, toNumber } from "../lib/payment";
import {
  cursoEnPeriodo,
  esPeriodoValido,
  periodoActual,
  todayInClub,
  vencimientoDe,
} from "../lib/payment-period";

export const paymentsRouter = Router();

// Nada de cuotas sin sesión.
paymentsRouter.use(requireAuth);

/**
 * Lo que se devuelve de cada pago.
 *
 * `user` va con select y no con `true` por lo mismo que en bookings.ts: un
 * include plano mandaría el hash de la contraseña en cada respuesta.
 */
const paymentInclude = {
  fee: { select: { id: true, name: true, amount: true, kind: true } },
  enrollment: {
    select: {
      id: true,
      discipline: { select: { id: true, name: true } },
    },
  },
  booking: {
    select: {
      id: true,
      date: true,
      schedule: {
        select: {
          start_time: true,
          end_time: true,
          place: { select: { id: true, name: true } },
        },
      },
    },
  },
  user: {
    select: { id: true, name: true, last_name: true, dni: true, email: true },
  },
} as const;

/**
 * Lo mismo que `paymentInclude` pero sin el email del socio: quien cobra necesita
 * saber a quién (nombre y DNI), no cómo contactarlo. Un profesor ve esto de sus
 * alumnos, y no tiene por qué ver más.
 */
const cobroInclude = {
  ...paymentInclude,
  user: { select: { id: true, name: true, last_name: true, dni: true } },
} as const;

/** Quién es el que cobra, según su sesión: la gestión o un profesor. */
const quienCobra = (req: Request): QuienCobra => ({
  esGestion: isAdmin(req),
  esProfesor: hasRole(req, "Profesor"),
});

function formatErrors(issues: z.ZodIssue[]) {
  const errors: Record<string, string> = {};
  issues.forEach((issue) => {
    errors[issue.path[0] as string] = issue.message;
  });
  return errors;
}

const periodoSchema = z
  .string()
  .refine(esPeriodoValido, "El período debe ser YYYY-MM");

const generateSchema = z.object({
  // Por defecto el mes corriente: es lo que la gestión quiere el 99% de las veces.
  period: periodoSchema.default(() => periodoActual()),
});

const motivo = z.string().trim().min(3).max(500);
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha YYYY-MM-DD");

// `confirmar`/`rechazar` ya no existen (D23): el cobro va por /cobro. Unión discriminada
// y estricta: cualquier otra acción o campo suelto es 400.
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("anular"), reason: motivo }).strict(),
  z.object({ action: z.literal("condonar"), reason: motivo }).strict(),
  z.object({ action: z.literal("editar"), due_date: fechaIso.nullable() }).strict(),
]);

const deleteSchema = z.object({ reason: motivo }).strict();

const createSchema = z
  .object({
    user_id: z.string().min(1),
    concept: z.string().min(1).max(40),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    amount: z.number().min(0.01).max(99_999_999.99).optional(),
    due_date: fechaIso.nullable().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

const cobroSchema = z
  .object({
    method: z.enum(METODOS_MANUALES).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

const revertirSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const uploadSchema = z.object({
  file: z.instanceof(File, { message: "Falta el archivo" }),
});

/** El FormData de un multipart, leído del stream de Express. Igual que en socio.ts. */
async function readFormData(req: Request) {
  const request = new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "" },
    body: Readable.toWeb(req as never),
    duplex: "half",
  } as RequestInit);
  return request.formData();
}

const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Predicado único de "vencida" (D25): pendiente con vencimiento no nulo ya pasado.
 * Lo comparten el filtro `estado=vencida` del listado y `/indicadores`.
 * (`lt` deja afuera los NULL; las filas eliminadas son `Anulado`.)
 */
const whereVencida = (hoy: string): Prisma.PaymentWhereInput => ({
  status: "Pendiente",
  due_date: { lt: new Date(`${hoy}T00:00:00Z`) },
});

type LiqInfo = {
  viva: boolean;
  ultima: { method: PaymentMethod; status: TransactionStatus; con_reserva: boolean; created_at: Date } & Record<string, unknown> | null;
};

/** Última liquidación de cada fila (incluye las `Anulado`) y si alguna está viva (D8). */
async function liquidacionesDe(ids: string[]) {
  const out = new Map<string, LiqInfo>();
  if (ids.length === 0) return out;
  const items = await prisma.paymentTransactionItem.findMany({
    where: { payment_id: { in: ids } },
    select: {
      payment_id: true,
      transaction: {
        select: {
          id: true,
          method: true,
          status: true,
          amount: true,
          paid_at: true,
          created_at: true,
          expires_at: true,
          voided_reason: true,
          voided_at: true,
          items: { select: { payment: { select: { concept: true } } } },
        },
      },
    },
  });
  const ahora = Date.now();
  for (const { payment_id, transaction: t } of items) {
    const cur = out.get(payment_id) ?? { viva: false, ultima: null };
    if (t.method === "MercadoPago" && t.status === "Pendiente" && t.expires_at && t.expires_at.getTime() > ahora) {
      cur.viva = true;
    }
    if (!cur.ultima || t.created_at > cur.ultima.created_at) {
      cur.ultima = {
        id: t.id,
        method: t.method,
        status: t.status,
        amount: toNumber(t.amount),
        paid_at: t.paid_at,
        created_at: t.created_at,
        voided_reason: t.voided_reason,
        voided_at: t.voided_at,
        con_reserva: t.items.some((i) => i.payment.concept === "Reserva"),
      };
    }
    out.set(payment_id, cur);
  }
  return out;
}

type FilaConLiq = { concept: string; status: PaymentStatus; deleted_at: Date | null };

/** Acciones que la gestión puede hacer sobre la fila: misma regla que usan los endpoints. */
function accionesDe(f: FilaConLiq, liq: LiqInfo | undefined): Accion[] {
  return accionesPermitidas({
    concept: f.concept,
    status: f.status,
    eliminado: f.deleted_at !== null,
    liquidacion_viva: liq?.viva ?? false,
    liquidacion: liq?.ultima ?? null,
  });
}

/**
 * GET /api/payments — cuotas y cobros. La gestión ve todos; el resto, los propios.
 * Con `?propias=true` sólo los propios, también para gestión.
 * Filtros: ?status=Pendiente ?concept=Disciplina ?period=2026-09 ?user_id=... ?from=&to=
 * Gestión además: ?q= (socio por nombre/apellido/DNI o nombre del cargo),
 * ?estado=vencida (D25), ?eliminados=1 (incluye las bajas lógicas, D7),
 * ?page=&page_size= (agrega `hay_mas`; sin `page` devuelve todo, como antes).
 *
 * `from`/`to` filtran por vencimiento, que es lo que le importa a un socio
 * mirando qué debe. Los reportes de ingresos filtran por fecha de cobro y viven
 * en /api/reports. Cada fila trae además `estado`, `eliminado`, `tipo` y
 * `liquidacion` (la última, incluso anulada); `acciones` sólo para gestión.
 */
paymentsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { status, concept, period, user_id, from, to, q, estado, eliminados, page, page_size } = req.query;
    // Gestión ve todas salvo que pida `?propias=true` (ver veComoGestion).
    const admin = veComoGestion(req);

    if (typeof period === "string" && !esPeriodoValido(period)) {
      return res.status(400).json({ success: false, error: "El período debe ser YYYY-MM" });
    }
    for (const [nombre, valor] of [["from", from], ["to", to]] as const) {
      if (typeof valor === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        return res
          .status(400)
          .json({ success: false, error: `${nombre} debe ser YYYY-MM-DD` });
      }
    }
    if (estado !== undefined && estado !== "vencida") {
      return res.status(400).json({ success: false, error: "estado sólo admite 'vencida'" });
    }
    const paginar = typeof page === "string";
    const nPagina = Math.max(1, Number.parseInt(String(page), 10) || 1);
    const tamano = Math.min(200, Math.max(1, Number.parseInt(String(page_size), 10) || 50));
    const palabras = admin ? palabrasDeBusqueda(q) : [];
    const hoy = todayInClub();

    const payments = await prisma.payment.findMany({
      where: {
        // Sale del token, nunca de la query: un socio no mira la deuda de otro.
        ...(admin
          ? typeof user_id === "string" && { user_id }
          : { user_id: req.user!.id }),
        // La baja lógica sólo se ve con ?eliminados=1 y sólo en el panel de gestión.
        ...(!(admin && eliminados === "1") && { deleted_at: null }),
        ...(estado === "vencida" && whereVencida(hoy)),
        ...(typeof status === "string" && { status: status as any }),
        ...(typeof concept === "string" && { concept: concept as any }),
        ...(typeof period === "string" && { period }),
        ...((typeof from === "string" || typeof to === "string") && {
          due_date: {
            ...(estado === "vencida" && { lt: new Date(`${hoy}T00:00:00Z`) }),
            ...(typeof from === "string" && { gte: new Date(`${from}T00:00:00Z`) }),
            ...(typeof to === "string" && { lte: new Date(`${to}T00:00:00Z`) }),
          },
        }),
        ...(palabras.length > 0 && {
          AND: palabras.map((palabra) => ({
            OR: [
              { name: { contains: palabra } },
              { user: { name: { contains: palabra } } },
              { user: { last_name: { contains: palabra } } },
              { user: { dni: { contains: palabra } } },
            ],
          })),
        }),
      },
      include: { ...paymentInclude, type: { select: { key: true, name: true } } },
      orderBy: [{ due_date: { sort: "desc", nulls: "last" } }, { created_at: "desc" }, { id: "asc" }],
      ...(paginar && { skip: (nPagina - 1) * tamano, take: tamano + 1 }),
    });

    const hayMas = paginar && payments.length > tamano;
    const filas = hayMas ? payments.slice(0, tamano) : payments;
    const liqs = await liquidacionesDe(filas.map((p) => p.id));

    return res.json({
      success: true,
      payments: filas.map((p) => {
        const liq = liqs.get(p.id);
        return {
          ...serializePayment(p),
          estado: estadoCuota({ status: p.status, due_date: aDia(p.due_date) }, hoy),
          eliminado: p.deleted_at !== null,
          tipo: p.type,
          liquidacion: liq?.ultima ?? null,
          ...(admin && { acciones: accionesDe(p, liq) }),
        };
      }),
      ...(paginar && { page: nPagina, page_size: tamano, hay_mas: hayMas }),
    });
  } catch (error) {
    console.error("List payments error:", error);
    return res.status(500).json({ success: false, error: "Error al listar las cuotas" });
  }
});

/**
 * GET /api/payments/resumen — totales del usuario del token (o de ?user_id= si
 * es la gestión). Lo que necesita la pantalla de cuotas del socio para el
 * encabezado, sin bajarse la lista entera.
 *
 * Va antes de "/:id" a propósito: Express matchea por orden y si no, tomaría
 * "resumen" como un id.
 */
paymentsRouter.get("/resumen", async (req: Request, res: Response) => {
  try {
    const admin = isAdmin(req);
    const userId =
      admin && typeof req.query.user_id === "string"
        ? req.query.user_id
        : req.user!.id;

    const pendientes = await prisma.payment.findMany({
      where: { user_id: userId, status: { in: ["Pendiente", "EnRevision"] } },
      select: { amount: true, due_date: true, status: true },
      orderBy: { due_date: { sort: "asc", nulls: "last" } },
    });

    const hoy = todayInClub();
    // "Vencido" se deriva acá y no se guarda: ver el comentario del modelo Payment.
    const vencidas = pendientes.filter(
      (p) => p.due_date != null && p.due_date.toISOString().slice(0, 10) < hoy,
    );

    const sumar = (filas: { amount: unknown }[]) =>
      filas.reduce((total, f) => total + Number(f.amount), 0);

    return res.json({
      success: true,
      resumen: {
        total_pendiente: sumar(pendientes),
        total_vencido: sumar(vencidas),
        cantidad_pendiente: pendientes.length,
        cantidad_vencida: vencidas.length,
        // El vencimiento más próximo sin pagar. Reemplaza al "next_due_date" que
        // no se guarda en la fila: como consulta nunca queda desactualizado.
        proximo_vencimiento: pendientes.find((p) => p.due_date)?.due_date ?? null,
      },
    });
  } catch (error) {
    console.error("Payments summary error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener el resumen" });
  }
});

/**
 * GET /api/payments/indicadores — cuotas sociales vencidas y socios afectados (D25).
 * Sólo gestión. Misma consulta que el filtro `?concept=Socio&estado=vencida`, así que
 * el contador y el listado enlazado no pueden discrepar. Va antes de "/:id".
 */
paymentsRouter.get("/indicadores", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const grupos = await prisma.payment.groupBy({
      by: ["user_id"],
      where: { ...whereVencida(todayInClub()), concept: CONCEPTO_CUOTA_SOCIAL, deleted_at: null },
      _count: { _all: true },
    });
    return res.json({
      success: true,
      cuotas_sociales_vencidas: grupos.reduce((n, g) => n + g._count._all, 0),
      socios: grupos.length,
    });
  } catch (error) {
    console.error("Payments indicators error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener los indicadores" });
  }
});

/**
 * POST /api/payments — cargo único para un socio (sin plantilla). `name` y `amount`
 * salen del tipo si no vienen; sin monto en ninguno, 400. `Reserva` sólo nace con la
 * reserva. Cada cargo lleva un `ref` `unico:{uuid}`: dos iguales están permitidos.
 */
paymentsRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: formatErrors(parsed.error.issues),
      });
    }
    const d = parsed.data;
    if (d.concept === "Reserva") {
      return res.status(400).json({ success: false, error: "Una reserva se crea reservando, no como cargo" });
    }
    const [tipo, socio] = await Promise.all([
      prisma.chargeType.findUnique({ where: { key: d.concept } }),
      prisma.user.findUnique({ where: { id: d.user_id }, select: { id: true } }),
    ]);
    if (!tipo || !tipo.active) {
      return res.status(400).json({ success: false, error: "Tipo de cargo inexistente o inactivo" });
    }
    if (!socio) return res.status(404).json({ success: false, error: "Socio no encontrado" });
    const amount = d.amount ?? (tipo.suggested_amount ? toNumber(tipo.suggested_amount) : undefined);
    if (amount === undefined) {
      return res.status(400).json({ success: false, error: "Falta el monto", errors: { amount: "Obligatorio" } });
    }

    const creada = await prisma.payment.create({
      data: {
        user_id: d.user_id,
        concept: d.concept,
        name: d.name ?? tipo.name,
        description: d.description ?? tipo.description,
        amount,
        due_date: d.due_date ? new Date(`${d.due_date}T00:00:00Z`) : null,
        notes: d.notes,
        ref: refUnico(),
        created_by: req.user!.id,
      },
      include: paymentInclude,
    });
    auditar(req, "create", "payment", creada.id, {
      despues: { user_id: d.user_id, concept: d.concept, amount, due_date: d.due_date ?? null },
    });
    return res.status(201).json({ success: true, payment: serializePayment(creada) });
  } catch (error) {
    console.error("Create payment error:", error);
    return res.status(500).json({ success: false, error: "Error al crear el cargo" });
  }
});

/**
 * POST /api/payments/generate — dispara a mano el motor de emisión (lib/emission.ts).
 * Sólo gestión.
 *
 * Es idempotente: cada cuota lleva un `ref` único (disciplina:<enrollment>:<periodo>)
 * y se insertan con skipDuplicates, así que correrlo dos veces para el mismo mes
 * no duplica nada. Eso importa más de lo que parece — nadie se acuerda de si ya
 * lo corrió, y sin la clave el segundo click cobraba el mes dos veces.
 *
 * También va antes de "/:id".
 */
paymentsRouter.post("/generate", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = generateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: formatErrors(parsed.error.issues),
      });
    }
    const { period } = parsed.data;
    // Disparo manual del motor de emisión (D5). El período elegido fija el "hoy"
    // del motor: el mes corriente usa el día real; otro mes, su día 1 (la gestión
    // lo usa para reponer un mes puntual).
    const hoy = period === periodoActual() ? todayInClub() : `${period}-01`;
    const { generadas, candidatas } = await emitirCargos({ hoy });

    return res.status(201).json({
      success: true,
      period,
      generadas,
      candidatas,
      // La diferencia son las que ya existían de una corrida anterior.
      omitidas: candidatas - generadas,
    });
  } catch (error) {
    console.error("Generate payments error:", error);
    return res.status(500).json({ success: false, error: "Error al generar las cuotas" });
  }
});

/**
 * GET /api/payments/por-cobrar?search= — las cuotas pendientes que quien está en
 * el mostrador puede cobrar. Va antes de "/:id".
 *
 * La gestión ve todas; un profesor, sólo las cuotas de disciplina de sus propias
 * disciplinas. `search` filtra por nombre, apellido o DNI del socio. Vienen
 * primero las que vencen antes, que son las que hay que ir a buscar.
 */
paymentsRouter.get("/por-cobrar", async (req: Request, res: Response) => {
  try {
    const quien = quienCobra(req);
    if (!quien.esGestion && !quien.esProfesor) {
      return res
        .status(403)
        .json({ success: false, error: "No tenés permisos para registrar cobros" });
    }

    // El alcance sale del token, nunca de un id que mande el cliente.
    const alcance = quien.esGestion
      ? {}
      : {
          concept: "Disciplina" as const,
          enrollment: {
            discipline: { professors: { some: { professor_id: req.user!.id } } },
          },
        };

    const palabras = palabrasDeBusqueda(req.query.search);

    const pagos = await prisma.payment.findMany({
      where: {
        status: { in: ["Pendiente", "EnRevision"] },
        ...alcance,
        // Cada palabra tiene que aparecer en alguno de los tres campos del socio.
        ...(palabras.length > 0 && {
          AND: palabras.map((palabra) => ({
            user: {
              OR: [
                { name: { contains: palabra } },
                { last_name: { contains: palabra } },
                { dni: { contains: palabra } },
              ],
            },
          })),
        }),
      },
      include: cobroInclude,
      orderBy: [{ due_date: { sort: "asc", nulls: "last" } }, { created_at: "asc" }],
      take: LIMITE_POR_COBRAR,
    });

    return res.json({
      success: true,
      payments: serializePayments(pagos),
      limite: LIMITE_POR_COBRAR,
    });
  } catch (error) {
    console.error("List payments to collect error:", error);
    return res.status(500).json({ success: false, error: "Error al listar las cuotas" });
  }
});

const MSG_SIN_PERMISO = "No tenés permisos para registrar cobros";

const cobroMultipleSchema = cobroSchema.extend({
  payment_ids: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * Cobro manual de una o varias filas (D10). Compartido por `/cobro` y `/:id/cobro`.
 * Orden de chequeos: 403 permisos/deuda propia/regla de cobro → 400 socios distintos
 * o Reserva mezclada → 409 cuotas → 409 orden_de_pago (P7) → 409 pago_en_curso → cobro.
 */
async function cobrarFilas(req: Request, res: Response, ids: string[], body: unknown, unico: boolean) {
  const quien = quienCobra(req);
  if (!quien.esGestion && !quien.esProfesor) {
    return res.status(403).json({ success: false, error: MSG_SIN_PERMISO });
  }

  const parsed = cobroMultipleSchema.omit({ payment_ids: true }).safeParse(body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Validación fallida",
      errors: formatErrors(parsed.error.issues),
    });
  }

  const filas = await prisma.payment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      user_id: true,
      concept: true,
      status: true,
      amount: true,
      due_date: true,
      booking_id: true,
      deleted_at: true,
      enrollment: {
        select: { discipline: { select: { professors: { select: { professor_id: true } } } } },
      },
    },
  });
  if (filas.length !== ids.length) {
    return res.status(404).json({ success: false, error: "Cuota no encontrada" });
  }
  if (new Set(filas.map((f) => f.user_id)).size !== 1) {
    return res.status(400).json({ success: false, error: "Las cuotas tienen que ser del mismo socio" });
  }
  if (filas[0]!.user_id === req.user!.id) {
    return res.status(403).json({ success: false, error: "No podés registrar el cobro de tu propia deuda" });
  }
  if (filas.length > 1 && filas.some((f) => f.concept === "Reserva")) {
    return res.status(400).json({ success: false, error: "Una reserva se cobra sola" });
  }

  let metodo: PaymentMethod = "Efectivo";
  const noCobrables: { id: string; estado: string }[] = [];
  for (const f of filas) {
    const decision = decidirCobro(
      quien,
      {
        concept: f.concept,
        status: f.deleted_at ? "Anulado" : f.status,
        esDeSuDisciplina:
          f.enrollment?.discipline.professors.some((p) => p.professor_id === req.user!.id) ?? false,
      },
      parsed.data.method,
    );
    if (!decision.ok) {
      if (decision.status === 403) {
        return res.status(403).json({ success: false, error: decision.error });
      }
      noCobrables.push({
        id: f.id,
        estado: estadoCuota({
          status: f.status,
          due_date: f.due_date ? f.due_date.toISOString().slice(0, 10) : null,
        }),
      });
      continue;
    }
    metodo = decision.method;
  }
  if (noCobrables.length > 0) {
    return res.status(409).json({
      success: false,
      error: unico ? "Esa cuota ya fue cobrada o anulada" : "Hay cuotas que ya no se pueden cobrar",
      cuotas: noCobrables,
    });
  }

  const orden = await verificarOrdenDePago(filas[0]!.user_id, ids);
  if (orden) {
    return res
      .status(409)
      .json({ success: false, error: "Hay cuotas anteriores sin pagar", orden_de_pago: orden });
  }

  const viva = await liquidacionViva(ids);
  if (viva) {
    return res.status(409).json({
      success: false,
      error: "Hay un pago en curso para esta cuota",
      pago_en_curso: {
        id: viva.id,
        vence: viva.expires_at?.toISOString() ?? null,
        checkout_url: viva.checkout_url,
      },
    });
  }

  const r = await registrarCobroManual({
    userId: filas[0]!.user_id,
    method: metodo,
    registeredBy: req.user!.id,
    notes: parsed.data.notes,
    filas: filas.map((f) => ({
      id: f.id,
      amount: f.amount,
      concept: f.concept,
      booking_id: f.booking_id,
    })),
  });
  if (!r) {
    return res.status(409).json({ success: false, error: "Esa cuota ya fue cobrada o anulada" });
  }

  auditar(req, "update", "liquidacion", r.liquidacionId, {
    despues: { metodo, filas: ids, estado: "Aprobado" },
  });

  const payments = await prisma.payment.findMany({ where: { id: { in: ids } }, include: cobroInclude });
  return res.json({
    success: true,
    liquidacion: { id: r.liquidacionId, status: "Aprobado" },
    filas: ids,
    payments: serializePayments(payments),
    // Contrato de dev de `/:id/cobro`.
    payment: payments[0] && serializePayment(payments[0]),
  });
}

const HORAS_PARA_PAGAR = 24;

const pagoEnCursoBody = (v: { id: string; expires_at: Date | null; checkout_url: string | null }) => ({
  id: v.id,
  vence: v.expires_at?.toISOString() ?? null,
  checkout_url: v.checkout_url,
});

/**
 * POST /api/payments/checkout { payment_ids } — el socio (o su tutor) paga cuotas con MP (D13).
 * Orden: 400 → 404 → 400 socios distintos → 403 → 400 Reserva → 409 cuotas → 409 orden_de_pago
 * → 409 pago_en_curso → 400 total 0 → 502. Va antes de "/:id".
 */
paymentsRouter.post("/checkout", async (req: Request, res: Response) => {
  try {
    const ids = z.array(z.string().min(1)).min(1).max(50).safeParse(req.body?.payment_ids);
    if (!ids.success) {
      return res.status(400).json({ success: false, error: "payment_ids es obligatorio" });
    }
    const unicos = [...new Set(ids.data)];
    const filas = await prisma.payment.findMany({
      where: { id: { in: unicos } },
      select: { id: true, user_id: true, concept: true, status: true, amount: true, name: true, due_date: true, deleted_at: true },
    });
    if (filas.length !== unicos.length) {
      return res.status(404).json({ success: false, error: "Cuota no encontrada" });
    }
    const deudorId = filas[0]!.user_id;
    if (filas.some((f) => f.user_id !== deudorId)) {
      return res.status(400).json({ success: false, error: "Las cuotas tienen que ser del mismo socio" });
    }
    if (!(await puedePagarPor({ id: req.user!.id, esGestion: isAdmin(req) }, deudorId))) {
      return res.status(403).json({ success: false, error: "No podés pagar estas cuotas" });
    }
    if (filas.some((f) => f.concept === "Reserva")) {
      return res.status(400).json({ success: false, error: "Una reserva se paga desde Mis reservas" });
    }
    const noPagables = filas.filter((f) => f.status !== "Pendiente" || f.deleted_at);
    if (noPagables.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Hay cuotas que ya no se pueden pagar",
        cuotas: noPagables.map((f) => ({
          id: f.id,
          estado: estadoCuota({ status: f.deleted_at ? "Anulado" : f.status, due_date: f.due_date ? f.due_date.toISOString().slice(0, 10) : null }),
        })),
      });
    }
    const orden = await verificarOrdenDePago(deudorId, unicos);
    if (orden) {
      return res.status(409).json({ success: false, error: "Hay cuotas anteriores sin pagar", orden_de_pago: orden });
    }
    const viva = await liquidacionViva(unicos);
    if (viva) {
      return res.status(409).json({ success: false, error: "Hay un pago en curso para esta cuota", pago_en_curso: pagoEnCursoBody(viva) });
    }
    const centavos = filas.reduce((acc, f) => acc + Math.round(Number(f.amount) * 100), 0);
    if (centavos <= 0) {
      return res.status(400).json({ success: false, error: "No hay nada para pagar" });
    }
    if (!accessToken()) {
      return res.status(502).json({ success: false, error: "El pago con Mercado Pago no está disponible" });
    }

    const vence = new Date(Date.now() + HORAS_PARA_PAGAR * 3600_000);
    const liq = await crearLiquidacionMP({ userId: req.user!.id, filas, expiresAt: vence });
    try {
      const pagador = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { email: true } });
      const pref = await createPreference({
        externalReference: liq.id,
        items: filas.map((f) => ({ title: f.name, quantity: 1, unit_price: Number(f.amount) })),
        payerEmail: pagador?.email,
        backUrlBase: process.env.MP_BACK_URL_BASE || "http://localhost:3000",
        notificationUrl: process.env.MP_NOTIFICATION_URL || undefined,
        expiresAt: vence,
      });
      await prisma.paymentTransaction.update({
        where: { id: liq.id },
        data: { mp_preference_id: pref.id, checkout_url: pref.init_point },
      });
      return res.status(201).json({
        success: true,
        pago: { id: liq.id, monto: liq.total.toFixed(2), vence: vence.toISOString() },
        checkout_url: pref.init_point,
      });
    } catch (error) {
      // MP falló: la liquidación no puede quedar viva bloqueando las filas.
      await prisma.paymentTransaction.update({ where: { id: liq.id }, data: { status: "Cancelado" } });
      console.error("Checkout Mercado Pago error:", error);
      return res.status(502).json({ success: false, error: "No pudimos iniciar el pago con Mercado Pago" });
    }
  } catch (error) {
    if (error instanceof PagoEnCurso) {
      return res.status(409).json({ success: false, error: error.message, pago_en_curso: pagoEnCursoBody(error.viva) });
    }
    console.error("Checkout error:", error);
    return res.status(500).json({ success: false, error: "Error al iniciar el pago" });
  }
});

/**
 * POST /api/payments/cobro — cobro manual de varias cuotas del mismo socio en una
 * sola operación (una liquidación). Va antes de "/:id".
 */
paymentsRouter.post("/cobro", async (req: Request, res: Response) => {
  try {
    const ids = z.array(z.string().min(1)).min(1).max(50).safeParse(req.body?.payment_ids);
    if (!ids.success) {
      return res.status(400).json({ success: false, error: "payment_ids es obligatorio" });
    }
    const { payment_ids: _omitido, ...resto } = req.body;
    return await cobrarFilas(req, res, [...new Set(ids.data)], resto, false);
  } catch (error) {
    console.error("Register manual collection error:", error);
    return res.status(500).json({ success: false, error: "Error al registrar el cobro" });
  }
});

/**
 * POST /api/payments/:id/cobro — envoltorio de un solo id (contrato de dev). La
 * gestión cobra por cualquier medio manual; un profesor, sólo efectivo y sólo
 * cuotas de disciplinas que dicta: ver `decidirCobro`.
 */
paymentsRouter.post("/:id/cobro", async (req: Request<{ id: string }>, res: Response) => {
  try {
    return await cobrarFilas(req, res, [req.params.id], req.body, true);
  } catch (error) {
    console.error("Register cash payment error:", error);
    return res.status(500).json({ success: false, error: "Error al registrar el cobro" });
  }
});

/**
 * POST /api/payments/:id/revertir { reason } — deshace un cobro manual (D11/D22b).
 * La liquidación pasa a `Anulado` (queda visible) y TODAS sus filas vuelven a
 * `Pendiente`. Los cobros de MP se reembolsan; los que incluyen una reserva se
 * deshacen cancelando la reserva.
 */
paymentsRouter.post("/:id/revertir", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = revertirSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: formatErrors(parsed.error.issues),
      });
    }

    const pago = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true },
    });
    if (!pago) return res.status(404).json({ success: false, error: "Cuota no encontrada" });
    if (pago.status !== "Pagado") {
      return res.status(409).json({ success: false, error: "Esa cuota no está paga" });
    }

    const liq = await prisma.paymentTransaction.findFirst({
      where: { status: "Aprobado", items: { some: { payment_id: pago.id } } },
      orderBy: { created_at: "desc" },
      select: { id: true, method: true, items: { select: { payment: { select: { id: true, concept: true } } } } },
    });
    if (!liq) {
      return res.status(409).json({ success: false, error: "Esa cuota no tiene un cobro para revertir" });
    }
    if (liq.method === "MercadoPago") {
      return res.status(409).json({ success: false, error: "Un cobro de Mercado Pago se reembolsa, no se revierte" });
    }
    if (liq.items.some((i) => i.payment.concept === "Reserva")) {
      return res.status(409).json({ success: false, error: "Un cobro con reserva se deshace cancelando la reserva" });
    }

    const filas = liq.items.map((i) => i.payment.id);
    let ok: boolean;
    try {
      ok = await prisma.$transaction(async (tx) => {
        const { count } = await tx.paymentTransaction.updateMany({
          where: { id: liq.id, status: "Aprobado" },
          data: {
            status: "Anulado",
            voided_by: req.user!.id,
            voided_reason: parsed.data.reason,
            voided_at: new Date(),
          },
        });
        if (count === 0) return false;
        await tx.payment.updateMany({
          where: { id: { in: filas }, status: "Pagado" },
          data: { status: "Pendiente", method: null, paid_at: null, registered_by: null },
        });
        return true;
      });
    } catch (e) {
      // Perdió la carrera contra otro revertir: mismo resultado que ver la liquidación ya anulada.
      if (!esConflictoDeEscritura(e)) throw e;
      ok = false;
    }
    if (!ok) {
      return res.status(409).json({ success: false, error: "Ese cobro ya fue revertido" });
    }

    auditar(req, "update", "liquidacion", liq.id, {
      motivo: parsed.data.reason,
      antes: { estado: "Aprobado", filas },
      despues: { estado: "Anulado" },
    });
    return res.json({ success: true, liquidacion: { id: liq.id, status: "Anulado" }, filas });
  } catch (error) {
    console.error("Revert collection error:", error);
    return res.status(500).json({ success: false, error: "Error al revertir el cobro" });
  }
});

/** GET /api/payments/:id — el dueño o la gestión. */
paymentsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: paymentInclude,
    });
    if (!payment) {
      return res.status(404).json({ success: false, error: "Cuota no encontrada" });
    }
    if (!isAdmin(req) && payment.user_id !== req.user!.id) {
      return res
        .status(403)
        .json({ success: false, error: "No tenés permisos para esta acción" });
    }
    return res.json({ success: true, payment: serializePayment(payment) });
  } catch (error) {
    console.error("Get payment error:", error);
    return res.status(500).json({ success: false, error: "Error al obtener la cuota" });
  }
});

/**
 * POST /api/payments/:id/comprobante — el socio sube el comprobante de la
 * transferencia y la cuota queda EnRevision hasta que la gestión la confirme.
 *
 * Multipart, igual que la foto de perfil en socio.ts. El kind "receipts" acepta
 * PDF además de imágenes: es lo que exporta el homebanking.
 */
paymentsRouter.post(
  "/:id/comprobante",
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const payment = await prisma.payment.findUnique({
        where: { id: req.params.id },
        select: { id: true, user_id: true, status: true, file_id: true },
      });
      if (!payment) {
        return res.status(404).json({ success: false, error: "Cuota no encontrada" });
      }
      if (!isAdmin(req) && payment.user_id !== req.user!.id) {
        return res
          .status(403)
          .json({ success: false, error: "No tenés permisos para esta acción" });
      }
      if (payment.status === "Pagado") {
        return res.status(409).json({ success: false, error: "Esa cuota ya está paga" });
      }
      if (payment.status === "Anulado") {
        return res.status(409).json({ success: false, error: "Esa cuota está anulada" });
      }

      const form = await readFormData(req);
      const parsed = uploadSchema.safeParse({ file: form.get("file") });
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Validación fallida",
          errors: formatErrors(parsed.error.issues),
        });
      }

      let fileId: string;
      try {
        fileId = await Storage.create({
          file: parsed.data.file,
          kind: "receipts",
          name: parsed.data.file.name,
          userId: payment.user_id,
        });
      } catch (err) {
        console.error("Error subiendo comprobante.", {
          error: err,
          cause: (err as Error).cause,
        });
        return res.status(400).json({
          success: false,
          error:
            (err as Error).message === "invalid-image-type"
              ? "El comprobante tiene que ser PDF o imagen"
              : (err as Error).message || "Error al subir el comprobante",
        });
      }

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { file_id: fileId, status: "EnRevision" },
        include: paymentInclude,
      });

      // Reemplazar el comprobante borra el anterior, como la foto de perfil: si
      // el socio sube uno corregido, el viejo no queda ocupando disco para siempre.
      if (payment.file_id) {
        try {
          await Storage.remove(payment.file_id);
        } catch (err) {
          console.error("Error borrando el comprobante anterior.", {
            error: err,
            oldFileId: payment.file_id,
          });
        }
      }

      return res.json({ success: true, payment: serializePayment(updated) });
    } catch (error) {
      console.error("Upload receipt error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al subir el comprobante" });
    }
  },
);

/** Mensajes por acción cuando la fila no admite la mutación pedida. */
const MSG_NO_PERMITIDA: Record<string, string> = {
  anular: "Esa cuota no se puede anular",
  condonar: "Esa cuota no se puede condonar",
  editar: "Esa cuota no se puede editar",
  eliminar: "Esa cuota no se puede eliminar",
};

/**
 * Mutación de gestión de una fila: valida que `accion` esté en `accionesPermitidas`
 * (misma regla que ve la UI), y aplica `data` con un `updateMany` guardado por el
 * estado leído (el perdedor de una carrera recibe 409). Devuelve la fila actualizada.
 */
async function mutarFila(
  req: Request<{ id: string }>,
  res: Response,
  accion: Accion,
  data: Prisma.PaymentUpdateManyMutationInput,
  auditoria: { motivo?: string; despues: unknown },
) {
  const fila = await prisma.payment.findUnique({
    where: { id: req.params.id },
    select: { id: true, concept: true, status: true, deleted_at: true, due_date: true },
  });
  if (!fila) return res.status(404).json({ success: false, error: "Cuota no encontrada" });

  const liq = (await liquidacionesDe([fila.id])).get(fila.id);
  if (liq?.viva) {
    return res.status(409).json({ success: false, error: "Hay un pago en curso para esta cuota" });
  }
  if (!accionesDe(fila, liq).includes(accion)) {
    return res.status(409).json({ success: false, error: MSG_NO_PERMITIDA[accion] });
  }

  const { count } = await prisma.payment.updateMany({
    where: { id: fila.id, status: fila.status, deleted_at: null },
    data,
  });
  if (count === 0) {
    return res.status(409).json({ success: false, error: "La cuota cambió de estado, actualizá y reintentá" });
  }
  auditar(req, "update", "payment", fila.id, {
    motivo: auditoria.motivo,
    antes: { status: fila.status, due_date: aDia(fila.due_date) },
    despues: auditoria.despues,
  });
  const payment = await prisma.payment.findUnique({ where: { id: fila.id }, include: paymentInclude });
  return res.json({ success: true, payment: payment && serializePayment(payment) });
}

/**
 * PATCH /api/payments/:id — la gestión anula, condona o edita el vencimiento
 * (`action: anular | condonar | editar`). Anular y condonar piden `reason` y sólo
 * aplican a `Pendiente`/`EnRevision` que no sean `Reserva` (una `Pagado` es 409).
 * El cobro va por /cobro; `confirmar`/`rechazar` ya no existen (D23).
 */
paymentsRouter.patch(
  "/:id",
  requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Validación fallida",
          errors: formatErrors(parsed.error.issues),
        });
      }
      const b = parsed.data;
      if (b.action === "editar") {
        return await mutarFila(
          req,
          res,
          "editar",
          { due_date: b.due_date ? new Date(`${b.due_date}T00:00:00Z`) : null },
          { despues: { due_date: b.due_date } },
        );
      }
      const status = b.action === "anular" ? "Anulado" : "Condonado";
      return await mutarFila(
        req,
        res,
        b.action,
        { status, resolved_by: req.user!.id, resolved_reason: b.reason, resolved_at: new Date() },
        { motivo: b.reason, despues: { status } },
      );
    } catch (error) {
      console.error("Update payment error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al actualizar la cuota" });
    }
  },
);

/**
 * DELETE /api/payments/:id { reason } — baja lógica (D7): sólo `Pendiente`, no `Reserva`
 * y sin pago en curso. Queda `Anulado` + `deleted_*`; el listado la oculta salvo `?eliminados=1`.
 */
paymentsRouter.delete("/:id", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = deleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: formatErrors(parsed.error.issues),
      });
    }
    return await mutarFila(
      req,
      res,
      "eliminar",
      {
        status: "Anulado",
        deleted_at: new Date(),
        deleted_by: req.user!.id,
        deleted_reason: parsed.data.reason,
      },
      { motivo: parsed.data.reason, despues: { status: "Anulado", eliminado: true } },
    );
  } catch (error) {
    console.error("Delete payment error:", error);
    return res.status(500).json({ success: false, error: "Error al eliminar la cuota" });
  }
});

/**
 * POST /api/payments/:id/reembolso { reason } — la gestión devuelve por Mercado Pago el cobro de
 * una fila `Pagado` (D12). 400 si no se cobró por MP, 409 si no está `Pagado` / hay un reembolso
 * en curso o ya hecho, 502 si MP falla (queda `failed` y el barrido reintenta, o `rejected`
 * y sólo la gestión lo reintenta llamando de nuevo).
 */
paymentsRouter.post("/:id/reembolso", requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const parsed = revertirSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Validación fallida",
        errors: formatErrors(parsed.error.issues),
      });
    }
    const fila = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, method: true },
    });
    if (!fila) return res.status(404).json({ success: false, error: "Cuota no encontrada" });
    if (fila.method !== "MercadoPago") {
      return res.status(400).json({ success: false, error: "Esa cuota no se cobró por Mercado Pago" });
    }
    if (fila.status !== "Pagado") {
      return res.status(409).json({ success: false, error: "Sólo se reembolsa una cuota pagada" });
    }
    // La liquidación MP que la saldó (la más reciente aprobada).
    const item = await prisma.paymentTransactionItem.findFirst({
      where: { payment_id: fila.id, transaction: { method: "MercadoPago", status: { in: ["Aprobado", "ReembolsadoParcial"] } } },
      orderBy: { transaction: { created_at: "desc" } },
      select: { transaction_id: true },
    });
    if (!item) return res.status(400).json({ success: false, error: "No hay un pago de Mercado Pago para reembolsar" });

    const r = await reembolsarItem({
      transaccionId: item.transaction_id,
      filaId: fila.id,
      motivo: parsed.data.reason,
      actor: req.user!.id,
      persona: true,
    });
    auditar(req, "update", "payment", fila.id, {
      motivo: parsed.data.reason,
      antes: { status: fila.status },
      despues: { reembolso: r.estado, refund_id: r.refundId },
    });
    if (r.estado === "approved") {
      return res.json({ success: true, reembolso: { id: r.refundId, estado: "aprobado" } });
    }
    if (r.estado === "en_curso" || r.estado === "ya_reembolsado") {
      return res.status(409).json({
        success: false,
        error: r.estado === "en_curso" ? "Hay un reembolso en curso" : "Esa cuota ya fue reembolsada",
      });
    }
    return res.status(502).json({
      success: false,
      error: "Mercado Pago no pudo procesar el reembolso",
      reembolso: { id: r.refundId, estado: r.estado },
    });
  } catch (error) {
    console.error("Refund payment error:", error);
    return res.status(500).json({ success: false, error: "Error al reembolsar la cuota" });
  }
});
