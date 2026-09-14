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
| GET | `/api/families` | Hijos a cargo del usuario logueado (`?all=true` incluye desvinculados) |
| POST | `/api/families/children` | Da de alta a un hijo y lo vincula (sin credenciales propias) |
| PATCH | `/api/families/:id/credentials` | Carga email + password reales al hijo vinculado |
| PATCH | `/api/families/:id/photo` | Asocia al hijo una foto ya subida con `PUT /api/files` |
| PATCH | `/api/families/:id/unlink` | Desvincula al hijo (`Family.active = false`) |
| PATCH | `/api/socio/password` | Cambia la contraseña propia (pide la actual) |

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

### Rutas de uso (`families`)

Flujo de un padre/tutor con hijos a cargo. Todas requieren sesión; el padre sale del
token, nunca de un id que mande el cliente. El `:id` de `/families/:id/*` es el id del
**vínculo** (`Family`), no del hijo.

- Dar de alta un hijo: `POST /api/families/children`
	- Body: `{ name, last_name, dni, birth_date, file_id? }`
	- El hijo se crea **sin** email/password propios (`has_credentials: false`) y queda
	  vinculado (`Family.active: true`). Tiene que ser menor de 18.
	- `409` si el DNI ya está registrado.
- Listar hijos a cargo: `GET /api/families` (`?all=true` trae también los desvinculados)
- Cargar credenciales reales al hijo: `PATCH /api/families/:id/credentials`
	- Body: `{ email, password }`
	- Después de esto el hijo puede loguearse solo (`has_credentials: true`).
	- Requiere que el vínculo siga activo (`409` si ya se desvinculó).
- Asociar una foto al hijo: `PATCH /api/families/:id/photo`
	- Body: `{ file_id }` (de un `PUT /api/files` anterior, esto no sube nada)
	- Mismas reglas que `credentials` (activo, dueño del vínculo).
- Desvincular al hijo: `PATCH /api/families/:id/unlink`
	- Pone `Family.active = false`. El hijo deja de listarse en `GET /api/families` del
	  padre; si ya tenía credenciales propias, sigue entrando con su cuenta igual que antes.
- Cambiar la propia contraseña: `PATCH /api/socio/password`
	- Body: `{ current_password, new_password }` — pensado para que el hijo cambie la que
	  le cargó el padre.

Detalle completo (shapes de respuesta, códigos de error) en `FAMILY_FLOW.md`.

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
