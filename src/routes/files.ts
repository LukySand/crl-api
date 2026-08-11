import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { Storage } from "../lib/storage";

const fileIdSchema = z.object({
    fileId: z
        .string({ error: "Missing or invalid file id" })
        .regex(/^[0-9]+$/, "Missing or invalid file id")
        .transform(Number),
});

const uploadSchema = z.object({
    file: z.instanceof(File, { message: "Missing file" }),
    kind: z.string({ error: "Missing kind" }).min(1, "Missing kind"),
    name: z.string({ error: "Missing name" }).min(1, "Missing name"),
    user_id: z
        .string({ error: "Missing or invalid user id" })
        .regex(/^[0-9]+$/, "Missing or invalid user id")
        .transform(Number),
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

// Uncomment to test.
filesRouter.put("/", async (req: Request, res: Response) => {
    const form = await readFormData(req);

    const validationResult = uploadSchema.safeParse({
        file: form.get("file"),
        kind: form.get("kind"),
        name: form.get("name"),
        user_id: form.get("user_id"),
    });

    if (!validationResult.success) {
        return res.status(400).json({
            error: "Validación fallida",
            errors: formatValidationErrors(validationResult.error.issues),
        });
    }

    const { file, kind, name, user_id } = validationResult.data;

    try {
        const result = await Storage.create({
            file,
            kind: kind as Storage.FileKind,
            name,
            userId: user_id,
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

filesRouter.delete("/", async (req: Request, res: Response) => {
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