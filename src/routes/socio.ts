import { Router, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { authenticate, type AuthedRequest } from "../middleware/auth";
import { changePasswordSchema } from "../lib/validation";

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

async function readFormData(req: AuthedRequest) {
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
socioRouter.use(authenticate);

/**
 * GET /api/socio/files?id=... — sirve un archivo almacenado (ej: foto de perfil).
 */
socioRouter.get("/files", async (req: AuthedRequest, res: Response) => {
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
socioRouter.patch("/profile-image", async (req: AuthedRequest, res: Response) => {
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
socioRouter.patch("/password", async (req: AuthedRequest, res: Response) => {
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