import { Router, type Request as ExpressRequest, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { requireAuth } from "../lib/auth";
import { changePasswordSchema } from "../lib/validation";
import { emitirCargos } from "../lib/emission";
import { syncPendingPayments } from "../lib/payment-sync";
import { cuotasSocialesVencidas, estadoCuota } from "../lib/payment-rules";
import { nombresDeRoles, rolesInclude, tieneRol } from "../lib/roles";
import { logger } from "../lib/logger";

const uploadSchema = z.object({
    file: z.instanceof(File, { message: "Missing file" }),
});

function formatValidationErrors(issues: z.ZodIssue[]) {
    const errors: Record<string, string> = {};
    issues.forEach((issue) => {
        const key = issue.path[0] as string;
        errors[key] = issue.message;
    });
    return errors;
}

async function readFormData(req: ExpressRequest) {
    const request = new Request(`http://localhost${req.originalUrl}`, {
        method: req.method,
        headers: {
            "content-type": req.headers["content-type"] ?? "",
        },
        body: Readable.toWeb(req as never),
        duplex: "half",
    });

    return request.formData();
}

function isUsableFileId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        id.trim() !== "" &&
        id !== "null" &&
        id !== "undefined"
    );
}

export const socioRouter = Router();

// Todo /api/socio requiere sesión.
socioRouter.use(requireAuth);

/**
 * GET /api/socio/files?id=... — sirve un archivo almacenado (ej: foto de perfil).
 */
socioRouter.get("/files", async (req: ExpressRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "No autenticado" });
        }

        const id = req.query.id;
        if (!isUsableFileId(id)) {
            return res.status(400).json({ error: "Falta el parámetro id" });
        }

        // Soporta cache condicional: el browser manda If-None-Match con
        // comillas (ej: "1699999"), Storage.getFile espera el valor pelado.
        const rawIfNoneMatch = req.headers["if-none-match"];
        const ifNoneMatch = Array.isArray(rawIfNoneMatch)
            ? rawIfNoneMatch[0]
            : rawIfNoneMatch?.replace(/"/g, "");

        let result;
        try {
            result = await Storage.getFile(id, ifNoneMatch);
        } catch (err) {
            console.error("Error leyendo archivo del storage.", { error: err, id });
            return res.status(404).json({ error: "Archivo no encontrado" });
        }

        if (result === "not-modified") {
            return res.status(304).end();
        }

        if (!result) {
            return res.status(404).json({ error: "Archivo no encontrado" });
        }

        res.setHeader("Content-Type", result.mime || "application/octet-stream");
        res.setHeader("Content-Length", String(result.size));
        res.setHeader("ETag", `"${result.etag}"`);
        res.setHeader("Last-Modified", result.lastModified.toUTCString());
        // no-cache: el browser guarda la foto pero pregunta siempre con el ETag
        // (304 si no cambió). La URL de la foto de un socio es fija (el id no
        // cambia al reemplazarla), así que con max-age se veía la vieja un rato.
        res.setHeader("Cache-Control", "private, no-cache");

        Readable.fromWeb(result.stream as never).pipe(res);
    } catch (error) {
        console.error("Get file error:", error);
        return res.status(500).json({ error: "Error al obtener el archivo" });
    }
});

/**
 * PATCH /api/socio/profile-image — reemplaza la foto de perfil del socio logueado.
 */
socioRouter.patch("/profile-image", async (req: ExpressRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "No autenticado" });
        }

        const form = await readFormData(req);
        const validationResult = uploadSchema.safeParse({ file: form.get("file") });

        if (!validationResult.success) {
            return res.status(400).json({
                error: "Validación fallida",
                errors: formatValidationErrors(validationResult.error.issues),
            });
        }

        const current = await prisma.user.findUnique({
            where: { id: userId },
            select: { file_id: true },
        });
        if (!current) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const { file } = validationResult.data;

        let newFileId: string;
        try {
            newFileId = await Storage.create({
                file,
                kind: "accountImages",
                // El nombre en disco es el id del socio, no el de la foto: con
                // `file.name`, dos socios que subían "IMG_0001.jpg" caían en la
                // misma ruta y el segundo pisaba la foto del primero.
                name: userId,
                userId,
            });
        } catch (err) {
            console.error("Error uploading profile image.", {
                error: err,
                cause: (err as Error).cause,
            });
            return res.status(400).json({
                error: (err as Error).message || "Error al subir la imagen",
            });
        }

        const updated = await prisma.user.update({
            where: { id: userId },
            data: { file_id: newFileId },
            select: { file_id: true },
        });

        // Si la foto nueva cayó en la misma ruta (mismo socio, mismo formato),
        // Storage.create reemplaza el archivo y devuelve el mismo id: borrar "la
        // vieja" sería borrar la que se acaba de subir.
        if (current.file_id && current.file_id !== newFileId) {
            try {
                await Storage.remove(String(current.file_id));
            } catch (err) {
                console.error("Error removing old profile image.", {
                    error: err,
                    oldFileId: current.file_id,
                });
            }
        }

        return res.status(200).json({ fileId: updated.file_id });
    } catch (error) {
        console.error("Update profile image error:", error);
        return res
            .status(500)
            .json({ error: "Error al actualizar la foto de perfil" });
    }
});

