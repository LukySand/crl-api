import { PrismaClient, RoleType } from "./generated/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
// El huso sale de la app y no de una constante local: si el club se muda, se
// cambia en un solo lugar y el seed sigue generando datos coherentes.
import { CLUB_TZ, parseDate, todayInClub } from "../src/lib/booking-date";

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

// Profesor de prueba con contraseña propia, corta de tipear, para entrar al panel
// de profesor. No pasa `passwordSchema` (exige 8 caracteres), así que esta cuenta
// no se puede crear desde el registro: sale sólo de acá. El login no valida largo
// —sólo verifica el hash— por eso entra igual.
const TEST_PROFESOR_PASSWORD = "Test123";

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
  profeTest: "a0000000-0000-4000-8000-000000000010",
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
  pasadaMartin: "c0000000-0000-4000-8000-000000000007",
  ventanaCerrada: "c0000000-0000-4000-8000-000000000008",
} as const;

const DIRECCION = "Av. Libertador 1234, Posadas, Misiones";

const RECARGO_NOCHE = 1000;
const DESDE_NOCHE = "20:00";

const CANCHAS = [
  {
    place: "Cancha de fútbol 5",
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

/** Nombre de la cuota mensual de una disciplina. */
const cuotaDisciplina = (disciplina: string) => `Cuota mensual — ${disciplina}`;

/**
 * Cuota mensual de cada disciplina, en pesos.
 *
 * Separadas de las tarifas de cancha a propósito: la cuota de vóley (8000/mes)
 * no es el alquiler de la cancha de vóley (9000/hora), aunque el espacio sea el
 * mismo. Antes las disciplinas apuntaban a la tarifa por hora de su cancha, que
 * es justo lo que `Fee.kind` vino a impedir.
 */
const DISCIPLINAS_CUOTA: [string, number][] = [
  ["Fútbol", 10000],
  ["Vóley", 8000],
  ["Hockey", 9000],
  ["Patín", 7500],
  ["Gimnasia Artística", 8500],
  ["Básquet", 8000],
];
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
  const testProfesorPassword = await Bun.password.hash(TEST_PROFESOR_PASSWORD);

  // Roles de cada usuario, de más a menos acceso: el primero es el principal y va
  // también en el `role_id` deprecado.
  const admin = [RoleType.Administrador];
  const profesor = [RoleType.Profesor];
  const socio = [RoleType.Socio];
  // Carolina además es socia: el caso de alguien con dos roles. Diego queda sólo
  // Profesor, para tener también al profe que no es socio.
  const profesorYSocio = [RoleType.Profesor, RoleType.Socio];

  const users = [
    {
      id: USER.admin,
      roles: admin,
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
      roles: profesor,
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
      roles: profesorYSocio,
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
      roles: socio,
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
      roles: socio,
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
      roles: socio,
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
      roles: socio,
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
      roles: socio,
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
      roles: socio,
      name: "Sofía",
      last_name: "Benítez",
      dni: "56120789",
      email: "sofia.benitez@crl.test",
      celular: null,
      file_id: null,
      birth_date: utcDate("2011-12-05"),
    },
    // Profe de prueba: DNI y contraseña cortos para entrar rápido al panel de
    // profesor. Lleva `password` propio, que pisa el DEMO_PASSWORD compartido
    // tanto al crear como al actualizar (el spread de `rest` va después).
    {
      id: USER.profeTest,
      roles: profesor,
      name: "Test",
      last_name: "Profesor",
      dni: "11111111",
      email: "test.profesor@crl.test",
      celular: null,
      file_id: null,
      birth_date: utcDate("1990-01-01"),
      password: testProfesorPassword,
    },
  ];

  for (const user of users) {
    const { id, roles, ...rest } = user;
    const ids = roles.map((r) => roleIds.get(r)!);
    const data = { ...rest, role_id: ids[0]! };
    await prisma.user.upsert({
      where: { id },
      update: data,
      create: { id, password, ...data },
    });
    // Deja exactamente estos roles: saca los que sobran y agrega los que faltan.
    await prisma.userRole.deleteMany({ where: { user_id: id, role_id: { notIn: ids } } });
    await prisma.userRole.createMany({
      data: ids.map((role_id) => ({ user_id: id, role_id })),
      skipDuplicates: true,
    });
  }
  console.log(`Usuarios listos (${users.length}).`);
}

async function seedFamilies() {
  const families = [
    { id: FAMILY.martin, parent_id: USER.socioMartin, child_id: USER.menorTomas, responsible: true },
    { id: FAMILY.lucia, parent_id: USER.socioLucia, child_id: USER.menorSofia, responsible: true },
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
    kind: "Reserva" as const,
    description: `Tarifa a partir de las ${DESDE_NOCHE}. $${RECARGO_NOCHE.toLocaleString("es-AR")} más que la de día.`,
  }));

  // ponytail: `kind` va explícito aunque el default sea Reserva. El seed es la
  // documentación ejecutable del modelo, y acá está justo la distinción que la
  // columna vino a hacer: alquilar la cancha de vóley una hora no es lo mismo
  // que la cuota mensual de la disciplina vóley, aunque las dos digan "vóley".
  const fees = [
    {
      name: "Cancha de fútbol 5 — 1 hora",
      amount: "12000.00",
      kind: "Reserva" as const,
      description: "Tarifa vigente para socios. Incluye luz artificial.",
    },
    {
      name: "Cancha de fútbol 11 — 1 hora",
      amount: "25000.00",
      kind: "Reserva" as const,
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Cancha de vóley — 1 hora",
      amount: "9000.00",
      kind: "Reserva" as const,
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Cancha de hockey — 1 hora",
      amount: "15000.00",
      kind: "Reserva" as const,
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Pista de patín — 1 hora",
      amount: "7000.00",
      kind: "Reserva" as const,
      description: "Tarifa vigente para socios.",
    },
    {
      name: "Salón de eventos — turno",
      amount: "90000.00",
      kind: "Reserva" as const,
      description: "Turno de 6 horas. No incluye servicio de catering.",
    },
    {
      name: "Cancha de fútbol 5 — 1 hora (2025)",
      amount: "9000.00",
      kind: "Reserva" as const,
      description:
        "Tarifa histórica, reemplazada por la de 2026. Queda para no pisar el precio de las reservas viejas.",
    },
    ...nocturnas,
    // Cuotas mensuales de las disciplinas. Son otra cosa que el alquiler por hora
    // del mismo espacio: se cobran una vez por mes cursado, no por turno usado.
    ...DISCIPLINAS_CUOTA.map(([disciplina, monto]) => ({
      name: cuotaDisciplina(disciplina),
      amount: monto.toFixed(2),
      kind: "Disciplina" as const,
      description: `Cuota mensual de ${disciplina}. Incluye las clases del mes.`,
    })),
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
      name: "Cancha de fútbol 5",
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
  // [nombre, profesores (0..n), nombre de tarifa|null, nombre de espacio|null]
  // Fútbol va con dos a propósito: es el caso de #6 y así queda dato de ejemplo
  // para probar que un profe ve las disciplinas que comparte con otro.
  //
  // La tarifa es la cuota MENSUAL de la disciplina, no el alquiler por hora del
  // espacio donde se dicta: son dos tarifas distintas aunque el lugar sea el
  // mismo (ver DISCIPLINAS_CUOTA).
  const disciplines: [string, string[], string | null, string | null][] = [
    [
      "Fútbol",
      [USER.profeFutbol, USER.profeVoley],
      cuotaDisciplina("Fútbol"),
      "Cancha de fútbol 5",
    ],
    // Vóley queda con dos: sirve para ver el panel del profe de prueba con una
    // disciplina compartida, además de las dos que dicta solo.
    [
      "Vóley",
      [USER.profeVoley, USER.profeTest],
      cuotaDisciplina("Vóley"),
      "Cancha de vóley",
    ],
    ["Hockey", [USER.profeTest], cuotaDisciplina("Hockey"), "Cancha de hockey"],
    ["Patín", [USER.profeTest], cuotaDisciplina("Patín"), "Pista de patín"],
    [
      "Gimnasia Artística",
      [USER.profeVoley],
      cuotaDisciplina("Gimnasia Artística"),
      "Pista de patín",
    ], // NUEVO
    ["Básquet", [], cuotaDisciplina("Básquet"), "Cancha de vóley"], // NUEVO
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

  for (const [name, professorIds, feeName, placeName] of disciplines) {
    const data = {
      name,
      fee_id: feeName ? (feeIds.get(feeName) ?? null) : null,
      place_id: placeName ? (placeIds.get(placeName) ?? null) : null,
    };
    const existing = await prisma.discipline.findFirst({ where: { name } });
    const discipline = existing
      ? await prisma.discipline.update({ where: { id: existing.id }, data })
      : await prisma.discipline.create({ data });

    byName.set(name, discipline.id);

    // #6: los profes viven en la tabla puente. Idempotente por la PK compuesta.
    // No borra los que alguien haya agregado a mano desde el panel.
    for (const professor_id of professorIds) {
      await prisma.disciplineProfessor.upsert({
        where: {
          discipline_id_professor_id: { discipline_id: discipline.id, professor_id },
        },
        update: {},
        create: { discipline_id: discipline.id, professor_id },
      });
    }

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
 * Migración puntual de #6: pasa las asignaciones del viejo `professor_id` a la
 * tabla puente, para las disciplinas que no cargó este seed (las que cada uno
 * creó a mano desde el panel). Idempotente y sin efecto una vez migradas.
 *
 * ponytail: vive acá y no en un script aparte porque el seed ya es el "poné la
 * base al día" del equipo. Se borra junto con la columna `professor_id`.
 */
async function backfillProfesores() {
  const pendientes = await prisma.discipline.findMany({
    where: { professor_id: { not: null }, professors: { none: {} } },
    select: { id: true, professor_id: true },
  });

  for (const d of pendientes) {
    await prisma.disciplineProfessor.create({
      data: { discipline_id: d.id, professor_id: d.professor_id! },
    });
  }
  if (pendientes.length) {
    console.log(`Profesores migrados a la tabla nueva (${pendientes.length}).`);
  }
}

/**
 * Migración puntual de los varios roles: a cada usuario que todavía no tiene filas
 * en `UserRole` le copia su `role_id`. Son los que no carga este seed (los que se
 * registraron o creó cada uno desde el panel). En prod lo hace la migración SQL;
 * las bases de dev se armaron con `db push`, que no la corre. Idempotente.
 *
 * ponytail: vive acá por lo mismo que `backfillProfesores`. Se borra junto con la
 * columna `role_id`.
 */
async function backfillRoles() {
  const pendientes = await prisma.user.findMany({
    where: { roles: { none: {} } },
    select: { id: true, role_id: true },
  });
  if (!pendientes.length) return;
  await prisma.userRole.createMany({
    data: pendientes.map((u) => ({ user_id: u.id, role_id: u.role_id })),
    skipDuplicates: true,
  });
  console.log(`Roles migrados a la tabla nueva (${pendientes.length}).`);
}

/**
 * Inscripciones de ejemplo (socios ↔ disciplinas), con el modelo de historial
 * (active/left_at). Idempotente: no re-inscribe si ya hay una activa para el par.
 */
async function seedEnrollments(disciplineIds: Map<string, number>) {
  // [socio, nombre de disciplina]
  const inscripciones: [string, string][] = [
    // Fútbol
    [USER.socioMartin, "Fútbol"],
    [USER.socioRodrigo, "Fútbol"],
    [USER.menorTomas, "Fútbol"],
    // Vóley
    [USER.socioLucia, "Vóley"],
    [USER.socioValentina, "Vóley"],
    // Hockey
    [USER.socioValentina, "Hockey"],
    // Patín / Gimnasia Artística
    [USER.menorSofia, "Patín"],
    [USER.menorSofia, "Gimnasia Artística"],
    [USER.socioValentina, "Gimnasia Artística"],
    // Básquet
    [USER.socioMartin, "Básquet"],
    [USER.socioRodrigo, "Básquet"],
  ];

  let creadas = 0;
  for (const [user_id, discName] of inscripciones) {
    const discipline_id = disciplineIds.get(discName);
    if (!discipline_id) continue;
    const yaActiva = await prisma.enrollment.findFirst({
      where: { user_id, discipline_id, active: true },
    });
    if (!yaActiva) {
      await prisma.enrollment.create({ data: { user_id, discipline_id } });
      creadas++;
    }
  }
  console.log(`Inscripciones listas (${creadas} nuevas).`);
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
      "Cancha de fútbol 5|1|19:00",
      USER.socioMartin,
      1,
      "Confirmada",
      "Partido semanal con los compañeros de trabajo.",
    ],
    [
      BOOKING.pendienteF5,
      "Cancha de fútbol 5|6|10:00",
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
    // Martín es el socio con el que se prueba la app: tiene que ver los tres
    // casos de cancelación sin cambiar de cuenta. La futura cancelable es
    // `confirmadaF5` (una semana adelante), la de ventana cerrada la arma
    // `seedBookingEnVentana`, y esta es la pasada.
    [
      BOOKING.pasadaMartin,
      "Cancha de hockey|5|18:00",
      USER.socioMartin,
      -1,
      "Confirmada",
      "Ya jugada: queda en el historial y no se puede cancelar.",
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

/** Cuántas horas adelante se pone el turno de prueba de "ya no se puede cancelar". */
const HORAS_VENTANA_DEMO = 2;

/**
 * Una reserva que arranca dentro de la ventana de cancelación, para poder probar
 * que el botón desaparece y que el backend rechaza el DELETE igual.
 *
 * No sale de la grilla fija de `CANCHAS` a propósito: el seed corre a cualquier
 * hora del día, así que ningún turno fijo garantiza caer dentro de las próximas
 * horas. Se calcula contra el reloj y se hace upsert por la clave natural
 * (espacio, día, hora): re-sembrar a la misma hora reutiliza la fila en vez de
 * duplicarla, y las horas posibles son 7×24, no infinitas.
 *
 * Va sobre la pista de patín porque es el espacio con la grilla más floja y sin
 * tarifa nocturna, así que la hora que toque nunca choca con un turno real.
 */
async function seedBookingEnVentana(
  placeIds: Map<string, number>,
  feeIds: Map<string, number>,
) {
  const ESPACIO = "Pista de patín";
  const TARIFA = "Pista de patín — 1 hora";

  const place_id = placeIds.get(ESPACIO);
  const fee_id = feeIds.get(TARIFA);
  if (!place_id || !fee_id) {
    console.warn(`Falta ${ESPACIO}, se saltea la reserva de ventana cerrada.`);
    return;
  }

  // En hora del club, no la del server: corriendo en UTC, a las 22:00 de
  // Argentina ya sería mañana y el turno caería en el día equivocado.
  const objetivo = new Date(Date.now() + HORAS_VENTANA_DEMO * 3_600_000);
  const fecha = objetivo.toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
  const hhmm = objetivo.toLocaleTimeString("en-GB", {
    timeZone: CLUB_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // Redondear a la hora en punto saca como mucho 59 minutos de las dos horas:
  // el turno sigue quedando adelante en el tiempo y dentro de la ventana.
  const desde = `${hhmm.slice(0, 2)}:00`;
  // horaSiguiente("23:00") daría "24:00", que no es un TIME válido.
  const hasta = desde === "23:00" ? "23:59" : horaSiguiente(desde);

  const date = utcDate(fecha);
  const start_time = toTime(desde);
  const day_of_week = date.getUTCDay();

  const schedule = await prisma.schedule.upsert({
    where: {
      place_id_day_of_week_start_time: { place_id, day_of_week, start_time },
    },
    update: { fee_id, end_time: toTime(hasta) },
    create: {
      place_id,
      fee_id,
      day_of_week,
      start_time,
      end_time: toTime(hasta),
    },
  });

  const data = {
    schedule_id: schedule.id,
    fee_id: schedule.fee_id,
    user_id: USER.socioMartin,
    date,
    status: "Confirmada" as const,
    notes: "Arranca en un rato: ya no entra en la ventana de cancelación.",
    active: true,
  };

  try {
    await prisma.booking.upsert({
      where: { id: BOOKING.ventanaCerrada },
      update: data,
      create: { id: BOOKING.ventanaCerrada, ...data },
    });
    console.log(`Reserva de ventana cerrada lista (${ESPACIO}, ${fecha} ${desde}).`);
  } catch (error: any) {
    if (error?.code === "P2002") {
      console.warn(
        `El turno ${ESPACIO} ${fecha} ${desde} ya está reservado, se saltea la reserva de ventana cerrada.`,
      );
      return;
    }
    throw error;
  }
}

/** Cuántos meses hacia atrás se siembran cuotas de disciplina. */
const MESES_DE_HISTORIAL = 3;

/** "YYYY-MM" de N meses atrás, contando desde el mes corriente. */
function periodoAtras(meses: number): string {
  const hoy = todayUTC();
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - meses, 1));
  return d.toISOString().slice(0, 7);
}

/** Vencimiento de un período: el día 10, igual que DIA_VENCIMIENTO en la app. */
function vencimientoDe(periodo: string): Date {
  return new Date(`${periodo}-10T00:00:00Z`);
}

/**
 * Cuotas y cobros de ejemplo.
 *
 * Siembra las dos mitades del ledger:
 *  - Un pago por cada reserva sembrada, con el estado que le corresponde a la
 *    reserva (confirmada = cobrada, cancelada = anulada).
 *  - Cuotas de disciplina de los últimos meses, con una mezcla de estados para
 *    que la pantalla de reportes tenga una serie con forma y no una barra sola.
 *
 * Idempotente por `ref` (unique): correrlo dos veces no duplica nada. Vale la
 * pena correrlo dos veces justamente para comprobarlo.
 */
async function seedPayments() {
  let creados = 0;
  // ponytail: el huso del club, NO todayUTC(). Corriendo el seed a la noche en
  // Argentina (UTC-3) el reloj UTC ya está en el día siguiente, así que los
  // cobros quedaban fechados mañana: caían fuera de la ventana del reporte y
  // volvían a meter ingresos futuros. Los reportes calculan "hoy" con
  // todayInClub(), y el seed tiene que usar la misma definición.
  const hoy = parseDate(todayInClub());

  // ── Reservas ───────────────────────────────────────────────────────────
  const bookings = await prisma.booking.findMany({
    include: { fee: { select: { id: true, amount: true } } },
  });

  for (const b of bookings) {
    // El estado del cobro sale del de la reserva: confirmada es "ya se cobró en
    // el club" (es lo que significaba antes de que existiera esta tabla),
    // cancelada no se cobra, y pendiente sigue debiéndose.
    const status =
      b.status === "Confirmada"
        ? ("Pagado" as const)
        : b.status === "Cancelada"
          ? ("Anulado" as const)
          : ("Pendiente" as const);

    const data = {
      user_id: b.user_id,
      concept: "Reserva" as const,
      booking_id: b.id,
      fee_id: b.fee.id,
      amount: b.fee.amount,
      period: null,
      due_date: b.date, // la reserva se paga el día del turno
      status,
      ...(status === "Pagado"
        ? {
            // El día del turno si ya pasó, hoy si todavía no: la gestión cobra
            // cuando confirma, no el día del partido. Sin el tope, una reserva
            // confirmada para dentro de tres semanas metía plata en el mes que
            // viene y el reporte mostraba ingresos futuros.
            paid_at: b.date < hoy ? b.date : hoy,
            method: "Efectivo" as const,
            registered_by: USER.admin,
          }
        : {}),
    };

    await prisma.payment.upsert({
      where: { ref: `reserva:${b.id}` },
      update: data,
      create: { ref: `reserva:${b.id}`, ...data },
    });
    creados++;
  }

  // ── Cuotas de disciplina ───────────────────────────────────────────────
  const enrollments = await prisma.enrollment.findMany({
    where: { active: true, discipline: { fee_id: { not: null } } },
    include: { discipline: { select: { fee: { select: { id: true, amount: true } } } } },
  });

  // Períodos de más viejo a más nuevo: el corriente es el último.
  const periodos = Array.from({ length: MESES_DE_HISTORIAL }, (_, i) =>
    periodoAtras(MESES_DE_HISTORIAL - 1 - i),
  );

  for (const [indice, periodo] of periodos.entries()) {
    const esCorriente = indice === periodos.length - 1;
    const due = vencimientoDe(periodo);

    for (const [posicion, e] of enrollments.entries()) {
      const fee = e.discipline.fee!;

      // Los meses cerrados están casi todos cobrados; el corriente es el que
      // tiene mezcla, que es donde se ve si la pantalla distingue los estados.
      // El reparto es determinístico (por posición) y no al azar: si el seed
      // sorteara, cada corrida cambiaría los números del reporte y no habría
      // forma de saber si una diferencia es un bug o el dado.
      const status = !esCorriente
        ? posicion % 7 === 0
          ? ("Pendiente" as const) // un moroso por mes, para el reporte de deuda
          : ("Pagado" as const)
        : posicion % 3 === 0
          ? ("Pagado" as const)
          : posicion % 3 === 1
            ? ("Pendiente" as const)
            : ("EnRevision" as const); // comprobante subido, esperando a la gestión

      // Transferencia y efectivo alternados, para que el corte por medio de
      // cobro tenga las dos barras.
      const method = posicion % 2 === 0 ? ("Transferencia" as const) : ("Efectivo" as const);

      const data = {
        user_id: e.user_id,
        concept: "Disciplina" as const,
        enrollment_id: e.id,
        fee_id: fee.id,
        amount: fee.amount,
        period: periodo,
        due_date: due,
        status,
        ...(status === "Pagado"
          ? {
              // Se paga cerca del vencimiento, no el mismo día siempre.
              paid_at: new Date(due.getTime() - (posicion % 5) * 86_400_000),
              method,
              registered_by: USER.admin,
            }
          : {}),
      };

      const ref = `disciplina:${e.id}:${periodo}`;
      await prisma.payment.upsert({
        where: { ref },
        update: data,
        create: { ref, ...data },
      });
      creados++;
    }
  }

  console.log(
    `Cuotas y cobros listos (${creados}: ${bookings.length} de reservas, ${enrollments.length * periodos.length} de disciplinas en ${periodos.length} meses).`,
  );
}

async function main() {
  const roleIds = await seedRoles();
  // Antes del corte de producción: si una base vieja llega sin la migración
  // aplicada, los usuarios no se quedan sin roles.
  await backfillRoles();

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
  await seedBookingEnVentana(placeIds, feeIds);

  const disciplineIds = await seedDisciplines(placeIds, feeIds);
  await backfillProfesores();
  await seedEnrollments(disciplineIds);

  // Va último: las cuotas cuelgan de las reservas y las inscripciones.
  await seedPayments();

  console.log(
    `\nSeed completado. Usuarios de ejemplo con contraseña "${DEMO_PASSWORD}":`,
  );
  console.log("  Administrador → DNI 28450113 (ana.gimenez@crl.test)");
  console.log("  Profesor      → DNI 31220874 (diego.ferreyra@crl.test)");
  console.log("  Profe + Socia → DNI 33907461 (carolina.ojeda@crl.test)");
  console.log("  Socio         → DNI 35112908 (martin.aguirre@crl.test)");
  console.log(
    `\nProfe de prueba (contraseña "${TEST_PROFESOR_PASSWORD}"):` +
      "\n  Profesor      → DNI 11111111 (test.profesor@crl.test) — Vóley, Hockey, Patín",
  );
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
