import { logger } from "./logger";
import prisma from "./prisma";
import * as ft from "file-type";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import * as web from "node:stream/web";
import { Prisma } from "../../prisma/generated/client";

/**
 * Provides methods to read and write static and persistent files. Saved files are always described in the database
 * table called "files".
 *
 * ## Usage
 * ### Create a file
 * To create a file, call the `create` method and pass the required parameter, which is a `CreateFileArgs` object,
 * whose properties are documented in its definition.
 * If suceeds, it returns the id of the file which is used to download it later. You can create a download url
 * for the file using the `process.env.URL` endpoint + `/api/files?id=[the file id]`. For example:
 * ```typescript
 * const fileId = await Storage.create({});
 * const downloadUrl = `${process.env.URL}/api/files?id=${fileId}`
 * ```
 *
 * The creation of a file may fail, which leads into an exception of type Error which may contain one of the following
 * error codes:
 * - **file-type-notfound** if the type of the file could not be determined (danger!!!!!!!!!!!!!!!!!!!!)
 * - **invalid-image-type** if the file type is not allowed. See `ALL_AVAILABLE_MIME_TYPES`.
 * - **file-write-panic** if something happens while writing the file to the disk.
 * - **file-too-big** if file exceeds the maximum size allowed
 *
 * Example:
 * ```typescript
 * const fileId = await Storage.create({
 *    userId: 'a0000000-0000-4000-8000-000000000004',
 *    name: 'profilePicture',
 *    file: formData.get("file") as File,
 *    kind: 'profilePictures'
 * });
 * ```
 *
 * **NOTE:** Using the `create` method you can update an existing file, just passing the same `kind` and the same `name`. The update will
 * happen automatically.
 *
 * ### Delete a file
 * To delete a file, call the `remove` method passing the id of the file you want to delete.
 *
 * The deletion of a file may fail, which leads into an exception of type Error which may contain one of the following
 * error codes:
 * - **file-not-found** if the file is not found.
 * - **file-not-deleted** if the file could not be deleted from the disk.
 *
 * ### Get a file
 * **NOTE:** Normally you won't use this method, instead call the `api/files` endpoint.
 *
 * To get a file from the disk and obtain its information from the database, cal the `getFile` method, passing the id of the file
 * you want to get and optionally the `ifNoneMatch` property.
 * If the file exists, it will return information about the file in a `FileRead` type, which contains a `ReadableStream` used
 * to stream the file somewhere.
 *
 * If `ifNoneMatch` property is passed, it will check if the file has changed since that *etag*. If not, it will return a `"not-modified"` string.
 *
 * ## Implementation details
 * ### Root folder
 * Files are organized in subfolders of the root folder, which is defined using the `FILES_STORAGE_PATH` environment variable.
 * Available subfolders are defined in the `ALL_FILE_KINDS` array, modify it as needed.
 *
 * ### Maximum size
 * The maximum available size for files is controlled by the `MAX_FILE_SIZE` environment variable, which indicates
 * the maximum allowed size, in megabytes, that can be uploaded.
 *
 * ### Allowed file types
 * The allowed file types are described by the list of mime types in the `ALL_AVAILABLE_MIME_TYPES` array. Modify it as needed.
 * By default it allows images only.
 */
export namespace Storage {
  export type CreateFileArgs = {
    /**
     * The name of the file.
     * Ex: profilePicture
     */
    name: string;

    /**
     * The blob File obtained from the FormData.
     */
    file: File;

    /**
     * The kind of the file, a.k.a. subfolder.
     */
    kind: FileKind;
  };

  export type FileRead = {
    stream: ReadableStream;
    size: bigint;
    mime: string;
    lastModified: Date;
    etag: string;
  };

  /**
   * Represents a kind of file, which is known as subfolder too.
   */
  export type FileKind = FileKindTuple[number];

  const rootFolder = getRootFolder();
  const maxFileSize = getMaxFileSize() * 1e6; // to get size in bytes

  /**
   * All the file kinds, will be translated to directory names. Add necessary.
   */
  const ALL_FILE_KINDS = [
    "accountImages",
    "postImages",
    "localImages",
  ] as const;
  const ALL_AVAILABLE_MIME_TYPES: readonly string[] = [
    "image/jpeg",
    "image/png",
    "image/heif",
    "image/heic",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/avif",
  ] as const;
  type FileKindTuple = typeof ALL_FILE_KINDS;