/**
 * PATCH /api/socio/password — cambia la contraseña propia (pide la actual).
 * Pensado sobre todo para un hijo al que el padre le cargó una contraseña
 * (POST /api/families/:id/credentials) y quiere ponerse una propia.
 */
socioRouter.patch("/password", async (req: ExpressRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "No autenticado" });
        }

        const validationResult = changePasswordSchema.safeParse(req.body ?? {});
        if (!validationResult.success) {
            return res.status(400).json({
                error: "Validación fallida",
                errors: formatValidationErrors(validationResult.error.issues),
            });
        }
        const { current_password, new_password } = validationResult.data;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const match = await Bun.password.verify(current_password, user.password);
        if (!match) {
            return res.status(401).json({ error: "La contraseña actual es incorrecta" });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { password: await Bun.password.hash(new_password), has_credentials: true },
        });

        return res.json({ success: true, message: "Contraseña actualizada" });
    } catch (error) {
        console.error("Change password error:", error);
        return res.status(500).json({ error: "Error al cambiar la contraseña" });
    }
});
// ─── Cuenta del socio: cuotas, credencial e historial (D15) ──────────────────

const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Pone la cuenta al día antes de leerla: emite lo que el cron no alcanzó a emitir
 * y concilia con MP los pagos cuyo webhook nunca llegó. Un fallo acá no puede dejar
 * al socio sin ver su cuenta, así que se loguea y se sigue con lo que hay.
 */
async function actualizarCuenta(userId: string) {
    try {
        await emitirCargos({ userId });
    } catch (error) {
        logger.error(error, "Emisión al leer la cuenta falló", { metadata: { user_id: userId } });
    }
    try {
        await syncPendingPayments({ userId, limite: 20 });
    } catch (error) {
        logger.error(error, "Conciliación al leer la cuenta falló", { metadata: { user_id: userId } });
    }
}

/** Filas propias, sin bajas lógicas ni reservas (esas viven en "Mis reservas"). */
function filasDeCuenta(userId: string) {
    return prisma.payment.findMany({
        where: { user_id: userId, deleted_at: null, concept: { not: "Reserva" } },
        select: {
            id: true,
            concept: true,
            name: true,
            description: true,
            amount: true,
            period: true,
            due_date: true,
            status: true,
            type: { select: { key: true, name: true } },
            enrollment: { select: { discipline: { select: { id: true, name: true } } } },
        },
        orderBy: [{ due_date: { sort: "desc", nulls: "last" } }, { created_at: "desc" }, { id: "asc" }],
    });
}

async function cuentaDe(userId: string) {
    await actualizarCuenta(userId);
    const filas = await filasDeCuenta(userId);
    const cuotas = filas.map((f) => {
        const vencimiento = aDia(f.due_date);
        return {
            id: f.id,
            concepto: f.concept,
            tipo: { key: f.type.key, nombre: f.type.name },
            nombre: f.name,
            descripcion: f.description,
            disciplina: f.enrollment?.discipline
                ? { id: f.enrollment.discipline.id, nombre: f.enrollment.discipline.name }
                : null,
            monto: f.amount.toString(),
            periodo: f.period,
            vencimiento,
            estado: estadoCuota({ status: f.status, due_date: vencimiento }),
        };
    });
    const pagables = cuotas.filter((c) => ["al_dia", "por_vencer", "vencida"].includes(c.estado));
    return {
        cuotas,
        deuda_total: pagables.reduce((acc, c) => acc + Number(c.monto), 0).toFixed(2),
        vencidas: cuotas.filter((c) => c.estado === "vencida").length,
    };
}

async function credencialDe(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, last_name: true, dni: true, file_id: true, active: true, ...rolesInclude },
    });
    if (!user) return null;
    await actualizarCuenta(userId);
    const filas = await prisma.payment.findMany({
        where: { user_id: userId, deleted_at: null, concept: "Socio" },
        select: { concept: true, status: true, due_date: true },
    });
    const vencidas = cuotasSocialesVencidas(filas.map((f) => ({ ...f, due_date: aDia(f.due_date) })));
    const esSocio = tieneRol(nombresDeRoles(user), "Socio");
    return {
        nombre_completo: `${user.name} ${user.last_name}`,
        // ponytail: el "número de socio" es el DNI (User no tiene número propio).
        numero_socio: user.dni,
        file_id: user.file_id,
        es_socio: esSocio,
        habilitada: esSocio && user.active && vencidas === 0,
        cuotas_vencidas: vencidas,
    };
}

