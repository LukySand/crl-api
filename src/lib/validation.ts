// ponytail: duplicado a propósito con el otro repo (crl-web/crl-api) para validar
// del lado cliente y servidor. Si crece o se desincroniza seguido, extraer a un paquete.
import { z } from "zod";
import { isValidPhoneNumber } from "libphonenumber-js/min";

// ── Campos reutilizables ────────────────────────────────────────────────
const nombreDe = (campo: string) =>
  z
    .string()
    .min(1, `El ${campo} es requerido`)
    .max(50, `El ${campo} debe tener máximo 50 caracteres`)
    .regex(/^[\p{L}\s]+$/u, `El ${campo} solo puede contener letras y espacios`);

export const nameSchema = nombreDe("nombre");
export const lastNameSchema = nombreDe("apellido");

export const dniSchema = z
  .string()
  .regex(/^[0-9]{8,10}$/, "El DNI debe tener entre 8 y 10 dígitos (solo números)");

export const emailSchema = z
  .email({ pattern: z.regexes.unicodeEmail, error: "Email inválido" })
  .max(75, "El email debe tener máximo 75 caracteres");

export const celularSchema = z
  .string({ error: "El celular es requerido" })
  .refine((v) => isValidPhoneNumber(v), "El celular no es un número válido");

export const passwordSchema = z
  .string()
  .min(8, "La contraseña debe tener mínimo 8 caracteres")
  .max(50, "La contraseña debe tener máximo 50 caracteres")
  .refine((v) => v.trim().length > 0, "La contraseña no puede ser solo espacios");

export const birthDateSchema = z
  .string()
  .min(1, "La fecha de nacimiento es requerida")
  .refine(
    (date) => new Date(date) <= new Date(),
    "La fecha de nacimiento no puede ser futura",
  )
  .refine((date) => {
    const birth = new Date(date);
    const today = new Date();
    const age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    const d = today.getDate() - birth.getDate();
    return (m < 0 || (m === 0 && d < 0) ? age - 1 : age) >= 13;
  }, "Debes tener al menos 13 años para registrarte");

// ── Schemas compuestos ──────────────────────────────────────────────────
export const registerSchema = z.object({
  name: nameSchema,
  last_name: lastNameSchema,
  dni: dniSchema,
  email: emailSchema,
  celular: celularSchema,
  password: passwordSchema,
  birth_date: birthDateSchema,
});

export type RegisterData = z.infer<typeof registerSchema>;
