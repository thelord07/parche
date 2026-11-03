/** Format an ISO timestamp as a relative time string in Spanish. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.floor((now - then) / 1000);

  if (diff < 5) return 'ahora mismo';
  if (diff < 60) return `hace ${diff} s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  if (diff < 7 * 86400) return `hace ${Math.floor(diff / 86400)} días`;

  const d = new Date(iso);
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Return a day label: "hoy", "ayer", or a date string. */
export function dayLabel(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const diffDays = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
      86400000,
  );
  if (diffDays === 0) return 'hoy';
  if (diffDays === 1) return 'ayer';
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

/** Return an avatar background color deterministically from a string (email / name).
 *  Uses light-dark() so the chip is legible in both themes:
 *  - Light theme: light hue-tinted bg → dark --text reads AA
 *  - Dark theme : dark hue-tinted bg  → light --text reads AA
 *  Requires color-scheme: light dark on :root (set in theme.css).
 */
export function avatarBg(s: string): string {
  const sum = [...s].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hue = (sum * 37) % 360;
  return `light-dark(oklch(0.88 0.08 ${hue}), oklch(0.29 0.04 ${hue}))`;
}
