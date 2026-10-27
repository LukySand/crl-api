/**
 * Utilidades para tests de ruta: servidor efímero (puerto 0, sin dependencias nuevas)
 * y usuarios con token real.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import prisma from "../lib/prisma";
import { sessionPayload, signToken } from "../lib/auth";
import { RoleType } from "../../prisma/generated/client";

let server: http.Server | null = null;
let base = "";

/** Levanta el API en un puerto libre. Idempotente: un solo servidor por corrida. */
export async function startTestServer(): Promise<string> {
  if (server) return base;
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return base;
}

export async function stopTestServer() {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  base = "";
}

/** `api("GET", "/api/admin/users", { token })` */
export async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

/** Los roles tienen que existir antes que cualquier usuario. Idempotente. */
export async function ensureRoles(): Promise<Map<string, number>> {
  for (const name of Object.values(RoleType)) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
  const rows = await prisma.role.findMany();
  return new Map(rows.map((r) => [r.name, r.id]));
}

let contador = 0;

/** Crea un usuario con los roles dados y un token firmado con `signToken` real. */
export async function makeUser(opts: { roles: (keyof typeof RoleType)[]; name?: string }) {
  const ids = await ensureRoles();
  const n = ++contador;
  const user = await prisma.user.create({
    data: {
      name: opts.name ?? `Test${n}`,
      last_name: "Prueba",
      dni: String(30_000_000 + n),
      email: `test${n}.${Date.now()}@crl.test`,
      password: "no-se-usa",
      birth_date: new Date("1990-01-01T00:00:00Z"),
      roles: { create: opts.roles.map((r) => ({ role_id: ids.get(r)! })) },
    },
    include: { roles: { include: { role: true } } },
  });
  return { id: user.id, token: signToken(sessionPayload(user)) };
}
