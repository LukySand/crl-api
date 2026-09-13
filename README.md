# CRL API — Backend (Express + Bun + Prisma)

Backend del Sistema CRL. Express corrido con **Bun**, Prisma 7 con adapter MariaDB sobre MySQL 8+.
Sirve solo `/api/*`. El frontend (repo aparte) le pega vía proxy.

## Requisitos

- [Bun](https://bun.sh) `>= 1.0`
- **MySQL 8 o superior**, por cualquiera de estas dos vías:
  - [Docker](https://docker.com) con Docker Compose (camino por defecto del equipo), o
  - un MySQL instalado localmente, escuchando en `127.0.0.1:3306`

## Puesta en marcha

```bash
bun install
cp .env.example .env   # completá los valores (o usá tu .env actual)
```

### Opción A — MySQL con Docker

```bash
bun run setup   # levanta el contenedor, genera Prisma, aplica schema y siembra
```

`bun run setup` **requiere Docker corriendo**: hace `docker compose up -d db` y después
espera a que el contenedor `mysql-dev` quede healthy. Si no tenés Docker levantado, el
script se queda esperando para siempre. En ese caso usá la Opción B.

### Opción B — MySQL local (sin Docker)

Si ya tenés tu propio MySQL corriendo, salteá `bun run setup` y hacé los pasos a mano:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS crl_db;"
bun run db:generate   # genera el cliente Prisma
bun run db:push       # aplica el schema
bun run db:seed       # siembra roles (+ datos demo en dev)
```

Revisá que `DATABASE_URL` en tu `.env` apunte a tu server local y lleve
`?allowPublicKeyRetrieval=true` (ver Problemas conocidos).

### Levantar el API

```bash
bun dev
```

API en `http://localhost:3001`. Verificá: `curl http://localhost:3001/api/health` → `{"ok":true}`.

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/health` | Healthcheck |
| POST | `/api/auth/login` | Login con `{ dni, password }` |
| POST | `/api/auth/register` | Alta de Socio + auto-login |
| GET | `/api/auth/verify` | Valida token (header `Authorization: Bearer` o cookie `auth_token`) |
| POST | `/api/auth/logout` | Limpia cookie de sesión |
| PUT | `/api/files` | Sube una imagen (`multipart/form-data`) |
| GET | `/api/files?id=:id` | Obtiene una imagen por id |
| DELETE | `/api/files?fileId=:id` | Elimina una imagen por id |

### Rutas de uso (`files`)

- Subir imagen: `PUT /api/files`
	- Form-data requerido: `file`, `kind`, `name`, `user_id`
	- Tipos:
		- `file`: archivo (`File`)
		- `kind`: `string` (valores: `accountImages` | `postImages` | `localImages`)
		- `name`: `string`
		- `user_id`: `number` entero
	- Tipos permitidos de imagen: `image/jpeg`, `image/png`, `image/heif`, `image/heic`, `image/webp`, `image/tiff`, `image/bmp`, `image/avif`
- Ver imagen por id: `GET /api/files?id=<fileId>`
	- Tipo de `fileId`: `number` entero
- Eliminar imagen: `DELETE /api/files?fileId=<fileId>`
	- Tipo de `fileId`: `number` entero

## Comandos

| Comando | Qué hace |
| --- | --- |
| `bun dev` | Servidor con hot reload |
| `bun start` | Servidor en modo producción |
| `bun run setup` | DB (Docker) + Prisma generate + push + seed (idempotente) |
| `bun run db:generate` | Regenera el cliente Prisma |
| `bun run db:push` | Aplica el schema sin crear migración |
| `bun run db:seed` | Siembra roles (+ datos demo en dev) |
| `bun run db:studio` | UI de Prisma para explorar la DB |
| `bun run db:migrate` | Crear/aplicar migraciones |
| `docker compose up -d db` | Solo la base de datos (Docker) |

> `bun run db:migrate` (`prisma migrate dev`) pide **resetear la base** por el drift de dev.
> No lo corras sin avisar al equipo.

## Base de datos (DBeaver u otro cliente)

| Campo | Valor |
| --- | --- |
| Host | `127.0.0.1` |
| Puerto | `3306` |
| Base | `crl_db` |
| Usuario | `root` |
| Contraseña | la de tu `.env` |

> DBeaver con MySQL 8+: en Driver Properties poné `allowPublicKeyRetrieval=true` (solo dev).

## Problemas conocidos

### `pool timeout: failed to retrieve a connection from pool after 10001ms`

El adapter no logra abrir la conexión. Hay dos causas, y se pueden dar juntas:

**1. `localhost` en vez de `127.0.0.1`.** En Mac, Bun resuelve `localhost` a IPv6, el adapter
de MariaDB se cuelga 10s y falla. Usá siempre `127.0.0.1` en `DATABASE_URL`.

**2. `caching_sha2_password` sin `allowPublicKeyRetrieval`.** Es el plugin de auth por defecto
desde MySQL 8. Con la caché de credenciales fría, el server exige el intercambio de clave
pública RSA, y el adapter se niega a pedirla sobre una conexión sin TLS. Agregá el flag:

```
DATABASE_URL="mysql://root:TUPASS@127.0.0.1:3306/crl_db?allowPublicKeyRetrieval=true"
```

Es inofensivo con Docker, así que conviene dejarlo puesto siempre.

Ojo con el síntoma: después de que alguien se conecta una vez (por ejemplo con el cliente
`mysql`), MySQL cachea las credenciales y **el error desaparece solo**. Vuelve cuando
reiniciás MySQL. Si el bug te parece intermitente, es esto.

El workaround clásico (`ALTER USER ... IDENTIFIED WITH mysql_native_password`) **no sirve en
MySQL 9**: ese plugin fue eliminado. El flag es el único camino.

### `bun run setup` se queda en "esperando DB"

El script espera un contenedor Docker llamado `mysql-dev`. Si usás un MySQL local no lo corras:
seguí la Opción B de la puesta en marcha.
