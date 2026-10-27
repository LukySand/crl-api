/**
 * Postulación de sponsors (issue #82).
 *
 * Un comercio —o una persona— se postula desde la web **sin tener cuenta**, y la
 * gestión aprueba o rechaza. No confundir con los locales adheridos
 * (`partner-stores.ts`): el sponsor aporta al club, el local adherido da
 * descuentos a los socios.
 *
 * Es el primer endpoint del sistema que **escribe sin sesión**, así que todo lo
 * que entra se valida en `lib/sponsor.ts`, la cola tiene tope
 * (`LIMITE_PENDIENTES`) y hay campo trampa (`CAMPO_TRAMPA`). Lo que sale a la
 * vitrina pública está recortado a mano: ver `VITRINA_SELECT`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { readFormData } from "../lib/multipart";
import { isAdmin, readToken, requireAdmin, requireAuth, veComoGestion } from "../lib/auth";
import {
  CAMPO_TRAMPA,
  LIMITE_PENDIENTES,
  denyBaja,
  denyEdicion,
  denyReactivar,
  denyRevision,
  sponsorContactoSchema,
  sponsorApplicationSchema,
  sponsorReviewSchema,
  statusFiltro,
  type SponsorStatus,
} from "../lib/sponsor";

export const sponsorsRouter = Router();

/** Los campos del formulario, en el orden en que los lee del multipart. */
const CAMPOS = [
  "business_name",
  "contact_name",
  "email",
  "phone",
  "sector",
  "contribution",
  "message",
] as const;

/**
 * Lo único que sale de la vitrina pública. Está escrito campo por campo a
 * propósito: la fila tiene CUIT, email, teléfono y el mensaje del acuerdo, y
 * ninguna de esas cuatro cosas va a una página que puede ver cualquiera. Un
 * `select` explícito no se rompe solo cuando mañana se agregue una columna.
 */
const VITRINA_SELECT = {
  id: true,
  business_name: true,
  sector: true,
  logo_file_id: true,
} as const;

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

function applicationId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ success: false, error: "ID inválido" });
    return null;
  }
  return id;
}

/**
 * GET /api/sponsors — la vitrina. **Pública y sin sesión**, igual que
 * `/api/novedades`: son los sponsors aprobados que se muestran en la landing.
 */
sponsorsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const sponsors = await prisma.sponsorApplication.findMany({
      where: { status: "Aprobada" },
      select: VITRINA_SELECT,
      orderBy: { business_name: "asc" },
    });
    return res.json({ success: true, sponsors });
  } catch (error) {
    console.error("List sponsors error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al listar los sponsors" });
  }
});

/**
 * POST /api/sponsors/applications — un comercio o una persona se postula. **Público.**
 *
 * Multipart, igual que el comprobante de una cuota: los datos van como campos de
 * texto y el logo (opcional) como archivo en el mismo pedido. Van juntos y no en
 * dos pasos porque subir el logo aparte exigiría sesión (`PUT /api/files`) y
 * dejaría archivos huérfanos si se abandona el formulario a mitad.
 */
