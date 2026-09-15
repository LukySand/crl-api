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

TypeScript en todo. Sin tests configurados.

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
├── server.ts             # Express: json middleware, /api/health, monta los routers
├── lib/
│   ├── prisma.ts         # cliente Prisma + adapter MariaDB (singleton en dev)
│   ├── auth.ts           # JWT: requireAuth / requireAdmin / isAdmin — LA canónica
│   ├── booking-date.ts   # reglas temporales de reservas
│   ├── payment-period.ts # períodos y vencimientos de cuotas
│   ├── payment.ts        # claves `ref` + serialización de Decimal
│   ├── fee.ts            # findOrCreateFeeForPlace
│   ├── storage.ts        # archivos en disco (mime permitido por kind)
│   └── validation.ts     # Zod — DUPLICADO con el frontend (ver abajo)
└── routes/
    ├── auth.ts, admin.ts, socio.ts, families.ts, files.ts
    ├── places.ts, schedules.ts, fees.ts, bookings.ts
    ├── disciplines.ts, enrollments.ts
    └── payments.ts, reports.ts

prisma/
├── schema.prisma
├── seed.ts               # siembra los roles
└── migrations/
scripts/dev-setup.sh      # bun run setup
```

---

## Endpoints

Todos en `src/routes/auth.ts`, montados bajo `/api/auth` (salvo health).

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/api/health` | Healthcheck → `{ok:true}` |
| POST | `/api/auth/login` | Login con `{dni, password}` → JWT 24h |
| POST | `/api/auth/register` | Alta de Socio + auto-login |
| GET | `/api/auth/verify` | Valida token (header `Bearer` o cookie `auth_token`) |
| POST | `/api/auth/logout` | Limpia cookie |
| GET | `/api/auth/google/config` | Expone el Client ID público al front |
| POST | `/api/auth/google` | Login/alta con Google (ID token) |

### Cuotas y reportes

