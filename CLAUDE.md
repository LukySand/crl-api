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

TypeScript en todo. Tests con `bun test`: los puros (reglas, fechas, cliente MP) corren sin base; los de ruta
(`src/routes/*.test.ts`) necesitan la base de test (`bun run test:db`, ver Comandos).

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
│   ├── auth.ts           # JWT: requireAuth / requireAdmin / isAdmin / hasRole — LA canónica
│   ├── roles.ts          # varios roles por usuario: orden, validación y reglas de gestión
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
| GET | `/api/payments/por-cobrar` | gestión o profesor | Cuotas pendientes que se pueden cobrar en mano. `?search=` por nombre, apellido o DNI. Gestión ve todas; un profesor sólo las de **disciplinas que dicta** |
| POST | `/api/payments/:id/cobro` | gestión o profesor | Registra el cobro en mano y deja la cuota Pagada (`registered_by`). Gestión: efectivo o transferencia, cualquier concepto. Profesor: sólo efectivo y sólo cuotas de disciplina de sus alumnos. Reglas en `lib/cobro.ts` |
| GET | `/api/reports/ingresos` | gestión | Totales + un corte. `?from= &to= &concept= &group=mes\|concepto\|metodo\|disciplina\|espacio` |
| GET | `/api/reports/series` | gestión | Serie temporal. `?bucket=dia\|semana\|mes &by=espacio\|disciplina\|concepto\|metodo &from= &to=` |
| GET | `/api/reports/morosos` | gestión | Quién debe y desde cuándo |
| GET | `/api/reports/export` | gestión | Descarga Excel o PDF de lo que muestra la pantalla de reportes. `?format=xlsx\|pdf &bucket= &from= &to= &canchas= &disciplinas=` (los dos últimos se repiten una vez por nombre; ausente = todas, vacío = ninguna) |
| GET | `/api/enrollments/export` | gestión o profe de esa disciplina | Lista de inscriptos para bajar o imprimir. `?discipline_id= &format=xlsx\|pdf`. Sin celular ni email a propósito (ver `lib/enrollment-export.ts`) |

### Cuenta del socio

| Método | Ruta | Guard | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/socio/cuotas` | sesión | Cuotas propias (sin reservas ni bajas lógicas) → `{cuotas, deuda_total, vencidas}`. Antes emite los cargos que falten y concilia con MP |
| GET | `/api/socio/cuotas/menor/:childId` | tutor | Lo mismo para un menor a cargo; el vínculo se verifica contra `Family` activa (403 si no) |
| GET | `/api/socio/credential` | sesión | Credencial: `habilitada = rol Socio && active && cuotas_vencidas === 0` |
| GET | `/api/socio/credential/menor/:childId` | tutor | Credencial de un menor a cargo |
| GET | `/api/socio/historial-pagos` | sesión | Liquidaciones del socio (o que saldan filas suyas) con `cuotas`, `reembolsos` y `booking_id` |

### Ajustes del club

Lo que antes eran constantes en el código ahora lo fija la gestión (pestaña Ajustes del admin):
horas para cancelar una reserva (`cancel_hours_before`, 10), días de anticipación del socio
(`days_ahead_member`, 21) y de la gestión (`days_ahead_admin`, 183), día de vencimiento de la cuota
(`payment_due_day`, 10). Una sola fila (`ClubSettings`, id 1); sin fila rige lo de siempre
(`AJUSTES_POR_DEFECTO` en `lib/settings.ts`, que es lo único que no cambió de valor).

| Método | Ruta | Guard | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/settings` | sesión | Los ajustes vigentes. Los lee el socio (horas para cancelar, anticipación) |
| PATCH | `/api/settings` | gestión | Cambio parcial: se manda sólo lo que cambia |

