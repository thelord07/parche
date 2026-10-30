/**
 * B1(a) — mailer test: the sent message's text and html contain `/auth#<token>`
 * and do NOT contain `/auth/<token>` (token must never be in a URL path).
 */

import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMailer } from './mailer.js';

describe('createMailer — sendMagicLink', () => {
  let sent: { text: string; html: string }[];

  beforeEach(() => {
    sent = [];
  });

  afterEach(() => {
    sent = [];
  });

  function makeTransport() {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const original = transport.sendMail.bind(transport);
    transport.sendMail = async (opts) => {
      const result = await original(opts);
      const parsed = JSON.parse((result as { message: string }).message) as {
        text: string;
        html: string;
      };
      sent.push({ text: parsed.text ?? '', html: parsed.html ?? '' });
      return result;
    };
    return transport;
  }

  it('text and html contain /auth#<token> (fragment-based link)', async () => {
    const transport = makeTransport();
    const mailer = createMailer(transport, {
      from: 'parche@example.com',
      publicUrl: 'https://parche.chamba.tools',
    });

    const token = 'abc123token';
    await mailer.sendMagicLink({ to: 'user@example.com', token });

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg).toBeDefined();
    expect(msg?.text).toContain(`/auth#${token}`);
    expect(msg?.html).toContain(`/auth#${token}`);
  });

  it('text and html do NOT contain /auth/<token> (token never in URL path)', async () => {
    const transport = makeTransport();
    const mailer = createMailer(transport, {
      from: 'parche@example.com',
      publicUrl: 'https://parche.chamba.tools',
    });

    const token = 'secrettoken456';
    await mailer.sendMagicLink({ to: 'user@example.com', token });

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg).toBeDefined();
    expect(msg?.text).not.toContain(`/auth/${token}`);
    expect(msg?.html).not.toContain(`/auth/${token}`);
  });

  it('uses publicUrl for the link, never the Host header', async () => {
    const transport = makeTransport();
    const mailer = createMailer(transport, {
      from: 'parche@example.com',
      publicUrl: 'https://parche.chamba.tools',
    });

    const token = 'tokenxyz';
    await mailer.sendMagicLink({ to: 'user@example.com', token });

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg?.text).toContain('https://parche.chamba.tools/auth#tokenxyz');
    expect(msg?.html).toContain('https://parche.chamba.tools/auth#tokenxyz');
  });
});
