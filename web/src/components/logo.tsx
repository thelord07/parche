function LogoIcon({ size = 24 }: { size?: number }) {
  return (
    // color: var(--accent) makes currentColor resolve to the accent token,
    // so all fill/stroke="currentColor" children track --accent automatically.
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ color: 'var(--accent)' }}
    >
      <path d="M4.5 13a4 4 0 0 1 8 0z" fill="oklch(0.5 0.015 70)" />
      <path d="M19.5 13a4 4 0 0 1 8 0z" fill="oklch(0.5 0.015 70)" />
      <circle cx="8.5" cy="6.5" r="2.6" fill="oklch(0.5 0.015 70)" />
      <circle cx="23.5" cy="6.5" r="2.6" fill="oklch(0.5 0.015 70)" />
      <path d="M11 13a5 5 0 0 1 10 0z" fill="currentColor" />
      <circle cx="16" cy="4.8" r="3.2" fill="currentColor" />
      <rect
        x="3"
        y="12"
        width="26"
        height="17"
        rx="3.5"
        fill="oklch(0.165 0.012 66)"
        stroke="oklch(0.5 0.015 70)"
        strokeWidth="2"
      />
      <path
        d="M9 17l4 3.5-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.5 24h6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <LogoIcon />
      <span
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 600,
          fontSize: 19,
          letterSpacing: '-0.02em',
        }}
      >
        <span style={{ color: 'var(--accent)' }}>pa</span>
        rche
      </span>
    </span>
  );
}
