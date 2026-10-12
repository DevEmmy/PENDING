import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatedNaira, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { buildAdvice } from '../lib/insights';
import { lagosDayKey, naira, nairaCompact } from '../lib/format';
import { useQuery } from '../state/workspace';
import { useVoice } from '../voice/VoiceProvider';
import { TrendPill } from './Home';

const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Insights() {
  const dash = useQuery(['dashboard', 'sales', 'products'], (api) => api.dashboard());
  const voice = useVoice();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number | null>(null);
  const d = dash.data;
  const week = d?.daily.slice(-7) ?? [];
  const max = Math.max(1, ...week.map((x) => x.revenue));
  const todayKey = lagosDayKey(new Date());
  const advice = d ? buildAdvice(d) : [];
  const ask = (q: string) => { navigate('/chat'); void voice.send(q, 'text'); };
  const sel = selected !== null ? week[selected] : null;

  return (
    <>
      <PageHeader title="VendorAI Insights" subtitle="Smart advice for your business" overlap />
      <div className="page-body overlap-body">
        {dash.error && <ErrorState message={`Insights didn't load: ${dash.error}`} onRetry={dash.retry} />}
        <div className="grid-2-wide" style={{ display: 'grid', gap: 16 }}>
          <section className="card chart-card" aria-labelledby="rev-h">
            <h2 id="rev-h" style={{ fontSize: 17 }}>Weekly Revenue</h2>
            {!d ? <Skeleton height={190} /> : (
              <>
                <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
                  <AnimatedNaira value={d.week.revenue} className="bold" />
                  <TrendPill current={d.week.revenue} previous={d.week.prev_revenue} label="last week" />
                </div>
                <div className="bar-chart" role="group" aria-label="Revenue for each of the last 7 days">
                  {week.map((day, i) => {
                    const wd = new Date(`${day.date}T12:00:00Z`).getUTCDay();
                    const h = Math.max(22, (day.revenue / max) * 100);
                    return (
                      <button key={day.date} className={`bar-col ${day.date === todayKey ? 'today' : ''} ${selected === i ? 'selected' : ''}`}
                        onClick={() => setSelected(selected === i ? null : i)} onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)}
                        aria-label={`${DAY_NAME[wd]}${day.date === todayKey ? ' (today)' : ''}: ${naira(day.revenue)} from ${day.count} sales`}>
                        <span className="bar-fill" style={{ height: `${h}%`, animationDelay: `${i * 40}ms` }}>{DAY_LETTER[wd]}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="chart-tip" aria-live="polite">
                  {sel ? <><strong>{DAY_NAME[new Date(`${sel.date}T12:00:00Z`).getUTCDay()]}</strong>: {naira(sel.revenue)} · {sel.count} sale{sel.count === 1 ? '' : 's'}</> : <span className="muted">Tap a bar to see that day. Highlighted bar is today.</span>}
                </div>
              </>
            )}
          </section>

          <section className="metric-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', alignContent: 'start' }} aria-label="Key figures">
            {!d ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={84} radius={18} />) : (
              <>
                <div className="metric"><div className="label">This month</div><div className="value">{nairaCompact(d.month.revenue)}</div><div className="note">{d.month.count} sales</div></div>
                <div className="metric"><div className="label">Profit this month</div><div className="value">{nairaCompact(d.month.profit)}</div><div className="note">{d.month.profit_complete ? 'After cost' : 'Items with cost price only'}</div></div>
                <div className="metric"><div className="label">Stock value (cost)</div><div className="value">{nairaCompact(d.stock.value_at_cost)}</div><div className="note">{d.stock.missing_cost_count ? `${d.stock.missing_cost_count} item(s) without cost` : `${d.stock.item_count} items`}</div></div>
                <Link to="/customers" className="metric card-link"><div className="label">Owed to you</div><div className="value">{nairaCompact(d.debts.outstanding)}</div><div className="note">{d.debts.debtors} customer(s)</div></Link>
              </>
            )}
          </section>
        </div>

        <h2>VendorAI Advice <span aria-hidden="true">✨</span></h2>
        {d && advice.length === 0 && <EmptyState icon="🌱" title="Not enough activity yet">Record a few sales this week and Vendora will spot your best and slowest items.</EmptyState>}
        <div className="grid-2">
          {advice.map((a) => (
            <article key={a.id} className={`advice-card advice-${a.tone}`}>
              <h3><span aria-hidden="true">{a.icon}</span> {a.title}</h3>
              <p>{a.body}</p>
              <button className="btn" onClick={() => ask(a.ask)}>Ask VendorAI →</button>
            </article>
          ))}
        </div>
        <p className="xs muted">Advice is worked out from your recorded sales and stock. It is guidance, not a guarantee.</p>
      </div>
    </>
  );
}
