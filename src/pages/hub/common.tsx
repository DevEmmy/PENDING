import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, EmptyState, PageHeader } from '../../components/ui';
import { mediaUrl, type AdvertSummary, type Verification } from '../../data/hubApi';
import { naira } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useWorkspace } from '../../state/workspace';

export const CATEGORY_LABEL: Record<string, string> = { foodstuff: 'Foodstuff', clothing: 'Clothing', electronics: 'Electronics', pharmacy: 'Pharmacy', cosmetics: 'Cosmetics', other: 'Other' };
export const CATEGORY_ICON: Record<string, string> = { foodstuff: '🍚', clothing: '👗', electronics: '📱', pharmacy: '💊', cosmetics: '💄', other: '🛍️' };

export function priceText(a: { price_min: number | null; price_max: number | null; unit: string | null }) {
  const per = a.unit ? ` / ${a.unit}` : '';
  if (a.price_min !== null && a.price_max !== null && a.price_max !== a.price_min) return `${naira(a.price_min)} – ${naira(a.price_max)}${per}`;
  if (a.price_min !== null) return `${naira(a.price_min)}${per}`;
  if (a.price_max !== null) return `Up to ${naira(a.price_max)}${per}`;
  return 'Price on request';
}

/** Only an admin-approved review can produce "verified". Other states are shown plainly. */
export function VerificationBadge({ status, compact }: { status: Verification; compact?: boolean }) {
  if (status === 'verified') return <span className="verified-tick" title="Verified by Vendora review">✓{compact ? '' : ' Verified'}</span>;
  if (compact) return null;
  if (status === 'pending') return <Badge tone="warning">Verification pending</Badge>;
  if (status === 'suspended') return <Badge tone="danger">Suspended</Badge>;
  return <Badge tone="neutral">Not verified</Badge>;
}

export function AdvertCard({ a }: { a: AdvertSummary }) {
  const img = mediaUrl(a.cover_path);
  return (
    <Link to={`/hub/adverts/${a.id}`} className="advert-card">
      <div className="advert-media">{img ? <img src={img} alt="" loading="lazy" /> : <span aria-hidden="true">{CATEGORY_ICON[a.category] ?? '🛍️'}</span>}</div>
      <div className="advert-body">
        <div className="row wrap" style={{ gap: 6 }}>
          {a.is_featured && <Badge tone="yellow">Featured</Badge>}
          <Badge tone="info">{a.pricing_type === 'wholesale' ? 'Wholesale' : a.pricing_type === 'both' ? 'Retail & wholesale' : 'Retail'}</Badge>
        </div>
        <strong>{a.headline}</strong>
        <span className="advert-price tabular">{priceText(a)}</span>
        {a.min_order_qty && a.min_order_qty > 1 ? <span className="xs muted">Min. order {a.min_order_qty} {a.unit ?? ''}</span> : null}
        {a.vendor_name && (
          <span className="vendor-line">
            <span>{a.vendor_name}</span><VerificationBadge status={a.vendor_verification} compact />
            {(a.market || a.city) && <span>· 📍 {[a.market, a.city].filter(Boolean).join(', ')}</span>}
          </span>
        )}
      </div>
    </Link>
  );
}

export function HubGate({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const auth = useAuth();
  const navigate = useNavigate();
  if (ws.mode === 'live') return <>{children}</>;
  return (
    <>
      <PageHeader title="Vendors Hub" subtitle="Find suppliers, advertise your goods and talk to other traders" />
      <div className="page-body">
        <EmptyState icon="🤝" title="The Hub connects real traders"
          action={auth.configured ? <Button onClick={() => { ws.exitDemo(); navigate('/signup'); }}>Create a free account</Button> : undefined}>
          The demo shop can't post adverts or message other vendors, because those are seen by real people.
          {auth.configured ? ' Create an account to join the Vendors Hub.' : ' Accounts are not switched on in this copy of Vendora yet.'}
        </EmptyState>
      </div>
    </>
  );
}

export function HubHeader({ title, subtitle, back, actions, children }: { title: string; subtitle?: string; back?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <PageHeader title={title} subtitle={subtitle} actions={<div className="row">{actions}{back && <Link to={back} className="btn btn-on-dark btn-sm">Back</Link>}</div>}>
      {children}
    </PageHeader>
  );
}
