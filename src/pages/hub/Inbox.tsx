import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, SkeletonList } from '../../components/ui';
import { listInbox, type InboxItem } from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { initials, relativeTime } from '../../lib/format';
import { useWorkspace } from '../../state/workspace';
import { HubGate, HubHeader, VerificationBadge } from './common';

export default function Inbox() {
  return <HubGate><List /></HubGate>;
}

function List() {
  const ws = useWorkspace();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); listInbox(ws.business!.id).then(setItems).catch((e) => setError(toAppError(e).message)); };
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [ws.business, ws.versions.hub]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <HubHeader title="Messages" subtitle="Conversations with other vendors" back="/hub" />
      <div className="page-body" style={{ maxWidth: 820 }}>
        {error && <ErrorState message={error} onRetry={load} />}
        {items === null && !error ? <SkeletonList rows={4} /> : !items?.length ? (
          <EmptyState icon="💬" title="No conversations yet" action={<Link to="/hub" className="btn btn-primary">Browse the Hub</Link>}>
            Message a vendor from their advert or profile.
          </EmptyState>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/hub/messages/${c.id}`} className={`list-row ${c.unread ? 'accent accent-info' : ''}`}>
                  <span className="avatar" aria-hidden="true">{initials(c.other?.display_name ?? 'V')}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="row-title">{c.other?.display_name ?? 'Vendor'}</span> {c.other && <VerificationBadge status={c.other.verification_status} compact />}
                    {c.unread && <span className="sr-only"> (unread)</span>}
                    <span className="row-sub" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: c.unread ? 700 : 400 }}>{c.last_message_preview ?? 'No messages yet'}</span>
                  </span>
                  <span className="xs muted nowrap">{c.last_message_at ? relativeTime(c.last_message_at) : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