  let ready = false;

  /**
   * Saves a file in the local storage. Returns the id of the file.
   * Throws an Error with the following codes:
   * - "file-type-notfound" if the type of the file could not be determined (danger!!!!!!!!!!!!!!!!!!!!)
   * - "invalid-image-type" if the file type is not allowed. See ALL_AVAILABLE_MIME_TYPES
   * - "file-write-panic" if something happens while writing the file to the disk.
   * - "file-too-big" if file exceeds the maximum size allowed
   */
  export async function create(arg: CreateFileArgs): Promise<string> {
    if (arg.file.size > maxFileSize) {
      throw new Error("file-too-big");
    }

    if (!ALL_FILE_KINDS.includes(arg.kind)) {
      throw new Error("invalid-filekind");
    }

    const rawStream = arg.file.stream();

    // verify file type (8 bytes are enough for common image formats)
    let fileType: ft.FileTypeResult | undefined;
    let fileTypeStream: ft.AnyWebReadableByteStreamWithFileType;
    try {
      fileTypeStream = await ft.fileTypeStream(rawStream, { sampleSize: 1024 });
      fileType = fileTypeStream.fileType;
    } catch (err) {
      throw new Error("stream-decode-error", { cause: err });
    }

    // verify if mime is detected
    if (fileType === undefined) {
      throw new Error("file-type-notfound");
    }

    console.log("[Storage.create] Detected file type:", fileType);

    // fileType = {
    //     ext: 'jpg',
    //     mime: 'image/jpeg'
    // }

    // verify if mime is available
    if (!ALL_AVAILABLE_MIME_TYPES.includes(fileType.mime)) {
      console.error("[Storage.create] Invalid mime type:", fileType.mime);
      console.error(
        "[Storage.create] Allowed mime types:",
        ALL_AVAILABLE_MIME_TYPES,
      );
      throw new Error("invalid-image-type");
    }

    // note: extension must not be saved in the path
    const savePath = path.join(
      rootFolder,
      arg.kind,
      `${arg.name}.${fileType.ext}`,
    );
    const saveDir = path.dirname(savePath);

    // Ensure the directory exists BEFORE starting the transaction
    try {
      await fs.mkdir(saveDir, { recursive: true });
      console.log("[Storage.create] Directory created/verified:", saveDir);
      console.log("[Storage.create] Target file path:", savePath);
    } catch (err) {
      console.error(
        "[Storage.create] Failed to create directory:",
        saveDir,
        err,
      );
      throw new Error("directory-creation-failed", { cause: err });
    }

    return await prisma
      .$transaction(async (txn) => {
        // check if file already exists in same path
        const existingFile = await txn.file.findFirst({
          where: { location: savePath },
          select: { id: true },
        });

        // create a writestream to the target file
        console.log("[Storage.create] Creating write stream for:", savePath);
        const writeStream = createWriteStream(savePath, {
          flags: "w",
          mode: 0o666,
          autoClose: true,
          flush: true,
        });

        try {
          // pipe file to local storage
          const readable = Readable.fromWeb(
            fileTypeStream as web.ReadableStream,
          );
          readable.pipe(writeStream);
          await finished(writeStream);
        } catch (err) {
          writeStream.destroy();
          throw new Error("file-write-panic", { cause: err });
        }

        let fileId: string;
        const now = new Date();

        if (existingFile) {
          fileId = String(existingFile.id);
          await txn.file.update({
            data: {
              size: arg.file.size,
              mime: fileType.mime,
              last_modified: now,
              etag: Math.floor(now.getTime() / 1000),
              optimized: false,
              raw_location: null,
              location: savePath,
            },
            where: { id: existingFile.id },
          });
        } else {
          // if writing file succeeds, write to db
          const createdFile = await txn.file.create({
            data: {
              name: `${arg.name}.${fileType.ext}`,
              location: savePath,
              created_at: now,
              last_modified: now,
              etag: Math.floor(now.getTime() / 1000),
              size: arg.file.size,
              mime: fileType.mime,
            },
          });
          fileId = String(createdFile.id);
        }

        return String(fileId);
      })
      .catch(async (err) => {
        // if insert to db fails, delete the file
        // ignore errors on delete file
        logger.error(err, "unable to create a file", {
          metadata: {
            file_ext: fileType.ext,
            file_mime: fileType.mime,
            kind: arg.kind,
            name: arg.name,
          },
        });
        await fs.rm(savePath, { force: true }).catch(() => {});
        throw new Error("db-insert-error", { cause: err });
      });
  }

