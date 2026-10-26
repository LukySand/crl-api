import { z } from "zod";

export const INSTAGRAM_TOKEN_MIN_LENGTH = 20;
export const INSTAGRAM_TOKEN_MAX_LENGTH = 1_000;

export type NovedadKind = "p" | "reel" | "tv";

export interface NovedadRef {
  code: string;
  kind: NovedadKind;
}

const INSTAGRAM_URL = /^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]{5,50})(?:[/?#]|$)/;

/**
 * Saca el tipo y el shortcode de un link de Instagram. Ignora los parámetros de
 * seguimiento (`?srtk=…`, `?igsh=…`): dos links al mismo post dan el mismo `code`.
 */
export function parseInstagramUrl(raw: string): NovedadRef | null {
  const match = INSTAGRAM_URL.exec(raw.trim());
  if (!match) return null;
  return { kind: match[1] as NovedadKind, code: match[2]! };
}

export function permalink({ kind, code }: NovedadRef): string {
  return `https://www.instagram.com/${kind}/${code}/`;
}

/** URL del embed oficial con imagen y texto completos; se muestra sin token. */
export function embedUrl(ref: NovedadRef): string {
  return `${permalink(ref)}embed/captioned/`;
}

/** Muestra solo el final del token: alcanza para reconocerlo sin exponerlo. */
export function maskToken(token: string): string {
  return `••••${token.slice(-4)}`;
}

export const novedadLinkCreateSchema = z
  .object({
    url: z
      .string({ error: "El link es requerido" })
      .trim()
      .min(1, "El link es requerido")
      .refine((value) => parseInstagramUrl(value) !== null, {
        message: "Pegá el link de un post o reel de Instagram (instagram.com/p/… o /reel/…)",
      }),
    pinned: z.boolean({ error: "Fijado inválido" }).optional(),
  })
  .strict();

export const novedadLinkUpdateSchema = z
  .object({ pinned: z.boolean({ error: "Fijado inválido" }) })
  .strict();

export const novedadLinkOrderSchema = z
  .object({
    ids: z
      .array(z.number().int(), { error: "La lista de ids es requerida" })
      .min(1, "La lista de ids es requerida")
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "La lista de ids tiene repetidos",
      }),
  })
  .strict();

export const instagramTokenSchema = z
  .object({
    token: z
      .string({ error: "El token es requerido" })
      .trim()
      .min(INSTAGRAM_TOKEN_MIN_LENGTH, "El token es demasiado corto")
      .max(INSTAGRAM_TOKEN_MAX_LENGTH, "El token es demasiado largo")
      .regex(/^\S+$/, "El token no puede tener espacios"),
  })
  .strict();

export type NovedadMediaType = "imagen" | "video" | "album";

export interface NovedadItem {
  id: string;
  tipo: NovedadMediaType;
  imagen: string | null;
  permalink: string;
  caption: string;
  fecha: string;
}

/** Un elemento de `GET /me/media` de la Graph API, con los campos que pedimos. */
export interface GraphMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

const MEDIA_TYPES: Record<string, NovedadMediaType> = {
  IMAGE: "imagen",
  VIDEO: "video",
  CAROUSEL_ALBUM: "album",
};

/** Normaliza un post de la Graph API; descarta los que no tienen link o fecha. */
export function normalizeGraphMedia(media: GraphMedia): NovedadItem | null {
  if (!media.id || !media.permalink || !media.timestamp) return null;
  const tipo = MEDIA_TYPES[media.media_type ?? ""] ?? "imagen";
  // Un video trae en `media_url` el mp4: para mostrarlo como tarjeta se usa la miniatura.
  const imagen = (tipo === "video" ? media.thumbnail_url : media.media_url) ?? null;
  return {
    id: media.id,
    tipo,
    imagen,
    permalink: media.permalink,
    caption: media.caption ?? "",
    fecha: media.timestamp,
  };
}
