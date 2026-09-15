# CRL API — Backend

Backend del **Sistema CRL** (Club Recreativo Libertador): plataforma para gestionar un club
deportivo (fútbol, vóley, patín, hockey). Proyecto de universidad, con propuesta formal en
`../PropuestaCRL.pdf` (visión, 17 historias de usuario, DER, tarifas).

Sirve **solo** `/api/*`. El frontend vive en otro repo y le pega vía proxy.

---

## Reglas de trabajo (leer primero)

1. **No levantes servidores ni valides contra un localhost propio.** Nada de `bun dev` +
   `curl` para verificar. Gasta tokens y no es efectivo. Razoná sobre el código y, si hace
   falta probar, decime qué comando correr y lo corro yo.
2. **No instales dependencias sin permiso explícito.** Ni `bun add`, ni `bun install <pkg>`.
   Si algo necesita una dep nueva, proponela y esperá el OK. Priorizá lo que ya está instalado.
3. **No corras migraciones destructivas.** `prisma migrate dev` pide **resetear la base** por
   el drift (ver Trampas). Nunca lo dispares por tu cuenta.
4. **No commitees ni pushees** salvo que te lo pida.
5. **Español, voseo argentino.**
6. **Son dos repos.** Si tocás algo compartido (ver `validation.ts` abajo), acordate del otro.

---

## Stack

| Capa | Tecnología |
| --- | --- |
| Runtime | **Bun** (no Node directo, no npm/pnpm) |
| Framework HTTP | **Express 5** |
| ORM | **Prisma 7** con `engineType = "client"` y `runtime = "bun"` |
| Driver | **@prisma/adapter-mariadb** (adapter, no el engine binario) |
| Base de datos | **MySQL 8** en Docker (`docker-compose.yml`) |
| Auth | **jsonwebtoken** (JWT propio, 24h) + `Bun.password` para hashing |
| OAuth | **google-auth-library** (verifica ID token; NO Passport, NO redirect flow) |
| Validación | **Zod 4** (`src/lib/validation.ts`) |
| Teléfonos | **libphonenumber-js** |
| Env | **dotenv** |

TypeScript en todo. Tests con `bun:test` (nativo de Bun, sin framework aparte) en
`src/lib/*.test.ts` y `src/routes/*.test.ts`.

---

## Arquitectura: dos repos

| Repo | Carpeta | Qué es | Puerto |
| --- | --- | --- | --- |
| **crl-web** | `.../Proyect/CRL` | React 19 + Tailwind, servido por Bun | 3000 |
| **crl-api** (este) | `.../Proyect/CRL-api` | Express 5 + Prisma 7 + MySQL 8 | 3001 |

- Frontend: `github.com/MorgensternMA/CRL`
- Backend: `github.com/LukySand/crl-api` ← **cuenta distinta** (LukySand, no MorgensternMA)

```
Navegador ──/api/*──► crl-web (Bun :3000) ──proxy──► crl-api (Express :3001) ──► MySQL :3306
          ──resto──► React SPA
```

El front hace `fetch("/api/...")` **relativo** y su server proxea acá. Sin CORS, cookies
same-origin. **Al agregar endpoints nuevos no se toca el proxy del front** — solo este repo.

---

## Estructura