Las constantes `HORAS_ANTES_CANCELAR`, `DIAS_ADELANTE_*` y `DIA_VENCIMIENTO` siguen existiendo pero
sólo como default de los parámetros (`dentroDeVentanaCancelacion(..., horas)`,
`vencimientoDe(periodo, dia)`): los handlers leen `getAjustes()` (`lib/settings-db.ts`, con 30 s de
cache que se descarta al guardar). Un cambio rige para lo que viene: las reservas ya hechas y las
cuotas ya generadas conservan su fecha.

### Sponsors

Un comercio —o una persona— se postula como sponsor **desde la web, sin cuenta**, y la gestión
aprueba o rechaza. No es un local adherido: el sponsor **aporta** al club, el local adherido **da**
descuentos a los socios (son dos tablas, `SponsorApplication` y `PartnerStore`). Reglas puras en
`lib/sponsor.ts`, con tests.

| Método | Ruta | Guard | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/sponsors` | **público** | La vitrina de la landing: sólo aprobados y sólo `{id, business_name, sector, logo_file_id}` |
| POST | `/api/sponsors/applications` | **público** | Una empresa se postula. Multipart: los datos + el logo (opcional) en el mismo pedido |
| GET | `/api/sponsors/applications` | sesión | Gestión ve todas; el resto, **las suyas**. `?status=` y `?propias=true` (ver abajo) |
| GET | `/api/sponsors/applications/:id` | gestión o dueño | Detalle |
| PATCH | `/api/sponsors/applications/:id/datos` | gestión o dueño | Corregir datos. Sólo si está `Pendiente` |
| PATCH | `/api/sponsors/applications/:id` | gestión | `{action: aprobar\|rechazar, rejection_reason?}`. Rechazar exige motivo |
| DELETE | `/api/sponsors/applications/:id` | gestión | Se terminó el auspicio: pasa a `Finalizada` y sale de la vitrina. Baja lógica |
| PATCH | `/api/sponsors/applications/:id/reactivate` | gestión | Vuelve a `Aprobada`. El sponsor de la temporada pasada que repite |

Cinco reglas que no se rompen:

- **No se pide CUIT.** A quien recién está averiguando, pedirle la identidad fiscal es fricción, y
  ese dato no hace falta hasta que hay acuerdo. Por eso tampoco es sólo para empresas:
  `business_name` es el nombre del comercio **o** de la persona, y en un pueblo de ~9.500
  habitantes el que quiere ayudar suele ser un vecino, no una S.A.
- **Lo público sale por un `select` escrito a mano** (`VITRINA_SELECT`). La fila tiene email,
  teléfono y el mensaje del acuerdo: nada de eso va a una página que ve cualquiera, y un `select`
  explícito no se rompe solo cuando mañana se agregue una columna.
- **El logo viaja en el mismo POST**, no en dos pasos. `PUT /api/files` exige sesión y quien se
  postula no tiene cuenta; además, subirlo aparte dejaría archivos huérfanos si abandona el
  formulario. `Storage.create` valida tipo por los **bytes** del archivo (no por el content-type que
  manda el cliente), que es lo que hace tolerable recibirlo sin sesión. Reusa el kind `localImages`.
- **Hay campo trampa** (`CAMPO_TRAMPA`, escondido en el formulario). Si viene con algo es un bot y
  la postulación se descarta devolviendo 201, no 400: un error le enseñaría al bot cuál era el campo.
  Reemplaza al CUIT, que hacía de filtro de basura con su dígito verificador antes de sacarlo.
- **La cola tiene tope** (`LIMITE_PENDIENTES` = 100 → 503), chequeado **antes** de escribir el logo
  así tampoco se llena el disco. Un límite por IP no serviría: el front proxea `/api/*` y todas las
  postulaciones llegan con la IP del proxy.

**Las formas de aportar** (`TIPOS_DE_APORTE`) son una lista cerrada y **sin montos**: una cifra en
pesos escrita en el código envejece sola —con la inflación de 2026, ~1,9% mensual, pierde un tercio
de su valor en un año— y además ningún club de este tamaño publica tarifa, se arregla hablando. Las
opciones dicen **qué** se aporta, no cuánto. Dos están marcadas `aConfirmar` porque el club todavía
las está definiendo; se muestran igual, avisando. La columna guarda el **`id`** de la opción
("equipo", "especie"…), no su texto, así la lista se cambia sin migración y sin dejar ilegibles las
postulaciones viejas (`tituloDeAporte` cae al valor crudo si el id ya no existe). El rubro sigue
siendo texto libre, y el mensaje es donde se explica cualquier combinación.

Un email no puede tener dos postulaciones Pendiente/Aprobada a la vez (409, comparando en
minúsculas), pero quien fue **rechazado sí puede volver a postularse**: cambió la propuesta. Por eso
`email` no es `@unique`. Y una vez resuelta, la postulación no se vuelve a aprobar ni rechazar
(`denyRevision`, 409): la fila es el registro de lo que se decidió, y pisarla borraría el motivo del
rechazo sin dejar rastro.

**Se puede postular con cuenta o sin ella.** Si el POST trae sesión, la fila guarda `user_id`
(**del token, nunca del body**) y esa persona la sigue desde la app —"Mi propuesta al club" en
Configuración del socio—, donde ve el estado y el motivo del rechazo. `GET /applications` usa la
misma convención que reservas y cuotas: la gestión ve todas, cualquier otra sesión ve las suyas, y
un admin pide las propias con `?propias=true` (`veComoGestion`). **Una postulación anónima no se
vincula sola** con una cuenta que después se registre con el mismo email: el registro no verifica
el email (deuda conocida), así que cualquiera que se anote con esa dirección vería la ajena.

**`/datos` tiene dos alcances en un mismo endpoint**, porque es el mismo concepto con distinto
permiso: el **dueño** corrige todo lo que escribió (es su propuesta) y la **gestión** sólo contacto
—nombre, email, teléfono—, que es el caso real del email tipeado mal de una anónima. El rubro, el
aporte y el mensaje son lo que la persona propuso y la gestión no los reescribe. Si alguien es dueño
y admin, manda el alcance de dueño. Sólo mientras esté `Pendiente` (`denyEdicion`): una resuelta es
el registro de lo que se decidió sobre **esos** datos.

⚠️ El seed se identifica por **`business_name`, no por email**: desde que la gestión puede corregir
el email, usarlo de clave hacía que el seed no reconociera su propia fila y la sembrara duplicada.

**`Finalizada` es el cuarto estado y no es un rechazo**: el trato existió y se cumplió, sólo que ya
no está vigente. Existe porque un auspicio es **por temporada**; sin él, el logo de quien dejó de
acompañar se queda en la landing para siempre. Las transiciones están en `denyBaja` y
`denyReactivar`, con tests: sólo se baja lo `Aprobada` y sólo se reactiva lo `Finalizada`, y el
ciclo Aprobada → Finalizada → Aprobada se puede repetir cada año. `reviewed_at`/`reviewed_by`
guardan el **último** cambio de estado, no sólo el primero.

### Bloqueo de espacios

Cierra un espacio durante un rango de fechas (y, si trae franja horaria, sólo en esa franja) sin
tocar los turnos: borrar el turno de los lunes valdría para todos los lunes, y el bloqueo es "el
lunes 21 por mantenimiento". Modelo `ScheduleBlock`; la lógica pura vive en `lib/schedule-block.ts`.

| Método | Ruta | Guard | Qué hace |
| --- | --- | --- | --- |
| GET | `/api/blocks` | gestión | Bloqueos vigentes (los que no terminaron). `?place_id=` |
| POST | `/api/blocks` | gestión | `{place_id, from, to?, start_time?, end_time?, reason}`. Sin `to` es un día; sin franja, todo el día. **409 con `conflictos` si ya hay reservas vivas en ese rango**: no las cancela solo |
| DELETE | `/api/blocks/:id` | gestión | Lo levanta: el espacio vuelve a poder reservarse |

`POST /api/bookings` responde 409 si el turno está bloqueado ese día (también para la gestión), y
`GET /api/bookings/availability` suma `slots: [{id, ocupado, motivo: "reserva"|"bloqueo", detalle}]`,
con el motivo del bloqueo en `detalle`. `taken` sigue siendo la lista plana e incluye los bloqueados.

`/ingresos` corta por **una** dimensión; `/series` es la de **dos** (tiempo × algo), que es lo
que hace falta para "cuánto facturó cada cancha por día". Cuatro reglas de `/series`:

- **El eje X no tiene huecos.** `rangoBuckets()` emite todos los cajones y los vacíos van en
  cero. Agrupando sólo los cobros que existen, un día muerto desaparece y las columnas se
  corren: el gráfico miente sobre su propia forma.
- **La ventana tiene tope por bucket** (30 días / 12 semanas / 12 meses). Sin tope,
  `bucket=dia` sobre todo el historial son cientos de columnas.
- **El rango tiene tope de columnas por corte** (`LIMITE_COLUMNAS` en `report-data.ts`): 62 por día
  (2 meses), 54 por semana (1 año), 72 por mes (6 años). Pasado eso las barras no se leen y
  `/series` y `/export` responden 400. Está duplicado en el front (`LIMITES`), que avisa antes de pedir.
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

`Role` (enum `SuperAdmin` / `Administrador` / `Profesor` / `Socio`), `User`, `UserRole` (los
roles de cada usuario, ver "Varios roles"), `File`, `Family` (vincula menores a un tutor
responsable).

Reservas: `Place` (espacio), `Schedule` (turno recurrente: `day_of_week` + TIME, sin fecha),
`Fee` (tarifa, inmutable, con `kind`) y `Booking` (la reserva: `Schedule` + una fecha concreta).
Disciplinas: `Discipline`, `DisciplineProfessor`, `DisciplineSchedule`, `Enrollment`.
Plata: `Payment` (ver "Cuotas y pagos" abajo).
Sponsors: `SponsorApplication` + enum `SponsorStatus` (ver "Sponsors").

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

## Varios roles por usuario

Una persona puede tener varios roles (Carolina es Profesor + Socio) y **los permisos se suman**.
La fuente de verdad es la tabla `UserRole`. Reglas:

- **Chequeá contra la lista, nunca contra un rol suelto.** `requireRole` / `requireAdmin` /
  `isAdmin(req)` / `hasRole(req, "Profesor")` ya miran `req.user.roles`. Un
  `req.user.role === "Profesor"` o un `else if` por rol asume que tenés uno solo y se rompe.
- **Socio es un rol:** paga cuota, tiene tarjeta, puede inscribirse. Un profe que no es socio no
  se inscribe (`POST /api/enrollments` exige el rol Socio).
- **`?propias=true`** en `GET /api/bookings`, `/api/payments` y `/api/enrollments` devuelve sólo
  lo del usuario del token, tenga el rol que tenga. Sin eso, un Admin + Socio vería en "Mis
  reservas" las de todo el club, y una profe + socia vería sus alumnos en vez de sus
  inscripciones. La app de socio lo manda; el panel de gestión no. Ver `veComoGestion()`.
- **Combinaciones:** cualquiera menos SuperAdmin + Administrador. Mínimo un rol. Nadie se saca a
  sí mismo el rol de gestión. Una cuenta que es o pasa a ser SuperAdmin sólo la toca un
  SuperAdmin. Todo en `lib/roles.ts`, con tests.
- **Un usuario sin roles no existe:** `User.role_id` se borró (migración
  `20260915200000_drop_user_role_id`, que antes copia a `UserRole` lo que falte). El token lleva
  sólo `roles`; uno viejo con `role` se trata como vencido y hay que re-loguearse. El alta y la
  edición de `/api/admin/users` piden `roles: [...]` (el schema está en `routes/admin.ts`, no en
  `validation.ts`, que está duplicado con el front).

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
| `bun run test:db` | Levanta/prepara la base de test (`db_test`); después `bun test <archivo>` |
| `bun test src/lib` | Tests puros, sin base |
| `bun run test:webhook` | Prueba el webhook de MP contra un server vivo (opcional) |

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
(`/api/enrollments`), cuotas y cobros (`/api/payments`), reportes de ingresos
(`/api/reports`) y postulación de sponsors (`/api/sponsors`).

Falta: publicaciones institucionales y locales adheridos con beneficios.

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
- **Lo ya `Pagado` no se anula a mano.** La plata entró de verdad; borrarla falsearía los
  ingresos del mes. Sólo un reembolso (abajo) lo pasa a `Anulado`.

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

### Liquidaciones, reembolsos y emisión

- **Una liquidación (`PaymentTransaction`) salda una o más filas** a través de
  `PaymentTransactionItem`. Los cinco métodos (`MercadoPago`, `Efectivo`, `Transferencia`,
  `MPFueraDeApp`, `TarjetaConPosnet`) pasan por `lib/settlement.ts`. Invariante: una fila
  `Pagado` pertenece a exactamente una liquidación aprobada; nunca hay dos vivas sobre la misma
  fila (`liquidacionViva`, `409 pago_en_curso`).
- **Un reembolso deja la fila `Anulado`**, conservando `paid_at` y `method` (la plata entró y
  salió: los reportes restan el egreso en el mes de `refunded_at`). `lib/refunds.ts`; un
  reembolso fallido se reintenta cada 15 minutos o se resuelve a mano (`/api/transactions`).
- **Pago duplicado** (la misma preferencia pagada dos veces): no se vuelca en la liquidación; queda
  un `Refund` con `mp_payment_id` del duplicado, clave `duplicado:{id}`, `payment_id` null e
  `income_reversal` false, y sale por `reembolsarItem` como cualquier reembolso (reintento y
  "Problemas de pagos" incluidos). Sin efectos: fila `Pagado`, liquidación y reserva no se tocan
  (`efectosDeReembolso`). `NULL` en `Refund.mp_payment_id` = el pago de la liquidación.
- **`Payment.concept` es FK a `charge_types.key`**: los tipos (`Reserva`, `Disciplina`, `Socio`
  son de sistema) y las plantillas recurrentes viven en `/api/charge-types` y
  `/api/recurring-templates`. `lib/emission.ts` emite el ciclo vigente; es idempotente por `ref`.
- **Orden de pago:** una Cuota social no se paga antes que una pendiente anterior del mismo
  socio (`409 orden_de_pago`, `lib/payment-rules.ts`). Las reservas nunca bloquean.
- **La credencial sólo la bloquea una Cuota social `Pendiente` vencida** (`cuotasSocialesVencidas`).
  `EnRevision` y `due_date` nulo no cuentan; otros conceptos tampoco.
- **Mercado Pago:** `lib/mercadopago.ts` (cliente), `lib/payment-sync.ts` (webhook + conciliación;
  `syncPendingPayments` también se llama al leer la cuenta del socio). Variables `MP_*` en
  `.env.example`; sin `MP_ACCESS_TOKEN` el checkout responde 502 y el resto anda.
- **Reservas sin pagar:** sólo la pagada en el acto con MP lleva `Booking.hold_until` (5 minutos);
  la asignada por la gestión nace `Pendiente` sin plazo propio, el socio la paga desde
  `POST /api/bookings/:id/checkout` (que crea el pago si no hay uno vivo) y `liberarReservasVencidas`
  la cancela al pasar el límite para cancelar (`cancel_hours_before`), salvo que haya nacido ya
  dentro de esa ventana (`debeCancelarseSinPagar`).
- **Scheduler** (`lib/scheduler.ts`): emisión diaria, conciliación y reintento de reembolsos cada
  15 minutos, y liberación de reservas sin pagar cada minuto. `DISABLE_CRON=true` lo apaga
  (tests, segunda instancia).
- **Raw SQL:** palabras reservadas de MySQL 8 (`system`, `rank`, `key`, `groups`, `payments`...)
  siempre entre backticks. Un `P2034` (conflicto de escritura) se mapea a 409 con
  `esConflictoDeEscritura`.

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