| Método | Ruta | Guard | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/payments` | sesión | Propias; gestión ve todas. `?status= &concept= &period= &user_id= &from= &to=` |
| GET | `/api/payments/resumen` | sesión | Totales del socio: pendiente, vencido, próximo vencimiento |
| POST | `/api/payments/generate` | gestión | Genera las cuotas de un período. **Idempotente** |
| GET | `/api/payments/:id` | dueño o gestión | Una cuota |
| POST | `/api/payments/:id/comprobante` | dueño | Sube el comprobante (multipart) → `EnRevision` |
| PATCH | `/api/payments/:id` | gestión | `{action: confirmar\|rechazar\|anular}` |
| GET | `/api/reports/ingresos` | gestión | Totales + un corte. `?from= &to= &concept= &group=mes\|concepto\|metodo\|disciplina\|espacio` |
| GET | `/api/reports/series` | gestión | Serie temporal. `?bucket=dia\|semana\|mes &by=espacio\|disciplina\|concepto\|metodo &from= &to=` |
| GET | `/api/reports/morosos` | gestión | Quién debe y desde cuándo |

`/ingresos` corta por **una** dimensión; `/series` es la de **dos** (tiempo × algo), que es lo
que hace falta para "cuánto facturó cada cancha por día". Tres reglas de `/series`:

- **El eje X no tiene huecos.** `rangoBuckets()` emite todos los cajones y los vacíos van en
  cero. Agrupando sólo los cobros que existen, un día muerto desaparece y las columnas se
  corren: el gráfico miente sobre su propia forma.
- **La ventana tiene tope por bucket** (30 días / 12 semanas / 12 meses). Sin tope,
  `bucket=dia` sobre todo el historial son cientos de columnas.
- **La semana se etiqueta por su lunes.** Orden lexicográfico = cronológico, el mismo truco que
  `todayInClub()` y `period`.

`/resumen` y `/generate` van declaradas **antes** de `/:id`, igual que `/availability` en
`bookings.ts`: Express matchea por orden y si no las tomaría como un id.

### Seguridad — regla al agregar endpoints

El usuario **siempre** se resuelve desde el JWT, nunca desde un `user_id` del body/query/params.
Confiar en un ID que manda el cliente es IDOR (cualquiera edita recursos ajenos). Todo endpoint
que opere "sobre mí" saca el `id` del token verificado.

---

## Modelo de datos

`Role` (enum `SuperAdmin` / `Administrador` / `Profesor` / `Socio`), `User`, `File`, `Family`
(vincula menores a un tutor responsable).

Reservas: `Place` (espacio), `Schedule` (turno recurrente: `day_of_week` + TIME, sin fecha),
`Fee` (tarifa, inmutable, con `kind`) y `Booking` (la reserva: `Schedule` + una fecha concreta).
Disciplinas: `Discipline`, `DisciplineProfessor`, `DisciplineSchedule`, `Enrollment`.
Plata: `Payment` (ver "Cuotas y pagos" abajo).

**IDs: `User`, `File`, `Family` y `Booking` usan UUID (`String @id @default(uuid())`).** El
resto es `Int` autoincremental. Migrado desde int en el commit `4db61f3`.

`Booking.active` es `Boolean?` y forma el unique `(schedule_id, date, active)`. MySQL ignora los
NULL en un índice único, así que poner `active: null` al cancelar libera el turno **sin borrar
la fila**: la reserva queda en el historial. Es el truco central del modelo — el código que
cancela es el único que toca ese campo, siempre en el mismo `update` que pone `status`.

Falta el modelo de cuotas, pagos, locales adheridos y publicaciones.

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
| `bun run db:seed` | Siembra roles |
| `docker compose up -d db` | Solo la base |

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

---

## Estado actual

Construido: auth (`/api/auth/*`), gestión de usuarios y bajas (`/api/admin/*`), archivos
(`/api/files`), espacios (`/api/places`), turnos (`/api/schedules`), tarifas (`/api/fees`),
reservas (`/api/bookings`), disciplinas (`/api/disciplines`), inscripciones
(`/api/enrollments`), cuotas y cobros (`/api/payments`) y reportes de ingresos
(`/api/reports`).

Falta: cuota de socio (el enum ya tiene el valor `Socio`, falta decidir dónde vive el monto
vigente del club), Mercado Pago, publicaciones institucionales, locales adheridos con
beneficios.

### Cuotas y pagos

`Payment` es el ledger: **una fila = un período adeudado que además registra cómo se saldó**.
Cubre las reservas de cancha (pago único) y las cuotas de disciplina (mensuales). Antes de
esto, `BookingStatus.Confirmada` hacía de "pagada" sin registrar quién cobró, cuándo ni cómo.

Reglas que no se rompen:

- **El monto se congela.** `Payment.amount` es una copia, no un join. `fee_id` va igual como
  snapshot. Sin la copia, repuntar `Discipline.fee_id` repreciaría todo el historial.
  Mismo criterio que `Booking.fee_id`.
- **No hay estado "Vencido".** Se deriva de `due_date < hoy` con status `Pendiente`.
  Guardarlo pediría un job a medianoche.
- **No hay `next_due_date`.** Es `min(due_date) where status = Pendiente`.
- **`ref` es único** (`reserva:<id>`, `disciplina:<enrollment>:<YYYY-MM>`,
  `socio:<user>:<YYYY-MM>`): hace idempotente a `POST /api/payments/generate`, que si no
  cobraría el mes dos veces cuando alguien lo corre de nuevo.
- **El pago viaja en la misma transacción que lo que lo origina.** Crear/cancelar una reserva,
  desinscribirse, dar de baja un socio o una disciplina: todo toca el pago en el mismo
  `$transaction`, por lo mismo que `status` y `active` de `Booking` nunca se separan.
- **Lo ya `Pagado` no se anula nunca.** La plata entró de verdad; borrarla falsearía los
  ingresos del mes. Las devoluciones no existen todavía.

Constantes en `src/lib/payment-period.ts` (nunca sueltas en un handler, igual que
`booking-date.ts`): `DIA_VENCIMIENTO = 10`. `cursoEnPeriodo()` decide a quién le toca la cuota
del mes — se cobra el mes completo si cursó aunque sea un día, sin prorrateo. Ahí viven también
los buckets de los reportes (`lunesDe`, `bucketDe`, `rangoBuckets`, `ventanaPorDefecto`).

⚠️ **"Hoy" siempre con `todayInClub()`, nunca con el reloj UTC** — incluido el seed. Corriendo
el seed de noche en Argentina (UTC-3) el UTC ya está en el día siguiente, así que los cobros
quedaban fechados mañana: se caían de la ventana del reporte y volvían a meter ingresos futuros.

`Fee.kind` (`Reserva | Disciplina | Socio`) separa el alquiler por hora de la cuota mensual:
la cancha de vóley sale $9.000/hora y la disciplina vóley $8.000/mes, y antes las dos podían
terminar siendo la misma fila. El front tiene que pedir `GET /api/fees?kind=Disciplina` al
elegir la cuota de una disciplina — el backend además lo valida.

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
  ajeno antes de que el dueño entre por Google.
- `email` no tiene constraint `@unique` en el schema; el register solo chequea DNI duplicado.
