import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field, Input, parseMoney, parseWhole, Select } from '../../components/ui';
import { SupabaseBusinessApi } from '../../data/supabaseApi';
import { toAppError } from '../../lib/errors';
import { naira } from '../../lib/format';
import { newOpId } from '../../lib/ids';
import { supabase } from '../../lib/supabase';
import { BUSINESS_CATEGORIES } from '../../lib/types';
import type { PendingBusiness } from '../../state/auth';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { Splash } from '../../components/Splash';
import { AuthLayout } from './SignIn';

const UNITS = ['bag', 'carton', 'tin', 'crate', 'piece', 'pack', 'bottle', 'sachet', 'kg', 'litre', 'box', 'dozen'];

export default function Onboarding() {
  const auth = useAuth();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const step = auth.profile?.onboarding_step ?? 'business';

  useEffect(() => {
    if (auth.profile && step === 'done' && ws.business) navigate('/', { replace: true });
  }, [auth.profile, step, ws.business, navigate]);

  if (!auth.profile) {
    if (auth.profileError) {
      return (
        <AuthLayout title="We couldn't load your profile">
          <div className="stack">
            <div className="alert alert-error" role="alert">⚠️ {auth.profileError}</div>
            <Button onClick={() => void auth.refreshProfile()}>Try again</Button>
            <Button variant="ghost" onClick={() => void auth.signOut()}>Sign out</Button>
          </div>
        </AuthLayout>
      );
    }
    return <Splash label="Preparing your account…" />;
  }
  if (!ws.ready) return <Splash label="Checking your shop…" />;
  if (!ws.business || step === 'business') return <BusinessStep pending={(auth.user?.user_metadata?.pending_business as PendingBusiness | undefined) ?? null} hasBusiness={Boolean(ws.business)} />;
  if (step === 'products') return <ProductsStep onDone={() => void auth.updateProfile({ onboarding_step: 'voice_intro' }).catch((e) => toast.error(toAppError(e).message))} />;
  return <VoiceIntroStep onDone={async () => {
    try { await auth.updateProfile({ onboarding_step: 'done' }); navigate('/', { replace: true }); } catch (e) { toast.error(toAppError(e).message); }
  }} />;
}

