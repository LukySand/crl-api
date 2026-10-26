import { expect, test } from "bun:test";
import {
  PARTNER_STORE_ADDRESS_MAX_LENGTH,
  PARTNER_STORE_DISCOUNT_MAX_LENGTH,
  PARTNER_STORE_NAME_MAX_LENGTH,
  partnerStoreCreateSchema,
  partnerStoreUpdateSchema,
} from "./partner-store";

const validStore = {
  name: "Librería Central",
  address: "San Martín 123",
  discount_description: "10% de descuento en efectivo",
};

test("recorta los tres textos antes de persistirlos", () => {
  expect(
    partnerStoreCreateSchema.parse({
      name: "  Librería Central  ",
      address: "  San Martín 123  ",
      discount_description: "  10% de descuento en efectivo  ",
    }),
  ).toEqual(validStore);
});

test("rechaza textos vacíos después del trim", () => {
  expect(partnerStoreCreateSchema.safeParse({ ...validStore, name: "   " }).success).toBe(false);
  expect(partnerStoreCreateSchema.safeParse({ ...validStore, address: "   " }).success).toBe(false);
  expect(
    partnerStoreCreateSchema.safeParse({ ...validStore, discount_description: "   " }).success,
  ).toBe(false);
});

test("respeta los máximos de persistencia y producto", () => {
  expect(
    partnerStoreCreateSchema.safeParse({
      ...validStore,
      name: "n".repeat(PARTNER_STORE_NAME_MAX_LENGTH + 1),
    }).success,
  ).toBe(false);
  expect(
    partnerStoreCreateSchema.safeParse({
      ...validStore,
      address: "a".repeat(PARTNER_STORE_ADDRESS_MAX_LENGTH + 1),
    }).success,
  ).toBe(false);
  expect(
    partnerStoreCreateSchema.safeParse({
      ...validStore,
      discount_description: "d".repeat(PARTNER_STORE_DISCOUNT_MAX_LENGTH + 1),
    }).success,
  ).toBe(false);
});

test("PATCH acepta sólo campos de texto y nunca active", () => {
  expect(partnerStoreUpdateSchema.parse({ name: "  Nuevo nombre  " })).toEqual({
    name: "Nuevo nombre",
  });
  expect(partnerStoreUpdateSchema.safeParse({ active: false }).success).toBe(false);
});
