import { readConflictMeta } from '@chamba/core';

export interface ParsedLink {
  target: string;
  alias?: string;
  kind: 'wiki' | 'md' | 'embed';
  snippet?: string;
}

export interface ParsedMeta {
  title?: string;
  summary?: string;
  type?: string;
  tags: string[];
  workItem?: string;
  project?: string;
  conflictOf?: string;
  conflictBase?: string;
  links: ParsedLink[];
}

const MAX_BYTES = 64 * 1024;

/** Extract a ~160 char snippet centered around `pos` */
function centeredSnippet(text: string, pos: number, len = 160): string {
  const half = Math.floor(len / 2);
  const start = Math.max(0, pos - half);
  const end = Math.min(text.length, pos + half);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip = snip + '…';
  return snip;
}

/**
 * Remove fenced code blocks and inline code spans from text to avoid false link matches.
 * Replaces the content with spaces to preserve character positions.
 */
function stripCode(text: string): string {
  // Fenced blocks: ```...``` or ~~~...~~~
  let result = text.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
  // Inline code: `...`
  result = result.replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));
  return result;
}

/** Mini frontmatter parser for known keys */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };
  const fm = text.slice(3, end);
  const body = text.slice(end + 4);
  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (val) meta[key] = val;
  }
  return { meta, body };
}

export function parseNote(content: string): ParsedMeta {
  // Cap to 64KB
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    content = Buffer.from(content, 'utf8').slice(0, MAX_BYTES).toString('utf8');
  }

  const { meta: fm, body } = parseFrontmatter(content);

  // conflict_of/conflict_base via core
  const conflictMeta = readConflictMeta(content);

  // title: frontmatter title or first # heading
  let title: string | undefined = fm['title'];
  if (!title) {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) title = headingMatch[1]?.trim();
  }

  // summary: frontmatter summary or first non-heading paragraph (≤200 chars)
  let summary: string | undefined = fm['summary'];
  if (!summary) {
    const stripped = body.replace(/^#[^\n]+\n?/m, '').trim();
    const firstPara = stripped.match(/^[^\n#>*\-`|<]+/m);
    if (firstPara) summary = firstPara[0].trim().slice(0, 200);
  }

  // type
  const type = fm['type'] ?? fm['kind'] ?? undefined;

  // tags: from frontmatter tags field (yaml list or comma-separated)
  let tags: string[] = [];
  const rawTags = fm['tags'] ?? fm['tag'] ?? '';
  if (rawTags) {
    if (rawTags.startsWith('[')) {
      tags = rawTags
        .slice(1, -1)
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      tags = rawTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  // Also extract inline #tags from body (excluding code)
  const strippedBody = stripCode(body);
  const inlineTags = Array.from(strippedBody.matchAll(/#([\w/\-áéíóúñü]+)/gi)).map(
    (m) => m[1] ?? '',
  );
  for (const t of inlineTags) {
    if (t && !tags.includes(t)) tags.push(t);
  }

  // work_item, project
  const workItem = fm['work_item'] ?? fm['work-item'] ?? fm['ticket'] ?? undefined;
  const project = fm['project'] ?? undefined;

  // links: wikilinks and markdown links (excluding code)
  const links: ParsedLink[] = [];
  const noCode = stripCode(content);

  // Embed wikilinks: ![[...]]
  for (const m of noCode.matchAll(/!\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g)) {
    const target = m[1]?.trim();
    if (!target) continue;
    const alias = m[2]?.trim();
    const snippet = centeredSnippet(content, m.index ?? 0);
    links.push({ target, alias, kind: 'embed', snippet });
  }

  // Regular wikilinks: [[...]] (not preceded by !)
  for (const m of noCode.matchAll(/(?<!!)\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g)) {
    const target = m[1]?.trim();
    if (!target) continue;
    const alias = m[2]?.trim();
    const snippet = centeredSnippet(content, m.index ?? 0);
    links.push({ target, alias, kind: 'wiki', snippet });
  }

  // Relative markdown links: [text](relative-path.md) — not http/https/data/javascript
  for (const m of noCode.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const href = m[2]?.trim();
    if (!href) continue;
    if (/^(https?:\/\/|data:|javascript:|mailto:|#)/.test(href)) continue;
    if (href.endsWith('.md') || href.match(/\.md[#?]/)) {
      const target = href.split('#')[0]?.split('?')[0] ?? href;
      const snippet = centeredSnippet(content, m.index ?? 0);
      links.push({ target, alias: m[1], kind: 'md', snippet });
    }
  }

  return {
    title,
    summary,
    type,
    tags,
    workItem,
    project,
    conflictOf: conflictMeta?.conflictOf ?? undefined,
    conflictBase: conflictMeta?.conflictBase ?? (undefined as string | undefined),
    links,
  };
}
