/**
 * Varios roles por usuario: una persona puede ser Profesor y Socio a la vez, y los
 * permisos se suman. La fuente de verdad es la tabla `UserRole`; `User.role_id`
 * queda como espejo del rol principal hasta el PR de limpieza.
 *
 * Todo lo que decide sobre roles vive acá y es puro (sin Prisma) para poder
 * testearlo sin base.
 */

/** De más a menos acceso. El primero que tenga un usuario es su rol principal. */
export const ROLE_ORDER = ["SuperAdmin", "Administrador", "Profesor", "Socio"] as const;
export type RoleName = (typeof ROLE_ORDER)[number];

/** Roles con permisos de gestión. */
export const ADMIN_ROLES = ["SuperAdmin", "Administrador"] as const;

/**
 * Lo que hay que pedirle a Prisma para saber los roles de un usuario. Trae también
 * el `role` viejo: ver `nombresDeRoles`.
 */
export const rolesInclude = {
  role: { select: { name: true } },
  roles: { select: { role: { select: { name: true } } } },
} as const;

type ConRoles = {
  role: { name: string };
  roles: { role: { name: string } }[];
};

/**
 * Los nombres de los roles de un usuario, ordenados de más a menos acceso.
 *
 * ponytail: si no tiene filas en `UserRole` cae al `role_id` viejo. Pasa con los
 * usuarios que creó una rama que todavía no escribe la tabla nueva, o en una base
 * de dev donde no se volvió a correr el seed. Se va con la columna.
 */
export function nombresDeRoles(user: ConRoles): string[] {
  const nombres = user.roles.length ? user.roles.map((r) => r.role.name) : [user.role.name];
  return ordenarRoles(nombres);
}

/** Sin repetidos y en el orden de `ROLE_ORDER`. */
export function ordenarRoles(roles: string[]): string[] {
  return ROLE_ORDER.filter((r) => roles.includes(r));
}

/** El de más acceso. Es el que va en `User.role_id` y en el `role` del token. */
export function rolPrincipal(roles: string[]): RoleName {
  return ordenarRoles(roles)[0] as RoleName;
}

export function tieneRol(roles: readonly string[], ...buscados: readonly string[]): boolean {
  return roles.some((r) => buscados.includes(r));
}

export const esGestion = (roles: readonly string[]) => tieneRol(roles, ...ADMIN_ROLES);

/**
 * Qué roles guardar al editar un usuario.
 *
 * ponytail: puente mientras la pantalla de Usuarios mande un solo `role`. Esa
 * pantalla muestra el rol principal en un select; si se guarda sin tocarlo, llega
 * el mismo principal y no hay que pisar los demás roles — si no, editarle el
 * celular a una profe que además es socia le borraría el rol Socio. Si el select
 * cambió, se reemplaza como siempre. Se va cuando el front mande `roles`.
 */
export function rolesParaGuardar(p: {
  pedidos: string[];
  antes: string[];
  vinoRolSuelto: boolean;
}): string[] {
  if (p.vinoRolSuelto && p.pedidos.length === 1 && p.pedidos[0] === rolPrincipal(p.antes)) {
    return ordenarRoles(p.antes);
  }
  return p.pedidos;
}

/** ¿La combinación de roles es válida? Devuelve el error o null. */
export function validarRoles(roles: string[]): string | null {
  if (!roles.length) return "Elegí al menos un rol";
  // SuperAdmin ya incluye todo lo de Administrador: tener los dos no suma nada y
  // deja dos formas de decir lo mismo.
  if (roles.includes("SuperAdmin") && roles.includes("Administrador")) {
    return "SuperAdmin y Administrador no van juntos";
  }
  return null;
}

/**
 * ¿Puede `actor` dejarle a `target` los roles `despues`? Devuelve el error (con su
 * status) o null. Las reglas:
 *  - Una cuenta que es o pasa a ser SuperAdmin sólo la toca un SuperAdmin.
 *  - Nadie se saca a sí mismo el rol de gestión: se quedaría afuera del panel sin
 *    nadie que lo note. Otro admin sí puede sacárselo.
 */
export function denyCambioDeRoles(p: {
  actorId: string;
  actorRoles: readonly string[];
  targetId: string;
  antes: readonly string[];
  despues: readonly string[];
}): { status: number; error: string } | null {
  const tocaSuperAdmin = p.antes.includes("SuperAdmin") || p.despues.includes("SuperAdmin");
  if (tocaSuperAdmin && !p.actorRoles.includes("SuperAdmin")) {
    return { status: 403, error: "Solo un SuperAdmin puede gestionar cuentas SuperAdmin" };
  }
  if (p.actorId === p.targetId && esGestion(p.antes) && !esGestion(p.despues)) {
    return { status: 400, error: "No podés sacarte tu propio rol de gestión" };
  }
  return null;
}
