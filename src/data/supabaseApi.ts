import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, toAppError } from '../lib/errors';
import { newId } from '../lib/ids';
import type {
  Customer, DashboardSummary, DebtResult, DebtTransaction, InventoryMovement, Invoice, NewProductInput,
  PaymentRecord, Product, Sale, SaleInput, SaleResult,
} from '../lib/types';
import type { BusinessApi, NewPaymentInput, RestockResult, VoiceLog } from './api';

const PRODUCT_COLS = 'id,business_id,name,unit,price,cost_price,stock_quantity,low_stock_threshold,image_url,archived_at,updated_at';

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function normProduct(r: Record<string, unknown>): Product {
  return {
    ...(r as unknown as Product),
    price: num(r.price),
    cost_price: numOrNull(r.cost_price),
    stock_quantity: num(r.stock_quantity),
    low_stock_threshold: num(r.low_stock_threshold),
  };
}

function normSaleResult(r: Record<string, unknown>): SaleResult {
  const items = (r.items as Record<string, unknown>[]) ?? [];
  return {
    ...(r as unknown as SaleResult),
    total_amount: num(r.total_amount),
    amount_paid: num(r.amount_paid),
    items: items.map((i) => ({
      ...(i as unknown as SaleResult['items'][number]),
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      line_total: num(i.line_total),
      stock_remaining: numOrNull(i.stock_remaining),
      low_stock_threshold: numOrNull(i.low_stock_threshold),
    })),
  };
}

function normSale(r: Record<string, unknown>): Sale {
  const items = (r.sale_items as Record<string, unknown>[]) ?? [];
  const customer = r.customers as { name?: string } | null;
  return {
    id: r.id as string,
    created_at: r.created_at as string,
    total_amount: num(r.total_amount),
    amount_paid: num(r.amount_paid),
    total_cost: numOrNull(r.total_cost),
    payment_method: r.payment_method as Sale['payment_method'],
    payment_status: r.payment_status as Sale['payment_status'],
    channel: r.channel as Sale['channel'],
    status: r.status as Sale['status'],
    reversal_reason: (r.reversal_reason as string) ?? null,
    customer_id: (r.customer_id as string) ?? null,
    customer_name: customer?.name ?? null,
    note: (r.note as string) ?? null,
    items: items.map((i) => ({
      product_id: (i.product_id as string) ?? null,
      product_name: i.product_name as string,
      unit: i.unit as string,
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      line_total: num(i.line_total),
    })),
  };
}

function normPayment(r: Record<string, unknown>): PaymentRecord {
  return { ...(r as unknown as PaymentRecord), amount: num(r.amount) };
}

