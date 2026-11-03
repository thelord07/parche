import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

/** Branded type — only produced by renderNote. Safe for dangerouslySetInnerHTML in note-article.tsx ONLY. */
declare const __sanitizedBrand: unique symbol;
export type SanitizedHtml = string & { readonly [__sanitizedBrand]: true };

// ---------------------------------------------------------------------------
// Explicit allowlist — the single XSS audit point.
// No style, no on* handlers, no dangerous schemes.
// ---------------------------------------------------------------------------
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'ul',
    'ol',
    'li',
    'blockquote',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'br',
    'hr',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'span',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target', 'class'],
    img: ['src', 'alt'],
    span: ['class'],
    code: ['class'],
    pre: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // img src: only allow data: (further filtered by transformTags.img to exclude svg+xml).
  // http/https are deliberately excluded — images must go through the API proxy.
  allowedSchemesByTag: {
    img: ['data'],
  },
  disallowedTagsMode: 'discard' as const,
  allowVulnerableTags: false,
  // M3: block protocol-relative URLs (//evil.com) — they are not XSS but redirect
  // users to external domains without the `rel` added by transformTags.a below.
  allowProtocolRelative: false,
  // Allow internal relative hrefs (starting with /) via transformTags
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs['href'] ?? '';
      // Redundant defense: sanitize-html's allowedSchemes already blocks dangerous
      // schemes, but we re-check here as belt-and-suspenders. vbscript: is added
      // because some older allowedSchemes lists miss it.
      if (/^javascript:|^vbscript:|^data:/i.test(href)) {
        return { tagName, attribs: { ...attribs, href: '#' } };
      }
      return { tagName, attribs };
    },
    img: (tagName, attribs) => {
      const src = attribs['src'] ?? '';
      // Only allow internal API images or safe inline data URIs.
      // data:image/svg+xml is excluded because SVG can embed script elements.
      const isApiPath = src.startsWith('/api/web/g/');
      const isInlineImage = /^data:image\/(?!svg\+xml)[a-z0-9.+-]+;base64,/i.test(src);
      if (!isApiPath && !isInlineImage) {
        // Strip the src so sanitize-html has nothing left to check/emit.
        const { src: _removed, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[<>"'&]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;',
    };
    return map[c] ?? c;
  });
}

