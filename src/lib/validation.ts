// ponytail: duplicado a propósito en el frontend (crl-web) para validar del lado cliente.
// Son 46 líneas; un paquete compartido para esto sería over-engineering. Si crece, extraer.
import { z } from "zod";

export const registerSchema = z.object({
    name: z.string()
        .min(1, "El nombre es requerido")
        .max(50, "El nombre debe tener máximo 50 caracteres")
        .regex(/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/, "El nombre solo puede contener letras y espacios"),

    last_name: z.string()
        .min(1, "El apellido es requerido")
        .max(50, "El apellido debe tener máximo 50 caracteres")
        .regex(/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/, "El apellido solo puede contener letras y espacios"),

    dni: z.string()
        .min(1, "El DNI es requerido")
        .max(20, "El DNI debe tener máximo 20 caracteres")
        .regex(/^[a-zA-Z0-9]+$/, "El DNI solo puede contener letras y números"),

    email: z.string()
        .min(1, "El email es requerido")
        .email("Email inválido")
        .max(75, "El email debe tener máximo 75 caracteres"),

    password: z.string()
        .min(8, "La contraseña debe tener mínimo 8 caracteres")
        .max(50, "La contraseña debe tener máximo 50 caracteres"),

    birth_date: z.string()
        .min(1, "La fecha de nacimiento es requerida")
        .refine((date) => {
            const birth = new Date(date);
            const today = new Date();
            return birth <= today;
        }, "La fecha de nacimiento no puede ser futura")
        .refine((date) => {
            const birth = new Date(date);
            const today = new Date();
            const age = today.getFullYear() - birth.getFullYear();
            const month = today.getMonth() - birth.getMonth();
            const day = today.getDate() - birth.getDate();
            const actualAge = month < 0 || (month === 0 && day < 0) ? age - 1 : age;
            return actualAge >= 13;
        }, "Debes tener al menos 13 años para registrarte"),
});

export type RegisterData = z.infer<typeof registerSchema>;
