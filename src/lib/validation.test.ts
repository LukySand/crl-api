import { expect, test } from "bun:test";
import {
  addChildSchema,
  changePasswordSchema,
  childBirthDateSchema,
  registerSchema,
  setChildCredentialsSchema,
} from "./validation";

/**
 * YYYY-MM-DD de alguien que cumplió (o cumple) `years` años, corrido
 * `offsetDays` días. `offsetDays` negativo = en el pasado respecto de esa
 * fecha (ya cumplió), positivo = todavía no (le falta).
 */
function birthDateYearsAgo(years: number, offsetDays = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const validChild = () => ({
  name: "Tomás",
  last_name: "Aguirre",
  dni: "55880231",
  birth_date: birthDateYearsAgo(13),
});

test("childBirthDateSchema rechaza fecha futura", () => {
  expect(childBirthDateSchema.safeParse(birthDateYearsAgo(0, 1)).success).toBe(false);
});

test("childBirthDateSchema rechaza vacío", () => {
  expect(childBirthDateSchema.safeParse("").success).toBe(false);
});

test("childBirthDateSchema acepta un recién nacido", () => {
  expect(childBirthDateSchema.safeParse(birthDateYearsAgo(0)).success).toBe(true);
});

// Margen de unos días alrededor del corte de 18 años (no exactamente 1 día):
// childBirthDateSchema usa getters locales sobre una fecha parseada como UTC,
// así que el límite exacto puede correrse un día según el huso del que corre
// el test. No es parte de lo que se está probando acá.
test("childBirthDateSchema acepta a alguien que todavía no cumplió 18", () => {
  expect(childBirthDateSchema.safeParse(birthDateYearsAgo(18, 3)).success).toBe(true);
});

test("childBirthDateSchema rechaza a alguien que ya cumplió 18", () => {
  expect(childBirthDateSchema.safeParse(birthDateYearsAgo(18, -3)).success).toBe(false);
});

test("addChildSchema acepta el alta mínima, sin file_id", () => {
  const r = addChildSchema.safeParse(validChild());
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.file_id).toBeUndefined();
});

test("addChildSchema acepta file_id opcional", () => {
  const r = addChildSchema.safeParse({
    ...validChild(),
    file_id: "f0000000-0000-4000-8000-000000000001",
  });
  expect(r.success).toBe(true);
});

// Si el registro aceptara file_id, cualquiera podría registrarse apuntando a la
// foto de otro socio y, al cambiar "la suya", borrársela.
test("registerSchema descarta un file_id aunque lo manden", () => {
  const r = registerSchema.safeParse({
    name: "Martín",
    last_name: "Aguirre",
    dni: "35112908",
    email: "martin@ejemplo.com",
    celular: "+5493764100004",
    password: "Password123",
    birth_date: birthDateYearsAgo(30),
    file_id: "f0000000-0000-4000-8000-000000000001",
  });
  expect(r.success).toBe(true);
  if (r.success) expect("file_id" in r.data).toBe(false);
});

test("addChildSchema rechaza un hijo de 18 años o más", () => {
  const r = addChildSchema.safeParse({ ...validChild(), birth_date: birthDateYearsAgo(20) });
  expect(r.success).toBe(false);
});

test("addChildSchema rechaza DNI con letras", () => {
  const r = addChildSchema.safeParse({ ...validChild(), dni: "abc12345" });
  expect(r.success).toBe(false);
});

test("addChildSchema rechaza nombre con números", () => {
  const r = addChildSchema.safeParse({ ...validChild(), name: "Tomas2" });
  expect(r.success).toBe(false);
});

test("setChildCredentialsSchema exige email válido", () => {
  const r = setChildCredentialsSchema.safeParse({
    email: "no-es-un-email",
    password: "unaClaveSegura123",
  });
  expect(r.success).toBe(false);
});

test("setChildCredentialsSchema exige password de al menos 8 caracteres", () => {
  expect(
    setChildCredentialsSchema.safeParse({ email: "tomas@crl.test", password: "corta" }).success,
  ).toBe(false);
  expect(
    setChildCredentialsSchema.safeParse({ email: "tomas@crl.test", password: "unaClaveSegura123" })
      .success,
  ).toBe(true);
});

test("changePasswordSchema exige current_password no vacía", () => {
  expect(
    changePasswordSchema.safeParse({ current_password: "", new_password: "unaClaveNueva123" })
      .success,
  ).toBe(false);
});

test("changePasswordSchema acepta el cambio con ambas contraseñas válidas", () => {
  expect(
    changePasswordSchema.safeParse({
      current_password: "laDeAntes123",
      new_password: "unaClaveNueva123",
    }).success,
  ).toBe(true);
});

test("changePasswordSchema: la contraseña nueva no puede ser solo espacios", () => {
  expect(
    changePasswordSchema.safeParse({ current_password: "laDeAntes123", new_password: "        " })
      .success,
  ).toBe(false);
});
