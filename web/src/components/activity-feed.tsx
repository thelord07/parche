/** Activity feed: events grouped by day with "Ver más" pagination. */

import { Link } from 'react-router-dom';
import type { ActivityEvent } from '../api.ts';
import { avatarBg, dayLabel, timeAgo } from '../lib/time.ts';

interface ActivityFeedProps {
  slug: string;
  events: ActivityEvent[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function groupByDay(events: ActivityEvent[]): Array<{ day: string; events: ActivityEvent[] }> {
  const groups: Array<{ day: string; events: ActivityEvent[] }> = [];
  let currentDay = '';
  let currentGroup: ActivityEvent[] = [];

  for (const event of events) {
    const day = dayLabel(event.at);
    if (day !== currentDay) {
      if (currentGroup.length > 0) {
        groups.push({ day: currentDay, events: currentGroup });
      }
      currentDay = day;
      currentGroup = [event];
    } else {
      currentGroup.push(event);
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ day: currentDay, events: currentGroup });
  }
  return groups;
}

function ActivityRow({ event, slug }: { event: ActivityEvent; slug: string }) {
  const initial = event.user.name[0]?.toUpperCase() ?? '?';
  const bg = avatarBg(event.user.email ?? event.user.name);

  const notePath = event.verb === 'renombró' && event.renamedTo ? event.renamedTo : event.path;

  return (
    <Link
      to={event.hash !== null ? `/g/${slug}/n/${notePath}` : '#'}
      style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr) auto',
        gap: 12,
        alignItems: 'start',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text)',
        textDecoration: 'none',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--bg2)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 4,
          background: bg,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {initial}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 14, lineHeight: 1.4 }}>
          <strong style={{ fontWeight: 600 }}>{event.user.name || event.user.email}</strong>{' '}
          {event.verb}{' '}
          <code
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
            }}
          >
            {event.path}
          </code>
          {event.verb === 'renombró' && event.renamedTo && (
            <>
              {' → '}
              <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                {event.renamedTo}
              </code>
            </>
          )}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          {event.hashCorto && <>{event.hashCorto} · </>}
          desde {event.deviceLabel}
          {event.project && <> · {event.project}</>}
          {event.workItem && <> · {event.workItem}</>}
        </span>
      </span>

      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
          marginTop: 2,
        }}
      >
        {timeAgo(event.at)}
      </span>
    </Link>
  );
}

export function ActivityFeed({
  slug,
  events,
  hasMore,
  loadingMore,
  onLoadMore,
}: ActivityFeedProps) {
  if (events.length === 0) {
    return (
      <div
        style={{
          padding: '32px 16px',
          textAlign: 'center',
          color: 'var(--muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      >
        Sin actividad todavía.
      </div>
    );
  }

  const groups = groupByDay(events);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {groups.map((group) => (
        <div
          key={group.day}
          style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
        >
          <div
            style={{
              padding: '8px 16px',
              background: 'var(--bg2)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: 'var(--muted)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {group.day}
          </div>
          {group.events.map((event) => (
            <ActivityRow key={event.seq} event={event} slug={slug} />
          ))}
        </div>
      ))}

      {hasMore && (
        <div style={{ textAlign: 'center', paddingTop: 8 }}>
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 14px',
              borderRadius: 5,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 13,
              fontWeight: 500,
              cursor: loadingMore ? 'not-allowed' : 'pointer',
              opacity: loadingMore ? 0.6 : 1,
            }}
          >
            {loadingMore ? 'Cargando…' : 'Ver más'}
          </button>
        </div>
      )}
    </div>
  );
}
