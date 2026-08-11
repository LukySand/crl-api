# CRL API — Backend (Express + Bun + Prisma)

Backend del Sistema CRL. Express corrido con **Bun**, Prisma 7 con adapter MariaDB sobre MySQL 8.
Sirve solo `/api/*`. El frontend (repo aparte) le pega vía proxy.

## Requisitos

- [Bun](https://bun.sh) `>= 1.0`
- [Docker](https://docker.com) con Docker Compose

## Puesta en marcha (2 comandos)

```bash
bun install
```

```bash
cp .env.example .env   # completá los valores (o usá tu .env actual)
bun run setup          # levanta MySQL, genera Prisma, aplica schema y siembra roles
```

Después, el servidor de desarrollo:

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
| `bun run setup` | DB + Prisma generate + push + seed (idempotente) |
| `bun run db:studio` | UI de Prisma para explorar la DB |
| `bun run db:migrate` | Crear/aplicar migraciones |
| `docker compose up -d db` | Solo la base de datos |

## Base de datos (DBeaver u otro cliente)

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Puerto | `3306` |
| Base | `crl_db` |
| Usuario | `root` |
| Contraseña | la de tu `.env` |

> DBeaver con MySQL 8: en Driver Properties poné `allowPublicKeyRetrieval=true` (solo dev).
