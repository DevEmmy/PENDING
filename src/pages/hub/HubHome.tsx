import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Field, Input, Select, Sheet, SkeletonList, Tabs, Textarea } from '../../components/ui';
import {
  addComment, assetUrl, createPost, getVendorProfile, listComments, listFeed, listNotifications, markNotificationsRead,
  PAGE_SIZE, recommendedVendors, searchAdverts, searchVendors, setLiked,
  type AdvertSummary, type FeedComment, type FeedPost, type Notification, type SearchParams, type VendorProfile,
} from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { initials, relativeTime } from '../../lib/format';
import { BUSINESS_CATEGORIES } from '../../lib/types';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { useHubBadge } from './useHubBadge';
import { AdvertCard, CATEGORY_LABEL, HubGate, HubHeader, VerificationBadge } from './common';

export default function HubHome() {
  return <HubGate><Hub /></HubGate>;
}

function Hub() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'discover' | 'feed'>(params.get('tab') === 'feed' ? 'feed' : 'discover');
  const [notifOpen, setNotifOpen] = useState(false);
  const unread = useHubBadge();
  const mine = useMine();

  return (
    <>
      <HubHeader title="Vendors Hub" subtitle="Find suppliers, advertise your goods and connect with other traders"
        actions={<>
          <button className="icon-btn on-dark" onClick={() => setNotifOpen(true)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} style={{ position: 'relative' }}>
            🔔{unread > 0 && <span className="nav-dot" style={{ top: -2, right: -2 }} aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>
          <Link to="/hub/adverts/new" className="btn btn-yellow btn-sm">＋ Advert</Link>
        </>}>
        <nav className="chip-scroll" aria-label="Hub sections">
          <Link to="/hub/messages" className="chip on-dark">💬 Messages</Link>
          <Link to="/hub/connections" className="chip on-dark">🤝 Connections</Link>
          <Link to="/hub/my-adverts" className="chip on-dark">📣 My adverts</Link>
          <Link to="/hub/profile" className="chip on-dark">🏪 My shop profile</Link>
        </nav>
      </HubHeader>
      <div className="page-body">
        {mine && !mine.is_public && (
          <div className="alert alert-warning">
            <span className="grow">Your shop is <strong>hidden</strong> from other vendors. Make it public so suppliers and buyers can find you and message you.</span>
            <Link to="/hub/profile" className="btn btn-sm btn-secondary">Set up profile</Link>
          </div>
        )}
        <Tabs label="Hub view" value={tab} onChange={(v) => { setTab(v); params.set('tab', v); setParams(params, { replace: true }); }}
          options={[{ value: 'discover', label: 'Discover' }, { value: 'feed', label: 'Activity feed' }]} />
        {tab === 'discover' ? <Discover initialQuery={params.get('q') ?? ''} /> : <Feed canPost={ws.business?.role !== 'assistant'} />}
      </div>
      <NotificationsSheet open={notifOpen} onClose={() => { setNotifOpen(false); ws.invalidate('hub'); }} />
    </>
  );
}

function useMine() {
  const ws = useWorkspace();
  const [vp, setVp] = useState<VendorProfile | null>(null);
  useEffect(() => {
    if (!ws.business) return;
    getVendorProfile(ws.business.id).then(setVp).catch(() => setVp(null));
  }, [ws.business, ws.versions.hub]);
  return vp;
}

