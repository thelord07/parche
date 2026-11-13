import type { FastifyInstance } from 'fastify';
import type { SecretScanStatus } from '../secrets/scan-status.js';
import { VERSION } from '../version.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const secretScanStatus = app.secretScanStatus as SecretScanStatus | undefined;
    return reply.status(200).send({
      status: 'ok',
      version: VERSION,
      metaBackfill: (app.metaStatus as { backfill: string } | undefined)?.backfill ?? 'idle',
      // PARCHE-013 (D3) — estado del re-escaneo de secretos: nunca rutas ni
      // valores, solo state/rulesVersion/pending/scanned.
      secretScan: {
        state: secretScanStatus?.scan ?? 'idle',
        rulesVersion: secretScanStatus?.rulesVersion ?? null,
        pending: secretScanStatus?.pending ?? 0,
        scanned: secretScanStatus?.scanned ?? 0,
      },
    });
  });
}
