import { z } from "zod";

export const PARTNER_STORE_NAME_MAX_LENGTH = 100;
export const PARTNER_STORE_ADDRESS_MAX_LENGTH = 255;
export const PARTNER_STORE_DISCOUNT_MAX_LENGTH = 5_000;

export const partnerStoreCreateSchema = z
  .object({
    name: z
      .string({ error: "El nombre es requerido" })
      .trim()
      .min(1, "El nombre es requerido")
      .max(
        PARTNER_STORE_NAME_MAX_LENGTH,
        `El nombre debe tener máximo ${PARTNER_STORE_NAME_MAX_LENGTH} caracteres`,
      ),
    address: z
      .string({ error: "La dirección es requerida" })
      .trim()
      .min(1, "La dirección es requerida")
      .max(
        PARTNER_STORE_ADDRESS_MAX_LENGTH,
        `La dirección debe tener máximo ${PARTNER_STORE_ADDRESS_MAX_LENGTH} caracteres`,
      ),
    discount_description: z
      .string({ error: "La descripción del descuento es requerida" })
      .trim()
      .min(1, "La descripción del descuento es requerida")
      .max(
        PARTNER_STORE_DISCOUNT_MAX_LENGTH,
        `La descripción del descuento debe tener máximo ${PARTNER_STORE_DISCOUNT_MAX_LENGTH} caracteres`,
      ),
  })
  .strict("Solo se pueden enviar campos del local adherido");

// `active` queda deliberadamente afuera: el estado sólo cambia en los endpoints
// de baja y reactivación, nunca como efecto lateral de una edición de texto.
export const partnerStoreUpdateSchema = partnerStoreCreateSchema.partial();
