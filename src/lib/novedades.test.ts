import { expect, test } from "bun:test";
import {
  embedUrl,
  instagramTokenSchema,
  maskToken,
  normalizeGraphMedia,
  novedadLinkCreateSchema,
  novedadLinkOrderSchema,
  parseInstagramUrl,
  permalink,
} from "./novedades";

test("saca el código y el tipo ignorando los parámetros de seguimiento", () => {
  expect(
    parseInstagramUrl("https://www.instagram.com/p/DaDYdUDRm2H/?mdxt=MzRlODBiNWFlZA==&srtk=MzRl"),
  ).toEqual({ kind: "p", code: "DaDYdUDRm2H" });
  expect(parseInstagramUrl("https://www.instagram.com/reel/DexlV10CYWc/?srtk=abc")).toEqual({
    kind: "reel",
    code: "DexlV10CYWc",
  });
  expect(parseInstagramUrl("  http://instagram.com/p/DJPjUj3yN-V  ")).toEqual({
    kind: "p",
    code: "DJPjUj3yN-V",
  });
});

test("rechaza links que no son de un post de Instagram", () => {
  expect(parseInstagramUrl("https://www.instagram.com/clubrecreativolibertador/")).toBeNull();
  expect(parseInstagramUrl("https://example.com/p/DaDYdUDRm2H/")).toBeNull();
  expect(parseInstagramUrl("https://www.instagram.com.evil.com/p/DaDYdUDRm2H/")).toBeNull();
  expect(parseInstagramUrl("no es un link")).toBeNull();
});

test("arma el permalink y el embed canónicos", () => {
  const ref = { kind: "reel", code: "DexlV10CYWc" } as const;
  expect(permalink(ref)).toBe("https://www.instagram.com/reel/DexlV10CYWc/");
  expect(embedUrl(ref)).toBe("https://www.instagram.com/reel/DexlV10CYWc/embed/captioned/");
});

test("el schema de alta valida el link y no acepta campos de más", () => {
  expect(novedadLinkCreateSchema.safeParse({ url: "https://www.instagram.com/p/DaDYdUDRm2H/" }).success).toBe(true);
  expect(novedadLinkCreateSchema.safeParse({ url: "https://example.com" }).success).toBe(false);
  expect(novedadLinkCreateSchema.safeParse({ url: "" }).success).toBe(false);
  expect(
    novedadLinkCreateSchema.safeParse({ url: "https://www.instagram.com/p/DaDYdUDRm2H/", code: "x" }).success,
  ).toBe(false);
});

test("el orden no admite ids repetidos ni listas vacías", () => {
  expect(novedadLinkOrderSchema.safeParse({ ids: [3, 1, 2] }).success).toBe(true);
  expect(novedadLinkOrderSchema.safeParse({ ids: [1, 1] }).success).toBe(false);
  expect(novedadLinkOrderSchema.safeParse({ ids: [] }).success).toBe(false);
});

test("recorta el token y rechaza los vacíos, cortos o con espacios", () => {
  const token = "IGAAabcdefghijklmnopqrstuvwxyz";
  expect(instagramTokenSchema.parse({ token: `  ${token}  ` })).toEqual({ token });
  expect(instagramTokenSchema.safeParse({ token: "corto" }).success).toBe(false);
  expect(instagramTokenSchema.safeParse({ token: "a".repeat(10) + " " + "b".repeat(10) }).success).toBe(false);
});

test("la máscara del token deja solo los últimos 4 caracteres", () => {
  expect(maskToken("IGAAabcdefghijklmnopqrstuvwxyz")).toBe("••••wxyz");
});

test("normaliza un post con imagen y usa la miniatura en los videos", () => {
  const base = { id: "1", permalink: "https://www.instagram.com/p/x/", timestamp: "2026-09-01T10:00:00+0000" };
  expect(
    normalizeGraphMedia({ ...base, media_type: "IMAGE", media_url: "img.jpg", caption: "Hola" }),
  ).toEqual({ id: "1", tipo: "imagen", imagen: "img.jpg", permalink: base.permalink, caption: "Hola", fecha: base.timestamp });
  expect(
    normalizeGraphMedia({ ...base, media_type: "VIDEO", media_url: "v.mp4", thumbnail_url: "thumb.jpg" })?.imagen,
  ).toBe("thumb.jpg");
  expect(normalizeGraphMedia({ ...base, media_type: "CAROUSEL_ALBUM", media_url: "a.jpg" })?.tipo).toBe("album");
});

test("descarta los posts sin link o sin fecha", () => {
  expect(normalizeGraphMedia({ id: "1", timestamp: "2026-09-01T10:00:00+0000" })).toBeNull();
  expect(normalizeGraphMedia({ id: "1", permalink: "https://www.instagram.com/p/x/" })).toBeNull();
});