function resolveWikilink(target: string, knownPaths: Set<string>): string | null {
  if (knownPaths.has(target)) return target;
  if (knownPaths.has(target + '.md')) return target + '.md';
  const baseLower = target.toLowerCase().replace(/\.md$/i, '');
  for (const p of knownPaths) {
    const base = (p.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
    if (base === baseLower) return p;
  }
  return null;
}

function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Use `any` to avoid type conflicts between markdown-it@15 native types and @types/markdown-it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdAny = any;

function buildRenderer(groupSlug: string, knownPaths: Set<string>) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

  md.core.ruler.push('wikilinks', (state: MdAny) => {
    for (const blockToken of state.tokens as MdAny[]) {
      if (blockToken.type !== 'inline' || !blockToken.children) continue;
      const newChildren: MdAny[] = [];
      for (const child of blockToken.children as MdAny[]) {
        if (child.type !== 'text') {
          newChildren.push(child);
          continue;
        }
        const text: string = child.content as string;
        const parts = text.split(/(!\[\[[^\]]*?\]\]|\[\[[^\]]*?\]\])/);
        for (const part of parts) {
          const embedM = /^!\[\[([^\]|#\n]+?)(?:\|([^\]\n]+?))?\]\]$/.exec(part);
          const wikiM = !embedM && /^\[\[([^\]|#\n]+?)(?:\|([^\]\n]+?))?\]\]$/.exec(part);
          if (embedM) {
            const target = (embedM[1] ?? '').trim();
            const resolved = resolveWikilink(target, knownPaths);
            if (resolved) {
              const encoded = encodePathSegments(resolved);
              const t = new state.Token('html_inline', '', 0) as MdAny;
              const isSvg = resolved.toLowerCase().endsWith('.svg');
              if (isSvg) {
                // SVG embeds are emitted as download links — embedding SVG via <img> would allow
                // scripts in SVG files if the server ever changes Content-Type handling.
                const rawUrl = `/api/web/g/${encodeURIComponent(groupSlug)}/raw?path=${encoded}`;
                t.content = `<a href="${rawUrl}" rel="noopener noreferrer">ver archivo (descarga)</a>`;
              } else {
                t.content = `<img src="/api/web/g/${encodeURIComponent(groupSlug)}/raw?path=${encoded}" alt="${escapeHtml(target)}">`;
              }
              newChildren.push(t);
            } else {
              const t = new state.Token('text', '', 0) as MdAny;
              t.content = part;
              newChildren.push(t);
            }
          } else if (wikiM) {
            const target = (wikiM[1] ?? '').trim();
            const alias = wikiM[2]?.trim() ?? target;
            const resolved = resolveWikilink(target, knownPaths);
            if (resolved) {
              const encoded = encodePathSegments(resolved);
              const tOpen = new state.Token('html_inline', '', 0) as MdAny;
              tOpen.content = `<a class="wl" href="/g/${encodeURIComponent(groupSlug)}/n/${encoded}">`;
              newChildren.push(tOpen);
              const tText = new state.Token('text', '', 0) as MdAny;
              tText.content = alias;
              newChildren.push(tText);
              const tClose = new state.Token('html_inline', '', 0) as MdAny;
              tClose.content = '</a>';
              newChildren.push(tClose);
            } else {
              const tSpan = new state.Token('html_inline', '', 0) as MdAny;
              tSpan.content = `<span class="wl wl-dead">${escapeHtml(alias)}</span>`;
              newChildren.push(tSpan);
            }
          } else if (part) {
            const t = new state.Token('text', '', 0) as MdAny;
            t.content = part;
            newChildren.push(t);
          }
        }
      }
      blockToken.children = newChildren;
    }
  });

  // Override link_open to add rel/target for external links and block dangerous hrefs
  const origLinkOpen =
    md.renderer.rules['link_open'] ??
    ((tokens: MdAny, idx: number, options: MdAny, _env: MdAny, self: MdAny) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules['link_open'] = (
    tokens: MdAny,
    idx: number,
    options: MdAny,
    env: MdAny,
    self: MdAny,
  ) => {
    const token = tokens[idx] as MdAny;
    if (!token) return '';
    const hrefIdx: number = token.attrIndex('href') as number;
    if (hrefIdx >= 0 && token.attrs) {
      const attr = token.attrs[hrefIdx] as MdAny;
      const href = String(attr?.[1] ?? '').trim();
      if (/^javascript:|^data:/i.test(href)) {
        token.attrs[hrefIdx] = ['href', '#'];
      } else if (/^https?:\/\//.test(href)) {
        token.attrSet('rel', 'noopener noreferrer nofollow');
        token.attrSet('target', '_blank');
      }
    }
    return origLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}

/**
 * Strip a leading YAML frontmatter block from markdown content.
 * Tolerates a BOM character and CRLF line endings.
 * A `---` that appears later in the document (an HR) is not touched.
 */
function stripFrontmatter(markdown: string): string {
  // Remove optional BOM
  const text = markdown.startsWith('﻿') ? markdown.slice(1) : markdown;
  // Match --- at position 0 (after optional BOM) through closing ---
  // The opening --- must be on its own line (only optional trailing spaces/tabs)
  // The closing --- must be on its own line followed by newline or EOF
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fm) return markdown;
  // Return the content after the frontmatter (preserving any trailing content)
  return text.slice(fm[0].length);
}

/**
 * Render Markdown to sanitized HTML.
 * Returns a SanitizedHtml branded string — safe to inject with dangerouslySetInnerHTML
 * in note-article.tsx ONLY.
 */
export function renderNote(
  markdown: string,
  groupSlug: string,
  knownPaths: Set<string>,
): SanitizedHtml {
  const md = buildRenderer(groupSlug, knownPaths);
  const rawHtml = md.render(stripFrontmatter(markdown));
  const clean = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  return clean as SanitizedHtml;
}