export class SupabaseBusinessApi implements BusinessApi {
  readonly mode = 'live' as const;
  constructor(private db: SupabaseClient, readonly businessId: string, private userId: string) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await this.db.rpc(fn, args);
    } catch (e) {
      throw toAppError(e);
    }
    if (res.error) throw toAppError(res.error);
    return res.data as T;
  }

  async listProducts(opts: { includeArchived?: boolean } = {}): Promise<Product[]> {
    let q = this.db.from('products').select(PRODUCT_COLS).eq('business_id', this.businessId).order('name');
    if (!opts.includeArchived) q = q.is('archived_at', null);
    const { data, error } = await q;
    if (error) throw toAppError(error);
    return (data ?? []).map((r) => normProduct(r as Record<string, unknown>));
  }

  async createProduct(input: NewProductInput): Promise<Product> {
    const data = await this.rpc<Record<string, unknown>>('create_product', {
      p_business_id: this.businessId, p_name: input.name, p_unit: input.unit, p_price: input.price,
      p_cost_price: input.costPrice, p_low_stock_threshold: input.lowStockThreshold,
      p_opening_quantity: input.openingQuantity, p_client_op_id: input.clientOpId,
    });
    return normProduct(data);
  }

  async updateProduct(id: string, patch: Partial<Pick<Product, 'name' | 'unit' | 'price' | 'cost_price' | 'low_stock_threshold'>>) {
    const { data, error } = await this.db.from('products').update(patch).eq('id', id).eq('business_id', this.businessId).select('id');
    if (error) throw toAppError(error);
    if (!data?.length) throw new AppError('FORBIDDEN', 'You cannot edit this product. Only owners and managers can change prices.');
  }

  async archiveProduct(id: string, archived: boolean) {
    const { data, error } = await this.db.from('products')
      .update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id).eq('business_id', this.businessId).select('id');
    if (error) throw toAppError(error);
    if (!data?.length) throw new AppError('FORBIDDEN', 'Only owners and managers can archive products.');
  }

  async restock(productId: string, quantity: number, unitCost: number | null, clientOpId: string, note?: string): Promise<RestockResult> {
    const r = await this.rpc<RestockResult>('restock_product', {
      p_business_id: this.businessId, p_product_id: productId, p_quantity: quantity,
      p_unit_cost: unitCost, p_client_op_id: clientOpId, p_note: note ?? null,
    });
    return { ...r, stock_quantity: num(r.stock_quantity) };
  }

  async adjustStock(productId: string, newQuantity: number, reason: string, clientOpId: string) {
    const r = await this.rpc<{ stock_quantity: number }>('adjust_stock', {
      p_business_id: this.businessId, p_product_id: productId, p_new_quantity: newQuantity,
      p_reason: reason, p_client_op_id: clientOpId,
    });
    return { stock_quantity: num(r.stock_quantity) };
  }

  async listMovements(productId: string): Promise<InventoryMovement[]> {
    const { data, error } = await this.db.from('inventory_movements')
      .select('id,product_id,kind,quantity_delta,quantity_after,reason,created_at')
      .eq('product_id', productId).order('created_at', { ascending: false }).limit(50);
    if (error) throw toAppError(error);
    return (data ?? []) as InventoryMovement[];
  }

  async recordSale(input: SaleInput): Promise<SaleResult> {
    const r = await this.rpc<Record<string, unknown>>('record_sale', {
      p_business_id: this.businessId, p_client_op_id: input.clientOpId, p_items: input.items,
      p_payment_method: input.paymentMethod, p_amount_paid: input.amountPaid ?? null,
      p_customer_id: input.customerId ?? null, p_channel: input.channel, p_note: input.note ?? null,
    });
    return normSaleResult(r);
  }

  async reverseSale(saleId: string, reason: string): Promise<SaleResult> {
    const r = await this.rpc<Record<string, unknown>>('reverse_sale', { p_business_id: this.businessId, p_sale_id: saleId, p_reason: reason });
    return normSaleResult(r);
  }

  async listSales(opts: { limit?: number; before?: string } = {}): Promise<Sale[]> {
    let q = this.db.from('sales')
      .select('id,created_at,total_amount,amount_paid,total_cost,payment_method,payment_status,channel,status,reversal_reason,customer_id,note,customers(name),sale_items(product_id,product_name,unit,quantity,unit_price,line_total)')
      .eq('business_id', this.businessId).order('created_at', { ascending: false }).limit(opts.limit ?? 30);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw toAppError(error);
    return (data ?? []).map((r) => normSale(r as unknown as Record<string, unknown>));
  }

  async getSale(id: string): Promise<Sale | null> {
    const { data, error } = await this.db.from('sales')
      .select('id,created_at,total_amount,amount_paid,total_cost,payment_method,payment_status,channel,status,reversal_reason,customer_id,note,customers(name),sale_items(product_id,product_name,unit,quantity,unit_price,line_total)')
      .eq('id', id).eq('business_id', this.businessId).maybeSingle();
    if (error) throw toAppError(error);
    return data ? normSale(data as unknown as Record<string, unknown>) : null;
  }

  async listCustomers(): Promise<Customer[]> {
    const { data, error } = await this.db.from('customer_balances')
      .select('customer_id,name,phone,balance,last_activity_at').eq('business_id', this.businessId).order('name');
    if (error) throw toAppError(error);
    return (data ?? []).map((r) => ({ ...(r as Customer), balance: num((r as Customer).balance) }));
  }

  async createCustomer(name: string, phone?: string): Promise<Customer> {
    const { data, error } = await this.db.from('customers')
      .insert({ business_id: this.businessId, name: name.trim(), phone: phone?.trim() || null }).select('id,name,phone').single();
    if (error) {
      if (error.code === '23505') throw new AppError('DUPLICATE_NAME', `You already have a customer called "${name.trim()}".`);
      throw toAppError(error);
    }
    return { customer_id: data.id, name: data.name, phone: data.phone, balance: 0, last_activity_at: null };
  }

  async customerLedger(customerId: string): Promise<DebtTransaction[]> {
    const { data, error } = await this.db.from('debt_transactions')
      .select('id,kind,amount,note,sale_id,created_at').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100);
    if (error) throw toAppError(error);
    return (data ?? []).map((r) => ({ ...(r as DebtTransaction), amount: num((r as DebtTransaction).amount) }));
  }

  async recordDebt(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult> {
    const r = await this.rpc<DebtResult>('record_debt', {
      p_business_id: this.businessId, p_customer_id: customerId, p_amount: amount, p_note: note, p_client_op_id: clientOpId,
    });
    return { ...r, balance: num(r.balance) };
  }

  async recordDebtPayment(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult> {
    const r = await this.rpc<DebtResult>('record_debt_payment', {
      p_business_id: this.businessId, p_customer_id: customerId, p_amount: amount, p_note: note, p_client_op_id: clientOpId,
    });
    return { ...r, balance: num(r.balance) };
  }

  async issueInvoice(saleId: string): Promise<Invoice> {
    return this.rpc<Invoice>('issue_invoice', { p_business_id: this.businessId, p_sale_id: saleId });
  }

  async getInvoiceForSale(saleId: string): Promise<Invoice | null> {
    const { data, error } = await this.db.from('invoices').select('id,invoice_number,issued_at,status').eq('sale_id', saleId).maybeSingle();
    if (error) throw toAppError(error);
    return data ? { invoice_id: data.id, invoice_number: data.invoice_number, issued_at: data.issued_at, status: data.status } : null;
  }

  async dashboard(): Promise<DashboardSummary> {
    const d = await this.rpc<DashboardSummary>('get_dashboard_summary', { p_business_id: this.businessId });
    // Numeric columns arrive as JSON numbers already; normalise defensively.
    const n = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
    return {
      ...d,
      today: n(d.today as unknown as Record<string, unknown>) as unknown as DashboardSummary['today'],
      week: n(d.week as unknown as Record<string, unknown>) as unknown as DashboardSummary['week'],
      month: n(d.month as unknown as Record<string, unknown>) as unknown as DashboardSummary['month'],
      debts: n(d.debts as unknown as Record<string, unknown>) as unknown as DashboardSummary['debts'],
      stock: n(d.stock as unknown as Record<string, unknown>) as unknown as DashboardSummary['stock'],
      daily: d.daily.map((x) => ({ ...x, revenue: num(x.revenue), count: num(x.count) })),
      products: d.products.map((p) => ({
        ...p, price: num(p.price), cost_price: numOrNull(p.cost_price), units_7d: num(p.units_7d), revenue_7d: num(p.revenue_7d),
        units_prev_7d: num(p.units_prev_7d), units_today: num(p.units_today), stock_quantity: num(p.stock_quantity),
        low_stock_threshold: num(p.low_stock_threshold),
      })),
    };
  }

  async listPayments(limit = 20): Promise<PaymentRecord[]> {
    const { data, error } = await this.db.from('payments_received')
      .select('id,amount,payer_name,channel,source,verification_status,receipt_path,sale_id,note,created_at')
      .eq('business_id', this.businessId).order('created_at', { ascending: false }).limit(limit);
    if (error) throw toAppError(error);
    return (data ?? []).map((r) => normPayment(r as Record<string, unknown>));
  }

  async recordPayment(input: NewPaymentInput): Promise<PaymentRecord> {
    const { data, error } = await this.db.from('payments_received')
      .insert({ business_id: this.businessId, amount: input.amount, payer_name: input.payerName || null, channel: input.channel, note: input.note || null, recorded_by: this.userId })
      .select('id,amount,payer_name,channel,source,verification_status,receipt_path,sale_id,note,created_at').single();
    if (error) throw toAppError(error);
    return normPayment(data as Record<string, unknown>);
  }

  async attachReceipt(paymentId: string, file: File, onProgress?: (pct: number) => void): Promise<PaymentRecord> {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${this.businessId}/${newId()}.${ext}`;
    onProgress?.(10);
    const up = await this.db.storage.from('receipts').upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw new AppError('UPLOAD_FAILED', `The receipt was not uploaded (${up.error.message}). The payment record is unchanged — try again.`, { retryable: true });
    onProgress?.(80);
    const { data, error } = await this.db.from('payments_received')
      .update({ receipt_path: path, verification_status: 'pending_review' }).eq('id', paymentId)
      .select('id,amount,payer_name,channel,source,verification_status,receipt_path,sale_id,note,created_at').single();
    if (error) throw toAppError(error);
    onProgress?.(100);
    return normPayment(data as Record<string, unknown>);
  }

  async linkPaymentToSale(paymentId: string, saleId: string) {
    const { error } = await this.db.from('payments_received').update({ sale_id: saleId }).eq('id', paymentId);
    if (error) throw toAppError(error);
  }

  async logVoice(entry: VoiceLog) {
    // Metadata only (no transcript or audio). Failure to log must never block the trader.
    await this.db.from('voice_interactions').insert({
      business_id: this.businessId, user_id: this.userId, language: entry.language,
      input_mode: entry.inputMode, intent: entry.intent.slice(0, 40), outcome: entry.outcome,
    });
  }
}
