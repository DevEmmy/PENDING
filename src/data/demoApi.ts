import { AppError } from '../lib/errors';
import { lagosDayKey } from '../lib/format';
import { newId } from '../lib/ids';
import type {
  Customer, DashboardSummary, DebtResult, DebtTransaction, InventoryMovement, Invoice, NewProductInput,
  PaymentRecord, Product, Sale, SaleInput, SaleResult,
} from '../lib/types';
import type { BusinessApi, NewPaymentInput, RestockResult, VoiceLog } from './api';

/**
 * Demo shop: a clearly-labelled, in-browser sample business. It mirrors the server's rules
 * (stock checks, idempotency, debts, invoice numbering) but never touches Supabase and is
 * never mixed with a real account's data. State lives in sessionStorage only.
 */

interface DemoState {
  version: 3;
  products: Product[];
  sales: (Sale & { client_op_id: string })[];
  customers: { id: string; name: string; phone: string | null }[];
  debts: (DebtTransaction & { customer_id: string; client_op_id: string | null })[];
  movements: (InventoryMovement & { client_op_id: string | null })[];
  invoices: (Invoice & { sale_id: string })[];
  payments: PaymentRecord[];
  invoiceSeq: number;
}

export const DEMO_BUSINESS_ID = 'demo-business';
const KEY = 'vendora.demo.v3';

const round2 = (n: number) => Math.round(n * 100) / 100;

function seed(now = new Date()): DemoState {
  const t = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60000).toISOString();
  const mk = (name: string, unit: string, price: number, cost: number | null, stock: number, threshold: number, minsAgo: number): Product => ({
    id: newId(), business_id: DEMO_BUSINESS_ID, name, unit, price, cost_price: cost, stock_quantity: stock,
    low_stock_threshold: threshold, image_url: null, archived_at: null, updated_at: t(minsAgo),
  });
  const products = [
    mk('Rice (50kg)', 'bag', 35000, 30000, 14, 5, 2),
    mk('Peak Milk', 'carton', 8400, 7300, 8, 3, 60),
    mk('Indomie', 'carton', 6000, 5100, 6, 2, 180),
    mk('Tomato Paste', 'carton', 3600, 3000, 2, 3, 60 * 26),
    mk('Sugar (50kg)', 'bag', 19000, 17200, 0, 2, 60 * 50),
    mk('Vegetable Oil', 'crate', 14400, 12600, 9, 3, 240),
  ];
  const customers = [
    { id: newId(), name: 'Emeka Chukwu', phone: '08031234567' },
    { id: newId(), name: 'Amaka Obi', phone: '08059876543' },
    { id: newId(), name: 'Chidi Okeke', phone: null },
  ];
  const state: DemoState = {
    version: 3, products, sales: [], customers, debts: [], movements: [], invoices: [], payments: [], invoiceSeq: 0,
  };
  for (const p of products) {
    state.movements.push({ id: newId(), product_id: p.id, kind: 'opening', quantity_delta: p.stock_quantity, quantity_after: p.stock_quantity, reason: 'Demo opening stock', created_at: t(60 * 24 * 15), client_op_id: null });
  }
  // Deterministic history for the last 13 days + today so charts and insights have something real to compute from.
  const pattern = [[0, 2], [2, 3], [1, 2], [5, 1], [0, 3], [3, 4], [2, 1]];
  for (let d = 13; d >= 0; d--) {
    const salesToday = d === 0 ? 3 : 2 + ((d * 7) % 4);
    for (let k = 0; k < salesToday; k++) {
      const [pi, qty] = pattern[(d + k) % pattern.length];
      const p = products[pi];
      const minsAgo = d * 1440 + 60 + k * 47;
      const sale: Sale & { client_op_id: string } = {
        id: newId(), client_op_id: newId(), created_at: t(minsAgo), total_amount: p.price * qty, amount_paid: p.price * qty,
        total_cost: p.cost_price !== null ? p.cost_price * qty : null, payment_method: k % 2 ? 'transfer' : 'cash',
        payment_status: 'paid', channel: k % 3 === 0 ? 'voice' : 'pos', status: 'completed', reversal_reason: null,
        customer_id: null, customer_name: null, note: null,
        items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: qty, unit_price: p.price, line_total: p.price * qty }],
      };
      state.sales.push(sale);
    }
  }
  // An outstanding debt for Emeka (from a credit sale three days ago)
  const rice = products[0];
  const creditSale: Sale & { client_op_id: string } = {
    id: newId(), client_op_id: newId(), created_at: t(3 * 1440), total_amount: rice.price, amount_paid: 15000, total_cost: rice.cost_price,
    payment_method: 'credit', payment_status: 'part_paid', channel: 'voice', status: 'completed', reversal_reason: null,
    customer_id: customers[0].id, customer_name: customers[0].name, note: null,
    items: [{ product_id: rice.id, product_name: rice.name, unit: rice.unit, quantity: 1, unit_price: rice.price, line_total: rice.price }],
  };
  state.sales.push(creditSale);
  state.debts.push({ id: newId(), customer_id: customers[0].id, kind: 'charge', amount: 20000, note: 'Unpaid balance on sale', sale_id: creditSale.id, created_at: creditSale.created_at, client_op_id: null });
  state.payments.push(
    { id: newId(), amount: 8500, payer_name: 'Emeka Chukwu', channel: 'transfer', source: 'manual', verification_status: 'unverified', receipt_path: null, sale_id: null, note: null, created_at: t(35) },
    { id: newId(), amount: 5000, payer_name: null, channel: 'transfer', source: 'manual', verification_status: 'unverified', receipt_path: null, sale_id: null, note: 'Unknown sender', created_at: t(200) },
  );
  state.sales.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return state;
}

