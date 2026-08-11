import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { Storage } from "../lib/storage";
import { requireAuth, requireAdmin } from "../lib/auth";

// File.id es UUID (String), igual que User.id. Antes esto validaba /^[0-9]+$/ y
// transformaba a Number: quedó de cuando los ids eran int autoincremental y no
// matcheaba ningún archivo real.
const fileIdSchema = z.object({
    fileId: z.uuid({ error: "Missing or invalid file id" }),
});

const uploadSchema = z.object({
    file: z.instanceof(File, { message: "Missing file" }),
    kind: z.string({ error: "Missing kind" }).min(1, "Missing kind"),
    name: z.string({ error: "Missing name" }).min(1, "Missing name"),
});

function formatValidationErrors(issues: z.ZodIssue[]) {
    const errors: Record<string, string> = {};
    issues.forEach((issue) => {
        const key = issue.path[0] as string;
        errors[key] = issue.message;
    });
    return errors;
}

function getFirstQueryValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

async function readFormData(req: Request) {
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

export const filesRouter = Router();

/** GET /api/files?id=<uuid> — descarga. Público: las imágenes se muestran en la app. */
filesRouter.get("/", async (req: Request, res: Response) => {
    const validationResult = fileIdSchema.safeParse({
        fileId: getFirstQueryValue(req.query.id),
    });

    if (!validationResult.success) {
        return res.status(400).json({
            error: "Validación fallida",
            errors: formatValidationErrors(validationResult.error.issues),
        });
    }

    const fileId = validationResult.data.fileId;

    const ifNoneMatch = req.headers["if-none-match"] ?? undefined;
    const file = await Storage.getFile(fileId, ifNoneMatch);
    if (!file) {
        return res.status(404).json({ error: "File not found" });
    }

    if (file === "not-modified") {
        return res.status(304).end();
    }

    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Length", file.size.toString());
    res.setHeader("Cache-Control", "public, max-age=86400, must-revalidate");
    res.setHeader("Etag", file.etag);
    res.setHeader("Last-Modified", file.lastModified.toUTCString());

    return Readable.fromWeb(file.stream).pipe(res);
});

/**
 * PUT /api/files — sube (o reemplaza) un archivo. Exige sesión.
 *
 * El dueño sale del token, no del form: antes venía como `user_id` en el
 * FormData, así que cualquiera podía subir archivos a nombre de otro (y sin
 * estar logueado, porque la ruta no pedía sesión).
 */
filesRouter.put("/", requireAuth, async (req: Request, res: Response) => {
    const form = await readFormData(req);

    const validationResult = uploadSchema.safeParse({
        file: form.get("file"),
        kind: form.get("kind"),
        name: form.get("name"),
    });

    if (!validationResult.success) {
        return res.status(400).json({
            error: "Validación fallida",
            errors: formatValidationErrors(validationResult.error.issues),
        });
    }

    const { file, kind, name } = validationResult.data;

    try {
        const result = await Storage.create({
            file,
            kind: kind as Storage.FileKind,
            name,
            userId: req.user!.id,
        });
        return res.status(200).json({ fileId: result });
    } catch (err) {
        console.error("Error creating file.", {
            error: err,
            cause: (err as Error).cause,
        });
        return res.status(400).json({ error: (err as Error).message });
    }
});

/** DELETE /api/files?fileId=<uuid> — solo gestión: borra el archivo del disco y la DB. */
filesRouter.delete("/", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const validationResult = fileIdSchema.safeParse({
        fileId: getFirstQueryValue(req.query.fileId),
    });

    if (!validationResult.success) {
        return res.status(400).json({
            error: "Validación fallida",
            errors: formatValidationErrors(validationResult.error.issues),
        });
    }

    const fileId = validationResult.data.fileId;

    try {
        await Storage.remove(fileId);
        return res.status(200).json({ deleted: true });
    } catch (err) {
        console.error(err);
        return res.status(400).json({
            deleted: false,
            error: (err as Error).message,
        });
    }
});
