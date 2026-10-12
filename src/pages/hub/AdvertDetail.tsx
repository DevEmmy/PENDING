import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, ErrorState, Field, Select, Sheet, Skeleton, Textarea } from '../../components/ui';
import { assetUrl, getAdvert, isSaved, mediaUrl, report, setSaved, startConversation, type Advert, type AdvertMedia, type VendorProfile } from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { formatDate, initials } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { CATEGORY_ICON, CATEGORY_LABEL, HubGate, HubHeader, priceText, VerificationBadge } from './common';

export default function AdvertDetail() {
  return <HubGate><Detail /></HubGate>;
}

export function ReportSheet({ open, onClose, target }: { open: boolean; onClose: () => void; target: { advertId?: string; businessId?: string } }) {
  const auth = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState('scam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Report to Vendora" description="Reports are reviewed by the Vendora team. The vendor is not told who reported.">
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await report(auth.user!.id, target, reason, details.trim()); toast.success('Thanks — your report was sent for review.'); onClose(); }
        catch (err) { toast.error(`Report not sent: ${toAppError(err).message}`); }
        finally { setBusy(false); }
      }}>
        <Field label="What's wrong?">{({ id }) => (
          <Select id={id} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="scam">Looks like a scam</option><option value="fake_product">Fake or counterfeit product</option><option value="wrong_price">Misleading price</option>
            <option value="offensive">Offensive content</option><option value="spam">Spam</option><option value="other">Something else</option>
          </Select>
        )}</Field>
        <Field label="Details" optional>{({ id }) => <Textarea id={id} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} />}</Field>
        <div className="sheet-footer" style={{ marginTop: 0 }}><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger-solid" loading={busy}>Send report</Button></div>
      </form>
    </Sheet>
  );
}

