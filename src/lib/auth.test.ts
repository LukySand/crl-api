import { describe, expect, test } from "bun:test";

// Cada import lleva un query distinto para evaluar el módulo de nuevo.
async function importar(env: Record<string, string | undefined>, n: number) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try {
    return await import(`./auth?${n}`);
  } finally {
    process.env = prev;
  }
}

describe("JWT_SECRET", () => {
  test("producción sin JWT_SECRET: falla al importar", async () => {
    await expect(importar({ NODE_ENV: "production", JWT_SECRET: undefined }, 1)).rejects.toThrow(/JWT_SECRET/);
  });
  test("producción con JWT_SECRET: ok", async () => {
    await importar({ NODE_ENV: "production", JWT_SECRET: "x" }, 2);
  });
  test("test/dev sin JWT_SECRET: ok", async () => {
    await importar({ NODE_ENV: "test", JWT_SECRET: undefined }, 3);
  });
});
