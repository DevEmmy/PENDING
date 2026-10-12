import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatedNaira, Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, parseMoney, Select, Sheet, SkeletonList, Tabs } from '../components/ui';
import { toAppError } from '../lib/errors';
import { formatDate, formatTime, lagosDayKey, naira, relativeTime } from '../lib/format';
import type { PaymentRecord, Sale } from '../lib/types';
import { discardQueued, retryQueued } from '../offline/queue';
import { useToast } from '../state/toast';
import { useQuery, useWorkspace } from '../state/workspace';

const METHOD: Record<string, string> = { cash: 'Cash', transfer: 'Transfer', pos: 'POS', credit: 'Credit' };
const CHANNEL: Record<string, string> = { voice: 'Voice recorded', pos: 'Recorded at till', manual: 'Recorded manually', offline: 'Recorded offline' };
const VSTATUS: Record<PaymentRecord['verification_status'], { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  unverified: { label: 'Not verified', tone: 'danger' },
  pending_review: { label: 'Receipt uploaded · awaiting review', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export function saleTitle(s: Sale) {
  const items = s.items.map((i) => `${i.product_name} ${i.quantity} ${i.quantity === 1 ? i.unit : i.unit + 's'}`).join(', ');
  return s.customer_name ? `${s.customer_name} – ${items}` : items;
}

export default function Sales() {
  const ws = useWorkspace();
  const [tab, setTab] = useState<'sales' | 'payments'>('sales');
  const [payOpen, setPayOpen] = useState(false);
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const dash = useQuery(['dashboard', 'sales'], (api) => api.dashboard());
  const [pages, setPages] = useState(1);
  const sales = useQuery(['sales'], (api) => api.listSales({ limit: 20 * pages }), [pages]);
  const payments = useQuery(['payments'], (api) => api.listPayments(30));
  const d = dash.data;
  const failedQueue = ws.queue.filter((q) => q.status === 'failed');
  const pendingQueue = ws.queue.filter((q) => q.status !== 'failed');

  return (
    <>
      <PageHeader title="Sales & Payments" subtitle="Every sale and payment in one place" overlap actions={<Link to="/sales/new" className="btn btn-yellow btn-sm">＋ New sale</Link>} />
      <div className="page-body overlap-body">
        <div className="stat-grid">
          <div className="stat-card" style={{ ['--bar' as string]: 'var(--green-500)' }}><div className="label">Today</div><div className="value">{d ? <AnimatedNaira value={d.today.revenue} compactFrom={1_000_000} /> : '—'}</div></div>
          <div className="stat-card" style={{ ['--bar' as string]: 'var(--blue-500)' }}><div className="label">This week</div><div className="value">{d ? <AnimatedNaira value={d.week.revenue} compactFrom={1_000_000} /> : '—'}</div></div>
          <div className="stat-card" style={{ ['--bar' as string]: 'var(--yellow-400)' }}>
            <div className="label">Profit (7 days)</div>
            <div className="value">{d ? <AnimatedNaira value={d.week.profit} compactFrom={1_000_000} /> : '—'}</div>
            {d && !d.week.profit_complete && <div className="xs muted">Some items have no cost price</div>}
          </div>
        </div>
        {dash.error && <ErrorState message={dash.error} onRetry={dash.retry} />}

        <div className="card bank-card">
          <div className="stack-sm" style={{ gap: 2 }}>
            <strong>🏦 Bank account not linked</strong>
            <span className="small muted">Automatic transfer detection needs a bank partner and isn't switched on yet. Record transfers you receive below.</span>
          </div>
          <Badge tone="neutral">Coming soon</Badge>
        </div>

        <div className="row wrap">
          <Button size="lg" className="grow" onClick={() => setPayOpen(true)}>💸 Record a payment received</Button>
        </div>

        {(pendingQueue.length > 0 || failedQueue.length > 0) && (
          <section className="card stack" aria-labelledby="queue-h">
            <div className="row-between">
              <h3 id="queue-h">Saved on this phone</h3>
              {ws.online && pendingQueue.length > 0 && <Button size="sm" variant="secondary" onClick={() => void ws.syncNow()}>Sync now</Button>}
            </div>
            <p className="small muted">These sales are not recorded yet. They sync automatically when you're online.</p>
            {ws.queue.map((q) => (
              <div key={q.opId} className="list-row" style={{ boxShadow: 'none', padding: '8px 0' }}>
                <span className={`tx-icon ${q.status === 'failed' ? 'warn' : 'queued'}`} aria-hidden="true">{q.status === 'failed' ? '!' : '⏳'}</span>
                <span className="grow">
                  <span className="row-title">{q.summary}</span>
                  <span className="row-sub" style={{ display: 'block' }}>
                    {q.status === 'failed' ? <span className="text-danger">Not accepted: {q.lastError}</span> : q.status === 'syncing' ? 'Syncing…' : `Waiting to sync · saved ${relativeTime(q.createdAt)}`}
                  </span>
                  {q.status === 'failed' && (
                    <span className="row" style={{ marginTop: 6 }}>
                      <Button size="sm" variant="secondary" onClick={() => void retryQueued(q.opId).then(() => ws.syncNow())}>Try again</Button>
                      <Button size="sm" variant="danger" onClick={() => { if (window.confirm('Discard this sale? It was never recorded, and this cannot be undone.')) void discardQueued(q.opId); }}>Discard</Button>
                    </span>
                  )}
                </span>
                <span className="row-amount">{naira(q.total)}</span>
              </div>
            ))}
          </section>
        )}

        <Tabs label="Transactions" value={tab} onChange={setTab} options={[{ value: 'sales', label: 'Recent sales' }, { value: 'payments', label: 'Payments received' }]} />

        {tab === 'sales' && (
          sales.loading && !sales.data ? <SkeletonList rows={5} /> : sales.error ? <ErrorState message={`Sales didn't load: ${sales.error}`} onRetry={sales.retry} /> :
          !sales.data?.length ? (
            <EmptyState icon="🧾" title="No sales yet" action={<Link to="/sales/new" className="btn btn-primary">Record a sale</Link>}>Record your first sale by voice or with the till.</EmptyState>
          ) : (
            <>
              <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {sales.data.map((s) => (
                  <li key={s.id}>
                    <Link to={`/sales/${s.id}`} className="list-row">
                      <span className={`tx-icon ${s.status === 'reversed' ? 'out' : 'ok'}`} aria-hidden="true">{s.status === 'reversed' ? '↺' : '✓'}</span>
                      <span className="grow">
                        <span className="row-title" style={{ display: 'block' }}>{saleTitle(s)}</span>
                        <span className="row-sub">
                          {s.status === 'reversed' ? 'Reversed' : `${METHOD[s.payment_method]}${s.payment_status !== 'paid' ? ` · ${naira(s.total_amount - s.amount_paid)} owing` : ''}`} · {CHANNEL[s.channel]} · {formatTime(s.created_at)}{lagosDayKey(s.created_at) === lagosDayKey(new Date()) ? '' : `, ${formatDate(s.created_at)}`}
                        </span>
                      </span>
                      <span className={`row-amount ${s.status === 'reversed' ? 'muted' : 'text-success'}`} style={s.status === 'reversed' ? { textDecoration: 'line-through' } : undefined}>{naira(s.total_amount, { signed: true })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {sales.data.length >= 20 * pages && <Button variant="secondary" onClick={() => setPages((p) => p + 1)} loading={sales.loading}>Show more</Button>}
            </>
          )
        )}

        {tab === 'payments' && (
          payments.loading && !payments.data ? <SkeletonList rows={4} /> : payments.error ? <ErrorState message={payments.error} onRetry={payments.retry} /> :
          !payments.data?.length ? (
            <EmptyState icon="💸" title="No payments recorded" action={<Button onClick={() => setPayOpen(true)}>Record a payment</Button>}>When a customer sends a transfer, record it here and attach the receipt.</EmptyState>
          ) : (
            <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {payments.data.map((p) => {
                const v = VSTATUS[p.verification_status];
                return (
                  <li key={p.id}>
                    <button className="list-row" onClick={() => setPayment(p)}>
                      <span className={`tx-icon ${p.verification_status === 'unverified' ? 'warn' : 'ok'}`} aria-hidden="true">{p.verification_status === 'unverified' ? '!' : '✓'}</span>
                      <span className="grow">
                        <span className="row-title" style={{ display: 'block' }}>{p.payer_name || 'Unknown sender'} · {METHOD[p.channel]}</span>
                        <span className="row-sub"><Badge tone={v.tone}>{v.label}</Badge> {relativeTime(p.created_at)}{p.verification_status === 'unverified' ? ' · tap to add receipt' : ''}</span>
                      </span>
                      <span className="row-amount text-success">{naira(p.amount, { signed: true })}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
      <RecordPaymentSheet open={payOpen} onClose={() => setPayOpen(false)} />
      <PaymentSheet payment={payment} onClose={() => setPayment(null)} />
    </>
  );
}

function RecordPaymentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState('');
  const [channel, setChannel] = useState<'transfer' | 'cash' | 'pos'>('transfer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseMoney(amount);
    if (!n || Number.isNaN(n) || n <= 0) { setError('Enter the amount received, e.g. 8500.'); return; }
    setBusy(true);
    setError(null);
    try {
      await ws.api!.recordPayment({ amount: n, payerName: payer.trim(), channel });
      ws.invalidate('payments');
      toast.success(`${naira(n)} payment recorded (not verified).`);
      setAmount(''); setPayer('');
      onClose();
    } catch (err) {
      setError(`Payment was not recorded: ${toAppError(err).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Record a payment received" description="This notes money you received. It is not a bank confirmation.">
      <form className="form" onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="Amount (₦)" required>{({ id }) => <Input id={id} data-autofocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="8500" />}</Field>
        <Field label="From" optional>{({ id }) => <Input id={id} value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. Emeka Chukwu" />}</Field>
        <Field label="How was it paid?">{({ id }) => (
          <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="pos">POS</option>
          </Select>
        )}</Field>
        <div className="sheet-footer" style={{ marginTop: 0 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>Save payment</Button>
        </div>
      </form>
    </Sheet>
  );
}

function PaymentSheet({ payment, onClose }: { payment: PaymentRecord | null; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<PaymentRecord | null>(null);
  const p = current && payment && current.id === payment.id ? current : payment;
  if (!p) return <Sheet open={false} onClose={onClose} title=""><span /></Sheet>;
  const v = VSTATUS[p.verification_status];

  const upload = async (file: File) => {
    setError(null);
    if (file.size > 5 * 1024 * 1024) { setError('That image is larger than 5 MB. Take a smaller photo or screenshot and try again.'); return; }
    if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(file.type)) { setError('Upload a photo (JPG, PNG, WebP) or a PDF.'); return; }
    setProgress(5);
    try {
      const updated = await ws.api!.attachReceipt(p.id, file, setProgress);
      setCurrent(updated);
      ws.invalidate('payments');
      toast.success('Receipt uploaded. Marked as awaiting review — this is not a bank verification.');
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Sheet open={Boolean(payment)} onClose={() => { setCurrent(null); onClose(); }} title={`${naira(p.amount)} from ${p.payer_name || 'unknown sender'}`} description={`${formatDate(p.created_at)}, ${formatTime(p.created_at)}`}>
      <div className="stack">
        <div className="row"><span>Status:</span><Badge tone={v.tone}>{v.label}</Badge></div>
        <div className="alert alert-info">
          Vendora cannot confirm transfers with your bank yet. A receipt photo helps your records, but it does not prove the money arrived — check your bank app before releasing goods.
        </div>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        {progress !== null && (
          <div role="status" aria-live="polite">
            <div className="progress"><span style={{ width: `${progress}%` }} /></div>
            <span className="xs muted">Uploading receipt… {progress}%</span>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        {p.verification_status === 'unverified' && (
          <Button size="lg" onClick={() => fileRef.current?.click()} loading={progress !== null} loadingText="Uploading…">📸 Upload receipt photo</Button>
        )}
        {p.receipt_path && <p className="small muted">📎 Receipt attached.</p>}
      </div>
    </Sheet>
  );
}