  /**
   * Deletes a file by its id.
   * Throws an Error with the following codes:
   * - "file-not-found" if the file is not found.
   * - "file-not-deleted" if the file could not be deleted.
   */
  /**
   * Elimina un archivo de la base de datos y de la capa de almacenamiento.
   * Si el id no existe, finaliza de forma segura sin arrojar P2025.
   */
  export async function remove(fileId: string): Promise<void> {
    if (!fileId) return;

    try {
      // 1. Opcional: Si necesitas consultar los metadatos antes de borrar de disco
      const existingFile = await prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!existingFile) {
        // El archivo ya no existe en la base de datos
        return;
      }

      // 2. Transacción única para eliminar la referencia en BD
      await prisma.$transaction(async (txn) => {
        await txn.file.deleteMany({
          where: {
            id: fileId,
          },
        });
      });

      // 3. Eliminar el archivo físico del sistema de archivos si corresponde
      // if (existingFile.path && fs.existsSync(existingFile.path)) {
      //   await fs.promises.unlink(existingFile.path);
      // }
    } catch (error) {
      console.error(`Error al eliminar el archivo con ID ${fileId}:`, error);
      // Manejo adicional de errores si fuera necesario
    }
  }

  /**
   * Returns details about a file and a opened ReadStream to read the file.
   * Returns null if the file does not exist.
   * If ifNoneMatch is passed and the file has not changed since that value, 'not-modified' is returned.
   */
  export async function getFile(
    fileId: string,
    ifNoneMatch?: string,
  ): Promise<FileRead | null | "not-modified"> {
    const file = await prisma.file.findFirst({
      where: {
        id: String(fileId),
        ...(ifNoneMatch
          ? {
              AND: {
                etag: {
                  gt: Number.parseInt(ifNoneMatch),
                },
              },
            }
          : {}),
      },
      select: {
        location: true,
        size: true,
        mime: true,
        last_modified: true,
        etag: true,
      },
    });
    if (!file) {
      if (ifNoneMatch) {
        return "not-modified";
      }
      return null;
    }

    try {
      const fileStream = createReadStream(file.location);
      const stream = new ReadableStream({
        start(controller) {
          fileStream.on("data", (chunk) => controller.enqueue(chunk));
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (err) => controller.error(err));
        },
        cancel() {
          fileStream.destroy();
        },
      });
      return {
        stream: stream,
        size: file.size,
        mime: file.mime,
        lastModified: file.last_modified,
        etag: file.etag.toString(),
      };
    } catch (err) {
      logger.error(err, "unable to open readable stream for file.", {
        data: {
          fileId: fileId,
        },
      });
      return null;
    }
  }

  /**
   * Initializes the repository. Call only once at startup.
   */
  export async function init(): Promise<void> {
    if (ready) {
      return;
    }

    console.log("Using root folder:", rootFolder);
    console.log(`Using max file size: ${maxFileSize / 1e6} mb.`);

    for (const fileKind of ALL_FILE_KINDS) {
      await fs.mkdir(path.join(rootFolder, fileKind), { recursive: true });
      // await fs.mkdir(path.join(rootFolder, fileKind))
      console.log(`Folder "${fileKind}" created.`);
    }

    ready = true;
  }

  function getRootFolder(): string {
    let p = process.env.FILES_STORAGE_PATH;
    if (!p || p.trim() === "" || p === ":temp:") {
      p = path.join(os.tmpdir(), "crltemp");
    }

    return p;
  }

  function getMaxFileSize(): number {
    const env = process.env.MAX_FILE_SIZE as string | undefined;
    if (!env) return 10;

    const number = Number.parseInt(env);
    if (!number || Number.isNaN(number)) return 10;

    return number;
  }
}
