import { expect, test } from "bun:test";
import {
  APORTE_IDS,
  TIPOS_DE_APORTE,
  denyBaja,
  denyEdicion,
  denyReactivar,
  denyRevision,
  sponsorApplicationSchema,
  sponsorContactoSchema,
  sponsorReviewSchema,
  statusFiltro,
  tituloDeAporte,
} from "./sponsor";

const valida = {
  business_name: "Panadería del Centro",
  contact_name: "Laura Benítez",
  email: "laura@panaderia.test",
  phone: "+5493434112233",
  sector: "Gastronomía",
  contribution: "especie",
  message: "Queremos acompañar al club con la merienda de los chicos.",
};

test("la postulación válida pasa", () => {
  const parsed = sponsorApplicationSchema.parse(valida);
  expect(parsed.business_name).toBe("Panadería del Centro");
  expect(parsed.contribution).toBe("especie");
});

test("se puede postular una persona, sin CUIT ni razón social", () => {
  // El formulario no pide identidad fiscal: alguien del pueblo se ofrece con su
  // nombre y listo. Si esto se rompe, volvimos a dejar afuera a las personas.
  const persona = {
    ...valida,
    business_name: "Mariana Sosa",
    contact_name: "Mariana Sosa",
    sector: "Particular",
    contribution: "cuota",
  };
  expect(sponsorApplicationSchema.safeParse(persona).success).toBe(true);
  // Y mandar un CUIT de más tampoco pasa: el campo ya no existe.
  expect(
    sponsorApplicationSchema.safeParse({ ...persona, cuit: "30712345671" }).success,
  ).toBe(false);
});

test("faltar un campo o mandar uno de más no pasa", () => {
  expect(sponsorApplicationSchema.safeParse({ ...valida, message: "  " }).success).toBe(false);
  expect(sponsorApplicationSchema.safeParse({ ...valida, email: "no-es-mail" }).success).toBe(false);
  // `status` no se manda: lo pone el backend. Si entrara, cualquiera se autoaprueba.
  expect(sponsorApplicationSchema.safeParse({ ...valida, status: "Aprobada" }).success).toBe(false);
});

test("el tipo de aporte tiene que ser una de las opciones", () => {
  for (const id of APORTE_IDS) {
    expect(sponsorApplicationSchema.safeParse({ ...valida, contribution: id }).success).toBe(true);
  }
  // Texto libre inventado, no. Para eso está el mensaje.
  expect(
    sponsorApplicationSchema.safeParse({ ...valida, contribution: "lo que sea" }).success,
  ).toBe(false);
  expect(sponsorApplicationSchema.safeParse({ ...valida, contribution: "" }).success).toBe(false);
});

test("ninguna opción de aporte lleva monto, y dos están a confirmar", () => {
  // Un número en pesos escrito acá envejece solo con la inflación. Si alguien
  // mete uno, este test lo frena.
  for (const t of TIPOS_DE_APORTE) {
    expect(`${t.titulo} ${t.detalle}`).not.toMatch(/\$|\bpesos\b/i);
  }
  const aConfirmar = TIPOS_DE_APORTE.filter((t) => t.aConfirmar).map((t) => t.id);
  expect(aConfirmar).toEqual(["cuota", "temporada"]);
});

test("una postulación vieja sigue siendo legible si cambia la lista", () => {
  expect(tituloDeAporte("equipo")).toBe("Equipar un equipo");
  expect(tituloDeAporte("una-opcion-que-ya-no-existe")).toBe("una-opcion-que-ya-no-existe");
});

test("rechazar exige motivo; aprobar no", () => {
  expect(sponsorReviewSchema.safeParse({ action: "aprobar" }).success).toBe(true);
  expect(sponsorReviewSchema.safeParse({ action: "rechazar" }).success).toBe(false);
  expect(
    sponsorReviewSchema.safeParse({ action: "rechazar", rejection_reason: "Rubro no compatible" })
      .success,
  ).toBe(true);
});

test("una postulación ya resuelta no se vuelve a tocar", () => {
  expect(denyRevision("Pendiente")).toBeNull();
  expect(denyRevision("Aprobada")).not.toBeNull();
  expect(denyRevision("Rechazada")).not.toBeNull();
});

test("sólo se da de baja un auspicio vigente", () => {
  expect(denyBaja("Aprobada")).toBeNull();
  expect(denyBaja("Finalizada")).not.toBeNull();
  expect(denyBaja("Pendiente")).not.toBeNull();
  // Rechazar y dar de baja no son lo mismo: la rechazada nunca fue sponsor.
  expect(denyBaja("Rechazada")).not.toBeNull();
});

test("sólo se reactiva un auspicio finalizado, y se puede ir y volver", () => {
  expect(denyReactivar("Finalizada")).toBeNull();
  expect(denyReactivar("Aprobada")).not.toBeNull();
  expect(denyReactivar("Pendiente")).not.toBeNull();
  expect(denyReactivar("Rechazada")).not.toBeNull();
  // Aprobada → Finalizada → Aprobada: el sponsor de la temporada pasada vuelve.
  expect(denyBaja("Aprobada")).toBeNull();
  expect(denyReactivar("Finalizada")).toBeNull();
});

test("dar de baja no reabre la decisión de aprobar o rechazar", () => {
  // `denyRevision` sigue cerrando todo lo que no esté Pendiente, Finalizada
  // incluida: una finalizada se reactiva, no se vuelve a aprobar.
  expect(denyRevision("Finalizada")).not.toBeNull();
});

test("los datos se corrigen sólo mientras está pendiente", () => {
  expect(denyEdicion("Pendiente")).toBeNull();
  // Una resuelta es el registro de lo que se decidió sobre ESOS datos: cambiarlos
  // después deja la decisión colgada de información que ya no es la que se miró.
  for (const s of ["Aprobada", "Rechazada", "Finalizada"] as const) {
    expect(denyEdicion(s)).not.toBeNull();
  }
});

test("la gestión sólo corrige contacto, no la propuesta", () => {
  const contacto = {
    contact_name: "Laura Benítez",
    email: "laura@panaderia.test",
    phone: "+5493434112233",
  };
  expect(sponsorContactoSchema.safeParse(contacto).success).toBe(true);
  // El rubro, el aporte y el mensaje son lo que la persona propuso: no entran.
  for (const extra of ["sector", "contribution", "message", "business_name"]) {
    expect(sponsorContactoSchema.safeParse({ ...contacto, [extra]: "x" }).success).toBe(false);
  }
  expect(sponsorContactoSchema.safeParse({ ...contacto, email: "mal" }).success).toBe(false);
});

test("el filtro por estado ignora cualquier cosa", () => {
  expect(statusFiltro("Aprobada")).toBe("Aprobada");
  expect(statusFiltro("Finalizada")).toBe("Finalizada");
  expect(statusFiltro("aprobada")).toBeNull();
  expect(statusFiltro(undefined)).toBeNull();
  expect(statusFiltro(["Aprobada"])).toBeNull();
});
