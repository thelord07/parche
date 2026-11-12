import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kindsOf, SCAN_MAX_BYTES, scanBuffer } from './scan-blob.js';

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
