import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, SkeletonList } from '../../components/ui';
import { listMyAdverts, mediaUrl, updateAdvert, type Advert } from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { relativeTime } from '../../lib/format';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { CATEGORY_ICON, HubGate, HubHeader, priceText } from './common';

const TONE = { published: 'success', draft: 'neutral', paused: 'warning' } as const;

export default function MyAdverts() {
  return <HubGate><Mine /></HubGate>;
}

function Mine() {
  const ws = useWorkspace();
  const toast = useToast();
  const [ads, setAds] = useState<(Advert & { cover_path: string | null })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { setError(null); listMyAdverts(ws.business!.id).then(setAds).catch((e) => setError(toAppError(e).message)); };
  useEffect(load, [ws.business, ws.versions.hub]);  

  const setStatus = async (a: Advert, status: Advert['status']) => {
    setBusy(a.id);
    try {
      const updated = await updateAdvert(a.id, { status });
      setAds((l) => l?.map((x) => (x.id === a.id ? { ...x, ...updated } : x)) ?? null);
      toast.success(status === 'published' ? 'Advert is live.' : 'Advert paused.');
    } catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
  };

  return (
    <>
      <HubHeader title="My adverts" back="/hub" actions={<Link to="/hub/adverts/new" className="btn btn-yellow btn-sm">＋ New</Link>} />
      <div className="page-body" style={{ maxWidth: 820 }}>
        {error && <ErrorState message={error} onRetry={load} />}
        {ads === null && !error ? <SkeletonList rows={3} /> : ads && !ads.length ? (
          <EmptyState icon="📣" title="No adverts yet" action={<Link to="/hub/adverts/new" className="btn btn-primary">Create an advert</Link>}>Advertise your goods to other traders and buyers in the Hub.</EmptyState>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {ads?.map((a) => (
              <li key={a.id} className="list-row">
                <span className="avatar" style={{ borderRadius: 12, background: 'var(--blue-50)' }} aria-hidden="true">
                  {a.cover_path ? <img src={mediaUrl(a.cover_path) ?? ''} alt="" /> : CATEGORY_ICON[a.category] ?? '🛍️'}
                </span>
                <Link to={`/hub/adverts/${a.id}`} className="grow" style={{ color: 'inherit' }}>
                  <span className="row-title">{a.headline}</span><br />
                  <span className="row-sub">{priceText(a)} · updated {relativeTime(a.updated_at)}</span>
                </Link>
                <span className="stack-sm" style={{ alignItems: 'flex-end' }}>
                  <Badge tone={TONE[a.status]}>{a.status}</Badge>
                  {a.status === 'published' && <button className="btn btn-ghost btn-sm" disabled={busy === a.id} onClick={() => void setStatus(a, 'paused')}>Pause</button>}
                  {a.status !== 'published' && <button className="btn btn-ghost btn-sm" disabled={busy === a.id} onClick={() => void setStatus(a, 'published')}>Publish</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
