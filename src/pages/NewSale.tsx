import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, EmptyState, Field, Input, PageHeader, parseMoney, Select, Sheet, SkeletonList } from '../components/ui';
import { toAppError } from '../lib/errors';
import { naira, quantity } from '../lib/format';
import { newOpId } from '../lib/ids';
import { stockStatus, type PaymentMethod, type Product, type SaleResult } from '../lib/types';
import { submitSale } from '../offline/queue';
import { useWorkspace } from '../state/workspace';

interface Line { product: Product; qty: number; price: number }

export default function NewSale() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Line[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [paidNow, setPaidNow] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ kind: 'recorded'; result: SaleResult } | { kind: 'queued' } | null>(null);
  const opId = useRef(newOpId('sale'));
  const [hint, setHint] = useState<string | null>(null);

  const products = useMemo(() => ws.products.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())), [ws.products, q]);
  const total = Math.round(cart.reduce((a, l) => a + l.qty * l.price, 0) * 100) / 100;
  const paid = method === 'credit' ? parseMoney(paidNow) ?? 0 : total;
  const owing = Math.max(0, Math.round((total - (Number.isNaN(paid) ? 0 : paid)) * 100) / 100);

  const add = (p: Product) => {
    setError(null);
    setCart((c) => {
      const existing = c.find((l) => l.product.id === p.id);
      const nextQty = (existing?.qty ?? 0) + 1;
      if (nextQty > p.stock_quantity) {
        setHint(`Only ${quantity(p.stock_quantity, p.unit)} of ${p.name} in stock.`);
        return c;
      }
      setHint(null);
      return existing ? c.map((l) => (l.product.id === p.id ? { ...l, qty: nextQty } : l)) : [...c, { product: p, qty: 1, price: p.price }];
    });
    opId.current = newOpId('sale'); // cart changed → this is a new sale attempt
  };
  const setQty = (id: string, qty: number) => {
    setCart((c) => c.flatMap((l) => {
      if (l.product.id !== id) return [l];
      if (qty <= 0) return [];
      return [{ ...l, qty: Math.min(qty, l.product.stock_quantity) }];
    }));
    opId.current = newOpId('sale');
  };
  const setPrice = (id: string, v: string) => {
    const n = parseMoney(v);
    setCart((c) => c.map((l) => (l.product.id === id ? { ...l, price: n === null || Number.isNaN(n) ? 0 : n } : l)));
    opId.current = newOpId('sale');
  };

  const submit = async () => {
    setError(null);
    if (!cart.length) { setError('Add at least one item.'); return; }
    if (cart.some((l) => !(l.price >= 0))) { setError('Check the prices.'); return; }
    if (method === 'credit' && (Number.isNaN(paid) || paid > total)) { setError(`Amount paid now must be between ₦0 and ${naira(total)}.`); return; }
    if (owing > 0 && !customerId && !newCustomer.trim()) { setError('Choose who owes the balance, or add a new customer.'); return; }
    if (!ws.api) return;
    setBusy(true);
    try {
      let cid = customerId || null;
      if (!cid && newCustomer.trim() && owing > 0) {
        cid = (await ws.api.createCustomer(newCustomer.trim())).customer_id;
        ws.invalidate('customers');
      }
      const outcome = await submitSale(ws.api, {
        clientOpId: opId.current, channel: 'pos', paymentMethod: method, amountPaid: method === 'credit' ? paid : null, customerId: cid,
        items: cart.map((l) => ({ product_id: l.product.id, quantity: l.qty, unit_price: l.price })),
      }, cart.map((l) => `${quantity(l.qty, l.product.unit)} ${l.product.name}`).join(', '), total);
      if (outcome.kind === 'recorded') {
        ws.invalidate('products', 'sales', 'dashboard', 'customers');
        setDone({ kind: 'recorded', result: outcome.result });
      } else {
        setDone({ kind: 'queued' });
      }
    } catch (e) {
      setError(`Sale not recorded: ${toAppError(e).message}`);
      ws.invalidate('products'); // refresh stock in case it changed
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCart([]); setMethod('cash'); setPaidNow(''); setCustomerId(''); setNewCustomer(''); setDone(null); setError(null);
    opId.current = newOpId('sale');
  };

  return (
    <>
      <PageHeader title="New sale" subtitle="Tap items to add them. Stock updates when you record." actions={<Link to="/sales" className="btn btn-on-dark btn-sm">Close</Link>} />
      <div className="page-body">
        <div className="pos-layout">
          <section className="stack" aria-label="Products">
            <div className="search-bar">
              <span aria-hidden="true">🔍</span>
              <label htmlFor="pos-search" className="sr-only">Find a product</label>
              <input id="pos-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product…" />
            </div>
            {hint && <div className="alert alert-warning" role="status">{hint}</div>}
            {ws.productsState.loading && !ws.products.length ? <SkeletonList rows={4} height={104} /> : !ws.products.length ? (
              <EmptyState icon="📦" title="No products yet" action={<Link className="btn btn-primary" to="/stock?add=1">Add a product</Link>}>Add products to sell them here.</EmptyState>
            ) : (
              <div className="grid-cards">
                {products.map((p) => {
                  const inCart = cart.find((l) => l.product.id === p.id);
                  const out = stockStatus(p) === 'out';
                  return (
                    <button key={p.id} className={`product-tile ${inCart ? 'in-cart' : ''}`} onClick={() => add(p)} disabled={out}
                      aria-label={`${p.name}, ${naira(p.price)}, ${quantity(p.stock_quantity, p.unit)} in stock${inCart ? `, ${inCart.qty} in sale` : ''}`}>
                      {inCart && <span className="qty-badge" aria-hidden="true">{inCart.qty}</span>}
                      <strong>{p.name}</strong>
                      <span className="tabular">{naira(p.price)}</span>
                      <span className={`xs ${out ? 'text-danger' : stockStatus(p) === 'low' ? 'text-warning' : 'muted'}`}>{out ? 'Out of stock' : `${quantity(p.stock_quantity, p.unit)} left`}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card cart-panel stack" aria-labelledby="cart-h">
            <h2 id="cart-h">This sale</h2>
            {cart.length === 0 ? <p className="muted small">Tap products to add them to this sale.</p> : (
              <div>
                {cart.map((l) => (
                  <div key={l.product.id} className="cart-line">
                    <div>
                      <strong>{l.product.name}</strong>
                      <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                        <label htmlFor={`price-${l.product.id}`} className="muted">₦ each</label>
                        <input id={`price-${l.product.id}`} className="input" style={{ width: 110, minHeight: 36, padding: '6px 10px' }} inputMode="decimal" defaultValue={l.price} onBlur={(e) => setPrice(l.product.id, e.target.value)} />
                      </div>
                    </div>
                    <div className="stepper" role="group" aria-label={`Quantity of ${l.product.name}`}>
                      <button type="button" onClick={() => setQty(l.product.id, l.qty - 1)} aria-label={l.qty === 1 ? `Remove ${l.product.name}` : `One less ${l.product.name}`}>{l.qty === 1 ? '🗑' : '−'}</button>
                      <input aria-label="Quantity" inputMode="numeric" value={l.qty} onChange={(e) => setQty(l.product.id, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                      <button type="button" onClick={() => setQty(l.product.id, l.qty + 1)} disabled={l.qty >= l.product.stock_quantity} aria-label={`One more ${l.product.name}`}>+</button>
                    </div>
                    <span className="xs muted">{l.qty >= l.product.stock_quantity ? 'All remaining stock' : `${l.product.stock_quantity - l.qty} will be left`}</span>
                    <strong className="tabular" style={{ textAlign: 'right' }}>{naira(l.qty * l.price)}</strong>
                  </div>
                ))}
              </div>
            )}
            <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack-sm">
              <legend className="label">Payment</legend>
              <div className="segmented">
                {(['cash', 'transfer', 'pos', 'credit'] as PaymentMethod[]).map((m) => (
                  <button key={m} type="button" className="chip" aria-pressed={method === m} onClick={() => setMethod(m)}>{m === 'pos' ? 'POS' : m === 'credit' ? 'Credit' : m[0].toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </fieldset>
            {method === 'transfer' && <p className="xs muted">Check your bank app shows the money before releasing goods — Vendora does not confirm transfers yet.</p>}
            {method === 'credit' && (
              <Field label="Paid now (₦)" optional help="Leave empty if they paid nothing yet.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} placeholder="0" />}</Field>
            )}
            {owing > 0 && (
              <div className="stack-sm">
                <Field label="Customer who owes" required>{({ id }) => (
                  <Select id={id} value={customerId} onChange={(e) => { setCustomerId(e.target.value); if (e.target.value) setNewCustomer(''); }}>
                    <option value="">Choose a customer…</option>
                    {ws.customers.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.name}{c.balance > 0 ? ` (owes ${naira(c.balance)})` : ''}</option>)}
                  </Select>
                )}</Field>
                {!customerId && <Field label="…or new customer name">{({ id }) => <Input id={id} value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} placeholder="e.g. Bisi Adewale" />}</Field>}
              </div>
            )}
            <div className="total-row"><span>Total</span><span className="tabular">{naira(total)}</span></div>
            {owing > 0 && <div className="row-between small"><span className="muted">Owing after this sale</span><strong className="text-danger tabular">{naira(owing)}</strong></div>}
            {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
            <Button size="lg" block onClick={() => void submit()} loading={busy} loadingText="Recording…" disabled={!cart.length}>Record sale · {naira(total)}</Button>
          </section>
        </div>
      </div>

      <Sheet open={Boolean(done)} onClose={reset} title={done?.kind === 'queued' ? 'Saved on this phone' : 'Sale recorded'}>
        {done?.kind === 'queued' ? (
          <div className="stack">
            <div className="alert alert-warning">⏳ You're offline, so this sale is <strong>not recorded yet</strong>. It's saved on this phone and will sync automatically when you're back online.</div>
            <Button onClick={reset}>New sale</Button>
          </div>
        ) : done?.kind === 'recorded' ? (
          <div className="stack">
            <div className="alert alert-success" role="status">✅ {done.result.duplicate ? 'This sale was already recorded — nothing was added twice.' : `${naira(done.result.total_amount)} recorded.`}</div>
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {done.result.items.map((i) => (
                <li key={i.product_id ?? i.product_name} className="row-between small">
                  <span>{i.product_name}</span>
                  <span className="muted">{i.stock_remaining !== null ? `${quantity(i.stock_remaining, i.unit)} left` : ''}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="secondary" className="grow" onClick={() => navigate(`/sales/${done.result.sale_id}?invoice=1`)}>🧾 Invoice</Button>
              <Button className="grow" onClick={reset}>New sale</Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