```
src/
├── server.ts               # Express: json middleware, /api/health, monta los 10 routers
├── lib/
│   ├── auth.ts             # JWT: signToken/readToken, requireAuth/requireRole/requireAdmin/isAdmin
│   ├── availability.ts     # cruza turnos con reservas + clases de disciplina (función pura, testeada)
│   ├── availability.test.ts
│   ├── booking-date.ts     # fechas/horas en huso del club, topes de anticipación (testeado)
│   ├── booking-date.test.ts
│   ├── fee.ts              # findOrCreateFeeForPlace: reusa/crea la tarifa de un turno o reserva
│   ├── logger.ts           # buffer de logs a la tabla `logs`, flush por tamaño o cada 5s
│   ├── prisma.ts           # cliente Prisma + adapter MariaDB (singleton en dev)
│   ├── random-id.ts        # id numérico pseudo-aleatorio de 31 bits
│   ├── storage.ts          # Storage: sube/lee/borra archivos en disco + fila en `files`
│   ├── time.ts             # TIME regex, toTime, overlaps (rangos horarios)
│   └── validation.ts       # Zod — DUPLICADO con el frontend (ver abajo)
├── middleware/
│   └── auth.ts             # authenticate/requireRole — usado solo por socioRouter (ver nota abajo)
└── routes/
    ├── admin.ts            # adminRouter — CRUD de usuarios con rol
    ├── auth.ts             # authRouter — login/registro/Google
    ├── booking-admin.test.ts
    ├── bookings.ts         # bookingsRouter — reservas de espacios
    ├── disciplines.ts      # disciplinesRouter — disciplinas + sus horarios de clase
    ├── enrollments.ts      # enrollmentsRouter — inscripciones socio↔disciplina
    ├── fee-category.test.ts
    ├── fees.ts             # feesRouter — tarifas (inmutables, sin PATCH/DELETE)
    ├── files.ts            # filesRouter — subida/descarga genérica de archivos
    ├── places.ts           # placesRouter — espacios del club (canchas, salón)
    ├── schedules.ts        # schedulesRouter — turnos reservables de un espacio
    └── socio.ts            # socioRouter — foto de perfil del socio logueado

prisma/
├── schema.prisma
├── seed.ts               # siembra roles, usuarios, archivos, familias, tarifas, espacios,
│                         # turnos, disciplinas, inscripciones y reservas (idempotente)
├── migrations/
└── generated/            # cliente Prisma generado (bun run db:generate) — no editar a mano
scripts/dev-setup.sh      # bun run setup
```

`src/lib/auth.ts` y `src/middleware/auth.ts` son dos implementaciones de JWT distintas y
duplicadas: casi todos los routers usan `lib/auth.ts` (`requireAuth`/`requireAdmin`/`isAdmin`),
pero `socio.ts` usa `middleware/auth.ts` (`authenticate`). Mismo JWT, dos lecturas del token.

---

## Endpoints

10 routers montados en `server.ts`, todos bajo `/api/*`. Rutas sin login se marcan **público**;
el resto exige `requireAuth`/`authenticate` y, si dice **gestión**, además `requireAdmin`
(rol `SuperAdmin` o `Administrador`).