sponsorsRouter.post("/applications", async (req: Request, res: Response) => {
  try {
    const form = await readFormData(req);

    // Campo trampa: sólo lo completa un bot que llena todo lo que encuentra. Se
    // responde 201 como si nada en vez de 400 — un error le enseña al bot cuál
    // era el campo y vuelve sin él.
    const trampa = form.get(CAMPO_TRAMPA);
    if (typeof trampa === "string" && trampa.trim()) {
      console.warn("Postulación de sponsor descartada: campo trampa completado.");
      return res.status(201).json({
        success: true,
        message: "Recibimos tu postulación. La gestión del club te va a contactar.",
      });
    }

    const parsed = sponsorApplicationSchema.safeParse(
      Object.fromEntries(CAMPOS.map((c) => [c, form.get(c) ?? undefined])),
    );
    if (!parsed.success) return validationError(res, parsed.error);
    const datos = parsed.data;

    // Uno por vez: si ese email ya tiene una pendiente o aprobada, no se duplica.
    // Una rechazada sí puede volver a postularse (cambió de propuesta).
    //
    // La clave es el email porque ya no se pide CUIT, y es igual el dato con el
    // que la gestión va a contestar. Se compara en minúsculas: nadie espera que
    // "Juan@…" y "juan@…" sean dos postulaciones distintas.
    const previa = await prisma.sponsorApplication.findFirst({
      where: { email: datos.email.toLowerCase(), status: { in: ["Pendiente", "Aprobada"] } },
      select: { status: true },
    });
    if (previa) {
      return res.status(409).json({
        success: false,
        error:
          previa.status === "Aprobada"
            ? "Con ese email ya hay un sponsor del club"
            : "Ya hay una postulación en revisión con ese email",
      });
    }

    // Tope de la cola: lo que acota el daño de que el formulario sea público.
    // Se chequea **antes** de escribir el logo, así tampoco se llena el disco.
    const pendientes = await prisma.sponsorApplication.count({
      where: { status: "Pendiente" },
    });
    if (pendientes >= LIMITE_PENDIENTES) {
      return res.status(503).json({
        success: false,
        error:
          "Estamos revisando muchas postulaciones. Probá de nuevo en unos días.",
      });
    }

    // El logo es opcional. `Storage.create` valida tamaño y tipo real por los
    // bytes del archivo (no por el content-type que manda el cliente), que es lo
    // que hace tolerable recibirlo sin sesión. Reusa el kind `localImages`: es el
    // mismo tipo de cosa (el logo de un comercio) y el nombre en disco es un UUID.
    const logo = form.get("logo");
    let logoFileId: string | null = null;
    if (logo instanceof File && logo.size > 0) {
      try {
        logoFileId = await Storage.create({
          file: logo,
          kind: "localImages",
          name: crypto.randomUUID(),
          // El Storage sólo lo usa para loguear: `File` no tiene dueño y acá no
          // hay usuario con el que responder.
          userId: "postulacion-sponsor",
        });
      } catch (err) {
        console.error("Error subiendo el logo del sponsor.", {
          error: err,
          cause: (err as Error).cause,
        });
        // El `message` de Storage es un código interno ("file-too-big",
        // "file-type-notfound"…). Al que está llenando el formulario se le dice
        // qué arreglar: si no se distingue tamaño de formato, prueba de nuevo
        // con la misma imagen más chica y vuelve a fallar.
        const detalle =
          (err as Error).message === "file-too-big"
            ? "El logo es demasiado grande"
            : "El logo tiene que ser una imagen (JPG, PNG o WEBP)";
        return res.status(400).json({
          success: false,
          error: detalle,
          errors: { logo: detalle },
        });
      }
    }

    // Si vino con sesión, la postulación queda atada a esa cuenta y la persona la
    // va a poder seguir desde la app. El id sale **del token**, nunca del body:
    // si lo mandara el cliente, cualquiera postularía a nombre de otro.
    const sesion = readToken(req);

    await prisma.sponsorApplication.create({
      data: {
        ...datos,
        email: datos.email.toLowerCase(),
        logo_file_id: logoFileId,
        user_id: sesion?.id ?? null,
      },
    });

    // A un anónimo no se le devuelve la fila: no tiene con qué hacer nada con
    // ella y expondría el id de una postulación ajena. Lo que sí cambia es el
    // mensaje: con cuenta la puede seguir desde la app, sin cuenta se entera
    // recién cuando el club le escribe.
    return res.status(201).json({
      success: true,
      conCuenta: !!sesion,
      message: sesion
        ? "Recibimos tu postulación. La podés seguir desde la app, en Configuración."
        : "Recibimos tu postulación. Te escribimos al email que dejaste.",
    });
  } catch (error) {
    console.error("Create sponsor application error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Error al enviar la postulación" });
  }
});

