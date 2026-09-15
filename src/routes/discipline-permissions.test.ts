/**
 * ponytail: se testea `isAdmin`, no los handlers (pedirían Express + MySQL).
 * Está acá porque los dos chequeos de permisos en disciplines.ts (`/:id/full` y
 * `denyScheduleEdit`) comparaban el rol contra el string "Administrador" y
 * dejaban afuera a SuperAdmin, que no podía editar los horarios de una clase.
 * Si alguien vuelve a sacar SuperAdmin de ADMIN_ROLES, esto falla.
 */
import { expect, test } from "bun:test";
import type { Request } from "express";
import { isAdmin } from "../lib/auth";

const req = (role?: string) =>
  ({ user: role ? { id: "u1", role } : undefined }) as unknown as Request;

test("los dos roles de gestión son admin", () => {
  expect(isAdmin(req("SuperAdmin"))).toBe(true);
  expect(isAdmin(req("Administrador"))).toBe(true);
});

test("profesor, socio y anónimo no son admin", () => {
  expect(isAdmin(req("Profesor"))).toBe(false);
  expect(isAdmin(req("Socio"))).toBe(false);
  expect(isAdmin(req())).toBe(false);
});
