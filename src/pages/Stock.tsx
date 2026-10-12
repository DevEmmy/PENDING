import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, PageHeader, parseMoney, parseWhole, Select, Sheet, SkeletonList, StockBadge, Textarea } from '../components/ui';
import { matchByName } from '../assistant/matching';
import { AppError, toAppError } from '../lib/errors';
import { formatDate, formatTime, naira, quantity, relativeTime } from '../lib/format';
import { newOpId } from '../lib/ids';
import { stockStatus, type Product, type StockStatus } from '../lib/types';
import { useToast } from '../state/toast';
import { useQuery, useWorkspace } from '../state/workspace';
import { recognitionSupported, startRecognition, type RecognitionHandle } from '../voice/recognition';

const UNITS = ['bag', 'carton', 'tin', 'crate', 'piece', 'pack', 'bottle', 'sachet', 'kg', 'litre', 'box', 'dozen', 'roll', 'gallon'];
const accent: Record<StockStatus, string> = { in: 'accent-success', low: 'accent-warning', out: 'accent-danger' };

export default function Stock() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<RecognitionHandle | null>(null);
  const canManage = ws.business?.role !== 'assistant';

  useEffect(() => {
    const add = params.get('add');
    if (add !== null) {
      setAdding(add === '1' ? '' : add);
      params.delete('add');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const counts = useMemo(() => ({
    all: ws.products.length,
    low: ws.products.filter((p) => stockStatus(p) === 'low').length,
    out: ws.products.filter((p) => stockStatus(p) === 'out').length,
  }), [ws.products]);

  const shown = useMemo(() => {
    let list = ws.products;
    if (filter !== 'all') list = list.filter((p) => stockStatus(p) === filter);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      const direct = list.filter((p) => p.name.toLowerCase().includes(needle));
      if (direct.length) list = direct;
      else {
        // Fuzzy fallback so spoken/misspelt names ("indomi") still find the item.
        const m = matchByName(q, list, (p) => p.name, 0.5);
        list = m.best ? [m.best] : m.candidates;
      }
    }
    const order: Record<StockStatus, number> = { out: 0, low: 1, in: 2 };
    return [...list].sort((a, b) => order[stockStatus(a)] - order[stockStatus(b)] || a.name.localeCompare(b.name));
  }, [ws.products, filter, q]);

  const voiceSearch = () => {
    if (listening) { rec.current?.stop(); return; }
    setListening(true);
    rec.current = startRecognition(ws.language, {
      onInterim: (t) => setQ(t),
      onFinal: (t) => setQ(t.replace(/^(how much|how many|find|search)\s+/i, '').replace(/\s+(remain|left)\??$/i, '')),
      onError: () => setListening(false),
      onEnd: () => setListening(false),
    });
    if (!rec.current) setListening(false);
  };

  return (
    <>
      <PageHeader
        title="Your Stock"
        subtitle="Updated automatically from your sales, voice and restocks"
        actions={canManage ? <Button variant="yellow" size="sm" onClick={() => setAdding('')}>＋ Add stock</Button> : undefined}
      >
        <div className="summary-row" role="group" aria-label="Filter stock">
          <button className="summary-pill pill-info" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{counts.all} items</button>
          <button className="summary-pill pill-warning" aria-pressed={filter === 'low'} onClick={() => setFilter(filter === 'low' ? 'all' : 'low')}>{counts.low} low</button>
          <button className="summary-pill pill-danger" aria-pressed={filter === 'out'} onClick={() => setFilter(filter === 'out' ? 'all' : 'out')}>{counts.out} out</button>
        </div>
      </PageHeader>
      <div className="page-body">
        <div className="search-bar">
          <span aria-hidden="true">🔍</span>
          <label htmlFor="stock-search" className="sr-only">Search items</label>
          <input id="stock-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items or speak…" autoComplete="off" />
          {recognitionSupported() && (
            <button className={`round-btn ${listening ? 'send' : 'mic'}`} style={{ width: 44, height: 44, fontSize: 18 }} onClick={voiceSearch} aria-label={listening ? 'Stop voice search' : 'Search by voice'} aria-pressed={listening}>
              <span aria-hidden="true">{listening ? '⏹' : '🎙️'}</span>
            </button>
          )}
        </div>
        {ws.productsState.fromCache && (
          <div className="alert alert-warning" role="status">📡 Offline — showing stock saved on this phone at {formatTime(ws.productsState.fromCache)} on {formatDate(ws.productsState.fromCache)}. Counts may have changed.</div>
        )}
        {ws.productsState.error && <ErrorState message={`Your stock didn't load: ${ws.productsState.error}`} onRetry={() => ws.invalidate('products')} />}
        {ws.productsState.loading && !ws.products.length ? <SkeletonList rows={6} /> : shown.length === 0 ? (
          ws.products.length === 0 ? (
            <EmptyState icon="📦" title="No products yet" action={canManage ? <Button onClick={() => setAdding('')}>Add your first product</Button> : undefined}>
              Add what you sell so Vendora can track it when you record sales.
            </EmptyState>
          ) : (
            <EmptyState icon="🔍" title="No matching items" action={<Button variant="secondary" onClick={() => { setQ(''); setFilter('all'); }}>Show all stock</Button>}>
              {q ? <>Nothing matches “{q}”.</> : 'Nothing in this group.'}{canManage && q && <> <button className="btn btn-ghost btn-sm" onClick={() => setAdding(q)}>Add “{q}”</button></>}
            </EmptyState>
          )
        ) : (
          <ul className="stock-grid" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Stock items">
            {shown.map((p) => (
              <li key={p.id}>
                <button className={`list-row accent stock-row ${accent[stockStatus(p)]}`} onClick={() => setSelected(p)}>
                  <span className="stack-sm" style={{ gap: 2, paddingLeft: 4 }}>
                    <span className="row-title">{p.name}</span>
                    <span className="row-sub">{quantity(p.stock_quantity, p.unit)} · Last updated {relativeTime(p.updated_at)}</span>
                  </span>
                  <span className="row-amount">{naira(p.price)}</span>
                  <StockBadge product={p} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ProductSheet product={selected ? ws.products.find((p) => p.id === selected.id) ?? selected : null} onClose={() => setSelected(null)} canManage={canManage} />
      <AddProductSheet initialName={adding} onClose={() => setAdding(null)} />
    </>
  );
}

function AddProductSheet({ initialName, onClose }: { initialName: string | null; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const open = initialName !== null;
  const [f, setF] = useState({ name: '', unit: 'bag', price: '', cost: '', qty: '', threshold: '3' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const opId = useRef(newOpId());
  useEffect(() => {
    if (open) { setF({ name: initialName ?? '', unit: 'bag', price: '', cost: '', qty: '', threshold: '3' }); setErrors({}); opId.current = newOpId(); }
  }, [open, initialName]);
  const dirty = Boolean(f.name || f.price || f.qty);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const price = parseMoney(f.price);
    const cost = parseMoney(f.cost);
    const qty = parseWhole(f.qty) ?? 0;
    const threshold = parseWhole(f.threshold) ?? 0;
    if (!f.name.trim()) errs.name = 'Enter the product name.';
    if (price === null || Number.isNaN(price)) errs.price = 'Enter a selling price like 35000 or 35k.';
    if (cost !== null && Number.isNaN(cost)) errs.cost = 'Enter a cost like 30000, or leave it empty.';
    if (Number.isNaN(qty)) errs.qty = 'Use a whole number.';
    if (Number.isNaN(threshold)) errs.threshold = 'Use a whole number.';
    if (!errs.name && ws.products.some((p) => p.name.toLowerCase() === f.name.trim().toLowerCase())) errs.name = 'You already have a product with this name.';
    setErrors(errs);
    if (Object.keys(errs).length || !ws.api) return;
    setBusy(true);
    try {
      const p = await ws.api.createProduct({ name: f.name.trim(), unit: f.unit, price: price!, costPrice: cost, lowStockThreshold: threshold, openingQuantity: qty, clientOpId: opId.current });
      ws.invalidate('products', 'dashboard');
      toast.success(`${p.name} added with ${quantity(p.stock_quantity, p.unit)}.`);
      onClose();
    } catch (err) {
      const ae = toAppError(err);
      if (ae.code === 'DUPLICATE_NAME') setErrors({ name: ae.message });
      else toast.error(`${f.name.trim() || 'Product'} was not added: ${ae.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add a product" description="Tell Vendora what you sell and how many you have now."
      confirmClose={() => !dirty || busy || window.confirm('Discard this product? What you typed will be lost.')}>
      <form className="form" onSubmit={submit} noValidate>
        <Field label="Product name" required error={errors.name}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus aria-invalid={invalid} aria-describedby={describedBy} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Rice (50kg)" />}</Field>
        <div className="form-grid">
          <Field label="Sold per">{({ id }) => <Select id={id} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>}</Field>
          <Field label="Quantity now" error={errors.qty}>{({ id, invalid }) => <Input id={id} aria-invalid={invalid} inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} placeholder="0" />}</Field>
          <Field label="Selling price (₦)" required error={errors.price}>{({ id, invalid, describedBy }) => <Input id={id} aria-invalid={invalid} aria-describedby={describedBy} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="35000" />}</Field>
          <Field label="Cost price (₦)" optional error={errors.cost}>{({ id, invalid }) => <Input id={id} aria-invalid={invalid} inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="30000" />}</Field>
          <Field label="Warn me when below" error={errors.threshold} help="Low-stock alert level">{({ id, invalid, describedBy }) => <Input id={id} aria-invalid={invalid} aria-describedby={describedBy} inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}</Field>
        </div>
        <div className="sheet-footer" style={{ marginTop: 0 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy} loadingText="Saving…">Save product</Button>
        </div>
      </form>
    </Sheet>
  );
}

function ProductSheet({ product, onClose, canManage }: { product: Product | null; onClose: () => void; canManage: boolean }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'restock' | 'adjust' | 'edit'>('view');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ qty: '', cost: '', count: '', reason: '', name: '', price: '', costPrice: '', threshold: '', unit: '' });
  const [error, setError] = useState<string | null>(null);
  const opId = useRef(newOpId());
  const movements = useQuery(['products'], async (api) => (product ? api.listMovements(product.id) : []), [product?.id]);

  useEffect(() => {
    if (product) {
      setMode('view');
      setError(null);
      setF({ qty: '', cost: product.cost_price?.toString() ?? '', count: String(product.stock_quantity), reason: '', name: product.name, price: String(product.price), costPrice: product.cost_price?.toString() ?? '', threshold: String(product.low_stock_threshold), unit: product.unit });
    }
  }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!product) return <Sheet open={false} onClose={onClose} title=""><span /></Sheet>;
  const go = (m: typeof mode) => { setMode(m); setError(null); opId.current = newOpId(); };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      const msg = await fn();
      ws.invalidate('products', 'dashboard');
      toast.success(msg);
      setMode('view');
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const restock = () => run(async () => {
    const qty = parseWhole(f.qty);
    const cost = parseMoney(f.cost);
    if (!qty || Number.isNaN(qty) || qty <= 0) throw new AppError('INVALID_INPUT', 'Enter how many you added, e.g. 10.');
    if (cost !== null && Number.isNaN(cost)) throw new AppError('INVALID_INPUT', 'Cost should be a number, e.g. 30000.');
    const r = await ws.api!.restock(product.id, qty, cost, opId.current);
    return r.duplicate ? 'That restock was already saved.' : `Restocked. ${r.name} now has ${quantity(r.stock_quantity, r.unit)}.`;
  });
  const adjust = () => run(async () => {
    const count = parseWhole(f.count);
    if (count === null || Number.isNaN(count)) throw new AppError('INVALID_INPUT', 'Enter the correct count, e.g. 7.');
    const r = await ws.api!.adjustStock(product.id, count, f.reason, opId.current);
    return `Stock count corrected to ${quantity(r.stock_quantity, product.unit)}.`;
  });
  const edit = () => run(async () => {
    const price = parseMoney(f.price);
    const cost = parseMoney(f.costPrice);
    const threshold = parseWhole(f.threshold);
    if (!f.name.trim()) throw new AppError('INVALID_INPUT', 'Name cannot be empty.');
    if (price === null || Number.isNaN(price)) throw new AppError('INVALID_INPUT', 'Enter a valid selling price.');
    if (cost !== null && Number.isNaN(cost)) throw new AppError('INVALID_INPUT', 'Enter a valid cost price or leave it empty.');
    if (threshold === null || Number.isNaN(threshold)) throw new AppError('INVALID_INPUT', 'Enter a whole number for the alert level.');
    await ws.api!.updateProduct(product.id, { name: f.name.trim(), price, cost_price: cost, low_stock_threshold: threshold, unit: f.unit.trim() || product.unit });
    return 'Product details saved.';
  });

  const kindLabel: Record<string, string> = { opening: 'Opening stock', sale: 'Sold', restock: 'Restocked', adjustment: 'Count corrected', sale_reversal: 'Sale reversed' };

  return (
    <>
      <Sheet open={Boolean(product)} onClose={onClose} title={product.name} description={<><StockBadge product={product} /> · {naira(product.price)} per {product.unit}</>}>
        {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
        {mode === 'view' && (
          <div className="stack">
            <div className="metric-grid">
              <div className="metric"><div className="label">In stock</div><div className="value">{quantity(product.stock_quantity, product.unit)}</div></div>
              <div className="metric"><div className="label">Cost price</div><div className="value">{product.cost_price !== null ? naira(product.cost_price) : '—'}</div>{product.cost_price === null && <div className="note">Add it to see profit</div>}</div>
            </div>
            {canManage ? (
              <div className="row wrap">
                <Button onClick={() => go('restock')}>＋ Restock</Button>
                <Button variant="secondary" onClick={() => go('adjust')}>Correct count</Button>
                <Button variant="secondary" onClick={() => go('edit')}>Edit details</Button>
              </div>
            ) : <p className="muted small">Only the shop owner or a manager can change stock and prices.</p>}
            <h3>History</h3>
            {movements.loading && !movements.data ? <SkeletonList rows={3} height={36} /> : movements.error ? <ErrorState message={movements.error} onRetry={movements.retry} /> : (
              <div>
                {(movements.data ?? []).length === 0 && <p className="muted small">No changes yet.</p>}
                {(movements.data ?? []).map((m) => (
                  <div key={m.id} className="movement">
                    <span>{kindLabel[m.kind]}{m.reason ? ` · ${m.reason}` : ''}<br /><span className="muted xs">{formatDate(m.created_at)}, {formatTime(m.created_at)}</span></span>
                    <span className="tabular" style={{ textAlign: 'right' }}>
                      <strong className={m.quantity_delta > 0 ? 'text-success' : ''}>{m.quantity_delta > 0 ? '+' : ''}{m.quantity_delta}</strong>
                      <br /><span className="muted xs">→ {m.quantity_after}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {canManage && (
              <>
                <hr className="divider" />
                <Button variant="danger" onClick={() => setArchiveOpen(true)}>Archive product</Button>
              </>
            )}
          </div>
        )}
        {mode === 'restock' && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void restock(); }} noValidate>
            <Field label={`How many ${product.unit}s did you add?`} required>{({ id }) => <Input id={id} data-autofocus inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} placeholder="10" />}</Field>
            <Field label="Cost per item (₦)" optional help="Updates your cost price for profit figures.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />}</Field>
            {parseWhole(f.qty) ? <p className="small muted">New count: <strong>{product.stock_quantity} → {product.stock_quantity + (parseWhole(f.qty) || 0)}</strong></p> : null}
            <div className="row"><Button variant="secondary" onClick={() => go('view')} disabled={busy}>Back</Button><Button type="submit" className="grow" loading={busy}>Save restock</Button></div>
          </form>
        )}
        {mode === 'adjust' && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void adjust(); }} noValidate>
            <div className="alert alert-info">Use this when you count your stock and the number is different (damaged, missing or miscounted). Sales and restocks update stock automatically.</div>
            <Field label="Correct count" required>{({ id }) => <Input id={id} data-autofocus inputMode="numeric" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />}</Field>
            <Field label="Reason" required>{({ id }) => <Textarea id={id} rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. 1 bag damaged by rain" />}</Field>
            <div className="row"><Button variant="secondary" onClick={() => go('view')} disabled={busy}>Back</Button><Button type="submit" className="grow" loading={busy}>Save count</Button></div>
          </form>
        )}
        {mode === 'edit' && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void edit(); }} noValidate>
            <Field label="Name" required>{({ id }) => <Input id={id} data-autofocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <div className="form-grid">
              <Field label="Selling price (₦)" required>{({ id }) => <Input id={id} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field>
              <Field label="Cost price (₦)" optional>{({ id }) => <Input id={id} inputMode="decimal" value={f.costPrice} onChange={(e) => setF({ ...f, costPrice: e.target.value })} />}</Field>
              <Field label="Sold per">{({ id }) => <Input id={id} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
              <Field label="Low-stock alert at">{({ id }) => <Input id={id} inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}</Field>
            </div>
            <p className="xs muted">Changing the price only affects new sales. Past sales keep the price they were sold at.</p>
            <div className="row"><Button variant="secondary" onClick={() => go('view')} disabled={busy}>Back</Button><Button type="submit" className="grow" loading={busy}>Save changes</Button></div>
          </form>
        )}
      </Sheet>
      <ConfirmDialog open={archiveOpen} title={`Archive ${product.name}?`} confirmLabel="Archive" tone="danger" busy={busy}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void run(async () => { await ws.api!.archiveProduct(product.id, true); setArchiveOpen(false); onClose(); return `${product.name} archived. Past sales are kept.`; })}>
        <p>It will be hidden from your stock list and sales screen. Its sales history stays in your records.</p>
      </ConfirmDialog>
    </>
  );
}
