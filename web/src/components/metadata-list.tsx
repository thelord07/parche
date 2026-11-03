/** Metadata sidebar panel — DL grid of label/value pairs. */

interface MetadataItem {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  color?: string;
}

interface MetadataListProps {
  items: MetadataItem[];
}

export function MetadataList({ items }: MetadataListProps) {
  return (
    <dl
      style={{
        margin: 0,
        display: 'grid',
        gridTemplateColumns: '88px minmax(0, 1fr)',
        gap: '10px 12px',
        fontSize: 14,
      }}
    >
      {items.map((item) => (
        <span key={item.label} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--muted)' }}>{item.label}</dt>
          <dd
            style={{
              margin: 0,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: item.mono ? 'nowrap' : undefined,
              fontFamily: item.mono ? "'JetBrains Mono', monospace" : undefined,
              fontSize: item.mono ? 13 : undefined,
              color: item.color ?? undefined,
            }}
          >
            {item.value}
          </dd>
        </span>
      ))}
    </dl>
  );
}
