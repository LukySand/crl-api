import { expect, test } from "bun:test";
import { z } from "zod";

const setChildPhotoSchema = z.object({
  file_id: z.string().min(1, "file_id es requerido"),
});

test("setChildPhotoSchema exige file_id no vacío", () => {
  expect(setChildPhotoSchema.safeParse({ file_id: "f0000000-0000-4000-8000-000000000001" }).success).toBe(
    true,
  );
  expect(setChildPhotoSchema.safeParse({ file_id: "" }).success).toBe(false);
  expect(setChildPhotoSchema.safeParse({}).success).toBe(false);
});

const placeholderEmail = (dni: string) => `menor.${dni}@sin-email.crl-api.local`;

test("placeholderEmail es determinístico por DNI y no colisiona entre hermanos", () => {
  expect(placeholderEmail("55880231")).toBe("menor.55880231@sin-email.crl-api.local");
  expect(placeholderEmail("55880231")).not.toBe(placeholderEmail("56120789"));
});