| Router | Base | Endpoints |
| --- | --- | --- |
| — | `/api/health` | `GET /` — healthcheck → `{ok:true}` |
| `authRouter` | `/api/auth` | `POST /login`, `GET /verify`, `POST /register`, `POST /logout`, `GET /google/config`, `POST /google` — todo público (ver [Auth](#auth-cómo-funciona)) |
| `filesRouter` | `/api/files` | `GET /?id=` público; `PUT /` (auth, sube/reemplaza); `DELETE /?fileId=` (gestión) |
| `adminRouter` | `/api/admin` | Todo gestión. `GET /users`; `POST /users`; `PUT /users/:id`; `DELETE /users/:id` (baja lógica + cancela sus reservas futuras); `PATCH /users/:id/reactivate` |
| `placesRouter` | `/api/places` | `GET /` público (`?all=true` gestión ve inactivos); `GET /occupancy` (gestión); `GET /:id` público; `POST /`, `PATCH /:id`, `DELETE /:id` (baja lógica), `PATCH /:id/reactivate` — gestión |
| `schedulesRouter` | `/api/schedules` | `GET /?place_id=` y `GET /:id` público (sólo turnos vivos); `POST /`, `PATCH /:id` — gestión, rechazan superponerse con otro turno o con una clase; `DELETE /:id` — gestión, **baja lógica**: 409 si tiene reservas futuras sin cancelar |
| `feesRouter` | `/api/fees` | `GET /?category=` y `GET /:id` público; `POST /` gestión. Sin PATCH/DELETE: `Fee` es inmutable |
| `bookingsRouter` | `/api/bookings` | Todo auth. `GET /?status=&place_id=` (propias; gestión ve todas); `GET /availability?place_id=&date=`; `GET /:id`; `POST /` (gestión puede reservar a nombre de otro socio, fijar precio y estado); `PATCH /:id`; `DELETE /:id` (cancela, no borra) |
| `disciplinesRouter` | `/api/disciplines` | `GET /` y `GET /:id` público; `POST /`, `PATCH /:id`, `DELETE /:id` (baja lógica + desinscribe a todos los socios), `PATCH /:id/reactivate` — gestión. Sub-recurso horarios: `GET /:id/schedules` público; `POST/PATCH/DELETE /:id/schedules(/:sid)` — gestión o el profesor a cargo. `POST` y `PATCH` dan 409 si la clase se pisa con un turno reservable vivo del espacio |
| `enrollmentsRouter` | `/api/enrollments` | Todo auth. `GET /?discipline_id=` (filtrado por rol: admin todas, profesor las que dicta, socio las propias); `POST /` (a sí mismo, o gestión inscribe a otro); `DELETE /:id` (baja lógica) |
| `socioRouter` | `/api/socio` | Todo auth (vía `middleware/auth.ts`). `GET /files?id=` (archivo propio); `PATCH /profile-image` (reemplaza la foto de perfil) |

### Seguridad — regla al agregar endpoints

El usuario **siempre** se resuelve desde el JWT, nunca desde un `user_id` del body/query/params.
Confiar en un ID que manda el cliente es IDOR (cualquiera edita recursos ajenos). Todo endpoint
que opere "sobre mí" saca el `id` del token verificado.

---

## Modelo de datos

- `Role` — enum `RoleType`: `SuperAdmin` / `Administrador` / `Profesor` / `Socio`.
- `User` — `active` es baja lógica (false = dado de baja). `has_credentials` distingue al que
  puede entrar solo del menor que depende del tutor.
- `File` — un archivo subido (imagen), referenciado por `User.file_id` o `Place.file_id`.
- `Family` — vincula un `User` menor (`child_id`) a un tutor (`parent_id`) + `responsible`.
  Lo expone `familiesRouter` (`/api/families`).
- `Log` — buffer de auditoría/informativos que escribe `lib/logger.ts` (tabla `logs`).
- `Place` — espacio del club (cancha, salón); baja lógica con `active`.
- `Schedule` — turno reservable semanal de un `Place` (día + hora + `Fee`).
- `Booking` — una reserva de un `Schedule` para una fecha puntual. Enum `BookingStatus`
  (`Pendiente`/`Confirmada`/`Cancelada`).
- `Discipline` — disciplina del club (fútbol, vóley…) con cuota/espacio opcionales; baja lógica
  con `active` y `full` para cortar inscripciones cuando se llena el cupo.
- `DisciplineProfessor` — tabla puente: varios profes por disciplina (#6). Reemplaza a
  `Discipline.professor_id`, que quedó **deprecado** y que nadie lee ni escribe.
- `DisciplineSchedule` — horario semanal fijo de una `Discipline` (no se reserva, se dicta).
- `Enrollment` — inscripción de un socio a una `Discipline`, con historial de períodos.
- `Fee` — tarifa **inmutable** (sin endpoint de update: cambiar precio = fila nueva).
  Enum `FeeCategory`: `Reserva` / `CuotaSocio` / `Disciplina` / `Donacion` / `Otro`. La
  categoría `Reserva` sólo la crea `findOrCreateFeeForPlace()`, nunca el admin a mano.

**IDs**: `User`, `File`, `Family` y `Booking` usan UUID (`String @id @default(uuid())`).
El resto (`Role`, `Log`, `Fee`, `Place`, `Discipline`, `DisciplineSchedule`, `Enrollment`,
`Schedule`) usa `Int` autoincremental. Migrado desde int en el commit `4db61f3`.

**Truco `active` nullable para uniques parciales** (`ponytail:` en el schema): `Booking`,
`Enrollment` y `Schedule` tienen `active Boolean?` dentro de un `@@unique(...)` — `true` mientras la
fila está viva, `null` cuando se cancela/da de baja. MySQL no soporta índices únicos parciales,
pero sí ignora `NULL` en un unique, así que dar de baja libera el turno/la inscripción sin
borrar la fila (se conserva el historial). El código que da de baja es siempre el único que
toca ese campo, en el mismo `update` que cambia el estado, para que nunca quede desincronizado.

En `Schedule` el truco además es lo que hace posible la baja lógica: sin `active` dentro del
unique, dar de baja el turno del martes 19:00 ocuparía `(place_id, day_of_week, start_time)`
para siempre y no se podría volver a crear ese turno nunca más.

**Ojo con el unique compuesto en Prisma**: los mantenedores confirmaron (discussions
[#23522](https://github.com/prisma/prisma/discussions/23522) y
[#21322](https://github.com/prisma/prisma/discussions/21322)) que el input de unique compuesto
exige un valor para cada campo aunque sea nullable, y no acepta `null` cómodo. Por eso la baja
lógica actualiza por `where: { id }`, nunca por el tuple. Apuntarle al tuple sólo es válido con
un valor concreto (el seed usa `active: true`).

---

## Auth: cómo funciona

- **JWT propio** (`jsonwebtoken`, 24h) firmado acá. El front lo guarda en cookie `auth_token` +
  `localStorage.user_data` y redirige por rol. Stateless, sin sesiones de servidor.
- **Google**: Google Identity Services renderiza el botón en el navegador → el ID token llega
  acá → se verifica con `google-auth-library` (firma + audience + `email_verified`) → se emite
  el JWT propio. **Sin Passport, sin redirect flow**, así que `OAUTH_SECRET` del `.env` no se
  usa (solo `OAUTH_ID`).
  En Google Console alcanza con **Orígenes autorizados de JavaScript** = `http://localhost:3000`
  (+ dominio de prod). Nada en "URI de redireccionamiento".
- **Emails duplicados**: si el email de Google coincide con un `User` existente → **se linkea** y
  se loguea en esa cuenta (el email es la identidad y Google ya lo verificó).
- **Alta con Google**: Google solo da email+nombre, pero `User` exige `dni` y `birth_date`. Si el
  usuario es nuevo se devuelve `{needsProfile:true}` y el front pide esos datos en una pantalla
  propia. **La cuenta no se crea hasta tenerlos** → nunca queda una cuenta a medias.
- Usuarios de Google reciben `password = hash(crypto.randomUUID())`: solo para cumplir el
  `NOT NULL`. Nadie la conoce, no pueden entrar por dni+password.

---

## `validation.ts` está duplicado a propósito

`src/lib/validation.ts` existe **igual** en los dos repos: el front valida en cliente, este
revalida en servidor. Marcado con comentario `ponytail:`.

**Si tocás uno, copiá al otro.**

Schemas: `name` / `last_name` (regex `\p{L}`, acepta acentos), `dni` (8-10 dígitos, solo números),
`email` (`z.email` + `z.regexes.unicodeEmail`), `celular` (`isValidPhoneNumber`), `password`
(8-50, no solo espacios), `birth_date` (no futura, mínimo 13 años), y `registerSchema`.

---

## Comandos

```bash
bun install
cp .env.example .env    # completar valores
bun run setup           # MySQL en docker + prisma generate + db push + seed (idempotente)
bun dev                 # :3001, hot reload
```

| Comando | Qué hace |
| --- | --- |
| `bun dev` | Servidor con hot reload |
| `bun start` | Modo producción |
| `bun run setup` | DB + generate + push + seed |
| `bun run db:studio` | UI de Prisma |
| `bun run db:generate` | Regenera el cliente |
| `bun run db:push` | Aplica el schema sin migración |
| `bun run db:seed` | Siembra datos de prueba (roles, usuarios, espacios, turnos…) |
| `docker compose up -d db` | Solo la base |
| `bun test` | Corre los tests (`bun:test`) |

En prod, `entrypoint.sh` corre `migrate deploy` + seed antes de arrancar.

---

## Trampas conocidas (importante)

1. **`DATABASE_URL` debe usar `127.0.0.1`, NO `localhost`.** En Mac, Bun resuelve `localhost` a
   IPv6, el adapter de MariaDB se cuelga 10s y falla con "pool timeout". El `.env` no está
   commiteado, así que cada quien lo arregla en el suyo.
2. **La DB de dev tiene drift**: se armó con `db push`, no con migraciones, así que
   `prisma migrate dev` pide **resetear la base** (perder datos). El cambio a UUID y el de
   `celular` se hicieron así. Para cambios de schema en dev: SQL aditivo + escribir la migración
   a mano para prod. **No dispares `migrate dev` sin avisar.**
3. **`prisma.config.ts`**: el `seed` tiene que ser un comando completo (`bun prisma/seed.ts`),
   no solo la ruta del archivo — si no, Prisma intenta ejecutarlo como binario y tira `EACCES`.
4. Al agregar deps o tocar `validation.ts`, recordá que hay **dos repos**.
5. `JWT_SECRET=secret` en el `.env` de dev — cambiar antes de cualquier deploy.
6. **El cliente Prisma se desincroniza de tres formas distintas.** Las tres dan errores que
   parecen bugs de código y no lo son. Identificá cuál es antes de tocar nada:

   | Síntoma | Qué está desfasado | Fix |
   | --- | --- | --- |
   | `tsc` se queja de un campo que **sí** está en `schema.prisma` (o exige uno que no está) | cliente generado viejo, schema nuevo | `bun run db:generate` |
   | En runtime: `The column X does not exist in the current database` (P2022) | cliente nuevo, **base** vieja | aplicar la migración con `prisma db execute --file` |
   | En runtime: `Unknown argument 'X'` pero `tsc` pasa limpio | cliente ok en disco, **el proceso de `bun dev` tiene el viejo en memoria** | reiniciar `bun dev` (Ctrl+C y de nuevo) |

   El tercero es el más confuso justamente porque `tsc --noEmit` sale en 0: `bun --hot`
   recarga tu código, pero no vuelve a evaluar el cliente generado. Si regeneraste con el
   server levantado, reinicialo.

---

## Estado actual

**Construido**: auth completo (JWT + Google), gestión de usuarios y roles, archivos/fotos de
perfil, familias (vínculo menor↔tutor), espacios (`Place`) con ocupación, turnos reservables
(`Schedule`) con validación de solapamiento, reservas (`Booking`) con cancelación y topes de
anticipación, tarifas (`Fee`) categorizadas, disciplinas con varios profesores y sus horarios
de clase, e inscripciones socio↔disciplina.

**Falta** (ni siquiera hay modelo en el schema): pagos (Mercado Pago / comprobante de
transferencia), cuotas de socio como obligación mensual con vencimiento, publicaciones
institucionales, locales adheridos con beneficios, y reportes de ingresos.

### Reglas temporales de las reservas

Todas viven en `src/lib/booking-date.ts`, con su test en `booking-date.test.ts`. Nunca las
metas sueltas en un handler:

| Constante | Qué limita |
| --- | --- |
| `DIAS_ADELANTE_SOCIO` = 21 | Cuánto puede reservar hacia adelante un socio |
| `DIAS_ADELANTE_ADMIN` = 183 | Lo mismo para la gestión (~6 meses, para eventos) |
| `HORAS_ANTES_CANCELAR` = 10 | Hasta cuándo puede **cancelar** un socio. La gestión no tiene tope |

`dentroDeVentanaCancelacion(date, start_time, ahora?)` resuelve la última: combina la fecha de
la reserva con la hora del turno y las compara como string `"YYYY-MM-DDTHH:MM"` en huso del
club, que es el mismo truco de `todayInClub()` / `nowTimeInClub()` (el orden lexicográfico es el
cronológico). El límite es **inclusivo**: con 10 horas justas todavía se cancela. Una reserva
pasada cae sola, no hace falta un chequeo aparte.

`HORAS_ANTES_CANCELAR` está **duplicada** en el front (`CRL/src/app/pages/socio/reservas.ts`),
igual que `validation.ts`: el front esconde el botón, el back rechaza el `DELETE`. Si tocás una,
tocá la otra.

## Deuda conocida

- El registro normal (dni+password) **no verifica el email**. Alguien podría registrar un email
  ajeno antes de que el dueño entre por Google. (`email` sí tiene `@unique` en el schema, así
  que el duplicado explota — pero el registro nunca prueba que el mail sea tuyo.)
- `src/lib/auth.ts` y `src/middleware/auth.ts` son dos implementaciones duplicadas del mismo
  JWT. `socio.ts` usa la del medio, todo el resto usa la de `lib/`. Unificar.
- El no-solapamiento de `Schedule` vive en la aplicación, no en la base: MySQL 8 no tiene
  exclusion constraints (eso es Postgres). Si algún día se escribe en la tabla por fuera de
  `POST/PATCH /api/schedules`, nada impide turnos pisados.
