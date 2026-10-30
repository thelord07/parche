import { Link } from 'react-router-dom';
import { Logo } from './logo.tsx';

interface HeaderProps {
  user?: { email: string };
  breadcrumb?: Array<{ label: string; href?: string }>;
}

export function Header({ user, breadcrumb }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        height: 56,
        padding: '0 24px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      >
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Logo />
        </Link>
        {!breadcrumb && (
          <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>by chamba</span>
        )}
        {breadcrumb?.map((crumb) => (
          <span key={crumb.label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--muted)' }}>/</span>
            {crumb.href ? (
              <Link to={crumb.href} style={{ textDecoration: 'none', color: 'var(--text)' }}>
                {crumb.label}
              </Link>
            ) : (
              <span style={{ color: 'var(--muted)' }}>{crumb.label}</span>
            )}
          </span>
        ))}
      </div>
      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            {user.email}
          </span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--card)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {user.email[0]?.toUpperCase()}
          </span>
        </div>
      )}
    </header>
  );
}