/**
 * GET /api/sponsors/applications — las postulaciones.
 * `?status=Pendiente|Aprobada|Rechazada|Finalizada`; sin filtro, todas.
 *
 * La gestión ve las de todo el club; cualquier otra sesión ve **las suyas**, que
 * es lo que alimenta "Mi propuesta" en la app. Un admin puede pedir las propias
 * con `?propias=true`, igual que en reservas, inscripciones y cuotas
 * (`veComoGestion`): un Administrador que además postuló su comercio quiere ver
 * la suya, no las de todos.
 */
sponsorsRouter.get(
  "/applications",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const status = statusFiltro(req.query.status);
      const propias = veComoGestion(req) ? {} : { user_id: req.user!.id };
      const applications = await prisma.sponsorApplication.findMany({
        where: { ...propias, ...(status ? { status } : {}) },
        // Las pendientes primero y, dentro de cada estado, la más vieja arriba:
        // es el orden en que hay que atenderlas.
        orderBy: [{ status: "asc" }, { created_at: "asc" }],
      });
      return res.json({ success: true, applications });
    } catch (error) {
      console.error("List sponsor applications error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al listar las postulaciones" });
    }
  },
);

/** GET /api/sponsors/applications/:id — el detalle. Gestión o quien la mandó. */
sponsorsRouter.get(
  "/applications/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const id = applicationId(req, res);
      if (id === null) return;

      const application = await prisma.sponsorApplication.findUnique({
        where: { id },
      });
      if (!application) {
        return res
          .status(404)
          .json({ success: false, error: "Postulación no encontrada" });
      }
      // Mismo criterio que una cuota: el dueño ve la suya, la gestión ve todas.
      if (!isAdmin(req) && application.user_id !== req.user!.id) {
        return res
          .status(403)
          .json({ success: false, error: "No tenés permisos para esta acción" });
      }
      return res.json({ success: true, application });
    } catch (error) {
      console.error("Get sponsor application error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al traer la postulación" });
    }
  },
);

/**
 * PATCH /api/sponsors/applications/:id/datos — corregir los datos. Pendiente nada más.
 *
 * Dos usos en un mismo endpoint, porque son el mismo concepto ("corregir lo que
 * dice la ficha") con distinto alcance:
 *
 *  - **Quien la mandó** (tiene cuenta y es suya) corrige todo lo que escribió:
 *    es su propuesta. Así, el que se postuló con cuenta no depende de nadie para
 *    arreglar un dato.
 *  - **La gestión** corrige sólo contacto —nombre, email, teléfono— porque el
 *    caso real es el email tipeado mal de una postulación anónima, que es justo
 *    el dato con el que iban a contestar. El rubro, el aporte y el mensaje son lo
 *    que la persona propuso, y la gestión no reescribe propuestas ajenas.
 *
 * Si alguien es dueño **y** admin, manda el alcance de dueño: es su propia ficha.
 */
sponsorsRouter.patch(
  "/applications/:id/datos",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const id = applicationId(req, res);
      if (id === null) return;

      const actual = await prisma.sponsorApplication.findUnique({
        where: { id },
        select: { status: true, user_id: true },
      });
      if (!actual) {
        return res
          .status(404)
          .json({ success: false, error: "Postulación no encontrada" });
      }

      const esDueño = !!actual.user_id && actual.user_id === req.user!.id;
      if (!esDueño && !isAdmin(req)) {
        return res
          .status(403)
          .json({ success: false, error: "No tenés permisos para esta acción" });
      }

      const deny = denyEdicion(actual.status as SponsorStatus);
      if (deny) return res.status(409).json({ success: false, error: deny });

      const schema = esDueño ? sponsorApplicationSchema : sponsorContactoSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);

      const application = await prisma.sponsorApplication.update({
        where: { id },
        data: { ...parsed.data, email: parsed.data.email.toLowerCase() },
      });
      return res.json({ success: true, application });
    } catch (error) {
      console.error("Edit sponsor application error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al corregir los datos" });
    }
  },
);

