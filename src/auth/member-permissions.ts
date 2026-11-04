import type { Role } from '@chamba/core';
import { can } from '@chamba/core';

/**
 * Resultado tipado para operaciones de permisos de miembros.
 * Permite que los endpoints mapeen el motivo a códigos HTTP precisos.
 */
export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: 'forbidden' | 'last_owner' | 'invalid_role' };

/** Roles válidos como destino de un cambio de rol (owner NO es asignable en B). */
const VALID_DEST_ROLES: ReadonlySet<string> = new Set(['admin', 'editor', 'reader']);

/**
 * ¿Puede el actor cambiar el rol de un miembro target al rol destino?
 *
 * Casos de error:
 *   - destRole === 'owner' → invalid_role (no se permite en B; O-TRANSFER)
 *   - destRole no reconocido → invalid_role
 *   - targetCurrentRole === 'owner' → last_owner (el único owner no puede ser demoteado)
 *   - actor no tiene permiso sobre targetCurrentRole o destRole → forbidden
 *
 * Nota sobre "self": el caller pasa (actorRole, 'owner', destRole) cuando el actor
 * intenta bajarse a sí mismo siendo el único owner, con lo que cae en last_owner.
 * Si admin quiere bajarse a sí mismo, pasa (admin, 'admin', destRole) → `can` permite.
 *
 * Mapeo remove→revoke: `can()` no expone 'remove' como SyncAction; se gatea con
 * `can(actor,'revoke',targetRole)` porque quitar a un miembro revoca todos sus
 * dispositivos. Semánticamente equivalente: solo owner/admin tienen revoke, y
 * admin no puede sobre owner — la misma matriz que change_role.
 */
export function canChangeRole(
  actorRole: Role,
  targetCurrentRole: Role,
  destRole: string,
): PermissionResult {
  // Destino owner → siempre invalid_role (no hay transferencia en B)
  if (destRole === 'owner' || !VALID_DEST_ROLES.has(destRole)) {
    return { allowed: false, reason: 'invalid_role' };
  }

  // El único owner no puede ser demoteado (invariante last_owner)
  if (targetCurrentRole === 'owner') {
    // Si el actor es owner intentando cambiar su propio rol: last_owner
    // Si el actor es admin intentando tocar al owner: forbidden
    if (actorRole === 'owner') {
      return { allowed: false, reason: 'last_owner' };
    }
    // Para cualquier otro actor: `can` devuelve false para owner target
    return { allowed: false, reason: 'forbidden' };
  }

  // Verificar permiso sobre el rol actual del target
  if (!can(actorRole, 'change_role', targetCurrentRole)) {
    return { allowed: false, reason: 'forbidden' };
  }

  // Verificar permiso sobre el rol destino
  if (!can(actorRole, 'change_role', destRole as Role)) {
    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: true };
}

/**
 * ¿Puede el actor quitar a un miembro con el rol target?
 *
 * - El único owner no puede ser quitado → last_owner
 * - Usa can(actor,'revoke',targetRole) como gate (ver nota en canChangeRole)
 */
export function canRemoveMember(actorRole: Role, targetCurrentRole: Role): PermissionResult {
  // El único owner no puede ser quitado (aplica también a owner quitándose a sí mismo)
  if (targetCurrentRole === 'owner') {
    if (actorRole === 'owner') {
      return { allowed: false, reason: 'last_owner' };
    }
    // admin u otro intentando quitar al owner → forbidden
    return { allowed: false, reason: 'forbidden' };
  }

  if (!can(actorRole, 'revoke', targetCurrentRole)) {
    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: true };
}

/**
 * ¿Puede el actor revocar un dispositivo que pertenece a deviceUserId con rol deviceOwnerRole?
 *
 * Regla "self": cualquier rol puede revocar sus propios dispositivos.
 * Para ajenos: can(actor,'revoke',deviceOwnerRole).
 */
export function canRevokeDevice(
  actorUserId: string,
  actorRole: Role,
  deviceUserId: string,
  deviceOwnerRole: Role,
): PermissionResult {
  // Dispositivo propio → siempre permitido
  if (deviceUserId === actorUserId) {
    return { allowed: true };
  }

  // Dispositivo ajeno → verificar permiso por rol
  if (!can(actorRole, 'revoke', deviceOwnerRole)) {
    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: true };
}