/** El vínculo tutor-menor se verifica contra Family activa, nunca se asume del id. */
async function esTutorDe(parentId: string, childId: string) {
    const vinculo = await prisma.family.findFirst({
        where: { parent_id: parentId, child_id: childId, active: true },
        select: { id: true },
    });
    return vinculo !== null;
}

/** GET /api/socio/cuotas — sin `:id`: el socio sale del token (evita IDOR). */
socioRouter.get("/cuotas", async (req: ExpressRequest, res: Response) => {
    try {
        return res.json({ success: true, ...(await cuentaDe(req.user!.id)) });
    } catch (error) {
        console.error("Get cuotas error:", error);
        return res.status(500).json({ error: "Error al obtener las cuotas" });
    }
});

/** GET /api/socio/cuotas/menor/:childId — las cuotas de un menor a cargo. */
socioRouter.get("/cuotas/menor/:childId", async (req: ExpressRequest, res: Response) => {
    try {
        const childId = req.params.childId as string;
        if (!(await esTutorDe(req.user!.id, childId))) {
            return res.status(403).json({ error: "No tenés un menor a cargo con ese id" });
        }
        return res.json({ success: true, ...(await cuentaDe(childId)) });
    } catch (error) {
        console.error("Get cuotas menor error:", error);
        return res.status(500).json({ error: "Error al obtener las cuotas del menor" });
    }
});

/**
 * GET /api/socio/credential — `habilitada` se calcula en cada request: sólo bloquea una
 * Cuota social `Pendiente` vencida (`EnRevision` y vencimiento null no cuentan).
 */
socioRouter.get("/credential", async (req: ExpressRequest, res: Response) => {
    try {
        const credencial = await credencialDe(req.user!.id);
        if (!credencial) return res.status(404).json({ error: "Usuario no encontrado" });
        return res.json({ success: true, credencial });
    } catch (error) {
        console.error("Get credential error:", error);
        return res.status(500).json({ error: "Error al obtener la credencial" });
    }
});

/** GET /api/socio/credential/menor/:childId — credencial de un menor a cargo. */
socioRouter.get("/credential/menor/:childId", async (req: ExpressRequest, res: Response) => {
    try {
        const childId = req.params.childId as string;
        if (!(await esTutorDe(req.user!.id, childId))) {
            return res.status(403).json({ error: "No tenés un menor a cargo con ese id" });
        }
        const credencial = await credencialDe(childId);
        if (!credencial) return res.status(404).json({ error: "Usuario no encontrado" });
        return res.json({ success: true, credencial });
    } catch (error) {
        console.error("Get credential menor error:", error);
        return res.status(500).json({ error: "Error al obtener la credencial del menor" });
    }
});

/**
 * GET /api/socio/historial-pagos — liquidaciones cuyo `user_id` es el socio o que saldan
 * filas suyas (un tutor que pagó por él). `booking_id` sale de la fila de reserva saldada.
 */
socioRouter.get("/historial-pagos", async (req: ExpressRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const pagos = await prisma.paymentTransaction.findMany({
            where: { OR: [{ user_id: userId }, { items: { some: { payment: { user_id: userId } } } }] },
            orderBy: { created_at: "desc" },
            select: {
                id: true,
                method: true,
                amount: true,
                status: true,
                mp_status_detail: true,
                registered_by: true,
                paid_at: true,
                created_at: true,
                items: {
                    select: { payment: { select: { id: true, period: true, concept: true, name: true, booking_id: true } } },
                },
                refunds: { where: { refunded_at: { not: null } }, select: { amount: true, refunded_at: true, payment_id: true } },
            },
        });

        // `registered_by` es un id suelto (auditoría): los nombres se resuelven en una sola query.
        const registradores = [...new Set(pagos.map((p) => p.registered_by).filter(Boolean))] as string[];
        const nombres = new Map(
            (
                await prisma.user.findMany({
                    where: { id: { in: registradores } },
                    select: { id: true, name: true, last_name: true },
                })
            ).map((u) => [u.id, `${u.name} ${u.last_name}`]),
        );

        return res.json({
            success: true,
            pagos: pagos.map((p) => ({
                id: p.id,
                fecha: p.paid_at ?? p.created_at,
                monto: p.amount.toString(),
                forma_de_pago: p.method,
                estado: p.status,
                motivo_rechazo: p.mp_status_detail,
                registrado_por: p.registered_by ? (nombres.get(p.registered_by) ?? null) : null,
                booking_id: p.items.find((i) => i.payment.booking_id)?.payment.booking_id ?? null,
                cuotas: p.items.map((i) => ({
                    id: i.payment.id,
                    periodo: i.payment.period,
                    concepto: i.payment.concept,
                    nombre: i.payment.name,
                })),
                reembolsos: p.refunds.map((r) => ({
                    monto: r.amount.toString(),
                    fecha: r.refunded_at,
                    cuota_id: r.payment_id,
                })),
            })),
        });
    } catch (error) {
        console.error("Historial de pagos error:", error);
        return res.status(500).json({ error: "Error al obtener el historial de pagos" });
    }
});