function Detail() {
  const { id = '' } = useParams();
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<{ advert: Advert; media: AdvertMedia[]; vendor: VendorProfile | null } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSavedState] = useState(false);
  const [busy, setBusy] = useState<'msg' | 'save' | null>(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    setData(undefined);
    getAdvert(id).then((d) => { setData(d); if (d) void isSaved(auth.user!.id, id).then(setSavedState).catch(() => {}); }).catch((e) => setError(toAppError(e).message));
  }, [id, auth.user]);

  if (error) return <><HubHeader title="Advert" back="/hub" /><div className="page-body"><ErrorState message={error} /></div></>;
  if (data === undefined) return <><HubHeader title="Advert" back="/hub" /><div className="page-body"><Skeleton height={280} radius={22} /><Skeleton height={140} radius={22} /></div></>;
  if (data === null) return <><HubHeader title="Advert" back="/hub" /><div className="page-body"><ErrorState message="This advert is no longer available. It may have been paused or removed." /></div></>;

  const { advert: a, media, vendor } = data;
  const own = a.business_id === ws.business?.id;

  const message = async () => {
    setBusy('msg');
    try {
      const conv = await startConversation(ws.business!.id, a.business_id, a.id);
      navigate(`/hub/messages/${conv}?advert=${a.id}`);
    } catch (e) {
      toast.error(toAppError(e).message);
    } finally { setBusy(null); }
  };
  const toggleSave = async () => {
    setBusy('save');
    try { await setSaved(auth.user!.id, a.id, !saved); setSavedState(!saved); toast.success(saved ? 'Removed from saved.' : 'Saved.'); }
    catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
  };
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: a.headline, text: `${a.headline} — ${priceText(a)}`, url });
      else { await navigator.clipboard.writeText(url); toast.success('Link copied.'); }
    } catch { /* cancelled */ }
  };

  return (
    <>
      <HubHeader title={a.headline} subtitle={`${CATEGORY_LABEL[a.category] ?? 'Other'}${a.published_at ? ` · posted ${formatDate(a.published_at)}` : ''}`} back="/hub" />
      <div className="page-body" style={{ maxWidth: 820 }}>
        {own && a.status !== 'published' && <div className="alert alert-warning">This advert is <strong>{a.status}</strong> — other vendors can't see it.</div>}
        {a.moderation_status !== 'ok' && <div className="alert alert-error">This advert was {a.moderation_status} by Vendora review.</div>}
        <div className="gallery" aria-label="Photos and video">
          {media.length ? media.map((m) => (
            <div key={m.id}>{m.media_type === 'video' ? <video src={mediaUrl(m.storage_path) ?? ''} controls preload="metadata" /> : <img src={mediaUrl(m.storage_path) ?? ''} alt={a.headline} loading="lazy" />}</div>
          )) : <div className="advert-media" style={{ fontSize: 64 }} aria-hidden="true">{CATEGORY_ICON[a.category] ?? '🛍️'}</div>}
        </div>
        {media.length > 1 && <p className="xs muted center">Swipe to see {media.length} photos</p>}

        <section className="card stack">
          <div className="row wrap" style={{ gap: 6 }}>
            {a.is_featured && <Badge tone="yellow">Featured</Badge>}
            <Badge tone="info">{a.pricing_type === 'wholesale' ? 'Wholesale' : a.pricing_type === 'both' ? 'Retail & wholesale' : 'Retail'}</Badge>
          </div>
          <div className="advert-price" style={{ fontSize: 26 }}>{priceText(a)}</div>
          <dl className="confirm-lines" style={{ color: 'var(--text)' }}>
            {a.product_name && <div><dt className="muted">Product</dt><dd>{a.product_name}</dd></div>}
            {a.min_order_qty && <div><dt className="muted">Minimum order</dt><dd>{a.min_order_qty} {a.unit ?? ''}</dd></div>}
            {a.available_qty !== null && <div><dt className="muted">Available (vendor says)</dt><dd>{a.available_qty} {a.unit ?? ''}</dd></div>}
            {(a.market || a.city) && <div><dt className="muted">Location</dt><dd>📍 {[a.market, a.city, a.state].filter(Boolean).join(', ')}</dd></div>}
            {a.delivery_info && <div><dt className="muted">Delivery</dt><dd>{a.delivery_info}</dd></div>}
          </dl>
          {a.description && <p style={{ whiteSpace: 'pre-wrap' }}>{a.description}</p>}
          <div className="row wrap">
            {own ? (
              <Link to={`/hub/adverts/${a.id}/edit`} className="btn btn-primary">✏️ Edit advert</Link>
            ) : (
              <>
                {a.allow_messages && vendor?.allow_messages ? <Button onClick={() => void message()} loading={busy === 'msg'}>💬 Message vendor</Button> : <span className="small muted">This vendor isn't taking messages.</span>}
                <Button variant="secondary" onClick={() => void toggleSave()} loading={busy === 'save'} aria-pressed={saved}>{saved ? '★ Saved' : '☆ Save'}</Button>
              </>
            )}
            <Button variant="secondary" onClick={() => void share()}>📤 Share</Button>
            {!own && <Button variant="ghost" onClick={() => setReporting(true)}>🚩 Report</Button>}
          </div>
          <p className="xs muted">Prices and stock are posted by the vendor. Vendora does not hold payments — agree terms and inspect goods before paying.</p>
        </section>

        {vendor && (
          <Link to={`/hub/vendors/${vendor.business_id}`} className="card card-link row">
            <span className="avatar" aria-hidden="true">{vendor.logo_path ? <img src={assetUrl(vendor.logo_path) ?? ''} alt="" /> : initials(vendor.display_name)}</span>
            <span className="grow"><strong>{vendor.display_name}</strong> <VerificationBadge status={vendor.verification_status} /><br />
              <span className="small muted">{[vendor.market, vendor.city].filter(Boolean).join(', ')}</span></span>
            <span aria-hidden="true">›</span>
          </Link>
        )}
      </div>
      <ReportSheet open={reporting} onClose={() => setReporting(false)} target={{ advertId: a.id, businessId: a.business_id }} />
    </>
  );
}
