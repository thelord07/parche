import { describe, expect, it } from 'vitest';
import { parseNote } from './parser.js';

describe('parseNote', () => {
  it('extracts title from frontmatter', () => {
    const md = '---\ntitle: Mi Nota\n---\nContenido';
    const result = parseNote(md);
    expect(result.title).toBe('Mi Nota');
  });

  it('extracts title from first # heading if no frontmatter title', () => {
    const md = '# Mi Título\n\nContenido aquí.';
    const result = parseNote(md);
    expect(result.title).toBe('Mi Título');
  });

  it('extracts summary from frontmatter', () => {
    const md = '---\nsummary: Resumen breve\n---\nTexto.';
    const result = parseNote(md);
    expect(result.summary).toBe('Resumen breve');
  });

  it('extracts tags from frontmatter (comma-separated)', () => {
    const md = '---\ntags: tag1, tag2, tema/frontend\n---\n';
    const result = parseNote(md);
    expect(result.tags).toContain('tag1');
    expect(result.tags).toContain('tema/frontend');
  });

  it('extracts tags from frontmatter (YAML array)', () => {
    const md = '---\ntags: [tag1, tag2]\n---\n';
    const result = parseNote(md);
    expect(result.tags).toContain('tag1');
    expect(result.tags).toContain('tag2');
  });

  it('extracts work_item and project from frontmatter', () => {
    const md = '---\nwork_item: TICKET-123\nproject: myapp\n---\n';
    const result = parseNote(md);
    expect(result.workItem).toBe('TICKET-123');
    expect(result.project).toBe('myapp');
  });

  it('extracts conflict_of and conflict_base from frontmatter via readConflictMeta', () => {
    const md = '---\nconflict_of: auth/flujo-login.md\nconflict_base: abc123\n---\n# Copia';
    const result = parseNote(md);
    expect(result.conflictOf).toBe('auth/flujo-login.md');
  });

  it('extracts wikilinks', () => {
    const md = 'Ver [[flujo-login]] y [[otro|Alias]].';
    const result = parseNote(md);
    expect(result.links.length).toBeGreaterThanOrEqual(2);
    const wiki = result.links.find((l) => l.target === 'flujo-login');
    expect(wiki?.kind).toBe('wiki');
    const aliased = result.links.find((l) => l.alias === 'Alias');
    expect(aliased?.target).toBe('otro');
  });

  it('extracts embed wikilinks', () => {
    const md = '![[imagen.png]]';
    const result = parseNote(md);
    expect(result.links.some((l) => l.kind === 'embed' && l.target === 'imagen.png')).toBe(true);
  });

  it('extracts relative markdown links', () => {
    const md = 'Ver [doc](../auth/login.md) para más.';
    const result = parseNote(md);
    expect(result.links.some((l) => l.kind === 'md')).toBe(true);
  });

  it('does NOT extract links inside code fences', () => {
    const md = '```\n[[wikilink-in-fence]]\n[link](file.md)\n```';
    const result = parseNote(md);
    expect(result.links.length).toBe(0);
  });

  it('does NOT extract links inside inline code', () => {
    const md = 'Uso `[[no-link]]` aquí.';
    const result = parseNote(md);
    expect(result.links.length).toBe(0);
  });

  it('does NOT extract external links as md links', () => {
    const md = '[Google](https://google.com)';
    const result = parseNote(md);
    expect(result.links.length).toBe(0);
  });

  it('does NOT extract javascript: links', () => {
    const md = '[XSS](javascript:alert(1))';
    const result = parseNote(md);
    expect(result.links.length).toBe(0);
  });

  it('extracts snippet for wikilinks', () => {
    const md = 'Hay un enlace a [[flujo-login]] aquí.';
    const result = parseNote(md);
    const link = result.links.find((l) => l.target === 'flujo-login');
    expect(link?.snippet).toBeTruthy();
  });

  it('handles note larger than 64KB by capping', () => {
    const large = 'x'.repeat(70 * 1024);
    // Should not throw
    const result = parseNote(large);
    expect(result).toBeDefined();
  });

  it('never throws on malformed content', () => {
    expect(() => parseNote('')).not.toThrow();
    expect(() => parseNote('---\nbad yaml: [{}\n---\n')).not.toThrow();
  });

  it('wikilink with spaces and special chars (ñ)', () => {
    const md = '[[flujo login (ñ)]]';
    const result = parseNote(md);
    expect(result.links.some((l) => l.target === 'flujo login (ñ)')).toBe(true);
  });
});
