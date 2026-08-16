import prisma from "./prisma";

/**
 * Devuelve el id de una tarifa con ese monto **para ese espacio**: reusa la que
 * ya esté en otro turno o reserva del mismo lugar, o crea una nueva con el
 * nombre del lugar.
 *
 * Compartido por schedules.ts (precio del turno) y bookings.ts (precio puntual
 * de una reserva, que puede diferir del turno). Antes vivía sólo en schedules.ts
 * y sólo miraba Schedule.fee; una reserva con precio especial no se reusaba
 * entre sí, así que cada override creaba una tarifa nueva.
 *
 * Va en el backend y no en el front: si no serían dos viajes (buscar y después
 * crear) con una carrera en el medio — dos admins cargando el mismo precio a la
 * vez terminarían con dos tarifas iguales.
 *
 * Acotado al espacio a propósito: buscando por monto solo, un turno de vóley a
 * 9000 podía terminar apuntando a "Cancha de fútbol 5 — 1 hora (2025)" (misma
 * plata, otro lugar) y el nombre quedaba sin sentido.
 */
export async function findOrCreateFeeForPlace(amount: number, placeId: number): Promise<number> {
  const place = await prisma.place.findUnique({
    where: { id: placeId },
    select: { name: true },
  });
  if (!place) throw Object.assign(new Error("place-not-found"), { code: "P2003" });

  const existente = await prisma.fee.findFirst({
    where: {
      amount,
      OR: [
        { schedules: { some: { place_id: placeId } } },
        { bookings: { some: { schedule: { place_id: placeId } } } },
      ],
    },
    orderBy: { created_at: "desc" },
    select: { id: true },
  });
  if (existente) return existente.id;

  const creada = await prisma.fee.create({
    data: {
      // Nombre derivado del lugar y el monto: nadie lo elige, tiene que ser predecible.
      name: `${place.name} — $${amount.toLocaleString("es-AR")}`,
      amount,
      description: "Creada automáticamente al cargar un horario o una reserva.",
    },
    select: { id: true },
  });
  return creada.id;
}
