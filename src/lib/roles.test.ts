import { expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import {
  denyCambioDeRoles,
  nombresDeRoles,
  ordenarRoles,
  rolesParaGuardar,
  rolPrincipal,
  tieneRol,
  validarRoles,
} from "./roles";
import { readToken, sessionPayload, signToken } from "./auth";

const conFilas = (...nombres: string[]) => nombres.map((name) => ({ role: { name } }));

test("los roles se ordenan de más a menos acceso y sin repetidos", () => {
  expect(ordenarRoles(["Socio", "Profesor", "Socio"])).toEqual(["Profesor", "Socio"]);
  expect(rolPrincipal(["Socio", "Administrador"])).toBe("Administrador");
});

test("sin filas en UserRole cae al role_id viejo", () => {
  expect(nombresDeRoles({ role: { name: "Profesor" }, roles: [] })).toEqual(["Profesor"]);
  // Con filas manda la tabla nueva, aunque role_id diga otra cosa.
  expect(
    nombresDeRoles({ role: { name: "Profesor" }, roles: conFilas("Socio", "Profesor") }),
  ).toEqual(["Profesor", "Socio"]);
});

test("los permisos se suman: alcanza con tener uno de los roles", () => {
  expect(tieneRol(["Profesor", "Socio"], "Socio")).toBe(true);
  expect(tieneRol(["Profesor", "Socio"], "SuperAdmin", "Administrador")).toBe(false);
});

test("validarRoles: al menos uno, y SuperAdmin con Administrador no", () => {
  expect(validarRoles([])).not.toBeNull();
  expect(validarRoles(["SuperAdmin", "Administrador"])).not.toBeNull();
  expect(validarRoles(["SuperAdmin", "Socio"])).toBeNull();
  expect(validarRoles(["Administrador", "Profesor", "Socio"])).toBeNull();
});

const base = { actorId: "ana", targetId: "otro", actorRoles: ["Administrador"] };

test("un Administrador no toca cuentas SuperAdmin, ni para dar ni para sacar", () => {
  expect(denyCambioDeRoles({ ...base, antes: ["Socio"], despues: ["SuperAdmin"] })?.status).toBe(403);
  expect(denyCambioDeRoles({ ...base, antes: ["SuperAdmin"], despues: ["Socio"] })?.status).toBe(403);
  expect(
    denyCambioDeRoles({ ...base, actorRoles: ["SuperAdmin"], antes: ["Socio"], despues: ["SuperAdmin"] }),
  ).toBeNull();
});

test("nadie se saca a sí mismo el rol de gestión, pero otro admin sí puede", () => {
  const propio = { ...base, targetId: "ana" };
  expect(
    denyCambioDeRoles({ ...propio, antes: ["Administrador"], despues: ["Socio"] })?.status,
  ).toBe(400);
  // Sumarse Socio siendo admin está bien.
  expect(
    denyCambioDeRoles({ ...propio, antes: ["Administrador"], despues: ["Administrador", "Socio"] }),
  ).toBeNull();
  // Un SuperAdmin que se pasa a Administrador sigue siendo gestión.
  expect(
    denyCambioDeRoles({
      ...propio,
      actorRoles: ["SuperAdmin"],
      antes: ["SuperAdmin"],
      despues: ["Administrador"],
    }),
  ).toBeNull();
  expect(denyCambioDeRoles({ ...base, antes: ["Administrador"], despues: ["Socio"] })).toBeNull();
});

test("front viejo (un solo `role`): guardar sin tocar el select no borra los otros roles", () => {
  const antes = ["Profesor", "Socio"];
  expect(rolesParaGuardar({ pedidos: ["Profesor"], antes, vinoRolSuelto: true })).toEqual(antes);
  // Cambió el select: se reemplaza.
  expect(rolesParaGuardar({ pedidos: ["Socio"], antes, vinoRolSuelto: true })).toEqual(["Socio"]);
  // Con la lista nueva manda siempre lo pedido, aunque sea sólo el principal.
  expect(rolesParaGuardar({ pedidos: ["Profesor"], antes, vinoRolSuelto: false })).toEqual(["Profesor"]);
});

const reqCon = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as Request;

test("el token lleva todos los roles y el principal por compatibilidad", () => {
  const payload = sessionPayload({
    id: "u1",
    dni: "33907461",
    email: "carolina@crl.test",
    name: "Carolina",
    last_name: "Ojeda",
    file_id: null,
    role: { name: "Profesor" },
    roles: conFilas("Socio", "Profesor"),
  });
  expect(payload.roles).toEqual(["Profesor", "Socio"]);
  expect(payload.role).toBe("Profesor");
  expect(readToken(reqCon(signToken(payload)))?.roles).toEqual(["Profesor", "Socio"]);
});

test("un token emitido antes de los varios roles (sólo `role`) sigue autorizando", () => {
  const secreto = process.env.JWT_SECRET || "your-secret-key-change-in-production";
  const viejo = jwt.sign({ id: "u1", role: "Administrador" }, secreto);
  expect(readToken(reqCon(viejo))?.roles).toEqual(["Administrador"]);
});
