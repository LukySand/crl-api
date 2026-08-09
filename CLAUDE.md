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
├── server.ts             # Express: json middleware, /api/health, monta authRouter
├── lib/
│   ├── prisma.ts         # cliente Prisma + adapter MariaDB (singleton en dev)
│   └── validation.ts     # Zod — DUPLICADO con el frontend (ver abajo)
└── routes/
    └── auth.ts           # authRouter (todos los endpoints actuales)

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

### Seguridad — regla al agregar endpoints

El usuario **siempre** se resuelve desde el JWT, nunca desde un `user_id` del body/query/params.
Confiar en un ID que manda el cliente es IDOR (cualquiera edita recursos ajenos). Todo endpoint
que opere "sobre mí" saca el `id` del token verificado.

---

## Modelo de datos

`Role` (enum `Administrador` / `Profesor` / `Socio`), `User`, `File`, `Family` (vincula menores
a un tutor responsable).

**IDs: `User`, `File` y `Family` usan UUID (`String @id @default(uuid())`).** Solo `Role.id` es
`Int` autoincremental. Migrado desde int en el commit `4db61f3`.

Falta todo el modelo de cuotas, pagos, espacios, reservas, locales adheridos y publicaciones.

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

Construido: **solo auth**. Falta todo lo grande de la propuesta: tarjeta digital de socio con
foto, gestión de socios y menores, cuotas de socio + de disciplina, pagos (Mercado Pago /
comprobante de transferencia), reservas de canchas y salón, publicaciones institucionales,
locales adheridos con beneficios, reportes de ingresos.

## Deuda conocida

- El registro normal (dni+password) **no verifica el email**. Alguien podría registrar un email
  ajeno antes de que el dueño entre por Google.
- `email` no tiene constraint `@unique` en el schema; el register solo chequea DNI duplicado.
