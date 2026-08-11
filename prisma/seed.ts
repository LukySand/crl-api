import { PrismaClient, RoleType } from "./generated/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

// ponytail: se conecta por DATABASE_URL (127.0.0.1) y no armando el host a mano.
// Con DB_HOST=localhost, en Mac Bun resuelve a IPv6 y el adapter se cuelga 10s.
const adapter = new PrismaMariaDb(process.env.DATABASE_URL!);

const prisma = new PrismaClient({ adapter });

/**
 * El seed tiene dos partes:
 *
 *  1. Roles — imprescindible para que ande el registro. Se siembran siempre,
 *     también en producción (los corre `entrypoint.sh`).
 *  2. Datos de ejemplo — usuarios, espacios, tarifas, horarios, reservas y
 *     disciplinas para tener con qué laburar en dev. NO se siembran en producción
 *     salvo que pongas SEED_DEMO=true a mano.
 *
 * Todo es idempotente: podés correrlo las veces que quieras y no duplica nada.
 */

const DEMO_PASSWORD = "Password123";

// UUIDs fijos: son la clave de la idempotencia. Si fueran aleatorios, cada
// corrida crearía usuarios nuevos en vez de actualizar los de la anterior.
const FILE = {
  fotoAdmin: "f0000000-0000-4000-8000-000000000001",
  fotoProfe: "f0000000-0000-4000-8000-000000000002",
  canchaF5: "f0000000-0000-4000-8000-000000000003",
  salon: "f0000000-0000-4000-8000-000000000004",
} as const;

const USER = {
  admin: "a0000000-0000-4000-8000-000000000001",
  profeFutbol: "a0000000-0000-4000-8000-000000000002",
  profeVoley: "a0000000-0000-4000-8000-000000000003",
  socioMartin: "a0000000-0000-4000-8000-000000000004",
  socioLucia: "a0000000-0000-4000-8000-000000000005",
  socioRodrigo: "a0000000-0000-4000-8000-000000000006",
  socioValentina: "a0000000-0000-4000-8000-000000000007",
  menorTomas: "a0000000-0000-4000-8000-000000000008",
  menorSofia: "a0000000-0000-4000-8000-000000000009",
} as const;

const FAMILY = {
  martin: "b0000000-0000-4000-8000-000000000001",
  lucia: "b0000000-0000-4000-8000-000000000002",
} as const;

const BOOKING = {
  confirmadaF5: "c0000000-0000-4000-8000-000000000001",
  pendienteF5: "c0000000-0000-4000-8000-000000000002",
  confirmadaSalon: "c0000000-0000-4000-8000-000000000003",
  pendienteVoley: "c0000000-0000-4000-8000-000000000004",
  cancelada: "c0000000-0000-4000-8000-000000000005",
  pasada: "c0000000-0000-4000-8000-000000000006",
} as const;

const DIRECCION = "Av. Libertador 1234, Posadas, Misiones";

const RECARGO_NOCHE = 1000;
const DESDE_NOCHE = "20:00";

const CANCHAS = [
  {
    place: "Cancha de fútbol 5 «A»",
    fee: "Cancha de fútbol 5 — 1 hora",
    base: 12000,
    dias: [1, 3, 5, 6], // lunes, miércoles, viernes, sábado
    horas: ["10:00", "18:00", "19:00", "20:00", "21:00"],
  },
  {
    place: "Cancha de vóley",
    fee: "Cancha de vóley — 1 hora",
    base: 9000,
    dias: [2, 4, 6],
    horas: ["18:00", "19:00", "20:00", "21:00"],
  },
  {
    place: "Cancha de hockey",
    fee: "Cancha de hockey — 1 hora",
    base: 15000,
    dias: [3, 5, 6],
    horas: ["17:00", "18:00", "20:00", "21:00"],
  },
] as const;

const esNoche = (hhmm: string) => hhmm >= DESDE_NOCHE;
const feeNoche = (fee: string) => `${fee} (noche)`;
const horaSiguiente = (hhmm: string) =>
  `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, "0")}:${hhmm.slice(3)}`;

