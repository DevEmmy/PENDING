// @vitest-environment node
/**
 * LIVE integration test: runs the app's real data layer (supabase-js, SupabaseBusinessApi, hubApi)
 * over HTTP against a Supabase-compatible stack (Supabase Auth + PostgREST + PostgreSQL with
 * Vendora's migrations). Start one with scripts/local-stack/start.sh, then:
 *   source .local-stack/env.sh && LIVE=1 npx vitest run src/data/live.integration.test.ts
 * Skipped automatically when LIVE is not set. Does not cover Storage, Realtime or Edge Functions.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors';
import { newOpId } from '../lib/ids';
import { SupabaseBusinessApi } from './supabaseApi';

const LIVE = process.env.LIVE === '1' && process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY;
const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.VITE_SUPABASE_ANON_KEY!;
const run = Date.now().toString(36);
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function signUp(db: SupabaseClient, name: string, lang = 'en') {
  const { data, error } = await db.auth.signUp({
    email: `${name}-${run}@example.com`, password: 'Market2026!',
    options: { data: { full_name: `${name} Test`, preferred_language: lang, phone: '+2348030000000', pending_business: { name: `${name} Stores` } } },
  });
  if (error) throw error;
  return data;
}

describe.skipIf(!LIVE)('live data layer against Supabase Auth + PostgREST', () => {
  // Created in beforeAll so collecting this file never needs a configured stack.
  let ada: SupabaseClient;
  let chidi: SupabaseClient;
  let adaApi: SupabaseBusinessApi;
  let chidiApi: SupabaseBusinessApi;
  let adaBiz = '';
  let chidiBiz = '';
  let riceId = '';
  let saleId = '';

  beforeAll(async () => {
    ada = client();
    chidi = client();
    const a = await signUp(ada, 'ada', 'pcm');
    const c = await signUp(chidi, 'chidi');
    expect(a.session, 'autoconfirmed session for Ada').toBeTruthy();
    expect(c.session).toBeTruthy();
  });

  it('creates the profile at signup from metadata (database trigger)', async () => {
    const { data, error } = await ada.rpc('ensure_profile');
    expect(error).toBeNull();
    expect(data).toMatchObject({ full_name: 'ada Test', preferred_language: 'pcm', phone: '+2348030000000', onboarding_step: 'business' });
  });

  it('refuses a second account with the same email', async () => {
    const { data, error } = await client().auth.signUp({ email: `ada-${run}@example.com`, password: 'Another2026!' });
    const duplicate = Boolean(error) || (data.user?.identities?.length ?? 1) === 0;
    expect(duplicate).toBe(true);
  });

  it('creates businesses and loads memberships with the app\'s query', async () => {
    const r1 = await ada.rpc('create_business', { p_name: 'Ada Provisions', p_category: 'foodstuff', p_market_area: 'Alaba Market', p_city: 'Lagos' });
    expect(r1.error).toBeNull();
    const r2 = await chidi.rpc('create_business', { p_name: 'Chidi Wholesale', p_category: 'foodstuff', p_market_area: 'Mile 12', p_city: 'Lagos' });
    expect(r2.error).toBeNull();
    const { data: session } = await ada.auth.getUser();
    const { data, error } = await ada.from('business_members').select('role, businesses(id,name,category,market_area,city)').eq('user_id', session.user!.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ role: 'owner', businesses: { name: 'Ada Provisions' } });
    adaBiz = r1.data.id;
    chidiBiz = r2.data.id;
    adaApi = new SupabaseBusinessApi(ada, adaBiz, session.user!.id);
    const { data: cu } = await chidi.auth.getUser();
    chidiApi = new SupabaseBusinessApi(chidi, chidiBiz, cu.user!.id);
  });

  it('manages products and stock through RPCs', async () => {
    const rice = await adaApi.createProduct({ name: 'Rice (50kg)', unit: 'bag', price: 35000, costPrice: 30000, lowStockThreshold: 3, openingQuantity: 10, clientOpId: newOpId() });
    riceId = rice.id;
    expect(rice).toMatchObject({ stock_quantity: 10, price: 35000, cost_price: 30000 });
    await adaApi.createProduct({ name: 'Indomie', unit: 'carton', price: 6000, costPrice: null, lowStockThreshold: 2, openingQuantity: 6, clientOpId: newOpId() });
    await expect(adaApi.createProduct({ name: 'rice (50KG)', unit: 'bag', price: 1, costPrice: null, lowStockThreshold: 1, openingQuantity: 0, clientOpId: newOpId() }))
      .rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    const list = await adaApi.listProducts();
    expect(list.map((p) => p.name)).toEqual(['Indomie', 'Rice (50kg)']);
    // Stock can't be edited directly, even by the owner
    const direct = await ada.from('products').update({ stock_quantity: 999 }).eq('id', riceId);
    expect(direct.error?.message).toMatch(/permission denied/);
  });

  it('records a sale once even when retried, and reports remaining stock', async () => {
    const op = newOpId('sale');
    const input = { clientOpId: op, channel: 'voice' as const, paymentMethod: 'cash' as const, items: [{ product_id: riceId, quantity: 2, unit_price: 35000 }] };
    const r = await adaApi.recordSale(input);
    saleId = r.sale_id;
    expect(r).toMatchObject({ duplicate: false, total_amount: 70000, amount_paid: 70000, payment_status: 'paid' });
    expect(r.items[0]).toMatchObject({ product_name: 'Rice (50kg)', stock_remaining: 8 });
    const again = await adaApi.recordSale(input);
    expect(again).toMatchObject({ duplicate: true, sale_id: saleId });
    expect((await adaApi.listProducts()).find((p) => p.id === riceId)?.stock_quantity).toBe(8);
  });

  it('maps database errors to clear messages (insufficient stock)', async () => {
    const err = await adaApi.recordSale({ clientOpId: newOpId('sale'), channel: 'pos', paymentMethod: 'cash', items: [{ product_id: riceId, quantity: 50 }] }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.message).toBe('Only 8 bags of Rice (50kg) left.');
    expect(err.detail).toMatchObject({ available: 8, requested: 50 });
  });

  it('tracks credit sales, debt payments and balances', async () => {
    const emeka = await adaApi.createCustomer('Emeka Chukwu', '08031234567');
    await expect(adaApi.createCustomer('emeka chukwu')).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    const r = await adaApi.recordSale({ clientOpId: newOpId('sale'), channel: 'pos', paymentMethod: 'credit', amountPaid: 10000, customerId: emeka.customer_id, items: [{ product_id: riceId, quantity: 1 }] });
    expect(r.payment_status).toBe('part_paid');
    expect((await adaApi.listCustomers()).find((c) => c.name === 'Emeka Chukwu')?.balance).toBe(25000);
    await expect(adaApi.recordDebtPayment(emeka.customer_id, 30000, '', newOpId())).rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_BALANCE' });
    const op = newOpId();
    expect((await adaApi.recordDebtPayment(emeka.customer_id, 5000, 'cash', op)).balance).toBe(20000);
    expect((await adaApi.recordDebtPayment(emeka.customer_id, 5000, 'cash', op)).duplicate).toBe(true);
    const ledger = await adaApi.customerLedger(emeka.customer_id);
    expect(ledger.map((l) => [l.kind, l.amount])).toEqual(expect.arrayContaining([['charge', 25000], ['payment', -5000]]));
  });

  it('lists sales with customers and items, issues invoices, reverses sales', async () => {
    const sales = await adaApi.listSales({ limit: 10 });
    expect(sales).toHaveLength(2);
    expect(sales.find((s) => s.payment_method === 'credit')?.customer_name).toBe('Emeka Chukwu');
    expect(sales.find((s) => s.id === saleId)?.items[0]).toMatchObject({ product_name: 'Rice (50kg)', quantity: 2, line_total: 70000 });
    const inv = await adaApi.issueInvoice(saleId);
    expect(inv.invoice_number).toBe('INV-00001');
    expect((await adaApi.issueInvoice(saleId)).duplicate).toBe(true);
    expect((await adaApi.getInvoiceForSale(saleId))?.invoice_number).toBe('INV-00001');
    const rev = await adaApi.reverseSale(saleId, 'Customer returned the bags');
    expect(rev.status).toBe('reversed');
    expect((await adaApi.getSale(saleId))?.status).toBe('reversed');
    expect((await adaApi.getInvoiceForSale(saleId))?.status).toBe('void');
    expect((await adaApi.listProducts()).find((p) => p.id === riceId)?.stock_quantity).toBe(9);
  });

  it('restocks, adjusts and keeps a movement history', async () => {
    const op = newOpId();
    expect((await adaApi.restock(riceId, 5, 31000, op)).stock_quantity).toBe(14);
    expect((await adaApi.restock(riceId, 5, 31000, op)).duplicate).toBe(true);
    expect((await adaApi.adjustStock(riceId, 13, 'One bag torn', newOpId())).stock_quantity).toBe(13);
    const moves = await adaApi.listMovements(riceId);
    expect(moves.map((m) => m.kind)).toEqual(['adjustment', 'restock', 'sale_reversal', 'sale', 'sale', 'opening']);
  });

  it('computes the dashboard from records', async () => {
    const d = await adaApi.dashboard();
    expect(d.today).toMatchObject({ revenue: 35000, count: 1, profit: 5000, profit_complete: true });
    expect(d.debts).toMatchObject({ outstanding: 20000, debtors: 1 });
    expect(d.stock.item_count).toBe(2);
    expect(d.daily).toHaveLength(14);
  });

  it('records payments but never lets a user mark them bank-verified', async () => {
    const p = await adaApi.recordPayment({ amount: 8500, payerName: 'Emeka', channel: 'transfer' });
    expect(p.verification_status).toBe('unverified');
    const forged = await ada.from('payments_received').update({ verification_status: 'verified' }).eq('id', p.id);
    expect(forged.error?.message).toMatch(/only be verified/);
  });

  it('isolates businesses from each other', async () => {
    expect(await chidiApi.listProducts()).toEqual([]);
    const peek = await chidi.from('products').select('id').eq('business_id', adaBiz);
    expect(peek.data).toEqual([]);
    const cross = new SupabaseBusinessApi(chidi, adaBiz, 'x');
    await expect(cross.recordSale({ clientOpId: newOpId(), channel: 'pos', paymentMethod: 'cash', items: [{ product_id: riceId, quantity: 1 }] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(cross.dashboard()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await cross.listCustomers()).toEqual([]);
  });

  it('keeps anonymous visitors out', async () => {
    const anon = client();
    const r = await anon.from('products').select('id');
    expect(r.error?.message).toMatch(/permission denied/);
    const rpc = await anon.rpc('get_dashboard_summary', { p_business_id: adaBiz });
    expect(rpc.error).toBeTruthy();
  });

  it('runs the Vendors Hub flow between two vendors', async () => {
    // Chidi makes his shop public and publishes an advert
    expect((await chidi.from('vendor_profiles').update({ is_public: true, products_summary: 'Rice, beans, garri' }).eq('business_id', chidiBiz).select('business_id')).data).toHaveLength(1);
    const forged = await chidi.from('vendor_profiles').update({ verification_status: 'verified' }).eq('business_id', chidiBiz);
    expect(forged.error?.message).toMatch(/permission denied/);
    const { data: cu } = await chidi.auth.getUser();
    const ad = await chidi.from('adverts').insert({ business_id: chidiBiz, created_by: cu.user!.id, headline: `Mama Gold rice wholesale ${run}`, product_name: 'Rice 50kg', category: 'foodstuff', price_min: 32000, price_max: 34000, unit: 'bag', min_order_qty: 10, pricing_type: 'wholesale', market: 'Mile 12', city: 'Lagos', status: 'published' }).select('id').single();
    expect(ad.error).toBeNull();
    // Ada finds it with the app's search RPC, and messages Chidi
    const found = await ada.rpc('search_adverts', { p_query: `mama gold ${run}`, p_limit: 12, p_offset: 0 });
    expect(found.error).toBeNull();
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({ vendor_name: 'Chidi Wholesale', vendor_verification: 'unverified' });
    await ada.from('vendor_profiles').update({ is_public: true }).eq('business_id', adaBiz);
    const conn = await ada.rpc('request_connection', { p_business_id: adaBiz, p_target_business_id: chidiBiz });
    expect(conn.error).toBeNull();
    const conv = await ada.rpc('start_conversation', { p_business_id: adaBiz, p_other_business_id: chidiBiz, p_advert_id: ad.data!.id });
    expect(conv.error).toBeNull();
    const { data: au } = await ada.auth.getUser();
    const msg = { conversation_id: conv.data, sender_business_id: adaBiz, sender_user_id: au.user!.id, body: 'How much for 20 bags?', client_msg_id: 'msg-live-0001' };
    expect((await ada.from('messages').insert(msg)).error).toBeNull();
    expect((await ada.from('messages').insert(msg)).error?.code).toBe('23505'); // idempotent client id
    // Chidi reads it, gets notified, accepts the connection
    const inbox = await chidi.from('messages').select('body').eq('conversation_id', conv.data);
    expect(inbox.data).toEqual([{ body: 'How much for 20 bags?' }]);
    const notes = await chidi.from('notifications').select('kind');
    expect(notes.data?.map((n) => n.kind).sort()).toEqual(['connection_request', 'message']);
    expect((await chidi.rpc('respond_connection', { p_connection_id: conn.data.id, p_accept: true })).data.status).toBe('accepted');
    // A third party sees none of it
    const eve = client();
    await signUp(eve, 'eve');
    expect((await eve.from('messages').select('id')).data).toEqual([]);
    expect((await eve.from('vendor_connections').select('id')).data).toEqual([]);
  });
});
