import { Link, useNavigate } from 'react-router-dom';
import { AnimatedNaira, Badge, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { greeting, initials, naira, percentChange, quantity, relativeTime } from '../lib/format';
import { stockStatus } from '../lib/types';
import { useAuth } from '../state/auth';
import { useQuery, useWorkspace } from '../state/workspace';
import { useVoice } from '../voice/VoiceProvider';

const TRY = ['I sold two bags of rice', 'How much profit this week?', 'I just restocked 10 cartons of Indomie'];

export function TrendPill({ current, previous, label }: { current: number; previous: number; label: string }) {
  const pct = percentChange(current, previous);
  if (pct === null) return <span className="trend flat">No sales {label} to compare</span>;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return (
    <span className={`trend ${dir}`}>
      <span aria-hidden="true">{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>
      {Math.abs(pct)}% {dir === 'down' ? 'below' : dir === 'up' ? 'above' : 'same as'} {label}
    </span>
  );
}

export default function Home() {
  const ws = useWorkspace();
  const auth = useAuth();
  const voice = useVoice();
  const navigate = useNavigate();
  const dash = useQuery(['dashboard', 'sales', 'products'], (api) => api.dashboard());
  const recent = useQuery(['sales'], (api) => api.listSales({ limit: 5 }));
  const d = dash.data;
  const name = ws.mode === 'demo' ? 'Mama Ngozi' : auth.profile?.full_name || 'there';
  const biz = ws.business;
  const topToday = d?.products.filter((p) => p.units_today > 0).sort((a, b) => b.units_today - a.units_today)[0];
  const low = ws.products.filter((p) => stockStatus(p) !== 'in').sort((a, b) => a.stock_quantity - b.stock_quantity);
  const setupPending = ws.mode === 'live' && auth.profile && auth.profile.onboarding_step !== 'done';

  const trySay = (text: string) => {
    navigate('/chat');
    void voice.send(text, 'text');
  };

  return (
    <>
      <PageHeader
        overlap
        eyebrow={<>{greeting()} <span aria-hidden="true">👋</span></>}
        title={name}
        subtitle={[biz?.name, biz?.market_area].filter(Boolean).join(' · ')}
        actions={<Link to="/profile" className="avatar" aria-label={`${initials(name)} — profile and settings`}>{initials(name)}</Link>}
      />
      <div className="page-body overlap-body">
        <section className="card today-card" aria-labelledby="today-label">
          <div className="row-between wrap">
            <span id="today-label" className="muted small">Today's sales</span>
            {d && <TrendPill current={d.today.revenue} previous={d.today.yesterday_revenue} label="yesterday" />}
          </div>
          {dash.loading && !d ? <Skeleton height={40} width={180} /> : d ? <AnimatedNaira value={d.today.revenue} className="big" /> : null}
          {d && (
            <span className="muted small">
              {d.today.count} sale{d.today.count === 1 ? '' : 's'} recorded
              {topToday ? ` · ${topToday.name} selling fastest (${quantity(topToday.units_today, topToday.unit)})` : ''}
            </span>
          )}
          {dash.error && <ErrorState message={`Today's figures didn't load: ${dash.error}`} onRetry={dash.retry} />}
        </section>

        {setupPending && (
          <Link to="/onboarding" className="card card-link setup-card row-between">
            <span><strong>Finish setting up your shop</strong><br /><span className="small muted">Add products and learn voice — 2 minutes.</span></span>
            <span aria-hidden="true">→</span>
          </Link>
        )}

        <section className="talk-zone" aria-labelledby="talk-h">
          <h2 id="talk-h">What do you want to do?</h2>
          <p className="muted small" style={{ maxWidth: 300 }}>Just tap and speak — or type. English and Pidgin work best; Yoruba, Igbo &amp; Hausa are in early testing.</p>
          <button className="talk-button" onClick={() => voice.open()} aria-label="Tap to speak to Vendora">
            <span aria-hidden="true">🎙️</span>
          </button>
          <span className="talk-label" aria-hidden="true">Tap to speak</span>
        </section>

        <section className="stack" aria-labelledby="try-h">
          <h2 id="try-h" className="muted small" style={{ fontWeight: 600 }}>Try saying</h2>
          <div className="list try-list">
            {TRY.map((t) => (
              <button key={t} className="list-row" onClick={() => trySay(t)}>
                <span className="grow" style={{ paddingLeft: 6 }}>“{t}”</span>
                <span aria-hidden="true" className="muted">›</span>
              </button>
            ))}
          </div>
        </section>

        <nav className="quick-grid" aria-label="Quick actions">
          <Link to="/sales/new" className="quick-action"><span aria-hidden="true">🧾</span><span>New sale</span></Link>
          <Link to="/stock?add=1" className="quick-action"><span aria-hidden="true">➕</span><span>Add stock</span></Link>
          <Link to="/customers" className="quick-action"><span aria-hidden="true">💰</span><span>Money owed</span></Link>
          <Link to="/hub" className="quick-action"><span aria-hidden="true">🤝</span><span>Vendors Hub</span></Link>
        </nav>

        <div className="grid-2">
          <section className="card stack" aria-labelledby="attention-h">
            <div className="row-between"><h3 id="attention-h">Needs attention</h3><Link to="/stock" className="small">See stock</Link></div>
            {low.length === 0 ? (
              <p className="muted small">✅ Nothing is running low.</p>
            ) : (
              <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {low.slice(0, 4).map((p) => (
                  <li key={p.id} className="row-between small">
                    <span>{p.name}</span>
                    {stockStatus(p) === 'out' ? <Badge tone="danger">Out of stock</Badge> : <Badge tone="warning">{quantity(p.stock_quantity, p.unit)} left</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {d && d.debts.outstanding > 0 && (
              <Link to="/customers" className="row-between small" style={{ color: 'inherit' }}>
                <span>💰 {d.debts.debtors} customer{d.debts.debtors === 1 ? '' : 's'} owe you</span>
                <strong className="tabular">{naira(d.debts.outstanding)}</strong>
              </Link>
            )}
          </section>

          <section className="card stack" aria-labelledby="recent-h">
            <div className="row-between"><h3 id="recent-h">Recent sales</h3><Link to="/sales" className="small">See all</Link></div>
            {recent.loading && !recent.data ? <Skeleton height={120} /> : recent.error ? <ErrorState message={recent.error} onRetry={recent.retry} /> : recent.data?.length ? (
              <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {recent.data.map((s) => (
                  <li key={s.id}>
                    <Link to={`/sales/${s.id}`} className="row-between small" style={{ color: 'inherit' }}>
                      <span className="grow">
                        {s.items.map((i) => `${i.product_name} ×${i.quantity}`).join(', ')}
                        <span className="muted"> · {relativeTime(s.created_at)}</span>
                        {s.status === 'reversed' && <> <Badge tone="neutral">Reversed</Badge></>}
                      </span>
                      <strong className={`tabular ${s.status === 'reversed' ? 'muted' : 'text-success'}`}>{naira(s.total_amount, { signed: s.status !== 'reversed' })}</strong>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="muted small">No sales yet. Tap the mic and say “I sold…”.</p>}
          </section>
        </div>
      </div>
    </>
  );
}
