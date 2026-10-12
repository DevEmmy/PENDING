import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, ErrorState, Field, Input, PageHeader, parseMoney, Sheet, SkeletonList } from '../components/ui';
import { toAppError } from '../lib/errors';
import { formatDate, formatTime, naira } from '../lib/format';
import { newOpId } from '../lib/ids';
import { useToast } from '../state/toast';
import { useQuery, useWorkspace } from '../state/workspace';

export default function CustomerDetail() {
  const { id = '' } = useParams();
  const ws = useWorkspace();
  const ledger = useQuery(['customers'], (api) => api.customerLedger(id), [id]);
  const customer = ws.customers.find((c) => c.customer_id === id);
  const [action, setAction] = useState<'payment' | 'debt' | null>(null);
  const canCharge = ws.business?.role !== 'assistant';

  if (!customer) {
    return (
      <>
        <PageHeader title="Customer" actions={<Link to="/customers" className="btn btn-on-dark btn-sm">Back</Link>} />
        <div className="page-body"><ErrorState message="This customer was not found." /></div>
      </>
    );
  }
  const label = { charge: 'Took goods on credit', payment: 'Paid', adjustment: 'Correction' } as const;

  return (
    <>
      <PageHeader title={customer.name} subtitle={customer.phone ?? undefined} overlap actions={<Link to="/customers" className="btn btn-on-dark btn-sm">Back</Link>} />
      <div className="page-body overlap-body" style={{ maxWidth: 760 }}>
        <section className="card stack" aria-label="Balance">
          <span className="muted small">{customer.balance >= 0 ? 'Owes you' : 'You owe them (credit)'}</span>
          <span className={`tabular ${customer.balance > 0 ? 'text-danger' : ''}`} style={{ fontSize: 34, fontWeight: 800 }}>{naira(Math.abs(customer.balance))}</span>
          <div className="row wrap">
            <Button onClick={() => setAction('payment')} disabled={customer.balance <= 0}>💵 Record payment</Button>
            {canCharge && <Button variant="secondary" onClick={() => setAction('debt')}>＋ Add money owed</Button>}
            {customer.phone && customer.balance > 0 && (
              <a className="btn btn-secondary" href={`https://wa.me/234${customer.phone.replace(/\D/g, '').replace(/^0/, '').replace(/^234/, '')}?text=${encodeURIComponent(`Hello ${customer.name}, this is a friendly reminder from ${ws.business?.name}: your balance is ${naira(customer.balance)}. Thank you!`)}`} target="_blank" rel="noopener noreferrer">
                💬 Remind on WhatsApp
              </a>
            )}
          </div>
          {customer.balance <= 0 && <p className="xs muted">Nothing to collect right now.</p>}
        </section>

        <section className="card stack" aria-labelledby="hist-h">
          <h2 id="hist-h">History</h2>
          {ledger.loading && !ledger.data ? <SkeletonList rows={3} height={44} /> : ledger.error ? <ErrorState message={ledger.error} onRetry={ledger.retry} /> :
            !ledger.data?.length ? <p className="muted small">No credit or payments yet.</p> : (
              <div>
                {ledger.data.map((t) => (
                  <div key={t.id} className="movement">
                    <span>
                      {label[t.kind]}{t.note ? ` · ${t.note}` : ''}
                      {t.sale_id && <> · <Link to={`/sales/${t.sale_id}`}>sale</Link></>}
                      <br /><span className="xs muted">{formatDate(t.created_at)}, {formatTime(t.created_at)}</span>
                    </span>
                    <strong className={`tabular ${t.amount < 0 ? 'text-success' : 'text-danger'}`}>{t.amount < 0 ? '−' : '+'}{naira(Math.abs(t.amount))}</strong>
                  </div>
                ))}
              </div>
            )}
        </section>
      </div>
      <DebtSheet kind={action} customerId={customer.customer_id} name={customer.name} balance={customer.balance} onClose={() => setAction(null)} />
    </>
  );
}

function DebtSheet({ kind, customerId, name, balance, onClose }: { kind: 'payment' | 'debt' | null; customerId: string; name: string; balance: number; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opId = useRef(newOpId());
  const isPay = kind === 'payment';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseMoney(amount);
    if (!n || Number.isNaN(n) || n <= 0) { setError('Enter an amount above zero, e.g. 5000.'); return; }
    if (isPay && n > balance) { setError(`${name} only owes ${naira(balance)}.`); return; }
    setBusy(true);
    setError(null);
    try {
      const r = isPay ? await ws.api!.recordDebtPayment(customerId, n, note, opId.current) : await ws.api!.recordDebt(customerId, n, note, opId.current);
      ws.invalidate('customers', 'dashboard');
      toast.success(r.duplicate ? 'This was already recorded.' : `${isPay ? 'Payment recorded' : 'Debt recorded'}. ${name} now ${r.balance > 0 ? `owes ${naira(r.balance)}` : 'owes nothing'}.`);
      setAmount(''); setNote('');
      opId.current = newOpId();
      onClose();
    } catch (err) {
      setError(`${isPay ? 'Payment' : 'Debt'} not recorded: ${toAppError(err).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={kind !== null} onClose={onClose} title={isPay ? `Payment from ${name}` : `Money ${name} owes`} description={isPay ? `Currently owes ${naira(balance)}` : 'For goods taken without a recorded sale.'}>
      <form className="form" onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="Amount (₦)" required>{({ id }) => <Input id={id} data-autofocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" />}</Field>
        {isPay && balance > 0 && <Button variant="ghost" size="sm" onClick={() => setAmount(String(balance))}>Paid everything ({naira(balance)})</Button>}
        <Field label="Note" optional>{({ id }) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isPay ? 'e.g. Paid by transfer' : 'e.g. 2 cartons of milk'} />}</Field>
        <div className="sheet-footer" style={{ marginTop: 0 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>{isPay ? 'Record payment' : 'Record debt'}</Button>
        </div>
      </form>
    </Sheet>
  );
}
