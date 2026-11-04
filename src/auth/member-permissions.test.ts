/**
 * B-T1: Matriz completa de permisos para miembros y dispositivos.
 * Cubre 4 actores × 3 acciones × 5 targets (owner/admin/editor/reader/self).
 */

import { describe, expect, it } from 'vitest';
import { canChangeRole, canRemoveMember, canRevokeDevice } from './member-permissions.js';

// ---------------------------------------------------------------------------
// canChangeRole — destino válido ∈ {admin, editor, reader}
// ---------------------------------------------------------------------------

describe('canChangeRole', () => {
  describe('destino owner → siempre invalid_role', () => {
    for (const actor of ['owner', 'admin', 'editor', 'reader'] as const) {
      for (const target of ['owner', 'admin', 'editor', 'reader'] as const) {
        it(`actor=${actor} target=${target} dest=owner → invalid_role`, () => {
          const r = canChangeRole(actor, target, 'owner');
          expect(r).toEqual({ allowed: false, reason: 'invalid_role' });
        });
      }
    }
  });

  describe('destino desconocido → invalid_role', () => {
    it('dest=superadmin → invalid_role', () => {
      expect(canChangeRole('owner', 'admin', 'superadmin')).toEqual({
        allowed: false,
        reason: 'invalid_role',
      });
    });
  });

  describe('owner como actor', () => {
    it('owner → target=admin, dest=editor → allowed', () => {
      expect(canChangeRole('owner', 'admin', 'editor')).toEqual({ allowed: true });
    });
    it('owner → target=editor, dest=admin → allowed', () => {
      expect(canChangeRole('owner', 'editor', 'admin')).toEqual({ allowed: true });
    });
    it('owner → target=reader, dest=editor → allowed', () => {
      expect(canChangeRole('owner', 'reader', 'editor')).toEqual({ allowed: true });
    });
    // Self = owner intentando cambiar su propio rol → last_owner
    it('owner → target=owner (self), dest=admin → last_owner', () => {
      expect(canChangeRole('owner', 'owner', 'admin')).toEqual({
        allowed: false,
        reason: 'last_owner',
      });
    });
    it('owner → target=owner (self), dest=reader → last_owner', () => {
      expect(canChangeRole('owner', 'owner', 'reader')).toEqual({
        allowed: false,
        reason: 'last_owner',
      });
    });
  });

  describe('admin como actor', () => {
    it('admin → target=admin, dest=editor → allowed', () => {
      expect(canChangeRole('admin', 'admin', 'editor')).toEqual({ allowed: true });
    });
    it('admin → target=editor, dest=reader → allowed', () => {
      expect(canChangeRole('admin', 'editor', 'reader')).toEqual({ allowed: true });
    });
    it('admin → target=reader, dest=admin → allowed', () => {
      expect(canChangeRole('admin', 'reader', 'admin')).toEqual({ allowed: true });
    });
    // Admin sobre owner → forbidden
    it('admin → target=owner, dest=editor → forbidden', () => {
      expect(canChangeRole('admin', 'owner', 'editor')).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
    });
    // Admin bajándose a sí mismo (admin→editor/reader)
    it('admin → target=admin (self), dest=reader → allowed', () => {
      expect(canChangeRole('admin', 'admin', 'reader')).toEqual({ allowed: true });
    });
    // Admin no puede promover a owner
    it('admin → target=editor, dest=owner → invalid_role', () => {
      expect(canChangeRole('admin', 'editor', 'owner')).toEqual({
        allowed: false,
        reason: 'invalid_role',
      });
    });
  });

  describe('editor como actor', () => {
    for (const target of ['owner', 'admin', 'editor', 'reader'] as const) {
      for (const dest of ['admin', 'editor', 'reader'] as const) {
        it(`editor → target=${target}, dest=${dest} → forbidden`, () => {
          expect(canChangeRole('editor', target, dest)).toEqual({
            allowed: false,
            reason: 'forbidden',
          });
        });
      }
    }
  });

  describe('reader como actor', () => {
    for (const target of ['owner', 'admin', 'editor', 'reader'] as const) {
      for (const dest of ['admin', 'editor', 'reader'] as const) {
        it(`reader → target=${target}, dest=${dest} → forbidden`, () => {
          expect(canChangeRole('reader', target, dest)).toEqual({
            allowed: false,
            reason: 'forbidden',
          });
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// canRemoveMember
// ---------------------------------------------------------------------------

describe('canRemoveMember', () => {
  describe('owner como actor', () => {
    it('owner quita admin → allowed', () => {
      expect(canRemoveMember('owner', 'admin')).toEqual({ allowed: true });
    });
    it('owner quita editor → allowed', () => {
      expect(canRemoveMember('owner', 'editor')).toEqual({ allowed: true });
    });
    it('owner quita reader → allowed', () => {
      expect(canRemoveMember('owner', 'reader')).toEqual({ allowed: true });
    });
    // Único owner no puede ser quitado
    it('owner intenta quitarse a sí mismo (único owner) → last_owner', () => {
      expect(canRemoveMember('owner', 'owner')).toEqual({
        allowed: false,
        reason: 'last_owner',
      });
    });
  });

  describe('admin como actor', () => {
    it('admin quita admin → allowed', () => {
      expect(canRemoveMember('admin', 'admin')).toEqual({ allowed: true });
    });
    it('admin quita editor → allowed', () => {
      expect(canRemoveMember('admin', 'editor')).toEqual({ allowed: true });
    });
    it('admin quita reader → allowed', () => {
      expect(canRemoveMember('admin', 'reader')).toEqual({ allowed: true });
    });
    // Admin no puede quitar al owner
    it('admin intenta quitar al owner → forbidden', () => {
      expect(canRemoveMember('admin', 'owner')).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
    });
  });

  describe('editor como actor', () => {
    for (const target of ['owner', 'admin', 'editor', 'reader'] as const) {
      it(`editor intenta quitar a ${target} → forbidden`, () => {
        expect(canRemoveMember('editor', target)).toEqual({
          allowed: false,
          reason: 'forbidden',
        });
      });
    }
  });

  describe('reader como actor', () => {
    for (const target of ['owner', 'admin', 'editor', 'reader'] as const) {
      it(`reader intenta quitar a ${target} → forbidden`, () => {
        expect(canRemoveMember('reader', target)).toEqual({
          allowed: false,
          reason: 'forbidden',
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// canRevokeDevice
// ---------------------------------------------------------------------------

describe('canRevokeDevice', () => {
  const actorId = 'actor-123';
  const otherId = 'other-456';

  describe('dispositivo propio (self) → cualquier rol puede revocar', () => {
    for (const role of ['owner', 'admin', 'editor', 'reader'] as const) {
      it(`${role} revoca su propio dispositivo → allowed`, () => {
        // actor y device pertenecen al mismo userId
        expect(canRevokeDevice(actorId, role, actorId, 'reader')).toEqual({ allowed: true });
      });
    }
  });

  describe('dispositivo ajeno — owner como actor', () => {
    it('owner revoca dispositivo de admin → allowed', () => {
      expect(canRevokeDevice(actorId, 'owner', otherId, 'admin')).toEqual({ allowed: true });
    });
    it('owner revoca dispositivo de editor → allowed', () => {
      expect(canRevokeDevice(actorId, 'owner', otherId, 'editor')).toEqual({ allowed: true });
    });
    it('owner revoca dispositivo de reader → allowed', () => {
      expect(canRevokeDevice(actorId, 'owner', otherId, 'reader')).toEqual({ allowed: true });
    });
  });

  describe('dispositivo ajeno — admin como actor', () => {
    it('admin revoca dispositivo de admin → allowed', () => {
      expect(canRevokeDevice(actorId, 'admin', otherId, 'admin')).toEqual({ allowed: true });
    });
    it('admin revoca dispositivo de editor → allowed', () => {
      expect(canRevokeDevice(actorId, 'admin', otherId, 'editor')).toEqual({ allowed: true });
    });
    it('admin revoca dispositivo de reader → allowed', () => {
      expect(canRevokeDevice(actorId, 'admin', otherId, 'reader')).toEqual({ allowed: true });
    });
    // Admin no puede revocar dispositivos del owner
    it('admin intenta revocar dispositivo de owner → forbidden', () => {
      expect(canRevokeDevice(actorId, 'admin', otherId, 'owner')).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
    });
  });

  describe('dispositivo ajeno — editor como actor', () => {
    for (const ownerRole of ['owner', 'admin', 'editor', 'reader'] as const) {
      it(`editor intenta revocar dispositivo de ${ownerRole} → forbidden`, () => {
        expect(canRevokeDevice(actorId, 'editor', otherId, ownerRole)).toEqual({
          allowed: false,
          reason: 'forbidden',
        });
      });
    }
  });

  describe('dispositivo ajeno — reader como actor', () => {
    for (const ownerRole of ['owner', 'admin', 'editor', 'reader'] as const) {
      it(`reader intenta revocar dispositivo de ${ownerRole} → forbidden`, () => {
        expect(canRevokeDevice(actorId, 'reader', otherId, ownerRole)).toEqual({
          allowed: false,
          reason: 'forbidden',
        });
      });
    }
  });
});
