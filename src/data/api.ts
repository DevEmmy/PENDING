import type {
  Customer, DashboardSummary, DebtResult, DebtTransaction, InventoryMovement, Invoice, NewProductInput,
  PaymentRecord, Product, Sale, SaleInput, SaleResult,
} from '../lib/types';

export interface RestockResult {
  duplicate: boolean;
  product_id: string;
  name: string;
  unit: string;
  stock_quantity: number;
}

export interface NewPaymentInput {
  amount: number;
  payerName: string;
  channel: 'transfer' | 'cash' | 'pos';
  note?: string;
}

export interface VoiceLog {
  language: string;
  inputMode: 'voice' | 'text';
  intent: string;
  outcome: 'executed' | 'answered' | 'cancelled' | 'clarified' | 'failed';
}

/** Business operations. Implemented by the live Supabase API and the isolated demo API. */
export interface BusinessApi {
  readonly mode: 'live' | 'demo';
  readonly businessId: string;

  listProducts(opts?: { includeArchived?: boolean }): Promise<Product[]>;
  createProduct(input: NewProductInput): Promise<Product>;
  updateProduct(id: string, patch: Partial<Pick<Product, 'name' | 'unit' | 'price' | 'cost_price' | 'low_stock_threshold'>>): Promise<void>;
  archiveProduct(id: string, archived: boolean): Promise<void>;
  restock(productId: string, quantity: number, unitCost: number | null, clientOpId: string, note?: string): Promise<RestockResult>;
  adjustStock(productId: string, newQuantity: number, reason: string, clientOpId: string): Promise<{ stock_quantity: number }>;
  listMovements(productId: string): Promise<InventoryMovement[]>;

  recordSale(input: SaleInput): Promise<SaleResult>;
  reverseSale(saleId: string, reason: string): Promise<SaleResult>;
  listSales(opts?: { limit?: number; before?: string }): Promise<Sale[]>;
  getSale(id: string): Promise<Sale | null>;

  listCustomers(): Promise<Customer[]>;
  createCustomer(name: string, phone?: string): Promise<Customer>;
  customerLedger(customerId: string): Promise<DebtTransaction[]>;
  recordDebt(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult>;
  recordDebtPayment(customerId: string, amount: number, note: string, clientOpId: string): Promise<DebtResult>;

  issueInvoice(saleId: string): Promise<Invoice>;
  getInvoiceForSale(saleId: string): Promise<Invoice | null>;

  dashboard(): Promise<DashboardSummary>;

  listPayments(limit?: number): Promise<PaymentRecord[]>;
  recordPayment(input: NewPaymentInput): Promise<PaymentRecord>;
  attachReceipt(paymentId: string, file: File, onProgress?: (pct: number) => void): Promise<PaymentRecord>;
  linkPaymentToSale(paymentId: string, saleId: string): Promise<void>;

  logVoice(entry: VoiceLog): Promise<void>;
}
