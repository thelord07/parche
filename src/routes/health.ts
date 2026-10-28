import type { FastifyInstance } from 'fastify';
import { VERSION } from '../version.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok', version: VERSION });
  });
}
