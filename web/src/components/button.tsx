import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  size?: 'default' | 'compact';
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'default',
  style,
  children,
  ...rest
}: ButtonProps) {
  const height = size === 'compact' ? 30 : 40;
  const padding = size === 'compact' ? '0 12px' : '0 16px';
  const fontSize = size === 'compact' ? 13 : 14;

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height,
    padding,
    borderRadius: 5,
    fontSize,
    fontWeight: 600,
    border: 0,
    cursor: 'pointer',
    textDecoration: 'none',
    transition: 'background 0.1s',
    whiteSpace: 'nowrap',
  };

  if (variant === 'primary') {
    Object.assign(base, {
      background: 'var(--accent)',
      color: 'var(--bg)',
    });
  } else {
    Object.assign(base, {
      background: 'transparent',
      border: '1px solid var(--border)',
      color: 'var(--text)',
    });
  }

  return (
    <button type="button" style={{ ...base, ...style }} {...rest}>
      {children}
    </button>
  );
}
