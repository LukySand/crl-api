/**
 * Varios roles por usuario: una persona puede ser Profesor y Socio a la vez, y los
 * permisos se suman. La fuente de verdad es la tabla `UserRole`.
 *
 * Todo lo que decide sobre roles vive acá y es puro (sin Prisma) para poder
 * testearlo sin base.
 */

/** De más a menos acceso. */
export const ROLE_ORDER = ["SuperAdmin", "Administrador", "Profesor", "Socio"] as const;
export type RoleName = (typeof ROLE_ORDER)[number];

/** Roles con permisos de gestión. */
export const ADMIN_ROLES = ["SuperAdmin", "Administrador"] as const;

/** Lo que hay que pedirle a Prisma para saber los roles de un usuario. */
export const rolesInclude = {
  roles: { select: { role: { select: { name: true } } } },
} as const;

type ConRoles = {
  roles: { role: { name: string } }[];
};

/** Los nombres de los roles de un usuario, ordenados de más a menos acceso. */
export function nombresDeRoles(user: ConRoles): string[] {
  return ordenarRoles(user.roles.map((r) => r.role.name));
}

/** Sin repetidos y en el orden de `ROLE_ORDER`. */
export function ordenarRoles(roles: string[]): string[] {
  return ROLE_ORDER.filter((r) => roles.includes(r));
}

export function tieneRol(roles: readonly string[], ...buscados: readonly string[]): boolean {
  return roles.some((r) => buscados.includes(r));
}

export const esGestion = (roles: readonly string[]) => tieneRol(roles, ...ADMIN_ROLES);

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