function Discover({ initialQuery }: { initialQuery: string }) {
  const ws = useWorkspace();
  const [mode, setMode] = useState<'adverts' | 'vendors'>('adverts');
  const [filters, setFilters] = useState<SearchParams>({ query: initialQuery, sort: 'relevance' });
  const [debounced, setDebounced] = useState(filters);
  const [showFilters, setShowFilters] = useState(false);
  const [items, setItems] = useState<AdvertSummary[]>([]);
  const [vendors, setVendors] = useState<VendorProfile[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<VendorProfile[]>([]);
  const req = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDebounced(filters), 300); return () => clearTimeout(t); }, [filters]);
  useEffect(() => { setPage(0); }, [debounced, mode]);
  useEffect(() => {
    if (ws.business) recommendedVendors(ws.business.id).then(setRecommended).catch(() => setRecommended([]));
  }, [ws.business]);

  useEffect(() => {
    const r = ++req.current;
    setLoading(true);
    setError(null);
    const run = mode === 'adverts'
      ? searchAdverts(debounced, page).then((rows) => { if (r !== req.current) return; setItems((prev) => (page === 0 ? rows : [...prev, ...rows])); setHasMore(rows.length === PAGE_SIZE); })
      : searchVendors(debounced.query ?? '', debounced.location ?? '', debounced.category ?? '', page).then((rows) => { if (r !== req.current) return; setVendors((prev) => (page === 0 ? rows : [...prev, ...rows])); setHasMore(rows.length === PAGE_SIZE); });
    run.catch((e) => { if (r === req.current) setError(toAppError(e).message); }).finally(() => { if (r === req.current) setLoading(false); });
  }, [debounced, page, mode, ws.versions.hub]);

  const set = (patch: Partial<SearchParams>) => setFilters((f) => ({ ...f, ...patch }));
  const activeFilters = [filters.category, filters.location, filters.minPrice, filters.maxPrice, filters.pricingType].filter((x) => x !== undefined && x !== null && x !== '').length;

  return (
    <div className="stack">
      <div className="search-bar">
        <span aria-hidden="true">🔍</span>
        <label htmlFor="hub-search" className="sr-only">Search products or vendors</label>
        <input id="hub-search" type="search" value={filters.query ?? ''} onChange={(e) => set({ query: e.target.value })} placeholder={mode === 'adverts' ? 'Search products, e.g. rice, garri…' : 'Search vendors or markets…'} />
        <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} aria-controls="hub-filters">Filters{activeFilters ? ` (${activeFilters})` : ''}</button>
      </div>
      <div className="row wrap" role="group" aria-label="Search for">
        <button className="chip" aria-pressed={mode === 'adverts'} onClick={() => setMode('adverts')}>Products</button>
        <button className="chip" aria-pressed={mode === 'vendors'} onClick={() => setMode('vendors')}>Vendors</button>
        <div className="grow" />
        {mode === 'adverts' && (
          <>
            <label htmlFor="hub-sort" className="small muted">Sort</label>
            <Select id="hub-sort" style={{ width: 'auto', minHeight: 40 }} value={filters.sort} onChange={(e) => set({ sort: e.target.value as SearchParams['sort'] })}>
              <option value="relevance">Best match</option><option value="recent">Newest</option><option value="price_low">Price: low to high</option><option value="price_high">Price: high to low</option>
            </Select>
          </>
        )}
      </div>
      {showFilters && (
        <div id="hub-filters" className="card form-grid" style={{ animation: 'pop-in var(--t-med) var(--ease-out)' }}>
          <Field label="Category">{({ id }) => (
            <Select id={id} value={filters.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}>
              <option value="">All categories</option>{BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          )}</Field>
          <Field label="Market or city">{({ id }) => <Input id={id} value={filters.location ?? ''} onChange={(e) => set({ location: e.target.value || undefined })} placeholder="e.g. Mile 12" />}</Field>
          {mode === 'adverts' && <>
            <Field label="Min price (₦)">{({ id }) => <Input id={id} inputMode="numeric" value={filters.minPrice ?? ''} onChange={(e) => set({ minPrice: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} />}</Field>
            <Field label="Max price (₦)">{({ id }) => <Input id={id} inputMode="numeric" value={filters.maxPrice ?? ''} onChange={(e) => set({ maxPrice: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} />}</Field>
            <Field label="Buying">{({ id }) => (
              <Select id={id} value={filters.pricingType ?? ''} onChange={(e) => set({ pricingType: e.target.value || undefined })}>
                <option value="">Retail or wholesale</option><option value="wholesale">Wholesale</option><option value="retail">Retail</option>
              </Select>
            )}</Field>
          </>}
          <div className="full"><Button variant="ghost" size="sm" onClick={() => setFilters({ query: filters.query, sort: 'relevance' })}>Clear filters</Button></div>
        </div>
      )}

      {mode === 'adverts' && !filters.query && recommended.length > 0 && (
        <section className="stack-sm" aria-labelledby="rec-h">
          <h2 id="rec-h" style={{ fontSize: 16 }}>Suggested for you <span className="xs muted">(same market, city or category)</span></h2>
          <div className="chip-scroll">
            {recommended.map((v) => (
              <Link key={v.business_id} to={`/hub/vendors/${v.business_id}`} className="card card-link row" style={{ minWidth: 220, padding: 12 }}>
                <span className="avatar avatar-sm" aria-hidden="true">{v.logo_path ? <img src={assetUrl(v.logo_path) ?? ''} alt="" /> : initials(v.display_name)}</span>
                <span className="grow small"><strong>{v.display_name}</strong> <VerificationBadge status={v.verification_status} compact /><br /><span className="muted">{[v.market, v.city].filter(Boolean).join(', ') || CATEGORY_LABEL[v.category]}</span></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {error && <ErrorState message={`Couldn't load the Hub: ${error}`} onRetry={() => setDebounced({ ...debounced })} />}
      <div aria-live="polite" className="sr-only">{loading ? 'Loading results' : `${mode === 'adverts' ? items.length : vendors.length} results`}</div>
      {mode === 'adverts' ? (
        loading && page === 0 && !items.length ? <SkeletonList rows={3} height={220} /> : !items.length && !error ? (
          <EmptyState icon="🔎" title={filters.query ? `No adverts for “${filters.query}”` : 'No adverts yet'} action={<Link to="/hub/adverts/new" className="btn btn-primary">Post the first advert</Link>}>
            Try a different word or remove filters. You can also search for vendors.
          </EmptyState>
        ) : (
          <div className="hub-grid">{items.map((a) => <AdvertCard key={a.id} a={a} />)}</div>
        )
      ) : (
        loading && page === 0 && !vendors.length ? <SkeletonList rows={4} /> : !vendors.length && !error ? (
          <EmptyState icon="🏪" title="No vendors found">Try another market, city or product.</EmptyState>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {vendors.map((v) => (
              <li key={v.business_id}>
                <Link to={`/hub/vendors/${v.business_id}`} className="list-row">
                  <span className="avatar" aria-hidden="true">{v.logo_path ? <img src={assetUrl(v.logo_path) ?? ''} alt="" /> : initials(v.display_name)}</span>
                  <span className="grow"><span className="row-title">{v.display_name}</span> <VerificationBadge status={v.verification_status} compact /><br />
                    <span className="row-sub">{CATEGORY_LABEL[v.category]}{v.market || v.city ? ` · 📍 ${[v.market, v.city].filter(Boolean).join(', ')}` : ''}{v.products_summary ? ` · ${v.products_summary}` : ''}</span></span>
                  <span aria-hidden="true" className="muted">›</span>
                </Link>
              </li>
            ))}
          </ul>
        )
      )}
      {hasMore && <Button variant="secondary" loading={loading && page > 0} onClick={() => setPage((p) => p + 1)}>Load more</Button>}
    </div>
  );
}

const KIND_LABEL: Record<FeedPost['kind'], string> = { update: 'Update', new_stock: 'New stock', wholesale_offer: 'Wholesale offer', announcement: 'Announcement', new_advert: 'New advert' };

function Feed({ canPost }: { canPost: boolean }) {
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<FeedPost['kind']>('new_stock');
  const [posting, setPosting] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);
  const userId = auth.user!.id;

  const load = async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listFeed(userId, before);
      setPosts((p) => (before ? [...p, ...rows] : rows));
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [ws.versions.hub]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      await createPost(ws.business!.id, userId, kind, body.trim());
      setBody('');
      toast.success('Posted to the Hub.');
      await load();
    } catch (err) {
      toast.error(`Not posted: ${toAppError(err).message} Your text is still here.`);
    } finally {
      setPosting(false);
    }
  };

  const toggleLike = async (p: FeedPost) => {
    const next = !p.liked;
    setPosts((list) => list.map((x) => (x.id === p.id ? { ...x, liked: next, likes: x.likes + (next ? 1 : -1) } : x)));
    try { await setLiked(p.id, userId, next); } catch (e) {
      setPosts((list) => list.map((x) => (x.id === p.id ? { ...x, liked: p.liked, likes: p.likes } : x)));
      toast.error(toAppError(e).message);
    }
  };

  return (
    <div className="stack">
      {canPost && (
        <form className="card stack-sm" onSubmit={post}>
          <label htmlFor="post-body" className="label">Share a business update</label>
          <Textarea id="post-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Fresh Mama Gold rice just arrived — wholesale price for 10 bags and above." maxLength={1000} />
          <div className="row wrap">
            <Select aria-label="Post type" style={{ width: 'auto', minHeight: 40 }} value={kind} onChange={(e) => setKind(e.target.value as FeedPost['kind'])}>
              <option value="new_stock">New stock</option><option value="wholesale_offer">Wholesale offer</option><option value="announcement">Announcement</option><option value="update">Update</option>
            </Select>
            <div className="grow" />
            <Button type="submit" size="sm" loading={posting} disabled={!body.trim()}>Post</Button>
          </div>
        </form>
      )}
      {error && <ErrorState message={`The feed didn't load: ${error}`} onRetry={() => void load()} />}
      {loading && !posts.length ? <SkeletonList rows={3} height={120} /> : !posts.length && !error ? (
        <EmptyState icon="📰" title="No updates yet">When vendors share new stock or offers, they'll show here.</EmptyState>
      ) : posts.map((p) => (
        <article key={p.id} className="card feed-post">
          <div className="row">
            <span className="avatar avatar-sm" aria-hidden="true">{p.vendor ? initials(p.vendor.display_name) : 'V'}</span>
            <div className="grow">
              <Link to={`/hub/vendors/${p.business_id}`} style={{ color: 'inherit', fontWeight: 700 }}>{p.vendor?.display_name ?? 'Vendor'}</Link>{' '}
              {p.vendor && <VerificationBadge status={p.vendor.verification_status} compact />}
              <div className="xs muted">{KIND_LABEL[p.kind]} · {relativeTime(p.created_at)}</div>
            </div>
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
          {p.advert_id && <Link to={`/hub/adverts/${p.advert_id}`} className="context-chip">📣 View advert</Link>}
          <div className="feed-actions">
            <button aria-pressed={p.liked} onClick={() => void toggleLike(p)} aria-label={`${p.liked ? 'Unlike' : 'Like'} (${p.likes} likes)`}>{p.liked ? '❤️' : '🤍'} {p.likes}</button>
            <button aria-expanded={openComments === p.id} onClick={() => setOpenComments(openComments === p.id ? null : p.id)}>💬 {p.comments} comment{p.comments === 1 ? '' : 's'}</button>
          </div>
          {openComments === p.id && <Comments postId={p.id} onAdded={() => setPosts((l) => l.map((x) => (x.id === p.id ? { ...x, comments: x.comments + 1 } : x)))} />}
        </article>
      ))}
      {hasMore && <Button variant="secondary" loading={loading} onClick={() => void load(posts[posts.length - 1]?.created_at)}>Load older updates</Button>}
    </div>
  );
}

function Comments({ postId, onAdded }: { postId: string; onAdded: () => void }) {
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const [list, setList] = useState<FeedComment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { listComments(postId).then(setList).catch((e) => { setList([]); toast.error(toAppError(e).message); }); }, [postId, toast]);
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      {list === null ? <span className="small muted">Loading comments…</span> : list.map((c) => (
        <div key={c.id} className="small"><strong>{c.vendor_name ?? 'Vendor'}</strong> {c.body} <span className="xs muted">· {relativeTime(c.created_at)}</span></div>
      ))}
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        try {
          await addComment(postId, ws.business!.id, auth.user!.id, text.trim());
          setText('');
          onAdded();
          setList(await listComments(postId));
        } catch (err) {
          toast.error(`Comment not posted: ${toAppError(err).message}`);
        } finally { setBusy(false); }
      }}>
        <label htmlFor={`c-${postId}`} className="sr-only">Write a comment</label>
        <Input id={`c-${postId}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment…" maxLength={500} />
        <Button type="submit" size="sm" loading={busy} disabled={!text.trim()}>Send</Button>
      </form>
    </div>
  );
}

function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    listNotifications().then((n) => {
      setItems(n);
      void markNotificationsRead(n.filter((x) => !x.read_at).map((x) => x.id));
    }).catch((e) => setError(toAppError(e).message));
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="Notifications">
      {error ? <ErrorState message={error} /> : items === null ? <SkeletonList rows={3} height={48} /> : !items.length ? <p className="muted">No notifications yet.</p> : (
        <div className="stack-sm">
          {items.map((n) => (
            <button key={n.id} className="list-row" style={{ boxShadow: 'none', background: n.read_at ? 'transparent' : 'var(--blue-50)' }} onClick={() => { onClose(); if (n.link) navigate(n.link); }}>
              <span className="grow"><strong className="small">{n.title}</strong>{n.body && <><br /><span className="xs muted">{n.body}</span></>}</span>
              <span className="xs muted">{relativeTime(n.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
