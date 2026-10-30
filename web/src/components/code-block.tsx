interface CodeBlockProps {
  command: string;
  onCopy?: () => void;
  copied?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  /** 'primary' = accent button (default); 'secondary' = outlined button */
  variant?: 'primary' | 'secondary';
}

export function CodeBlock({
  command,
  onCopy,
  copied,
  copyLabel = 'Copiar',
  copiedLabel = 'Copiado',
  variant = 'primary',
}: CodeBlockProps) {
  // borderLeft is intentionally omitted here — it is handled by .code-block button
  // in theme.css so the media query can swap it for border-top on mobile without !important.
  const btnStyle: React.CSSProperties =
    variant === 'primary'
      ? {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 16px',
          background: 'var(--accent)',
          color: 'var(--bg)',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }
      : {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          background: 'transparent',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        };

  return (
    <div className="code-block">
      <code>
        <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
          $
        </span>
        {command}
      </code>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          style={btnStyle}
          className={variant === 'primary' ? 'code-block-btn-primary' : undefined}
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      )}
    </div>
  );
}
