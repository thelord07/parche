import { createHash, randomUUID } from 'node:crypto';
import type { Finding } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import {
  findingsPayload,
  kindsOf,
  MAX_FINDINGS_IN_RESPONSE,
  SCAN_MAX_BYTES,
  scanBuffer,
} from './scan-blob.js';

describe('scanBuffer', () => {
  it('finds a parche-token and an aws-access-key without ever returning the value', async () => {
    const secret = 'pch_abcdefgh12345678';
    const text = `linea limpia\ntoken: ${secret}\naws: AKIAIOSFODNN7EXAMPLE\n`;
    const findings = await scanBuffer(Buffer.from(text, 'utf8'), 'blob');

    expect(findings).not.toBeNull();
    expect(findings).not.toHaveLength(0);
    const json = JSON.stringify(findings);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('AKIAIOSFODNN7EXAMPLE');
    const kinds = kindsOf(findings!);
    expect(kinds).toContain('aws-access-key');
    expect(kinds).toContain('parche-token');
    for (const f of findings!) {
      expect(f).toHaveProperty('kind');
      expect(f).toHaveProperty('line');
      expect(f).toHaveProperty('fingerprint');
      expect(Object.keys(f).sort()).toEqual(['fingerprint', 'kind', 'line', 'path']);
    }
  });

  it('returns null for binary (non-UTF-8) content', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const result = await scanBuffer(binary, 'blob');
    expect(result).toBeNull();
  });

  it('returns null for buffers larger than SCAN_MAX_BYTES', async () => {
    const big = Buffer.alloc(SCAN_MAX_BYTES + 1, 'a');
    const result = await scanBuffer(big, 'blob');
    expect(result).toBeNull();
  });

  it('returns [] for clean text', async () => {
    const result = await scanBuffer(Buffer.from('nada que ver aquí\n', 'utf8'), 'blob');
    expect(result).toEqual([]);
  });

  it('fingerprint matches sha256(`${kind}\\n${value}`).slice(0, 12) — contract with the client allowlist', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const text = `aws: ${secret}\n`;
    const findings = await scanBuffer(Buffer.from(text, 'utf8'), 'blob');
    expect(findings).toHaveLength(1);

    const expected = createHash('sha256')
      .update(`aws-access-key\n${secret}`)
      .digest('hex')
      .slice(0, 12);
    expect(findings![0]!.fingerprint).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 — T1: reglas nuevas de @chamba/core ^1.15.1 (Stripe).
// ---------------------------------------------------------------------------
describe('scanBuffer — reglas de @chamba/core 1.15.1 (T1)', () => {
  it('un UUID generado dinámicamente (patrón de código, no un secreto) no genera hallazgo', async () => {
    const line = `const token = crypto.randomUUID(); // ${randomUUID()}\n`;
    const findings = await scanBuffer(Buffer.from(line, 'utf8'), 'blob');
    expect(findings).toEqual([]);
  });

  it('un sk_live_ falso genera un hallazgo stripe-secret-key', async () => {
    const secret = 'sk_' + 'live_' + '51H8FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
    const text = `stripe: ${secret}\n`;
    const findings = await scanBuffer(Buffer.from(text, 'utf8'), 'blob');
    expect(findings).not.toBeNull();
    const json = JSON.stringify(findings);
    expect(json).not.toContain(secret);
    // toContain, no toEqual: sk_live_ en "key: value" también matchea la
    // regla genérica `assignment` — el punto del test es stripe-secret-key.
    const kinds = kindsOf(findings!);
    expect(kinds).toContain('stripe-secret-key');
  });

  it('rk_live_ (restricted key) y whsec_ (webhook secret) generan hallazgo', async () => {
    const restricted = 'rk_' + 'live_' + '51H8FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
    const findingsA = await scanBuffer(Buffer.from(`stripe: ${restricted}\n`, 'utf8'), 'blob');
    expect(kindsOf(findingsA!)).toContain('stripe-restricted-key');

    const webhook = 'whs' + 'ec_' + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
    const findingsB = await scanBuffer(Buffer.from(`stripe: ${webhook}\n`, 'utf8'), 'blob');
    expect(kindsOf(findingsB!)).toContain('stripe-webhook-secret');
  });

  it('pk_live_ (publishable key, pública) no genera hallazgo', async () => {
    const publishable = 'pk_live_51H8FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
    const findings = await scanBuffer(Buffer.from(`stripe: ${publishable}\n`, 'utf8'), 'blob');
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 — findingsPayload: proyección del 422 (A7/A8/A9).
// ---------------------------------------------------------------------------
describe('findingsPayload', () => {
  it('proyecta solo {kind, fingerprint}, nunca line/path/el valor', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const findings = await scanBuffer(Buffer.from(`aws: ${secret}\n`, 'utf8'), 'blob');
    const payload = findingsPayload(findings!, new Set());
    expect(payload).toHaveLength(1);
    expect(Object.keys(payload[0]!).sort()).toEqual(['fingerprint', 'kind']);
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it('dedupe por (kind, fingerprint)', () => {
    const f: Finding = {
      kind: 'aws-access-key',
      fingerprint: 'abc123def456',
      line: 1,
      path: 'blob',
    };
    const payload = findingsPayload([f, f, f], new Set());
    expect(payload).toHaveLength(1);
  });

  it('prioriza los NO exentos cuando el tope recorta', () => {
    const exempt: Finding = {
      kind: 'aws-access-key',
      fingerprint: 'aaaaaaaaaaaa',
      line: 1,
      path: 'blob',
    };
    const notExempt: Finding = {
      kind: 'aws-access-key',
      fingerprint: 'bbbbbbbbbbbb',
      line: 1,
      path: 'blob',
    };
    const payload = findingsPayload([exempt, notExempt], new Set(['aaaaaaaaaaaa']));
    expect(payload[0]!.fingerprint).toBe('bbbbbbbbbbbb');
    expect(payload[1]!.fingerprint).toBe('aaaaaaaaaaaa');
  });

  it(`tope de ${MAX_FINDINGS_IN_RESPONSE} entradas, no exentas primero`, () => {
    const findings: Finding[] = Array.from({ length: MAX_FINDINGS_IN_RESPONSE + 10 }, (_, i) => ({
      kind: 'aws-access-key',
      fingerprint: i.toString().padStart(12, '0'),
      line: 1,
      path: 'blob',
    }));
    // Las últimas 10 (por fingerprint) están exentas — deben quedar fuera del
    // tope porque las no exentas (las primeras MAX_FINDINGS_IN_RESPONSE) ya
    // llenan la respuesta.
    const allowed = new Set(findings.slice(MAX_FINDINGS_IN_RESPONSE).map((f) => f.fingerprint));
    const payload = findingsPayload(findings, allowed);
    expect(payload).toHaveLength(MAX_FINDINGS_IN_RESPONSE);
    expect(payload.every((f) => !allowed.has(f.fingerprint))).toBe(true);
  });
});
