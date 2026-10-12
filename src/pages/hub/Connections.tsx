import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, ErrorState, SkeletonList, Tabs } from '../../components/ui';
import { listConnections, removeConnection, respondConnection, type Connection, type VendorProfile } from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { initials, relativeTime } from '../../lib/format';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { HubGate, HubHeader, VerificationBadge } from './common';

export default function Connections() {
  return <HubGate><List /></HubGate>;
}

type Row = { conn: Connection; other: VendorProfile | null; incoming: boolean };

function List() {
  const ws = useWorkspace();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'connected' | 'requests' | 'sent'>('connected');
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { setError(null); listConnections(ws.business!.id).then(setRows).catch((e) => setError(toAppError(e).message)); };
  useEffect(load, [ws.business, ws.versions.hub]);  

  const connected = rows?.filter((r) => r.conn.status === 'accepted') ?? [];
  const requests = rows?.filter((r) => r.conn.status === 'pending' && r.incoming) ?? [];
  const sent = rows?.filter((r) => r.conn.status === 'pending' && !r.incoming) ?? [];
  const shown = tab === 'connected' ? connected : tab === 'requests' ? requests : sent;

  const act = async (r: Row, fn: () => Promise<unknown>, msg: string) => {
    setBusy(r.conn.id);
    try { await fn(); toast.success(msg); load(); ws.invalidate('hub'); } catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
  };

  return (
    <>
      <HubHeader title="Connections" subtitle="Suppliers and vendors you work with" back="/hub" />
      <div className="page-body" style={{ maxWidth: 820 }}>
        <Tabs label="Connections" value={tab} onChange={setTab} options={[
          { value: 'connected', label: 'Connected', count: connected.length },
          { value: 'requests', label: 'Requests', count: requests.length },
          { value: 'sent', label: 'Sent', count: sent.length },
        ]} />
        {error && <ErrorState message={error} onRetry={load} />}
        {rows === null && !error ? <SkeletonList rows={3} /> : !shown.length ? (
          <EmptyState icon="🤝" title={tab === 'requests' ? 'No requests' : tab === 'sent' ? 'No pending requests' : 'No connections yet'} action={<Link to="/hub?tab=discover" className="btn btn-primary">Find vendors</Link>}>
            Connect with suppliers and nearby traders to keep them close.
          </EmptyState>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {shown.map((r) => (
              <li key={r.conn.id} className="list-row">
                <span className="avatar" aria-hidden="true">{initials(r.other?.display_name ?? 'V')}</span>
                <Link to={`/hub/vendors/${r.incoming ? r.conn.requester_business_id : r.conn.addressee_business_id}`} className="grow" style={{ color: 'inherit' }}>
                  <span className="row-title">{r.other?.display_name ?? 'Vendor'}</span> {r.other && <VerificationBadge status={r.other.verification_status} compact />}<br />
                  <span className="row-sub">{[r.other?.market, r.other?.city].filter(Boolean).join(', ')} · {relativeTime(r.conn.created_at)}</span>
                </Link>
                {tab === 'requests' && (
                  <span className="row">
                    <Button size="sm" variant="success" loading={busy === r.conn.id} onClick={() => void act(r, () => respondConnection(r.conn.id, true), 'Connected.')}>Accept</Button>
                    <Button size="sm" variant="secondary" disabled={busy === r.conn.id} onClick={() => void act(r, () => respondConnection(r.conn.id, false), 'Request declined.')}>Decline</Button>
                  </span>
                )}
                {tab === 'sent' && <Button size="sm" variant="ghost" disabled={busy === r.conn.id} onClick={() => void act(r, () => removeConnection(r.conn.id), 'Request cancelled.')}>Cancel</Button>}
                {tab === 'connected' && <Button size="sm" variant="ghost" disabled={busy === r.conn.id} onClick={() => { if (window.confirm(`Remove ${r.other?.display_name ?? 'this vendor'} from your connections?`)) void act(r, () => removeConnection(r.conn.id), 'Connection removed.'); }}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