/**
 * Mueve el estado de una postulación. Lo comparten la baja y la reactivación,
 * que sólo se diferencian en qué transición permiten y en el estado destino.
 */
async function cambiarEstado(
  req: Request<{ id: string }>,
  res: Response,
  opciones: {
    destino: SponsorStatus;
    deny: (actual: SponsorStatus) => string | null;
    errorGenerico: string;
  },
) {
  try {
    const id = applicationId(req, res);
    if (id === null) return;

    const actual = await prisma.sponsorApplication.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!actual) {
      return res
        .status(404)
        .json({ success: false, error: "Postulación no encontrada" });
    }

    const deny = opciones.deny(actual.status as SponsorStatus);
    if (deny) return res.status(409).json({ success: false, error: deny });

    const application = await prisma.sponsorApplication.update({
      where: { id },
      data: {
        status: opciones.destino,
        reviewed_at: new Date(),
        reviewed_by: req.user!.id,
      },
    });
    return res.json({ success: true, application });
  } catch (error) {
    console.error(`${opciones.errorGenerico}:`, error);
    return res.status(500).json({ success: false, error: opciones.errorGenerico });
  }
}

/**
 * DELETE /api/sponsors/applications/:id — se terminó el auspicio. Solo gestión.
 *
 * Es baja lógica, igual que en los locales adheridos: el sponsor sale de la
 * vitrina (`status` deja de ser Aprobada) pero la fila queda entera. Un auspicio
 * es por temporada; sin esto, el logo de quien ya no acompaña se queda en la
 * landing para siempre.
 */
sponsorsRouter.delete(
  "/applications/:id",
  requireAuth,
  requireAdmin,
  (req: Request<{ id: string }>, res: Response) =>
    cambiarEstado(req, res, {
      destino: "Finalizada",
      deny: denyBaja,
      errorGenerico: "Error al dar de baja el auspicio",
    }),
);

/**
 * PATCH /api/sponsors/applications/:id/reactivate — vuelve a la vitrina. Solo gestión.
 *
 * Va declarada **antes** que `/applications/:id`, igual que en partner-stores: no
 * chocan (tienen distinta cantidad de segmentos), pero el orden deja claro cuál
 * es la específica.
 */
sponsorsRouter.patch(
  "/applications/:id/reactivate",
  requireAuth,
  requireAdmin,
  (req: Request<{ id: string }>, res: Response) =>
    cambiarEstado(req, res, {
      destino: "Aprobada",
      deny: denyReactivar,
      errorGenerico: "Error al reactivar el auspicio",
    }),
);

/**
 * PATCH /api/sponsors/applications/:id — aprobar o rechazar. Solo gestión.
 * `{ action: "aprobar" | "rechazar", rejection_reason? }`
 *
 * El estado sólo se mueve desde Pendiente: una vez resuelta, la fila es el
 * registro de lo que se decidió (ver `denyRevision`).
 */
sponsorsRouter.patch(
  "/applications/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = applicationId(req, res);
      if (id === null) return;

      const parsed = sponsorReviewSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error);
      const { action, rejection_reason } = parsed.data;

      const actual = await prisma.sponsorApplication.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!actual) {
        return res
          .status(404)
          .json({ success: false, error: "Postulación no encontrada" });
      }

      const deny = denyRevision(actual.status as SponsorStatus);
      if (deny) return res.status(409).json({ success: false, error: deny });

      const application = await prisma.sponsorApplication.update({
        where: { id },
        data: {
          status: action === "aprobar" ? "Aprobada" : "Rechazada",
          // Aprobar limpia el motivo: no quedaría claro a qué se refiere.
          rejection_reason: action === "rechazar" ? rejection_reason! : null,
          reviewed_at: new Date(),
          reviewed_by: req.user!.id,
        },
      });
      return res.json({ success: true, application });
    } catch (error) {
      console.error("Review sponsor application error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Error al resolver la postulación" });
    }
  },
);
