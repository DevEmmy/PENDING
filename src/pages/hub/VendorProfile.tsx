import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import {
  assetUrl, blockBusiness, connectionWith, getVendorProfile, listVendorAdverts, requestConnection, startConversation,
  type AdvertSummary, type Connection, type VendorProfile as VP,
} from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { formatDate, initials } from '../../lib/format';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { ReportSheet } from './AdvertDetail';
import { AdvertCard, CATEGORY_LABEL, HubGate, HubHeader, VerificationBadge } from './common';

export default function VendorProfile() {
  return <HubGate><Vendor /></HubGate>;
}

function Vendor() {
  const { businessId = '' } = useParams();
  const ws = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const [vp, setVp] = useState<VP | null | undefined>(undefined);
  const [ads, setAds] = useState<AdvertSummary[]>([]);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'msg' | 'block' | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const me = ws.business!.id;
  const own = businessId === me;
  const canManage = ws.business?.role !== 'assistant';

  useEffect(() => {
    setVp(undefined);
    Promise.all([getVendorProfile(businessId), listVendorAdverts(businessId), own ? null : connectionWith(me, businessId)])
      .then(([p, a, c]) => { setVp(p); setAds(a.map((x) => ({ ...x, vendor_name: p?.display_name ?? '', vendor_verification: p?.verification_status ?? 'unverified' }))); setConn(c); })
      .catch((e) => setError(toAppError(e).message));
  }, [businessId, me, own]);

  if (error) return <><HubHeader title="Vendor" back="/hub" /><div className="page-body"><ErrorState message={error} /></div></>;
  if (vp === undefined) return <><HubHeader title="Vendor" back="/hub" /><div className="page-body"><Skeleton height={200} radius={22} /></div></>;
  if (vp === null) return <><HubHeader title="Vendor" back="/hub" /><div className="page-body"><ErrorState message="This vendor's profile is private or no longer available." /></div></>;

  const connect = async () => {
    setBusy('connect');
    try {
      const c = await requestConnection(me, businessId);
      setConn(c);
      toast.success(c.status === 'accepted' ? `You're now connected with ${vp.display_name}.` : 'Connection request sent.');
    } catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
  };
  const message = async () => {
    setBusy('msg');
    try { navigate(`/hub/messages/${await startConversation(me, businessId)}`); }
    catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
  };
  const connLabel = !conn ? '🤝 Connect' : conn.status === 'accepted' ? '✓ Connected' : conn.status === 'pending' ? (conn.requester_business_id === me ? 'Request sent' : 'Accept request') : conn.requester_business_id === me ? 'Send request again' : '🤝 Connect';
  const connDisabled = conn?.status === 'accepted' || (conn?.status === 'pending' && conn.requester_business_id === me);

  return (
    <>
      <HubHeader title={vp.display_name} subtitle={[CATEGORY_LABEL[vp.category], vp.market, vp.city].filter(Boolean).join(' · ')} back="/hub" />
      <div className="page-body" style={{ maxWidth: 900 }}>
        <section className="card stack">
          <div className="row">
            <span className="avatar avatar-lg" aria-hidden="true">{vp.logo_path ? <img src={assetUrl(vp.logo_path) ?? ''} alt="" /> : initials(vp.display_name)}</span>
            <div className="grow stack-sm">
              <VerificationBadge status={vp.verification_status} />
              {vp.verification_status === 'verified' && vp.verified_at && <span className="xs muted">Business details checked by Vendora on {formatDate(vp.verified_at)}.</span>}
              {vp.verification_status !== 'verified' && <span className="xs muted">Vendora has not checked this business's registration.</span>}
            </div>
          </div>
          {vp.description && <p style={{ whiteSpace: 'pre-wrap' }}>{vp.description}</p>}
          {vp.products_summary && <p className="small"><strong>Sells:</strong> {vp.products_summary}</p>}
          {!own && (
            <div className="row wrap">
              {vp.allow_messages && <Button onClick={() => void message()} loading={busy === 'msg'}>💬 Message</Button>}
              {canManage && <Button variant="secondary" onClick={() => void connect()} loading={busy === 'connect'} disabled={connDisabled}>{connLabel}</Button>}
              {vp.contact_whatsapp && <a className="btn btn-secondary" target="_blank" rel="noopener noreferrer" href={`https://wa.me/${vp.contact_whatsapp.replace(/\D/g, '').replace(/^0/, '234')}`}>WhatsApp</a>}
              <Button variant="ghost" onClick={() => setReporting(true)}>🚩 Report</Button>
              {canManage && <Button variant="ghost" onClick={() => setBlockOpen(true)}>🚫 Block</Button>}
            </div>
          )}
          {own && <Link to="/hub/profile" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}>Edit my profile</Link>}
          {vp.photo_paths.length > 0 && (
            <div className="upload-grid">{vp.photo_paths.map((p) => <div key={p} className="upload-tile"><img src={assetUrl(p) ?? ''} alt={`${vp.display_name} shop`} loading="lazy" /></div>)}</div>
          )}
        </section>
        <h2>Adverts</h2>
        {ads.length ? <div className="hub-grid">{ads.map((a) => <AdvertCard key={a.id} a={a} />)}</div> : <EmptyState icon="📣" title="No live adverts" />}
      </div>
      <ConfirmDialog open={blockOpen} title={`Block ${vp.display_name}?`} confirmLabel="Block" tone="danger" busy={busy === 'block'} onCancel={() => setBlockOpen(false)} onConfirm={async () => {
        setBusy('block');
        try { await blockBusiness(me, businessId); toast.success(`${vp.display_name} is blocked. They can't message you or connect.`); setBlockOpen(false); navigate('/hub'); }
        catch (e) { toast.error(toAppError(e).message); } finally { setBusy(null); }
      }}>
        <p>They won't be able to message you or send connection requests, and any connection is removed. You can't undo this from the app yet.</p>
      </ConfirmDialog>
      <ReportSheet open={reporting} onClose={() => setReporting(false)} target={{ businessId }} />
    </>
  );
}
