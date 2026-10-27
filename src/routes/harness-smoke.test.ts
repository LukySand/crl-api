// Requiere la base de test: `bun run test:db` y luego `bun test src/routes`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { api, makeUser, startTestServer, stopTestServer } from "../test/harness";

beforeAll(startTestServer);
afterAll(stopTestServer);

test("sin token: 401", async () => {
  expect((await api("GET", "/api/admin/users")).status).toBe(401);
});

test("token de Administrador: 200", async () => {
  const admin = await makeUser({ roles: ["Administrador"] });
  expect((await api("GET", "/api/admin/users", { token: admin.token })).status).toBe(200);
});
