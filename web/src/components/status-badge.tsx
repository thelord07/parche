/** Status badge: text + shape indicator.
 *  Shapes: dot (●, ok/active), ring (○, pending), triangle (△, conflict/warn).
 *  Always text + shape as per design system — never shape alone.
 */

type BadgeKind = 'ok' | 'pending' | 'warn';

interface StatusBadgeProps {
  kind: BadgeKind;
  label: string;
}

function Shape({ kind }: { kind: BadgeKind }) {
  if (kind === 'ok') {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'currentColor',
          flexShrink: 0,
        }}
      />
    );
  }
  if (kind === 'pending') {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          border: '1.5px solid currentColor',
          flexShrink: 0,
        }}
      />
    );
  }
  // warn / conflict → triangle
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M12 8v5M12 16.5v.5" />
      <path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

const COLORS: Record<BadgeKind, { color: string; borderColor: string }> = {
  ok: {
    color: 'var(--ok-text)',
    borderColor: 'oklch(0.77 0.11 165 / 0.45)',
  },
  pending: {
    color: 'var(--muted)',
    borderColor: 'var(--border)',
  },
  warn: {
    color: 'var(--warn-text)',
    borderColor: 'oklch(0.83 0.11 88 / 0.45)',
  },
};

export function StatusBadge({ kind, label }: StatusBadgeProps) {
  const { color, borderColor } = COLORS[kind];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        border: `1px solid ${borderColor}`,
        borderRadius: 4,
        color,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      <Shape kind={kind} />
      {label}
    </span>
  );
}
