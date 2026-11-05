import type { Role } from '@chamba/core';

/**
 * Visibilidad de email entre miembros del grupo.
 *
 * Regla (decisión de usuario 2026-11-04):
 *   - owner y admin ven el email de cualquier miembro.
 *   - editor y reader solo ven su propio email; el de otros se omite (nunca vacío).
 *
 * Uso:
 *   canSeeEmails(viewerRole) → true si el viewer ve emails ajenos
 *   redactEmail(email, viewerId, rowUserId, viewerRole) → email o undefined
 */

/**
 * Devuelve true si el rol del viewer le permite ver emails ajenos.
 */
function canSeeEmails(viewerRole: Role): boolean {
  return viewerRole === 'owner' || viewerRole === 'admin';
}

/**
 * Devuelve el email si debe ser visible para el viewer, undefined si debe omitirse.
 *
 * @param email       - Email del usuario al que pertenece el dato.
 * @param rowUserId   - Id del usuario al que pertenece el dato.
 * @param viewerUserId - Id del usuario que hace la solicitud.
 * @param viewerRole  - Rol del viewer en el grupo.
 */
export function redactEmail(
  email: string,
  rowUserId: string,
  viewerUserId: string,
  viewerRole: Role,
): string | undefined {
  // El propio email siempre es visible
  if (rowUserId === viewerUserId) return email;
  // owner y admin ven todos los emails
  if (canSeeEmails(viewerRole)) return email;
  // editor y reader: omitir
  return undefined;
}
