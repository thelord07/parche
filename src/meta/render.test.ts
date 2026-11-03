import { describe, expect, it } from 'vitest';
import { renderNote } from './render.js';

const emptyPaths = new Set<string>();
const slug = 'test-group';

describe('renderNote', () => {
  it('renders basic markdown', () => {
    const html = renderNote('# Hola\n\nMundo', slug, emptyPaths);
    expect(html).toContain('<h1>');
    expect(html).toContain('Hola');
    expect(html).toContain('Mundo');
  });

  it('resolves wikilink to known path', () => {
    const paths = new Set(['auth/flujo-login.md']);
    const html = renderNote('Ver [[flujo-login]]', slug, paths);
    expect(html).toContain('class="wl"');
    expect(html).toContain('/g/test-group/n/auth/flujo-login.md');
  });

  it('renders dead wikilink as span.wl-dead for unknown path', () => {
    const html = renderNote('Ver [[desconocido]]', slug, emptyPaths);
    expect(html).toContain('wl-dead');
    expect(html).toContain('desconocido');
  });

  it('encodes path segments in wikilinks (ñ and spaces)', () => {
    const paths = new Set(['auth/flujo login (ñ).md']);
    const html = renderNote('[[flujo login (ñ).md]]', slug, paths);
    expect(html).toContain('flujo%20login%20(%C3%B1).md');
  });

  it('renders embed wikilink as img', () => {
    const paths = new Set(['images/foto.png']);
    const html = renderNote('![[foto.png]]', slug, paths);
    expect(html).toContain('<img');
    expect(html).toContain('/api/web/g/test-group/raw?path=');
  });

  it('adds rel noopener to external links', () => {
    const html = renderNote('[Google](https://google.com)', slug, emptyPaths);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  // A4: XSS tests — verify no executable HTML, not just string absence
  // With html:false, raw HTML is escaped to text (&lt;...&gt;) which is safe.
  // We check for actual unescaped attributes/tags, not text content.
  it('A4: strips <script> tags', () => {
    const html = renderNote('<script>alert(1)</script>', slug, emptyPaths);
    // html:false escapes raw HTML; no executable <script> tag
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  it('A4: strips <img onerror> attributes', () => {
    const html = renderNote('<img onerror="alert(1)" src="x">', slug, emptyPaths);
    // html:false escapes the tag; no executable img element with onerror
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('A4: strips javascript: href', () => {
    const html = renderNote('[XSS](javascript:alert(1))', slug, emptyPaths);
    // link_open rule replaces javascript: hrefs; must not appear as a real href attribute
    expect(html).not.toMatch(/href=["']javascript:/i);
  });

  it('A4: strips <svg onload>', () => {
    const html = renderNote('<svg onload="alert(1)">', slug, emptyPaths);
    // html:false escapes; no actual svg element with onload
    expect(html).not.toMatch(/<svg[^>]*onload/i);
  });

  it('A4: strips raw HTML with on* handlers', () => {
    const html = renderNote('text <div onclick="alert()">click</div>', slug, emptyPaths);
    // html:false escapes; no unescaped element with any on* handler attribute
    expect(html).not.toMatch(/<[^>]+on\w+=/i);
  });

  it('A4: strips data: in img src — no href with data: scheme', () => {
    // A link with data: href should not produce an executable href
    const html = renderNote('[click](data:text/html,alert)', slug, emptyPaths);
    // link_open rule replaces data: hrefs; must not appear as a real href attribute
    expect(html).not.toMatch(/href=["']data:/i);
  });

  it('html:false prevents raw HTML injection', () => {
    // With html:false, raw HTML is escaped; no actual img tag with event handler
    const html = renderNote('<img src=x onerror=alert(1)>', slug, emptyPaths);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('returns SanitizedHtml branded type', () => {
    const html = renderNote('hello', slug, emptyPaths);
    // Just verify it's a string
    expect(typeof html).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // img src sanitization (PARCHE-007 D2 / O1 fix)
  // ---------------------------------------------------------------------------

  it('img src with http:// external URL → src attribute eliminated', () => {
    // Markdown image with an external http URL: markdown-it renders an <img>, then
    // the transformTags.img hook in render.ts removes the src since it is neither
    // an /api/web/g/ path nor an allowed inline data: image.
    const html = renderNote('![alt](http://evil.example.com/tracker.png)', slug, emptyPaths);
    expect(html).not.toMatch(/src=["']https?:\/\//i);
  });

  it('img src with https:// external URL → src attribute eliminated', () => {
    const html = renderNote('![alt](https://cdn.example.com/image.png)', slug, emptyPaths);
    expect(html).not.toMatch(/src=["']https?:\/\//i);
  });

  it('img src with data:image/png → permitted: wikilink to PNG renders as img with API path', () => {
    // data:image/png is an explicitly allowed inline data image type in SANITIZE_OPTIONS.
    // In practice PNG images arrive via wikilinks which produce internal /api/web/g/ paths,
    // not data: URIs. markdown-it also blocks data: URLs in Markdown image syntax.
    // The permitted path is the /api/web/g/ one — verify it is NOT stripped.
    const paths = new Set(['assets/logo.png']);
    const html = renderNote('![[logo.png]]', slug, paths);
    // Wikilink to PNG must render as <img> with internal API path
    expect(html).toContain('<img');
    expect(html).toMatch(/src="\/api\/web\/g\/[^"]+\/raw\?path=/);
  });

  it('img src with data:image/svg+xml → never appears as img src in rendered output', () => {
    // data:image/svg+xml is excluded by the (?!svg+xml) negative lookahead in render.ts.
    // markdown-it also blocks data: URLs in Markdown image syntax (renders as plain text).
    // Regardless of which layer blocks it, the rendered HTML must never contain
    // <img src="data:image/svg+xml..."> — test that the combined pipeline enforces this.
    const svgData = 'data:image/svg+xml;base64,PHN2Zy8+';
    const html = renderNote(`![alt](${svgData})`, slug, emptyPaths);
    expect(html).not.toMatch(/<img[^>]*src=["']data:image\/svg\+xml/i);
  });

  it('img src with /api/web/g/... path → permitted (internal API proxy)', () => {
    // Direct internal-API img tags appear only via wikilink embeds processed by
    // buildRenderer (e.g. ![[foo.png]]). For this unit-test we verify the sanitizer
    // itself allows the path by feeding markdown-it a raw image link.
    const internalSrc = '/api/web/g/my-group/raw?path=images/photo.png';
    const html = renderNote(`![alt](${internalSrc})`, slug, emptyPaths);
    expect(html).toContain(internalSrc);
  });

  it('![[x.svg]] wikilink embed → <a> "ver archivo (descarga)", NOT <img>', () => {
    // SVG wikilink embeds must not be rendered as <img> because SVG can execute script.
    // The fix emits an <a> link with rel="noopener noreferrer" instead.
    const paths = new Set(['assets/diagram.svg']);
    const html = renderNote('![[diagram.svg]]', slug, paths);
    // Must contain a download link, not an img tag for the SVG
    expect(html).toContain('ver archivo (descarga)');
    expect(html).not.toMatch(/<img[^>]+diagram\.svg/i);
  });

  it('[x](vbscript:...) → href replaced with #, no vbscript: in output', () => {
    // vbscript: is a dangerous scheme. The transformTags.a in SANITIZE_OPTIONS
    // replaces it with '#'. sanitize-html's allowedSchemes also rejects it.
    const html = renderNote('[click me](vbscript:window.open("evil"))', slug, emptyPaths);
    expect(html).not.toMatch(/href=["']vbscript:/i);
  });

  // ---------------------------------------------------------------------------
  // Frontmatter stripping (PARCHE-007 fix 1)
  // ---------------------------------------------------------------------------

  it('strips leading YAML frontmatter — keys do not appear in rendered HTML', () => {
    const md = `---
title: Mi Nota
tags: [foo, bar]
author: alguien
---

# Cuerpo

Texto del artículo.`;
    const html = renderNote(md, slug, emptyPaths);
    expect(html).not.toContain('title:');
    expect(html).not.toContain('tags:');
    expect(html).not.toContain('author:');
    // Body content is preserved
    expect(html).toContain('Cuerpo');
    expect(html).toContain('Texto del artículo.');
  });

  it('frontmatter with BOM at start is stripped', () => {
    const md = '﻿---\ntitle: Con BOM\n---\n\n# Hola';
    const html = renderNote(md, slug, emptyPaths);
    expect(html).not.toContain('title:');
    expect(html).toContain('Hola');
  });

  it('frontmatter with CRLF line endings is stripped', () => {
    const md = '---\r\ntitle: CRLF\r\n---\r\n\r\n# Body';
    const html = renderNote(md, slug, emptyPaths);
    expect(html).not.toContain('title:');
    expect(html).toContain('Body');
  });

  it('a --- HR in the middle of the document is preserved (not treated as frontmatter)', () => {
    // No leading frontmatter block; the --- appears mid-document
    const md = '# Intro\n\nPárrafo uno.\n\n---\n\nPárrafo dos.';
    const html = renderNote(md, slug, emptyPaths);
    // markdown-it renders a mid-document --- as <hr>
    expect(html).toContain('<hr');
    expect(html).toContain('Párrafo uno.');
    expect(html).toContain('Párrafo dos.');
  });
});
