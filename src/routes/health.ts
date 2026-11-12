import type { FastifyInstance } from 'fastify';
import { VERSION } from '../version.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      version: VERSION,
      metaBackfill: (app.metaStatus as { backfill: string } | undefined)?.backfill ?? 'idle',
      secretScan: (app.secretScanStatus as { scan: string } | undefined)?.scan ?? 'idle',
    });
  });
}
