import { Router, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Storage } from "../lib/storage";
import { authenticate, type AuthedRequest } from "../middleware/auth";

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

export const socioRouter = Router();

// Todo /api/socio requiere sesión.
socioRouter.use(authenticate);


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
                name: file.name,
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

        if (current.file_id) {
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