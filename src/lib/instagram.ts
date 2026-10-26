import prisma from "./prisma";
import { normalizeGraphMedia, type GraphMedia, type NovedadItem } from "./novedades";

const GRAPH_URL = "https://graph.instagram.com";
const MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
const MEDIA_LIMIT = 18;
const REQUEST_TIMEOUT_MS = 8_000;

/** Un post nuevo tarda como mucho esto en aparecer en la vitrina. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** El token dura 60 días y solo se puede renovar pasadas 24 h: se renueva al mes. */
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const INSTAGRAM_CONFIG_ID = 1;

let cache: { items: NovedadItem[]; at: number } | null = null;

/** Descarta lo cacheado: se llama cuando cambia o se borra el token. */
export function clearFeedCache() {
  cache = null;
}

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH_URL}${path}?${new URLSearchParams(params)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Instagram respondió ${response.status}`);
  return (await response.json()) as T;
}

/** ¿Instagram acepta este token? Se chequea antes de guardarlo. */
export async function isValidToken(token: string): Promise<boolean> {
  try {
    await graphGet("/me", { fields: "id", access_token: token });
    return true;
  } catch {
    return false;
  }
}

async function refreshToken(token: string): Promise<string> {
  const { access_token } = await graphGet<{ access_token: string }>("/refresh_access_token", {
    grant_type: "ig_refresh_token",
    access_token: token,
  });
  return access_token;
}

/** Renueva el token si lleva un mes sin tocarse. Si falla, sigue con el que tiene. */
async function ensureFreshToken(config: { access_token: string; token_updated_at: Date | null }) {
  const age = config.token_updated_at ? Date.now() - config.token_updated_at.getTime() : Infinity;
  if (age < REFRESH_AFTER_MS) return config.access_token;
  try {
    const fresh = await refreshToken(config.access_token);
    await prisma.instagramConfig.update({
      where: { id: INSTAGRAM_CONFIG_ID },
      data: { access_token: fresh, token_updated_at: new Date() },
    });
    return fresh;
  } catch (error) {
    console.error("Instagram token refresh error:", error);
    return config.access_token;
  }
}

/**
 * Últimos posts de la cuenta, del más nuevo al más viejo (así los devuelve Instagram).
 * Cacheados: si Instagram falla pero hay cache, devuelve lo último que se pudo traer.
 */
export async function getFeed(config: {
  access_token: string;
  token_updated_at: Date | null;
}): Promise<NovedadItem[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;
  try {
    const token = await ensureFreshToken(config);
    const { data } = await graphGet<{ data: GraphMedia[] }>("/me/media", {
      fields: MEDIA_FIELDS,
      limit: String(MEDIA_LIMIT),
      access_token: token,
    });
    const items = data.map(normalizeGraphMedia).filter((item): item is NovedadItem => !!item);
    cache = { items, at: Date.now() };
    return items;
  } catch (error) {
    if (cache) return cache.items;
    throw error;
  }
}
