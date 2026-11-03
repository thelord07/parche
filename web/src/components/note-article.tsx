/** Renders server-sanitized note HTML.
 *
 *  O1 CONTRACT:
 *  - `dangerouslySetInnerHTML` is used ONLY here (xss-static-scan.test.ts enforces this).
 *  - The `html` prop MUST be of the branded type `SanitizedHtml`; only `api.getNote` produces it.
 *  - Wikilinks (.wl) with same-origin href are intercepted and navigated via react-router.
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SanitizedHtml } from '../api.ts';

interface NoteArticleProps {
  html: SanitizedHtml;
}

export function NoteArticle({ html }: NoteArticleProps) {
  const articleRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  // Intercept same-origin wikilinks for SPA navigation.
  // `html` in deps ensures the handler is re-attached when content changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html triggers re-attach after dangerouslySetInnerHTML update
  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;
      try {
        const url = new URL(target.href, window.location.href);
        if (url.origin === window.location.origin) {
          e.preventDefault();
          navigate(url.pathname + url.search + url.hash);
        }
      } catch {
        // malformed href — let browser handle it
      }
    };

    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [navigate, html]);

  return (
    <article
      ref={articleRef}
      className="note-article"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: intentional — html is SanitizedHtml produced only by api.getNote (server-side sanitize-html, O1)
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        fontSize: 16,
        lineHeight: 1.65,
        color: 'var(--text)',
      }}
    />
  );
}
