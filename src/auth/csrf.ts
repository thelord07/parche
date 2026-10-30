import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * CSRF protection hook for /api/web/* mutations.
 * Requires:
 *   - Content-Type: application/json
 *   - X-Parche-CSRF: 1
 *
 * Only applies to non-GET/HEAD methods.
 * CLI Bearer endpoints (/api/join, /api/blob/*, /api/g/*) are NOT affected.
 */
export async function csrfHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Only check mutations
  if (request.method === 'GET' || request.method === 'HEAD') {
    return;
  }

  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) {
    return reply.status(403).send({ error: 'csrf' });
  }

  const csrfHeader = request.headers['x-parche-csrf'];
  if (csrfHeader !== '1') {
    return reply.status(403).send({ error: 'csrf' });
  }
}