export class DemoBusinessApi implements BusinessApi {
  readonly mode = 'demo' as const;
  readonly businessId = DEMO_BUSINESS_ID;
  private s: DemoState;
  private latencyMs: number;

  constructor(opts: { fresh?: boolean; latencyMs?: number; storage?: Storage | null } = {}) {
    this.latencyMs = opts.latencyMs ?? 250;
    this.storage = opts.storage === undefined ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null) : opts.storage;
    const saved = !opts.fresh ? this.load() : null;
    this.s = saved ?? seed();
    this.save();
  }
  private storage: Storage | null;

  static reset(storage: Storage | null = typeof sessionStorage !== 'undefined' ? sessionStorage : null) {
    try { storage?.removeItem(KEY); } catch { /* ignore */ }
  }

  private load(): DemoState | null {
    try {
      const raw = this.storage?.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as DemoState) : null;
      return parsed?.version === 3 ? parsed : null;
    } catch {
      return null;
    }
  }
  private save() {
    try { this.storage?.setItem(KEY, JSON.stringify(this.s)); } catch { /* storage full or blocked: keep in memory */ }
  }
  private wait() {
    return new Promise((r) => setTimeout(r, this.latencyMs));
  }
  private product(id: string): Product {
    const p = this.s.products.find((x) => x.id === id && !x.archived_at);
    if (!p) throw new AppError('PRODUCT_NOT_FOUND', 'That product could not be found. It may have been removed.');
    return p;
  }
  private balance(customerId: string): number {
    return round2(this.s.debts.filter((d) => d.customer_id === customerId).reduce((a, d) => a + d.amount, 0));
  }
  private saleResult(saleId: string, duplicate: boolean): SaleResult {
    const sale = this.s.sales.find((x) => x.id === saleId)!;
    return {
      sale_id: sale.id, duplicate, total_amount: sale.total_amount, amount_paid: sale.amount_paid,
      payment_status: sale.payment_status, payment_method: sale.payment_method, customer_id: sale.customer_id,
      created_at: sale.created_at, status: sale.status,
      items: sale.items.map((i) => {
        const p = this.s.products.find((x) => x.id === i.product_id);
        return { ...i, stock_remaining: p?.stock_quantity ?? null, low_stock_threshold: p?.low_stock_threshold ?? null };
      }),
    };
  }

  async listProducts(opts: { includeArchived?: boolean } = {}) {
    await this.wait();
    return this.s.products.filter((p) => opts.includeArchived || !p.archived_at).map((p) => ({ ...p })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProduct(input: NewProductInput) {
    await this.wait();
    const name = input.name.trim();
    if (!name) throw new AppError('INVALID_INPUT', 'Product name is required.');
    if (input.price < 0) throw new AppError('INVALID_INPUT', 'Selling price must be zero or more.');
    if (this.s.products.some((p) => !p.archived_at && p.name.toLowerCase() === name.toLowerCase()))
      throw new AppError('DUPLICATE_NAME', `You already have a product called "${name}".`);
    const p: Product = {
      id: newId(), business_id: DEMO_BUSINESS_ID, name, unit: input.unit.trim() || 'piece', price: round2(input.price),
      cost_price: input.costPrice === null ? null : round2(input.costPrice), stock_quantity: input.openingQuantity,
      low_stock_threshold: input.lowStockThreshold, image_url: null, archived_at: null, updated_at: new Date().toISOString(),
    };
    this.s.products.push(p);
    if (input.openingQuantity > 0)
      this.s.movements.push({ id: newId(), product_id: p.id, kind: 'opening', quantity_delta: input.openingQuantity, quantity_after: input.openingQuantity, reason: null, created_at: p.updated_at, client_op_id: input.clientOpId });
    this.save();
    return { ...p };
  }

  async updateProduct(id: string, patch: Partial<Pick<Product, 'name' | 'unit' | 'price' | 'cost_price' | 'low_stock_threshold'>>) {
    await this.wait();
    Object.assign(this.product(id), patch, { updated_at: new Date().toISOString() });
    this.save();
  }

  async archiveProduct(id: string, archived: boolean) {
    await this.wait();
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new AppError('PRODUCT_NOT_FOUND', 'That product could not be found.');
    p.archived_at = archived ? new Date().toISOString() : null;
    this.save();
  }

  async restock(productId: string, quantity: number, unitCost: number | null, clientOpId: string, note?: string): Promise<RestockResult> {
    await this.wait();
    if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError('INVALID_INPUT', 'Restock quantity must be a whole number above zero.');
    const p = this.product(productId);
    if (this.s.movements.some((m) => m.client_op_id === clientOpId && m.kind === 'restock'))
      return { duplicate: true, product_id: p.id, name: p.name, unit: p.unit, stock_quantity: p.stock_quantity };
    p.stock_quantity += quantity;
    if (unitCost !== null) p.cost_price = round2(unitCost);
    p.updated_at = new Date().toISOString();
    this.s.movements.push({ id: newId(), product_id: p.id, kind: 'restock', quantity_delta: quantity, quantity_after: p.stock_quantity, reason: note ?? null, created_at: p.updated_at, client_op_id: clientOpId });
    this.save();
    return { duplicate: false, product_id: p.id, name: p.name, unit: p.unit, stock_quantity: p.stock_quantity };
  }

  async adjustStock(productId: string, newQuantity: number, reason: string, clientOpId: string) {
    await this.wait();
    if (!Number.isInteger(newQuantity) || newQuantity < 0) throw new AppError('INVALID_INPUT', 'Stock count cannot be negative.');
    if (reason.trim().length < 3) throw new AppError('INVALID_INPUT', 'Please say why the stock count is changing (e.g. "damaged", "recount").');
    const p = this.product(productId);
    if (this.s.movements.some((m) => m.client_op_id === clientOpId && m.kind === 'adjustment')) return { stock_quantity: p.stock_quantity };
    const delta = newQuantity - p.stock_quantity;
    if (delta !== 0) {
      p.stock_quantity = newQuantity;
      p.updated_at = new Date().toISOString();
      this.s.movements.push({ id: newId(), product_id: p.id, kind: 'adjustment', quantity_delta: delta, quantity_after: newQuantity, reason: reason.trim(), created_at: p.updated_at, client_op_id: clientOpId });
      this.save();
    }
    return { stock_quantity: p.stock_quantity };
  }

  async listMovements(productId: string) {
    await this.wait();
    return this.s.movements.filter((m) => m.product_id === productId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  }

  async recordSale(input: SaleInput): Promise<SaleResult> {
    await this.wait();
    const existing = this.s.sales.find((x) => x.client_op_id === input.clientOpId);
    if (existing) return this.saleResult(existing.id, true);
    if (!input.items.length || input.items.length > 50) throw new AppError('INVALID_INPUT', 'A sale needs between 1 and 50 items.');
    if (input.customerId && !this.s.customers.some((c) => c.id === input.customerId)) throw new AppError('CUSTOMER_NOT_FOUND', 'That customer was not found.');
    // Validate everything before mutating (atomic, like the database transaction).
    const needed = new Map<string, number>();
    const lines = input.items.map((it) => {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new AppError('INVALID_INPUT', 'Each quantity must be a whole number above zero.');
      const p = this.product(it.product_id);
      const price = round2(it.unit_price ?? p.price);
      if (price < 0) throw new AppError('INVALID_INPUT', 'Prices cannot be negative.');
      needed.set(p.id, (needed.get(p.id) ?? 0) + it.quantity);
      if (p.stock_quantity < needed.get(p.id)!)
        throw new AppError('INSUFFICIENT_STOCK', `Only ${p.stock_quantity} ${p.unit} of ${p.name} left.`, { detail: { product_id: p.id, name: p.name, unit: p.unit, available: p.stock_quantity, requested: needed.get(p.id) } });
      return { p, qty: it.quantity, price };
    });
    const total = round2(lines.reduce((a, l) => a + l.qty * l.price, 0));
    const paid = round2(input.paymentMethod === 'credit' ? input.amountPaid ?? 0 : input.amountPaid ?? total);
    if (paid < 0 || paid > total) throw new AppError('INVALID_INPUT', 'Amount paid must be between zero and the sale total.');
    if (paid < total && !input.customerId) throw new AppError('CUSTOMER_REQUIRED', 'Choose the customer who owes the balance.');
    const costKnown = lines.every((l) => l.p.cost_price !== null);
    const now = new Date().toISOString();
    const sale: Sale & { client_op_id: string } = {
      id: newId(), client_op_id: input.clientOpId, created_at: now, total_amount: total, amount_paid: paid,
      total_cost: costKnown ? round2(lines.reduce((a, l) => a + l.qty * (l.p.cost_price ?? 0), 0)) : null,
      payment_method: input.paymentMethod, payment_status: paid === total ? 'paid' : paid === 0 ? 'unpaid' : 'part_paid',
      channel: input.channel, status: 'completed', reversal_reason: null, customer_id: input.customerId ?? null,
      customer_name: this.s.customers.find((c) => c.id === input.customerId)?.name ?? null, note: input.note ?? null,
      items: lines.map((l) => ({ product_id: l.p.id, product_name: l.p.name, unit: l.p.unit, quantity: l.qty, unit_price: l.price, line_total: round2(l.qty * l.price) })),
    };
    for (const l of lines) {
      l.p.stock_quantity -= l.qty;
      l.p.updated_at = now;
      this.s.movements.push({ id: newId(), product_id: l.p.id, kind: 'sale', quantity_delta: -l.qty, quantity_after: l.p.stock_quantity, reason: null, created_at: now, client_op_id: null });
    }
    if (paid < total) this.s.debts.push({ id: newId(), customer_id: input.customerId!, kind: 'charge', amount: round2(total - paid), note: 'Unpaid balance on sale', sale_id: sale.id, created_at: now, client_op_id: null });
    this.s.sales.unshift(sale);
    this.save();
    return this.saleResult(sale.id, false);
  }

  async reverseSale(saleId: string, reason: string) {
    await this.wait();
    if (reason.trim().length < 3) throw new AppError('INVALID_INPUT', 'Please give a reason for reversing this sale.');
    const sale = this.s.sales.find((x) => x.id === saleId);
    if (!sale) throw new AppError('SALE_NOT_FOUND', 'That sale was not found.');
    if (sale.status === 'reversed') throw new AppError('SALE_ALREADY_REVERSED', 'This sale was already reversed.');
    const now = new Date().toISOString();
    for (const i of sale.items) {
      const p = this.s.products.find((x) => x.id === i.product_id);
      if (!p) continue;
      p.stock_quantity += i.quantity;
      this.s.movements.push({ id: newId(), product_id: p.id, kind: 'sale_reversal', quantity_delta: i.quantity, quantity_after: p.stock_quantity, reason: reason.trim(), created_at: now, client_op_id: null });
    }
    const charged = this.s.debts.filter((d) => d.sale_id === saleId && d.kind === 'charge').reduce((a, d) => a + d.amount, 0);
    if (charged > 0 && sale.customer_id) this.s.debts.push({ id: newId(), customer_id: sale.customer_id, kind: 'adjustment', amount: -charged, note: `Sale reversed: ${reason.trim()}`, sale_id: saleId, created_at: now, client_op_id: null });
    sale.status = 'reversed';
    sale.reversal_reason = reason.trim();
    const inv = this.s.invoices.find((x) => x.sale_id === saleId);
    if (inv) inv.status = 'void';
    this.save();
    return this.saleResult(saleId, false);
  }

  async listSales(opts: { limit?: number; before?: string } = {}) {
    await this.wait();
    return this.s.sales.filter((x) => !opts.before || x.created_at < opts.before).slice(0, opts.limit ?? 30).map(({ client_op_id: _c, ...rest }) => rest);
  }

  async getSale(id: string) {
    await this.wait();
    const s = this.s.sales.find((x) => x.id === id);
    if (!s) return null;
    const { client_op_id: _c, ...rest } = s;
    return rest;
  }

  async listCustomers(): Promise<Customer[]> {
    await this.wait();
    return this.s.customers.map((c) => {
      const tx = this.s.debts.filter((d) => d.customer_id === c.id);
      return { customer_id: c.id, name: c.name, phone: c.phone, balance: this.balance(c.id), last_activity_at: tx.length ? tx.map((d) => d.created_at).sort().at(-1)! : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createCustomer(name: string, phone?: string): Promise<Customer> {
    await this.wait();
    const n = name.trim();
    if (!n) throw new AppError('INVALID_INPUT', 'Customer name is required.');
    if (this.s.customers.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new AppError('DUPLICATE_NAME', `You already have a customer called "${n}".`);
    const c = { id: newId(), name: n, phone: phone?.trim() || null };
    this.s.customers.push(c);
    this.save();
    return { customer_id: c.id, name: c.name, phone: c.phone, balance: 0, last_activity_at: null };
  }

  async customerLedger(customerId: string) {
    await this.wait();
    return this.s.debts.filter((d) => d.customer_id === customerId).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ customer_id: _c, client_op_id: _o, ...rest }) => rest);
  }

  async recordDebt(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult> {
    await this.wait();
    if (!(amount > 0)) throw new AppError('INVALID_INPUT', 'Amount owed must be above zero.');
    if (!this.s.customers.some((c) => c.id === customerId)) throw new AppError('CUSTOMER_NOT_FOUND', 'That customer was not found.');
    const dup = this.s.debts.find((d) => d.client_op_id === clientOpId);
    if (dup) return { duplicate: true, transaction_id: dup.id, balance: this.balance(customerId) };
    const tx = { id: newId(), customer_id: customerId, kind: 'charge' as const, amount: round2(amount), note: note || null, sale_id: null, created_at: new Date().toISOString(), client_op_id: clientOpId };
    this.s.debts.push(tx);
    this.save();
    return { duplicate: false, transaction_id: tx.id, balance: this.balance(customerId) };
  }

  async recordDebtPayment(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult> {
    await this.wait();
    if (!(amount > 0)) throw new AppError('INVALID_INPUT', 'Payment must be above zero.');
    if (!this.s.customers.some((c) => c.id === customerId)) throw new AppError('CUSTOMER_NOT_FOUND', 'That customer was not found.');
    const dup = this.s.debts.find((d) => d.client_op_id === clientOpId);
    if (dup) return { duplicate: true, transaction_id: dup.id, balance: this.balance(customerId) };
    const bal = this.balance(customerId);
    if (round2(amount) > bal) throw new AppError('PAYMENT_EXCEEDS_BALANCE', `This customer only owes ₦${bal.toLocaleString('en-NG')}.`, { detail: { balance: bal } });
    const tx = { id: newId(), customer_id: customerId, kind: 'payment' as const, amount: -round2(amount), note: note || null, sale_id: null, created_at: new Date().toISOString(), client_op_id: clientOpId };
    this.s.debts.push(tx);
    this.save();
    return { duplicate: false, transaction_id: tx.id, balance: this.balance(customerId) };
  }

  async issueInvoice(saleId: string): Promise<Invoice> {
    await this.wait();
    const existing = this.s.invoices.find((x) => x.sale_id === saleId);
    if (existing) return { ...existing, duplicate: true };
    const sale = this.s.sales.find((x) => x.id === saleId && x.status === 'completed');
    if (!sale) throw new AppError('SALE_NOT_FOUND', 'Only completed sales can be invoiced.');
    this.s.invoiceSeq += 1;
    const inv = { invoice_id: newId(), sale_id: saleId, invoice_number: `INV-${String(this.s.invoiceSeq).padStart(5, '0')}`, issued_at: new Date().toISOString(), status: 'issued' as const };
    this.s.invoices.push(inv);
    this.save();
    return { ...inv, duplicate: false };
  }

  async getInvoiceForSale(saleId: string) {
    await this.wait();
    return this.s.invoices.find((x) => x.sale_id === saleId) ?? null;
  }

  async dashboard(): Promise<DashboardSummary> {
    await this.wait();
    return computeDashboard(this.s.products, this.s.sales, this.s.debts);
  }

  async listPayments(limit = 20) {
    await this.wait();
    return [...this.s.payments].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  async recordPayment(input: NewPaymentInput) {
    await this.wait();
    if (!(input.amount > 0)) throw new AppError('INVALID_INPUT', 'Amount must be above zero.');
    const p: PaymentRecord = { id: newId(), amount: round2(input.amount), payer_name: input.payerName || null, channel: input.channel, source: 'manual', verification_status: 'unverified', receipt_path: null, sale_id: null, note: input.note || null, created_at: new Date().toISOString() };
    this.s.payments.push(p);
    this.save();
    return p;
  }

  async attachReceipt(paymentId: string, file: File, onProgress?: (pct: number) => void) {
    onProgress?.(30);
    await this.wait();
    onProgress?.(100);
    const p = this.s.payments.find((x) => x.id === paymentId);
    if (!p) throw new AppError('NOT_FOUND', 'That payment was not found.');
    p.receipt_path = `demo/${file.name}`;
    p.verification_status = 'pending_review';
    this.save();
    return { ...p };
  }

  async linkPaymentToSale(paymentId: string, saleId: string) {
    await this.wait();
    const p = this.s.payments.find((x) => x.id === paymentId);
    if (p) p.sale_id = saleId;
    this.save();
  }

  async logVoice(_entry: VoiceLog) {
    /* demo: nothing is stored */
  }
}

/** Same calculation the database performs in get_dashboard_summary (Lagos calendar days). */
export function computeDashboard(
  products: Product[],
  sales: Sale[],
  debts: { customer_id: string; amount: number }[],
  now = new Date(),
): DashboardSummary {
  const completed = sales.filter((s) => s.status === 'completed');
  const todayKey = lagosDayKey(now);
  const dayKeys = Array.from({ length: 14 }, (_, i) => lagosDayKey(new Date(now.getTime() - (13 - i) * 86400000)));
  const keyOf = (s: Sale) => lagosDayKey(s.created_at);
  const weekKeys = new Set(dayKeys.slice(7));
  const prevKeys = new Set(dayKeys.slice(0, 7));
  const yesterdayKey = dayKeys[12];
  const monthPrefix = todayKey.slice(0, 7);
  const sum = (xs: Sale[]) => round2(xs.reduce((a, s) => a + s.total_amount, 0));
  const today = completed.filter((s) => keyOf(s) === todayKey);
  const week = completed.filter((s) => weekKeys.has(keyOf(s)));
  const month = completed.filter((s) => keyOf(s).startsWith(monthPrefix));
  const costOf = (pid: string | null) => products.find((p) => p.id === pid)?.cost_price ?? null;
  const profit = (xs: Sale[]) => {
    let total = 0;
    let complete = true;
    let costedRevenue = 0;
    for (const s of xs) for (const i of s.items) {
      const c = s.total_cost !== null && s.items.length === 1 ? s.total_cost / i.quantity : costOf(i.product_id);
      if (c === null) { complete = false; continue; }
      total += i.line_total - i.quantity * c;
      costedRevenue += i.line_total;
    }
    return { profit: round2(total), complete, costedRevenue: round2(costedRevenue) };
  };
  const balances = new Map<string, number>();
  for (const d of debts) balances.set(d.customer_id, (balances.get(d.customer_id) ?? 0) + d.amount);
  const owing = [...balances.values()].filter((b) => b > 0);
  const active = products.filter((p) => !p.archived_at);
  const tp = profit(today);
  const wp = profit(week);
  const mp = profit(month);
  return {
    generated_at: now.toISOString(),
    today: { revenue: sum(today), count: today.length, profit: tp.profit, profit_complete: tp.complete, yesterday_revenue: sum(completed.filter((s) => keyOf(s) === yesterdayKey)) },
    week: { revenue: sum(week), count: week.length, prev_revenue: sum(completed.filter((s) => prevKeys.has(keyOf(s)))), profit: wp.profit, costed_revenue: wp.costedRevenue, profit_complete: wp.complete },
    month: { revenue: sum(month), count: month.length, profit: mp.profit, profit_complete: mp.complete },
    debts: { outstanding: round2(owing.reduce((a, b) => a + b, 0)), debtors: owing.length },
    stock: {
      item_count: active.length,
      out_count: active.filter((p) => p.stock_quantity === 0).length,
      low_count: active.filter((p) => p.stock_quantity > 0 && p.stock_quantity <= p.low_stock_threshold).length,
      value_at_cost: round2(active.reduce((a, p) => a + (p.cost_price !== null ? p.stock_quantity * p.cost_price : 0), 0)),
      missing_cost_count: active.filter((p) => p.cost_price === null && p.stock_quantity > 0).length,
      value_at_price: round2(active.reduce((a, p) => a + p.stock_quantity * p.price, 0)),
    },
    daily: dayKeys.map((k) => {
      const xs = completed.filter((s) => keyOf(s) === k);
      return { date: k, revenue: sum(xs), count: xs.length };
    }),
    products: active.map((p) => {
      const lines = (keys: Set<string> | string) => completed
        .filter((s) => (typeof keys === 'string' ? keyOf(s) === keys : keys.has(keyOf(s))))
        .flatMap((s) => s.items.filter((i) => i.product_id === p.id));
      const w = lines(weekKeys);
      return {
        product_id: p.id, name: p.name, unit: p.unit, stock_quantity: p.stock_quantity, low_stock_threshold: p.low_stock_threshold,
        price: p.price, cost_price: p.cost_price, units_7d: w.reduce((a, i) => a + i.quantity, 0),
        revenue_7d: round2(w.reduce((a, i) => a + i.line_total, 0)), units_prev_7d: lines(prevKeys).reduce((a, i) => a + i.quantity, 0),
        units_today: lines(todayKey).reduce((a, i) => a + i.quantity, 0), updated_at: p.updated_at,
      };
    }).sort((a, b) => b.revenue_7d - a.revenue_7d || a.name.localeCompare(b.name)),
  };
}
