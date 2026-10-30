import { useState } from 'react';

interface CopyableProps {
  text: string;
  label?: string;
  copiedLabel?: string;
}

export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState(false);

  function copy(text: string) {
    try {
      navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // ignore
    }
    setCopied(true);
    setTimeout(() => setCopied(false), timeout);
  }

  return { copied, copy };
}

export function CopyButton({
  text,
  label = 'Copiar',
  copiedLabel = 'Copiado',
  style,
}: CopyableProps & { style?: React.CSSProperties }) {
  const { copied, copy } = useCopy();

  return (
    <button
      type="button"
      onClick={() => copy(text)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 36,
        padding: '0 12px',
        borderRadius: 5,
        border: '1px solid var(--border)',
        background: 'transparent',
        color: 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </svg>
      {copied ? copiedLabel : label}
    </button>
  );
}
