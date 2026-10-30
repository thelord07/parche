import type { InputHTMLAttributes } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  prefix?: string;
}

export function Field({ label, id, hint, error, prefix, style, ...rest }: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={id} style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
        {label}
      </label>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          border: `1px solid ${error ? 'var(--warn)' : 'var(--border)'}`,
          borderRadius: 5,
          background: 'var(--bg2)',
          overflow: 'hidden',
        }}
      >
        {prefix && (
          <span
            style={{
              padding: '0 0 0 12px',
              color: 'var(--muted)',
              whiteSpace: 'nowrap',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
            }}
          >
            {prefix}
          </span>
        )}
        <input
          id={id}
          style={{
            flex: 1,
            minWidth: 0,
            padding: prefix ? '0 12px 0 0' : '0 12px',
            border: 0,
            background: 'transparent',
            color: 'var(--text)',
            fontFamily: prefix ? "'JetBrains Mono', monospace" : "'Instrument Sans', sans-serif",
            fontSize: prefix ? 13 : 15,
            outline: 'none',
            ...style,
          }}
          {...rest}
        />
      </div>
      {error && (
        <span style={{ fontSize: 13, color: 'var(--warn)' }} role="alert">
          {error}
        </span>
      )}
      {!error && hint && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{hint}</span>}
    </div>
  );
}
