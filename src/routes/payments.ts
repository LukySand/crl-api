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
import { estadoCuota } from "../lib/payment-rules";
import {
  liquidacionViva,
  registrarCobroManual,
  verificarOrdenDePago,
} from "../lib/settlement";
import type { PaymentMethod } from "../../prisma/generated/client";
import { emitirCargos } from "../lib/emission";
import { serializePayment, serializePayments } from "../lib/payment";
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

const updateSchema = z.object({
  // "confirmar" cobra, "rechazar" devuelve a Pendiente, "anular" da de baja la deuda.
  action: z.enum(["confirmar", "rechazar", "anular"]),
  method: z.enum(["Efectivo", "Transferencia", "MercadoPago"]).optional(),
  notes: z.string().max(1000).optional(),
});

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

/**
 * GET /api/payments — cuotas y cobros. La gestión ve todos; el resto, los propios.
 * Con `?propias=true` sólo los propios, también para gestión.
 * Filtros: ?status=Pendiente ?concept=Disciplina ?period=2026-09 ?user_id=... ?from=&to=
 *
 * `from`/`to` filtran por vencimiento, que es lo que le importa a un socio
 * mirando qué debe. Los reportes de ingresos filtran por fecha de cobro y viven
 * en /api/reports.
 */
paymentsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { status, concept, period, user_id, from, to } = req.query;
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

    const payments = await prisma.payment.findMany({
      where: {
        // Sale del token, nunca de la query: un socio no mira la deuda de otro.
        ...(admin
          ? typeof user_id === "string" && { user_id }
          : { user_id: req.user!.id }),
        ...(typeof status === "string" && { status: status as any }),
        ...(typeof concept === "string" && { concept: concept as any }),
        ...(typeof period === "string" && { period }),
        ...((typeof from === "string" || typeof to === "string") && {
          due_date: {
            ...(typeof from === "string" && { gte: new Date(`${from}T00:00:00Z`) }),
            ...(typeof to === "string" && { lte: new Date(`${to}T00:00:00Z`) }),
          },
        }),
      },
      include: paymentInclude,
      orderBy: [{ due_date: "desc" }],
    });

    return res.json({ success: true, payments: serializePayments(payments) });
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
    const ok = await prisma.$transaction(async (tx) => {
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

/**
 * PATCH /api/payments/:id — la gestión confirma el cobro, rechaza un comprobante
 * o anula la deuda. Sólo gestión: quien debe no decide si pagó.
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
      const { action, method, notes } = parsed.data;

      const data =
        action === "confirmar"
          ? {
              status: "Pagado" as const,
              paid_at: new Date(),
              // Sin medio declarado se asume efectivo: es el mostrador del club.
              method: method ?? ("Efectivo" as const),
              registered_by: req.user!.id,
            }
          : action === "rechazar"
            ? {
                // Vuelve a deber. El comprobante queda adjunto a propósito: es la
                // prueba de qué se rechazó.
                status: "Pendiente" as const,
                paid_at: null,
                method: null,
                registered_by: req.user!.id,
              }
            : {
                status: "Anulado" as const,
                registered_by: req.user!.id,
              };

      // La condición va en el UPDATE y no en un if previo, igual que al cancelar
      // una reserva: dos confirmaciones en paralelo tienen que dejar una sola.
      const { count } = await prisma.payment.updateMany({
        where: {
          id: req.params.id,
          // Una cuota paga no se vuelve a tocar por esta vía: para revertir un
          // cobro hace falta anularla explícitamente, no "confirmarla" de nuevo.
          ...(action === "anular" ? {} : { status: { not: "Pagado" } }),
        },
        data: { ...data, ...(notes !== undefined && { notes }) },
      });
      if (count === 0) {
        const existe = await prisma.payment.findUnique({
          where: { id: req.params.id },
          select: { id: true },
        });
        return existe
          ? res.status(409).json({ success: false, error: "Esa cuota ya está paga" })
          : res.status(404).json({ success: false, error: "Cuota no encontrada" });
      }

      const payment = await prisma.payment.findUnique({
        where: { id: req.params.id },
        include: paymentInclude,
      });

      return res.json({ success: true, payment: payment && serializePayment(payment) });
    } catch (error) {
      console.error("Update payment error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al actualizar la cuota" });
    }
  },
);