function BusinessStep({ pending, hasBusiness }: { pending: PendingBusiness | null; hasBusiness: boolean }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const [name, setName] = useState(pending?.name ?? '');
  const [category, setCategory] = useState(pending?.category ?? '');
  const [market, setMarket] = useState(pending?.market_area ?? '');
  const [city, setCity] = useState(pending?.city ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Business already exists (e.g. created on another device) → move on.
    if (hasBusiness && auth.profile?.onboarding_step === 'business') void auth.updateProfile({ onboarding_step: 'products' });
  }, [hasBusiness, auth]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) { setError('Enter your business name (at least 2 letters).'); return; }
    if (!supabase) return;
    setBusy(true);
    try {
      const { error: rpcError } = await supabase.rpc('create_business', { p_name: name.trim(), p_category: category || 'other', p_market_area: market.trim() || null, p_city: city.trim() || null });
      if (rpcError) throw rpcError;
      await ws.reloadBusinesses();
      await auth.refreshProfile();
    } catch (err) {
      setError(`Your shop was not created: ${toAppError(err).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Your shop" subtitle={`Welcome${auth.profile?.full_name ? `, ${auth.profile.full_name.split(' ')[0]}` : ''}! Confirm your business details.`} step={{ n: 1, of: 3, label: 'Business' }} onBack={() => void auth.signOut()}>
      <form className="form" onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="Business name" required>{({ id }) => <Input id={id} prefixIcon="🏪" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ngozi Provisions Store" />}</Field>
        <Field label="Business type">{({ id }) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select…</option>
            {BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        )}</Field>
        <div className="form-grid">
          <Field label="Market area" optional>{({ id }) => <Input id={id} value={market} onChange={(e) => setMarket(e.target.value)} placeholder="Alaba Market" />}</Field>
          <Field label="City" optional>{({ id }) => <Input id={id} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Lagos" />}</Field>
        </div>
        <Button type="submit" size="lg" block loading={busy} loadingText="Creating your shop…">Continue →</Button>
      </form>
    </AuthLayout>
  );
}

interface Row { name: string; unit: string; price: string; cost: string; qty: string }
const emptyRow = (): Row => ({ name: '', unit: 'bag', price: '', cost: '', qty: '' });

function ProductsStep({ onDone }: { onDone: () => void }) {
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const [row, setRow] = useState<Row>(emptyRow());
  const [added, setAdded] = useState<{ name: string; qty: number; unit: string; price: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = supabase && ws.business && auth.user ? new SupabaseBusinessApi(supabase, ws.business.id, auth.user.id) : null;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const price = parseMoney(row.price);
    const cost = parseMoney(row.cost);
    const qty = parseWhole(row.qty) ?? 0;
    if (!row.name.trim()) { setError('Enter the product name.'); return; }
    if (price === null || Number.isNaN(price)) { setError('Enter the selling price, e.g. 35000.'); return; }
    if (cost !== null && Number.isNaN(cost)) { setError('Cost price should be a number, e.g. 30000.'); return; }
    if (Number.isNaN(qty)) { setError('Quantity should be a whole number.'); return; }
    if (!api) return;
    setBusy(true);
    try {
      await api.createProduct({ name: row.name.trim(), unit: row.unit, price, costPrice: cost, lowStockThreshold: 3, openingQuantity: qty, clientOpId: newOpId() });
      setAdded((a) => [...a, { name: row.name.trim(), qty, unit: row.unit, price }]);
      setRow(emptyRow());
      ws.invalidate('products');
      toast.success(`${row.name.trim()} added.`);
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Add your first products" subtitle="Add the things you sell most. You can add more anytime from Stock." step={{ n: 2, of: 3, label: 'Products' }}>
      <form className="form" onSubmit={add} noValidate>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="Product name" required>{({ id }) => <Input id={id} value={row.name} onChange={(e) => setRow({ ...row, name: e.target.value })} placeholder="e.g. Rice (50kg)" />}</Field>
        <div className="form-grid">
          <Field label="Sold per">{({ id }) => <Select id={id} value={row.unit} onChange={(e) => setRow({ ...row, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>}</Field>
          <Field label="How many now">{({ id }) => <Input id={id} inputMode="numeric" value={row.qty} onChange={(e) => setRow({ ...row, qty: e.target.value })} placeholder="0" />}</Field>
          <Field label="Selling price (₦)" required>{({ id }) => <Input id={id} inputMode="decimal" value={row.price} onChange={(e) => setRow({ ...row, price: e.target.value })} placeholder="35000" />}</Field>
          <Field label="Cost price (₦)" optional help="Lets Vendora work out your profit.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={row.cost} onChange={(e) => setRow({ ...row, cost: e.target.value })} placeholder="30000" />}</Field>
        </div>
        <Button type="submit" variant="secondary" loading={busy}>+ Add product</Button>
      </form>
      {added.length > 0 && (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, marginTop: 16 }} aria-label="Products added">
          {added.map((a) => <li key={a.name} className="row-between small"><span>✅ {a.name}</span><span className="muted">{a.qty} {a.unit} · {naira(a.price)}</span></li>)}
        </ul>
      )}
      <div className="stack" style={{ marginTop: 20 }}>
        <Button size="lg" block onClick={onDone}>{added.length ? 'Continue →' : 'Skip for now →'}</Button>
      </div>
    </AuthLayout>
  );
}

function VoiceIntroStep({ onDone }: { onDone: () => void }) {
  return (
    <AuthLayout title="Talk to your shop" subtitle="Record sales by speaking — Vendora always checks with you before saving." step={{ n: 3, of: 3, label: 'Voice' }}>
      <div className="stack">
        <ol className="stack-sm" style={{ paddingLeft: 20, margin: 0 }}>
          <li>Tap the big blue mic on the Home screen.</li>
          <li>Say what happened, for example <strong>“I sold 2 bags of rice for 35,000 each, cash.”</strong></li>
          <li>Vendora shows the sale and total. Tap <strong>Yes</strong> to save it, or <strong>Cancel</strong>.</li>
        </ol>
        <div className="alert alert-info">You can also type anything you'd say. Ask “How market today?” or “Wetin dey finish?” anytime.</div>
        <Button size="lg" block onClick={onDone}>Open my shop →</Button>
      </div>
    </AuthLayout>
  );
}
