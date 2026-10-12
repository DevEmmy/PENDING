export type Language = 'en' | 'pcm' | 'yo' | 'ig' | 'ha';
export type MemberRole = 'owner' | 'manager' | 'assistant';
export type PaymentMethod = 'cash' | 'transfer' | 'pos' | 'credit';
export type SaleChannel = 'pos' | 'voice' | 'manual' | 'offline';

export const LANGUAGES: { code: Language; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'pcm', label: 'Pidgin', native: 'Naija Pidgin' },
  { code: 'yo', label: 'Yoruba', native: 'Yorùbá' },
  { code: 'ig', label: 'Igbo', native: 'Igbo' },
  { code: 'ha', label: 'Hausa', native: 'Hausa' },
];

export const BUSINESS_CATEGORIES = [
  { value: 'foodstuff', label: 'Foodstuff' },
  { value: 'clothing', label: 'Clothing' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'cosmetics', label: 'Cosmetics' },
  { value: 'other', label: 'Other' },
] as const;

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
  preferred_language: Language;
  onboarding_step: 'business' | 'products' | 'voice_intro' | 'done';
}

export interface Business {
  id: string;
  name: string;
  category: string;
  market_area: string | null;
  city: string | null;
  role: MemberRole;
}

export interface Product {
  id: string;
  business_id: string;
  name: string;
  unit: string;
  price: number;
  cost_price: number | null;
  stock_quantity: number;
  low_stock_threshold: number;
  image_url: string | null;
  archived_at: string | null;
  updated_at: string;
}

export type StockStatus = 'in' | 'low' | 'out';
export function stockStatus(p: Pick<Product, 'stock_quantity' | 'low_stock_threshold'>): StockStatus {
  if (p.stock_quantity <= 0) return 'out';
  if (p.stock_quantity <= p.low_stock_threshold) return 'low';
  return 'in';
}

export interface InventoryMovement {
  id: string;
  product_id: string;
  kind: 'opening' | 'sale' | 'restock' | 'adjustment' | 'sale_reversal';
  quantity_delta: number;
  quantity_after: number;
  reason: string | null;
  created_at: string;
}

export interface SaleItemInput {
  product_id: string;
  quantity: number;
  unit_price?: number;
}

export interface SaleInput {
  clientOpId: string;
  items: SaleItemInput[];
  paymentMethod: PaymentMethod;
  amountPaid?: number | null;
  customerId?: string | null;
  channel: SaleChannel;
  note?: string;
}

export interface SaleResultItem {
  product_id: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  stock_remaining: number | null;
  low_stock_threshold: number | null;
}

export interface SaleResult {
  sale_id: string;
  duplicate: boolean;
  total_amount: number;
  amount_paid: number;
  payment_status: 'paid' | 'part_paid' | 'unpaid';
  payment_method: PaymentMethod;
  customer_id: string | null;
  created_at: string;
  status: 'completed' | 'reversed';
  items: SaleResultItem[];
}

export interface Sale {
  id: string;
  created_at: string;
  total_amount: number;
  amount_paid: number;
  total_cost: number | null;
  payment_method: PaymentMethod;
  payment_status: 'paid' | 'part_paid' | 'unpaid';
  channel: SaleChannel;
  status: 'completed' | 'reversed';
  reversal_reason: string | null;
  customer_id: string | null;
  customer_name: string | null;
  note: string | null;
  items: { product_id: string | null; product_name: string; unit: string; quantity: number; unit_price: number; line_total: number }[];
}

export interface Customer {
  customer_id: string;
  name: string;
  phone: string | null;
  balance: number;
  last_activity_at: string | null;
}

export interface DebtTransaction {
  id: string;
  kind: 'charge' | 'payment' | 'adjustment';
  amount: number;
  note: string | null;
  sale_id: string | null;
  created_at: string;
}

export interface DebtResult {
  duplicate: boolean;
  transaction_id: string;
  balance: number;
}

export interface Invoice {
  invoice_id: string;
  invoice_number: string;
  issued_at: string;
  status: 'issued' | 'void';
  duplicate?: boolean;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  payer_name: string | null;
  channel: 'transfer' | 'cash' | 'pos';
  source: 'manual' | 'bank_feed';
  verification_status: 'unverified' | 'pending_review' | 'verified' | 'rejected';
  receipt_path: string | null;
  sale_id: string | null;
  note: string | null;
  created_at: string;
}

export interface ProductStat {
  product_id: string;
  name: string;
  unit: string;
  stock_quantity: number;
  low_stock_threshold: number;
  price: number;
  cost_price: number | null;
  units_7d: number;
  revenue_7d: number;
  units_prev_7d: number;
  units_today: number;
  updated_at: string;
}

export interface DashboardSummary {
  generated_at: string;
  today: { revenue: number; count: number; profit: number; profit_complete: boolean; yesterday_revenue: number };
  week: { revenue: number; count: number; prev_revenue: number; profit: number; costed_revenue: number; profit_complete: boolean };
  month: { revenue: number; count: number; profit: number; profit_complete: boolean };
  debts: { outstanding: number; debtors: number };
  stock: { item_count: number; out_count: number; low_count: number; value_at_cost: number; missing_cost_count: number; value_at_price: number };
  daily: { date: string; revenue: number; count: number }[];
  products: ProductStat[];
}

export interface NewProductInput {
  name: string;
  unit: string;
  price: number;
  costPrice: number | null;
  lowStockThreshold: number;
  openingQuantity: number;
  clientOpId: string;
}