function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00Z`);
}

function utcDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00Z`);
}

function todayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function dateForDayOfWeek(dayOfWeek: number, weeksAhead = 0): Date {
  const base = todayUTC();
  const delta = (dayOfWeek - base.getUTCDay() + 7) % 7;
  return new Date(base.getTime() + (delta + weeksAhead * 7) * 86_400_000);
}

async function seedRoles() {
  const roles = [
    RoleType.SuperAdmin,
    RoleType.Administrador,
    RoleType.Profesor,
    RoleType.Socio,
  ];

  for (const name of roles) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Roles listos (${roles.length}).`);

  const rows = await prisma.role.findMany();
  return new Map<string, number>(rows.map((r) => [r.name, r.id]));
}

async function seedFiles() {
  const now = new Date();
  const files = [
    {
      id: FILE.fotoAdmin,
      name: "ana-gimenez.jpg",
      location: "/uploads/usuarios/ana-gimenez.jpg",
      raw_location: "/uploads/raw/ana-gimenez.jpg",
      optimized: true,
      size: 184_320n,
      mime: "image/jpeg",
      etag: 1,
    },
    {
      id: FILE.fotoProfe,
      name: "diego-ferreyra.jpg",
      location: "/uploads/usuarios/diego-ferreyra.jpg",
      raw_location: "/uploads/raw/diego-ferreyra.jpg",
      optimized: true,
      size: 205_824n,
      mime: "image/jpeg",
      etag: 1,
    },
    {
      id: FILE.canchaF5,
      name: "cancha-futbol-5.jpg",
      location: "/uploads/espacios/cancha-futbol-5.jpg",
      raw_location: null,
      optimized: false,
      size: 742_400n,
      mime: "image/jpeg",
      etag: 2,
    },
    {
      id: FILE.salon,
      name: "salon-eventos.webp",
      location: "/uploads/espacios/salon-eventos.webp",
      raw_location: "/uploads/raw/salon-eventos.jpg",
      optimized: true,
      size: 512_000n,
      mime: "image/webp",
      etag: 3,
    },
  ];

  for (const file of files) {
    const { id, ...rest } = file;
    await prisma.file.upsert({
      where: { id },
      update: rest,
      create: { id, created_at: now, last_modified: now, ...rest },
    });
  }
  console.log(`Archivos listos (${files.length}).`);
}

async function seedUsers(roleIds: Map<string, number>) {
  const password = await Bun.password.hash(DEMO_PASSWORD);

  const admin = roleIds.get(RoleType.Administrador)!;
  const profesor = roleIds.get(RoleType.Profesor)!;
  const socio = roleIds.get(RoleType.Socio)!;

  const users = [
    {
      id: USER.admin,
      role_id: admin,
      name: "Ana",
      last_name: "Giménez",
      dni: "28450113",
      email: "ana.gimenez@crl.test",
      celular: "+5493764100001",
      file_id: FILE.fotoAdmin,
      birth_date: utcDate("1981-03-14"),
    },
    {
      id: USER.profeFutbol,
      role_id: profesor,
      name: "Diego",
      last_name: "Ferreyra",
      dni: "31220874",
      email: "diego.ferreyra@crl.test",
      celular: "+5493764100002",
      file_id: FILE.fotoProfe,
      birth_date: utcDate("1985-07-22"),
    },
    {
      id: USER.profeVoley,
      role_id: profesor,
      name: "Carolina",
      last_name: "Ojeda",
      dni: "33907461",
      email: "carolina.ojeda@crl.test",
      celular: "+5493764100003",
      file_id: null,
      birth_date: utcDate("1988-11-02"),
    },
    {
      id: USER.socioMartin,
      role_id: socio,
      name: "Martín",
      last_name: "Aguirre",
      dni: "35112908",
      email: "martin.aguirre@crl.test",
      celular: "+5493764100004",
      file_id: null,
      birth_date: utcDate("1990-05-09"),
    },
    {
      id: USER.socioLucia,
      role_id: socio,
      name: "Lucía",
      last_name: "Benítez",
      dni: "37845220",
      email: "lucia.benitez@crl.test",
      celular: "+5493764100005",
      file_id: null,
      birth_date: utcDate("1994-01-27"),
    },
    {
      id: USER.socioRodrigo,
      role_id: socio,
      name: "Rodrigo",
      last_name: "Cáceres",
      dni: "40233167",
      email: "rodrigo.caceres@crl.test",
      celular: null,
      file_id: null,
      birth_date: utcDate("1997-09-18"),
    },
    {
      id: USER.socioValentina,
      role_id: socio,
      name: "Valentina",
      last_name: "Duarte",
      dni: "42990455",
      email: "valentina.duarte@crl.test",
      celular: "+5493764100007",
      file_id: null,
      birth_date: utcDate("2001-06-30"),
    },
    {
      id: USER.menorTomas,
      role_id: socio,
      name: "Tomás",
      last_name: "Aguirre",
      dni: "55880231",
      email: "tomas.aguirre@crl.test",
      celular: null,
      file_id: null,
      birth_date: utcDate("2013-04-11"),
    },
    {
      id: USER.menorSofia,
      role_id: socio,
      name: "Sofía",
      last_name: "Benítez",
      dni: "56120789",
      email: "sofia.benitez@crl.test",
      celular: null,
      file_id: null,
      birth_date: utcDate("2011-12-05"),
    },
  ];

  for (const user of users) {
    const { id, ...rest } = user;
    await prisma.user.upsert({
      where: { id },
      update: rest,
      create: { id, password, ...rest },
    });
  }
  console.log(`Usuarios listos (${users.length}).`);
}

async function seedFamilies() {
  const families = [
    { id: FAMILY.martin, parent_id: USER.socioMartin, responsible: true },
    { id: FAMILY.lucia, parent_id: USER.socioLucia, responsible: true },
  ];

  for (const family of families) {
    const { id, ...rest } = family;
    await prisma.family.upsert({
      where: { id },
      update: rest,
      create: { id, ...rest },
    });
  }
  console.log(`Familias listas (${families.length}).`);
}

async function seedFees() {
  const nocturnas = CANCHAS.map((c) => ({
    name: feeNoche(c.fee),
    amount: (c.base + RECARGO_NOCHE).toFixed(2),
    description: `Tarifa a partir de las ${DESDE_NOCHE}. $${RECARGO_NOCHE.toLocaleString("es-AR")} más que la de día.`,
  }));

  const fees = [
    {
      name: "Cancha de fútbol 5 — 1 hora",
      amount: "12000.00",
      description: "Tarifa vigente para socios. Incluye luz artificial.",
    },
    {
      name: "Cancha de fútbol 11 — 1 hora",
      amount: "25000.00",
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Cancha de vóley — 1 hora",
      amount: "9000.00",
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Cancha de hockey — 1 hora",
      amount: "15000.00",
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Pista de patín — 1 hora",
      amount: "7000.00",
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Salón de eventos — turno",
      amount: "90000.00",
      description: "Turno de 6 horas. No incluye servicio de catering.",
    },
    {
      name: "Cancha de fútbol 5 — 1 hora (2025)",
      amount: "9000.00",
      description:
        "Tarifa histórica, reemplazada por la de 2026. Queda para no pisar el precio de las reservas viejas.",
    },
    ...nocturnas,
  ];

  const byName = new Map<string, number>();

  for (const fee of fees) {
    const existing = await prisma.fee.findFirst({ where: { name: fee.name } });
    const row = existing ?? (await prisma.fee.create({ data: fee }));
    byName.set(fee.name, row.id);
  }
  console.log(`Tarifas listas (${fees.length}).`);
  return byName;
}

async function seedPlaces() {
  const places = [
    {
      name: "Cancha de fútbol 5 «A»",
      address: DIRECCION,
      capacity: 10,
      description: "Césped sintético, iluminación LED y vestuarios.",
      file_id: FILE.canchaF5,
    },
    {
      name: "Cancha de fútbol 11",
      address: DIRECCION,
      capacity: 22,
      description: "Cancha principal de césped natural.",
      file_id: null,
    },
    {
      name: "Cancha de vóley",
      address: DIRECCION,
      capacity: 12,
      description: "Cancha cubierta de piso flotante.",
      file_id: null,
    },
    {
      name: "Cancha de hockey",
      address: DIRECCION,
      capacity: 22,
      description: "Césped sintético de agua.",
      file_id: null,
    },
    {
      name: "Pista de patín",
      address: DIRECCION,
      capacity: 30,
      description: "Pista de cemento alisado, techada.",
      file_id: null,
    },
    {
      name: "Salón de eventos",
      address: DIRECCION,
      capacity: 120,
      description: "Salón con cocina, barra y equipo de sonido.",
      file_id: FILE.salon,
    },
  ];

  const byName = new Map<string, number>();

  for (const place of places) {
    const existing = await prisma.place.findFirst({
      where: { name: place.name },
    });
    const row = existing ?? (await prisma.place.create({ data: place }));
    byName.set(place.name, row.id);
  }
  console.log(`Espacios listos (${places.length}).`);
  return byName;
}

async function seedSchedules(
  placeIds: Map<string, number>,
  feeIds: Map<string, number>,
) {
  const grillaCanchas = CANCHAS.flatMap((c) =>
    c.dias.flatMap((dia) =>
      c.horas.map((desde): [string, string, number, string, string] => [
        c.place,
        esNoche(desde) ? feeNoche(c.fee) : c.fee,
        dia,
        desde,
        horaSiguiente(desde),
      ]),
    ),
  );

  // [espacio, tarifa, día (0=domingo…6=sábado), desde, hasta]
  const schedules: [string, string, number, string, string][] = [
    ...grillaCanchas,
    [
      "Cancha de fútbol 11",
      "Cancha de fútbol 11 — 1 hora",
      2,
      "19:00",
      "20:00",
    ],
    [
      "Cancha de fútbol 11",
      "Cancha de fútbol 11 — 1 hora",
      5,
      "18:00",
      "19:00",
    ], // NUEVO
    [
      "Cancha de fútbol 11",
      "Cancha de fútbol 11 — 1 hora",
      6,
      "16:00",
      "17:00",
    ],
    [
      "Cancha de fútbol 11",
      "Cancha de fútbol 11 — 1 hora",
      0,
      "10:00",
      "11:00",
    ],
    ["Pista de patín", "Pista de patín — 1 hora", 1, "16:00", "17:00"],
    ["Pista de patín", "Pista de patín — 1 hora", 3, "18:00", "19:00"], // NUEVO
    ["Pista de patín", "Pista de patín — 1 hora", 4, "16:00", "17:00"],
    ["Salón de eventos", "Salón de eventos — turno", 5, "20:00", "23:00"], // NUEVO
    ["Salón de eventos", "Salón de eventos — turno", 6, "20:00", "23:00"],
    ["Salón de eventos", "Salón de eventos — turno", 0, "12:00", "18:00"],
  ];

  const byKey = new Map<
    string,
    { id: number; fee_id: number; day_of_week: number }
  >();

  for (const [placeName, feeName, day, from, to] of schedules) {
    const place_id = placeIds.get(placeName)!;
    const fee_id = feeIds.get(feeName)!;
    const start_time = toTime(from);

    const row = await prisma.schedule.upsert({
      where: {
        place_id_day_of_week_start_time: {
          place_id,
          day_of_week: day,
          start_time,
        },
      },
      update: { fee_id, end_time: toTime(to) },
      create: {
        place_id,
        fee_id,
        day_of_week: day,
        start_time,
        end_time: toTime(to),
      },
    });
    byKey.set(`${placeName}|${day}|${from}`, row);
  }
  console.log(`Horarios listos (${schedules.length}).`);
  return byKey;
}

async function seedDisciplines(
  placeIds: Map<string, number>,
  feeIds: Map<string, number>,
) {
  // [nombre, profesor_id|null, nombre de tarifa|null, nombre de espacio|null]
  const disciplines: [string, string | null, string | null, string | null][] = [
    [
      "Fútbol",
      USER.profeFutbol,
      "Cancha de fútbol 5 — 1 hora",
      "Cancha de fútbol 5 «A»",
    ],
    ["Vóley", USER.profeVoley, "Cancha de vóley — 1 hora", "Cancha de vóley"],
    ["Hockey", null, "Cancha de hockey — 1 hora", "Cancha de hockey"],
    ["Patín", null, "Pista de patín — 1 hora", "Pista de patín"],
    [
      "Gimnasia Artística",
      USER.profeVoley,
      "Pista de patín — 1 hora",
      "Pista de patín",
    ], // NUEVO
    ["Básquet", null, "Cancha de vóley — 1 hora", "Cancha de vóley"], // NUEVO
  ];

  // Horarios de clase por disciplina: [día (0=domingo), desde, hasta].
  const classSchedules: Record<string, [number, string, string][]> = {
    Fútbol: [
      [1, "18:00", "19:30"],
      [3, "18:00", "19:30"],
    ],
    Vóley: [
      [2, "19:00", "20:30"],
      [4, "19:00", "20:30"],
    ],
    Hockey: [[5, "17:30", "19:00"]],
    Patín: [[6, "10:00", "11:30"]],
    "Gimnasia Artística": [
      [1, "16:00", "17:30"],
      [3, "16:00", "17:30"],
    ], // NUEVO
    Básquet: [
      [2, "17:30", "19:00"],
      [4, "17:30", "19:00"],
    ], // NUEVO
  };

  const byName = new Map<string, number>();

  for (const [name, professor_id, feeName, placeName] of disciplines) {
    const data = {
      name,
      professor_id,
      fee_id: feeName ? (feeIds.get(feeName) ?? null) : null,
      place_id: placeName ? (placeIds.get(placeName) ?? null) : null,
    };
    const existing = await prisma.discipline.findFirst({ where: { name } });
    const discipline = existing
      ? await prisma.discipline.update({ where: { id: existing.id }, data })
      : await prisma.discipline.create({ data });

    byName.set(name, discipline.id);

    for (const [day, from, to] of classSchedules[name] ?? []) {
      const start_time = toTime(from);
      await prisma.disciplineSchedule.upsert({
        where: {
          discipline_id_day_of_week_start_time: {
            discipline_id: discipline.id,
            day_of_week: day,
            start_time,
          },
        },
        update: { end_time: toTime(to) },
        create: {
          discipline_id: discipline.id,
          day_of_week: day,
          start_time,
          end_time: toTime(to),
        },
      });
    }
  }
  console.log(`Disciplinas listas (${disciplines.length}).`);
  return byName;
}

/**
 * Inscripciones de socios a disciplinas (Enrollment M:N).
 * Idempotente mediante el índice único @@unique([user_id, discipline_id]).
 */
async function seedEnrollments(disciplineIds: Map<string, number>) {
  const enrollments = [
    // Fútbol
    { user_id: USER.socioMartin, discipline: "Fútbol" },
    { user_id: USER.socioRodrigo, discipline: "Fútbol" },
    { user_id: USER.menorTomas, discipline: "Fútbol" },
    // Vóley
    { user_id: USER.socioLucia, discipline: "Vóley" },
    { user_id: USER.socioValentina, discipline: "Vóley" },
    // Patín / Gimnasia Artística
    { user_id: USER.menorSofia, discipline: "Patín" },
    { user_id: USER.menorSofia, discipline: "Gimnasia Artística" },
    { user_id: USER.socioValentina, discipline: "Gimnasia Artística" },
    // Básquet
    { user_id: USER.socioMartin, discipline: "Básquet" },
    { user_id: USER.socioRodrigo, discipline: "Básquet" },
  ];

  let creadas = 0;

  for (const { user_id, discipline } of enrollments) {
    const discipline_id = disciplineIds.get(discipline);
    if (!discipline_id) continue;

    await prisma.enrollment.upsert({
      where: {
        user_id_discipline_id: {
          user_id,
          discipline_id,
        },
      },
      update: {},
      create: {
        user_id,
        discipline_id,
      },
    });
    creadas++;
  }

  console.log(`Inscripciones listas (${creadas}).`);
}

async function seedBookings(
  schedules: Map<string, { id: number; fee_id: number; day_of_week: number }>,
) {
  const bookings: [
    string,
    string,
    string,
    number,
    "Pendiente" | "Confirmada" | "Cancelada",
    string | null,
  ][] = [
    [
      BOOKING.confirmadaF5,
      "Cancha de fútbol 5 «A»|1|19:00",
      USER.socioMartin,
      1,
      "Confirmada",
      "Partido semanal con los compañeros de trabajo.",
    ],
    [
      BOOKING.pendienteF5,
      "Cancha de fútbol 5 «A»|6|10:00",
      USER.socioRodrigo,
      1,
      "Pendiente",
      null,
    ],
    [
      BOOKING.confirmadaSalon,
      "Salón de eventos|6|20:00",
      USER.socioLucia,
      3,
      "Confirmada",
      "Cumpleaños de 15. Se pidió el equipo de sonido.",
    ],
    [
      BOOKING.pendienteVoley,
      "Cancha de vóley|4|18:00",
      USER.socioValentina,
      2,
      "Pendiente",
      "Entrenamiento del equipo femenino.",
    ],
    [
      BOOKING.cancelada,
      "Cancha de hockey|3|17:00",
      USER.socioMartin,
      2,
      "Cancelada",
      "Se canceló por lluvia.",
    ],
    [
      BOOKING.pasada,
      "Cancha de fútbol 11|2|19:00",
      USER.socioRodrigo,
      -2,
      "Confirmada",
      "Reserva vieja, queda como historial.",
    ],
  ];

  let creadas = 0;

  for (const [id, key, user_id, weeks, status, notes] of bookings) {
    const schedule = schedules.get(key);
    if (!schedule) {
      console.warn(`Turno ${key} inexistente, se saltea la reserva.`);
      continue;
    }

    const data = {
      schedule_id: schedule.id,
      fee_id: schedule.fee_id,
      user_id,
      date: dateForDayOfWeek(schedule.day_of_week, weeks),
      status,
      notes,
      active: status === "Cancelada" ? null : true,
    };

    try {
      await prisma.booking.upsert({
        where: { id },
        update: data,
        create: { id, ...data },
      });
      creadas++;
    } catch (error: any) {
      if (error?.code === "P2002") {
        console.warn(
          `El turno ${key} ya está reservado, se saltea la reserva de ejemplo.`,
        );
        continue;
      }
      throw error;
    }
  }
  console.log(`Reservas listas (${creadas}).`);
}

async function main() {
  const roleIds = await seedRoles();

  const esProduccion = process.env.NODE_ENV === "production";
  if (esProduccion && process.env.SEED_DEMO !== "true") {
    console.log(
      "Producción: se siembran solo los roles. Usá SEED_DEMO=true para forzar el resto.",
    );
    return;
  }

  await seedFiles();
  await seedUsers(roleIds);
  await seedFamilies();

  const feeIds = await seedFees();
  const placeIds = await seedPlaces();
  const schedules = await seedSchedules(placeIds, feeIds);
  await seedBookings(schedules);

  const disciplineIds = await seedDisciplines(placeIds, feeIds);
  await seedEnrollments(disciplineIds);

  console.log(
    `\nSeed completado. Usuarios de ejemplo con contraseña "${DEMO_PASSWORD}":`,
  );
  console.log("  Administrador → DNI 28450113 (ana.gimenez@crl.test)");
  console.log("  Profesor      → DNI 31220874 (diego.ferreyra@crl.test)");
  console.log("  Socio         → DNI 35112908 (martin.aguirre@crl.test)");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Error en seed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
