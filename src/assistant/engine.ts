import { naira, pluralUnit, quantity as qty } from '../lib/format';
import type { Customer, DashboardSummary, Language, PaymentMethod, Product } from '../lib/types';
import { stockStatus } from '../lib/types';
import { matchByName } from './matching';
import { parse, type Parsed, type ParsedItem, type Screen } from './parser';

/** A fully-specified operation waiting for the trader's confirmation. */
export type Draft =
  | {
      kind: 'sale';
      lines: { product: Product; quantity: number; unitPrice: number; priceSource: 'said' | 'catalog' }[];
      payment: PaymentMethod | null;
      amountPaid: number | null;
      customer: Customer | null;
      newCustomerName: string | null;
    }
  | { kind: 'restock'; lines: { product: Product; quantity: number; unitCost: number | null }[] }
  | { kind: 'debt'; customer: Customer | null; newCustomerName: string | null; amount: number | null }
  | { kind: 'debt_payment'; customer: Customer; amount: number | null };

type Awaiting = 'price' | 'payment' | 'customer' | 'amount' | 'confirm' | 'choose_product';

export interface EngineState {
  draft: Draft | null;
  awaiting: Awaiting | null;
  choice: { candidates: Product[]; item: ParsedItem; remaining: ParsedItem[]; kind: 'sale' | 'restock'; meta: Extract<Parsed, { intent: 'sale' }> | Extract<Parsed, { intent: 'restock' }> } | null;
}

export const initialState: EngineState = { draft: null, awaiting: null, choice: null };

export interface EngineContext {
  products: Product[];
  customers: Customer[];
  language: Language;
  getDashboard: () => Promise<DashboardSummary>;
}

export interface ConfirmLine {
  label: string;
  value: string;
}
export interface ConfirmCard {
  title: string;
  lines: ConfirmLine[];
  total?: string;
  warning?: string;
  confirmLabel: string;
}

export interface Turn {
  reply: string;
  state: EngineState;
  intent: string;
  outcome: 'answered' | 'clarified' | 'cancelled' | 'ready' | 'failed';
  confirm?: ConfirmCard;
  /** Present only after an explicit "yes": the caller must execute it and report the real result. */
  execute?: Draft;
  navigate?: string;
  suggestions?: string[];
}

const pidgin = (lang: Language) => lang === 'pcm';
const t = (lang: Language, en: string, pcm: string) => (pidgin(lang) ? pcm : en);

const SCREEN_PATHS: Record<Screen, string> = {
  home: '/', chat: '/chat', stock: '/stock', sales: '/sales', insights: '/insights', hub: '/hub',
  customers: '/customers', profile: '/profile', messages: '/hub/messages', pos: '/sales/new',
};

const PAYMENT_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', transfer: 'Transfer', pos: 'POS', credit: 'Credit (owing)' };

function lineTotal(d: Extract<Draft, { kind: 'sale' }>) {
  return Math.round(d.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0) * 100) / 100;
}

function describeLines(lines: { product: Product; quantity: number }[]): string {
  return lines.map((l) => `${qty(l.quantity, l.product.unit)} of ${l.product.name}`).join(' and ');
}

export function saleCard(d: Extract<Draft, { kind: 'sale' }>, lang: Language): ConfirmCard {
  const total = lineTotal(d);
  const lines: ConfirmLine[] = d.lines.map((l) => ({
    label: `${qty(l.quantity, l.product.unit)} · ${l.product.name}`,
    value: `${naira(l.unitPrice)} each${l.priceSource === 'catalog' ? ' (usual price)' : ''}`,
  }));
  lines.push({ label: 'Payment', value: d.payment ? PAYMENT_LABEL[d.payment] : '—' });
  const paid = d.payment === 'credit' ? d.amountPaid ?? 0 : d.amountPaid ?? total;
  if (paid < total) {
    lines.push({ label: 'Paid now', value: naira(paid) });
    lines.push({ label: 'Owing', value: naira(total - paid) });
  }
  if (d.customer || d.newCustomerName) lines.push({ label: 'Customer', value: d.customer?.name ?? `${d.newCustomerName} (new customer)` });
  const short = d.lines.find((l) => l.quantity > l.product.stock_quantity);
  return {
    title: t(lang, 'Record this sale?', 'Make I record this sale?'),
    lines,
    total: naira(total),
    warning: short ? `Only ${qty(short.product.stock_quantity, short.product.unit)} of ${short.product.name} in stock.` : undefined,
    confirmLabel: t(lang, 'Yes, record sale', 'Yes, record am'),
  };
}

function restockCard(d: Extract<Draft, { kind: 'restock' }>, lang: Language): ConfirmCard {
  return {
    title: t(lang, 'Add this stock?', 'Make I add this stock?'),
    lines: d.lines.map((l) => ({
      label: `+${qty(l.quantity, l.product.unit)} · ${l.product.name}`,
      value: `${l.product.stock_quantity} → ${l.product.stock_quantity + l.quantity}${l.unitCost !== null ? ` · cost ${naira(l.unitCost)} each` : ''}`,
    })),
    confirmLabel: t(lang, 'Yes, update stock', 'Yes, update stock'),
  };
}

function debtCard(d: Extract<Draft, { kind: 'debt' }>, lang: Language): ConfirmCard {
  const name = d.customer?.name ?? `${d.newCustomerName} (new customer)`;
  return {
    title: t(lang, 'Record money owed?', 'Make I write this debt?'),
    lines: [
      { label: 'Customer', value: name },
      { label: 'Amount owed', value: naira(d.amount ?? 0) },
      ...(d.customer ? [{ label: 'New balance', value: naira(d.customer.balance + (d.amount ?? 0)) }] : []),
    ],
    confirmLabel: t(lang, 'Yes, record debt', 'Yes, write am'),
  };
}

function paymentCard(d: Extract<Draft, { kind: 'debt_payment' }>, lang: Language): ConfirmCard {
  return {
    title: t(lang, 'Record this payment?', 'Make I record this payment?'),
    lines: [
      { label: 'Customer', value: d.customer.name },
      { label: 'Paid', value: naira(d.amount ?? 0) },
      { label: 'Balance after', value: naira(d.customer.balance - (d.amount ?? 0)) },
    ],
    confirmLabel: t(lang, 'Yes, record payment', 'Yes, record am'),
  };
}

export function cardFor(d: Draft, lang: Language): ConfirmCard {
  switch (d.kind) {
    case 'sale': return saleCard(d, lang);
    case 'restock': return restockCard(d, lang);
    case 'debt': return debtCard(d, lang);
    case 'debt_payment': return paymentCard(d, lang);
  }
}

function matchCustomer(name: string, customers: Customer[]) {
  return matchByName(name, customers, (c) => c.name, 0.7);
}

function titleCase(s: string) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Move a sale draft forward: ask for whatever is missing, else show the confirmation card. */
function advanceSale(d: Extract<Draft, { kind: 'sale' }>, ctx: EngineContext, lead = ''): Turn {
  const lang = ctx.language;
  const state = (awaiting: Awaiting): EngineState => ({ draft: d, awaiting, choice: null });
  for (const l of d.lines) {
    if (l.quantity > l.product.stock_quantity) {
      return {
        reply: t(lang,
          `You only have ${qty(l.product.stock_quantity, l.product.unit)} of ${l.product.name} in stock, so I can't record ${l.quantity}. Restock first, or tell me the right quantity.`,
          `You only get ${qty(l.product.stock_quantity, l.product.unit)} of ${l.product.name} for stock, so I no fit record ${l.quantity}. Restock first or tell me the correct number.`),
        state: initialState, intent: 'sale', outcome: 'failed',
      };
    }
  }
  const missingPrice = d.lines.find((l) => !(l.unitPrice > 0));
  if (missingPrice) {
    const unit = missingPrice.product.unit;
    return {
      reply: lead + t(lang, `How much did you sell each ${unit} of ${missingPrice.product.name} for?`, `How much you sell each ${unit} of ${missingPrice.product.name}?`),
      state: state('price'), intent: 'sale', outcome: 'clarified',
    };
  }
  const total = lineTotal(d);
  if (!d.payment) {
    const priceNote = d.lines.length === 1
      ? `${describeLines(d.lines)} at ${naira(d.lines[0].unitPrice)}${d.lines[0].priceSource === 'catalog' ? t(lang, ' (your usual price)', ' (your normal price)') : ''} each`
      : describeLines(d.lines);
    return {
      reply: lead + t(lang,
        `${priceNote} comes to ${naira(total)}. Was it cash, transfer, POS or credit?`,
        `${priceNote} na ${naira(total)}. Na cash, transfer, POS or credit?`),
      state: state('payment'), intent: 'sale', outcome: 'clarified', suggestions: ['Cash', 'Transfer', 'POS', 'Credit'],
    };
  }
  const paid = d.payment === 'credit' ? d.amountPaid ?? 0 : d.amountPaid ?? total;
  if (paid > total) {
    return { reply: t(lang, `The amount paid can't be more than ${naira(total)}. How much did they pay?`, `Wetin dem pay no fit pass ${naira(total)}. How much dem pay?`), state: { draft: { ...d, amountPaid: null }, awaiting: 'payment', choice: null }, intent: 'sale', outcome: 'clarified' };
  }
  if (paid < total && !d.customer && !d.newCustomerName) {
    return {
      reply: lead + t(lang, `${naira(total - paid)} is still owing. Which customer is owing?`, `${naira(total - paid)} still dey owe. Which customer dey owe?`),
      state: state('customer'), intent: 'sale', outcome: 'clarified',
    };
  }
  return {
    reply: lead + t(lang, `That comes to ${naira(total)}. Shall I record it?`, `E come to ${naira(total)}. Make I record am?`),
    state: state('confirm'), intent: 'sale', outcome: 'ready', confirm: saleCard(d, lang), suggestions: ['Yes', 'No'],
  };
}

function advance(d: Draft, ctx: EngineContext, lead = ''): Turn {
  const lang = ctx.language;
  if (d.kind === 'sale') return advanceSale(d, ctx, lead);
  if (d.kind === 'restock') {
    return { reply: lead + t(lang, `Add ${describeLines(d.lines)} to your stock?`, `Make I add ${describeLines(d.lines)} to your stock?`), state: { draft: d, awaiting: 'confirm', choice: null }, intent: 'restock', outcome: 'ready', confirm: restockCard(d, lang), suggestions: ['Yes', 'No'] };
  }
  if (d.kind === 'debt') {
    const name = d.customer?.name ?? d.newCustomerName!;
    if (!(d.amount && d.amount > 0)) return { reply: t(lang, `How much does ${name} owe?`, `How much ${name} dey owe?`), state: { draft: d, awaiting: 'amount', choice: null }, intent: 'debt', outcome: 'clarified' };
    return { reply: lead + t(lang, `${name} owes ${naira(d.amount)}. Shall I record it?`, `${name} dey owe ${naira(d.amount)}. Make I write am?`), state: { draft: d, awaiting: 'confirm', choice: null }, intent: 'debt', outcome: 'ready', confirm: debtCard(d, lang), suggestions: ['Yes', 'No'] };
  }
  const c = d.customer;
  if (!(d.amount && d.amount > 0)) return { reply: t(lang, `How much did ${c.name} pay?`, `How much ${c.name} pay?`), state: { draft: d, awaiting: 'amount', choice: null }, intent: 'debt_payment', outcome: 'clarified' };
  if (d.amount > c.balance) {
    return { reply: t(lang, `${c.name} only owes ${naira(c.balance)}, so I can't record ${naira(d.amount)}. How much did they pay?`, `${c.name} only dey owe ${naira(c.balance)}, so I no fit record ${naira(d.amount)}. How much dem pay?`), state: { draft: { ...d, amount: null }, awaiting: 'amount', choice: null }, intent: 'debt_payment', outcome: 'clarified' };
  }
  return { reply: lead + t(lang, `${c.name} paid ${naira(d.amount)}. Shall I record it?`, `${c.name} pay ${naira(d.amount)}. Make I record am?`), state: { draft: d, awaiting: 'confirm', choice: null }, intent: 'debt_payment', outcome: 'ready', confirm: paymentCard(d, lang), suggestions: ['Yes', 'No'] };
}

/** Resolve spoken item phrases to products, pausing to ask when a phrase matches several. */
function resolveItems(
  kind: 'sale' | 'restock',
  items: ParsedItem[],
  meta: Extract<Parsed, { intent: 'sale' }> | Extract<Parsed, { intent: 'restock' }>,
  resolved: { product: Product; quantity: number }[],
  ctx: EngineContext,
): Turn | { product: Product; quantity: number }[] {
  const lang = ctx.language;
  const out = [...resolved];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const m = matchByName(it.phrase, ctx.products.filter((p) => !p.archived_at), (p) => p.name);
    if (m.ambiguous) {
      const names = m.candidates.map((c, idx) => `${idx + 1}. ${c.name}`).join(', ');
      return {
        reply: t(lang, `Which one do you mean: ${names}?`, `Which one you mean: ${names}?`),
        state: { draft: null, awaiting: 'choose_product', choice: { candidates: m.candidates, item: it, remaining: items.slice(i + 1), kind, meta: { ...meta, items: out.map((r) => ({ phrase: r.product.name, quantity: r.quantity, unitWord: null })) } as typeof meta } },
        intent: kind, outcome: 'clarified', suggestions: m.candidates.map((c) => c.name),
      };
    }
    if (!m.best) {
      return {
        reply: t(lang,
          `I can't find "${it.phrase}" in your stock. Add it on the Stock page first, then tell me again.`,
          `I no see "${it.phrase}" for your stock. Add am for Stock page first, then tell me again.`),
        state: initialState, intent: kind, outcome: 'failed', navigate: `/stock?add=${encodeURIComponent(titleCase(it.phrase))}`,
      };
    }
    if (it.quantity === null) {
      return {
        reply: t(lang, `How many ${pluralUnit(m.best.unit, 2)} of ${m.best.name}?`, `How many ${pluralUnit(m.best.unit, 2)} of ${m.best.name}?`),
        state: { draft: null, awaiting: 'choose_product', choice: { candidates: [m.best], item: { ...it, phrase: m.best.name }, remaining: items.slice(i + 1), kind, meta: { ...meta, items: out.map((r) => ({ phrase: r.product.name, quantity: r.quantity, unitWord: null })) } as typeof meta } },
        intent: kind, outcome: 'clarified',
      };
    }
    out.push({ product: m.best, quantity: it.quantity });
  }
  return out;
}

function buildFromResolved(kind: 'sale' | 'restock', resolved: { product: Product; quantity: number }[], meta: Extract<Parsed, { intent: 'sale' }> | Extract<Parsed, { intent: 'restock' }>, ctx: EngineContext): Turn {
  const lang = ctx.language;
  if (!resolved.length) {
    return { reply: t(lang, 'What did you sell? For example: "I sold 2 bags of rice".', 'Wetin you sell? Talk like: "I sell 2 bags of rice".'), state: initialState, intent: kind, outcome: 'clarified' };
  }
  if (kind === 'restock' && meta.intent === 'restock') {
    const single = resolved.length === 1;
    const unitCost = meta.unitCost ?? (single && meta.totalCost ? Math.round((meta.totalCost / resolved[0].quantity) * 100) / 100 : null);
    return advance({ kind: 'restock', lines: resolved.map((r) => ({ ...r, unitCost })) }, ctx);
  }
  if (meta.intent !== 'sale') return { reply: '', state: initialState, intent: kind, outcome: 'failed' };
  let note = '';
  const lines = resolved.map((r) => {
    let unitPrice = r.product.price;
    let priceSource: 'said' | 'catalog' = 'catalog';
    if (meta.unitPrice !== null && resolved.length === 1) { unitPrice = meta.unitPrice; priceSource = 'said'; }
    else if (meta.totalPrice !== null && resolved.length === 1) { unitPrice = Math.round((meta.totalPrice / r.quantity) * 100) / 100; priceSource = 'said'; }
    return { ...r, unitPrice, priceSource };
  });
  if (resolved.length > 1 && (meta.unitPrice !== null || meta.totalPrice !== null)) {
    note = t(lang, "I can't split one price across different items, so I've used your usual prices — check them below. ", 'I no fit share one price for different items, so I use your normal prices — check am below. ');
  }
  let customer: Customer | null = null;
  let newCustomerName: string | null = null;
  if (meta.customer) {
    const m = matchCustomer(meta.customer, ctx.customers);
    if (m.best) customer = m.best;
    else newCustomerName = titleCase(meta.customer);
  }
  return advance({ kind: 'sale', lines, payment: meta.payment, amountPaid: meta.amountPaid, customer, newCustomerName }, ctx, note);
}

function startItems(p: Extract<Parsed, { intent: 'sale' }> | Extract<Parsed, { intent: 'restock' }>, ctx: EngineContext): Turn {
  const kind = p.intent;
  const r = resolveItems(kind, p.items, p, [], ctx);
  if (!Array.isArray(r)) return r;
  return buildFromResolved(kind, r, p, ctx);
}

function helpText(lang: Language): string {
  return t(lang,
    'You can say things like: "I sold 2 bags of rice", "I bought 10 cartons of Indomie", "Emeka paid 5000", "How much rice is left?", "How was market today?" or "Find rice suppliers".',
    'You fit talk like: "I sell 2 bags of rice", "I buy 10 cartons Indomie", "Emeka don pay 5000", "How much rice remain?", "How market today?" or "Find rice supplier".');
}

const daysLeft = (stock: number, units7d: number) => (units7d > 0 ? Math.max(1, Math.round(stock / (units7d / 7))) : null);

async function answer(p: Parsed, ctx: EngineContext): Promise<Turn> {
  const lang = ctx.language;
  const base = { state: initialState, outcome: 'answered' as const };
  switch (p.intent) {
    case 'stock_query': {
      const m = matchByName(p.phrase, ctx.products, (x) => x.name);
      if (!m.best) {
        if (m.ambiguous) return { ...base, intent: 'stock_query', reply: m.candidates.map((c) => `${c.name}: ${qty(c.stock_quantity, c.unit)}`).join('. ') + '.' };
        return { ...base, intent: 'stock_query', reply: t(lang, `I can't find "${p.phrase}" in your stock.`, `I no see "${p.phrase}" for your stock.`) };
      }
      const prod = m.best;
      let reply = t(lang, `You have ${qty(prod.stock_quantity, prod.unit)} of ${prod.name} left.`, `You get ${qty(prod.stock_quantity, prod.unit)} of ${prod.name} remaining.`);
      try {
        const d = await ctx.getDashboard();
        const stat = d.products.find((x) => x.product_id === prod.id);
        const days = stat ? daysLeft(prod.stock_quantity, stat.units_7d) : null;
        if (days !== null && prod.stock_quantity > 0) reply += t(lang, ` At this week's rate, that lasts about ${days} day${days === 1 ? '' : 's'}.`, ` As e dey sell this week, e go finish in about ${days} day${days === 1 ? '' : 's'}.`);
      } catch { /* answer without the rate */ }
      if (stockStatus(prod) !== 'in') reply += t(lang, ' Time to restock.', ' Restock soon.');
      return { ...base, intent: 'stock_query', reply };
    }
    case 'debtors': {
      const owing = ctx.customers.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance);
      if (!owing.length) return { ...base, intent: 'debtors', reply: t(lang, 'Nobody owes you money right now.', 'Nobody dey owe you now.') };
      const total = owing.reduce((a, c) => a + c.balance, 0);
      const list = owing.slice(0, 5).map((c) => `${c.name} (${naira(c.balance)})`).join(', ');
      return { ...base, intent: 'debtors', reply: t(lang, `${owing.length} customer${owing.length === 1 ? ' owes' : 's owe'} you ${naira(total)}: ${list}.`, `${owing.length} customer dey owe you ${naira(total)}: ${list}.`), navigate: undefined };
    }
    case 'low_stock': {
      const low = ctx.products.filter((x) => !x.archived_at && stockStatus(x) !== 'in').sort((a, b) => a.stock_quantity - b.stock_quantity);
      if (!low.length) return { ...base, intent: 'low_stock', reply: t(lang, 'Nothing is running low right now.', 'Nothing dey finish for now.') };
      const list = low.slice(0, 6).map((x) => (x.stock_quantity === 0 ? `${x.name} (finished)` : `${x.name} (${qty(x.stock_quantity, x.unit)})`)).join(', ');
      return { ...base, intent: 'low_stock', reply: t(lang, `Running low: ${list}.`, `These ones dey finish: ${list}.`), navigate: undefined };
    }
    case 'customer_balance': {
      const m = matchCustomer(p.customer, ctx.customers);
      if (!m.best) return { ...base, intent: 'customer_balance', reply: t(lang, `I can't find a customer called ${titleCase(p.customer)}.`, `I no see customer wey dem dey call ${titleCase(p.customer)}.`) };
      const c = m.best;
      if (c.balance > 0) return { ...base, intent: 'customer_balance', reply: t(lang, `${c.name} owes you ${naira(c.balance)}.`, `${c.name} dey owe you ${naira(c.balance)}.`) };
      if (c.balance < 0) return { ...base, intent: 'customer_balance', reply: t(lang, `${c.name} doesn't owe you. You owe ${c.name} ${naira(-c.balance)} (credit balance).`, `${c.name} no dey owe. Na you owe ${c.name} ${naira(-c.balance)}.`) };
      return { ...base, intent: 'customer_balance', reply: t(lang, `${c.name} doesn't owe you anything.`, `${c.name} no dey owe you anything.`) };
    }
    case 'sales_summary': {
      const d = await ctx.getDashboard();
      const period = p.period === 'yesterday' ? null : p.period === 'week' ? d.week : p.period === 'month' ? d.month : d.today;
      if (p.period === 'yesterday') {
        return { ...base, intent: 'sales_summary', reply: t(lang, `Yesterday you sold ${naira(d.today.yesterday_revenue)}.`, `Yesterday you sell ${naira(d.today.yesterday_revenue)}.`) };
      }
      const label = p.period === 'week' ? t(lang, 'in the last 7 days', 'for the last 7 days') : p.period === 'month' ? t(lang, 'this month', 'this month') : t(lang, 'today', 'today');
      if (!period || period.count === 0) return { ...base, intent: 'sales_summary', reply: t(lang, `No sales recorded ${label} yet.`, `You never record any sale ${label}.`) };
      const profitText = period.profit_complete
        ? t(lang, ` Profit ${label}: ${naira(period.profit)} after cost.`, ` Profit ${label}: ${naira(period.profit)} after cost.`)
        : t(lang, ` Profit (only items with a cost price): ${naira(period.profit)}.`, ` Profit (only items wey get cost price): ${naira(period.profit)}.`);
      if (p.focus === 'profit') return { ...base, intent: 'sales_summary', reply: profitText.trim() };
      let reply = t(lang, `You sold ${naira(period.revenue)} ${label} from ${period.count} sale${period.count === 1 ? '' : 's'}.`, `Market dey move! You don sell ${naira(period.revenue)} ${label} (${period.count} sale${period.count === 1 ? '' : 's'}).`);
      const top = [...d.products].sort((a, b) => (p.period === 'today' ? b.units_today - a.units_today : b.revenue_7d - a.revenue_7d))[0];
      const topUnits = top ? (p.period === 'today' ? top.units_today : top.units_7d) : 0;
      if (top && topUnits > 0) {
        reply += t(lang, ` ${top.name} is your best seller — ${qty(topUnits, top.unit)} sold.`, ` ${top.name} na your best seller — ${qty(topUnits, top.unit)} don go.`);
        if (top.stock_quantity <= top.low_stock_threshold) reply += t(lang, ` Only ${qty(top.stock_quantity, top.unit)} left, so restock soon.`, ` Only ${qty(top.stock_quantity, top.unit)} remain, so restock soon.`);
      }
      return { ...base, intent: 'sales_summary', reply: reply + profitText };
    }
    case 'slow_items': {
      const d = await ctx.getDashboard();
      const candidates = d.products.filter((x) => x.stock_quantity > 0).sort((a, b) => a.units_7d - b.units_7d || b.stock_quantity - a.stock_quantity);
      const slow = candidates[0];
      if (!slow) return { ...base, intent: 'slow_items', reply: t(lang, 'You have no stock to compare yet.', 'You never get stock to compare.') };
      const sold = slow.units_7d === 0 ? t(lang, 'none sold in the last 7 days', 'nothing sell for the last 7 days') : t(lang, `only ${qty(slow.units_7d, slow.unit)} sold in the last 7 days`, `only ${qty(slow.units_7d, slow.unit)} sell for the last 7 days`);
      return { ...base, intent: 'slow_items', reply: t(lang, `${slow.name} is moving slowly — ${sold}, with ${qty(slow.stock_quantity, slow.unit)} still in stock.`, `${slow.name} dey slow small — ${sold}, and ${qty(slow.stock_quantity, slow.unit)} still dey.`) };
    }
    case 'top_items': {
      const d = await ctx.getDashboard();
      const top = d.products.filter((x) => x.units_7d > 0).slice(0, 3);
      if (!top.length) return { ...base, intent: 'top_items', reply: t(lang, 'No sales in the last 7 days yet.', 'No sale for the last 7 days.') };
      return { ...base, intent: 'top_items', reply: t(lang, 'Top sellers this week: ', 'Wetin sell pass this week: ') + top.map((x) => `${x.name} (${naira(x.revenue_7d)})`).join(', ') + '.' };
    }
    case 'vendor_search':
      return { ...base, intent: 'vendor_search', reply: t(lang, `Searching the Vendors Hub for "${p.query}".`, `I dey find "${p.query}" for Vendors Hub.`), navigate: `/hub?q=${encodeURIComponent(p.query)}` };
    case 'navigate':
      return { ...base, intent: 'navigate', reply: t(lang, 'Opening it now.', 'I dey open am.'), navigate: SCREEN_PATHS[p.screen] };
    case 'help':
      return { ...base, intent: 'help', reply: helpText(lang) };
    default:
      return { ...base, intent: 'unknown', outcome: 'failed', reply: t(lang, "Sorry, I didn't understand that. ", 'Sorry, I no understand. ') + helpText(lang) };
  }
}

/** Handle one user utterance given the current dialog state. Pure apart from reading the dashboard. */
export async function handle(text: string, state: EngineState, ctx: EngineContext): Promise<Turn> {
  const lang = ctx.language;
  const p = parse(text);

  // Universal cancel
  if (p.intent === 'no' && (state.draft || state.choice)) {
    return { reply: t(lang, 'Okay, cancelled. Nothing was recorded.', 'Okay, I don cancel am. Nothing record.'), state: initialState, intent: state.draft?.kind ?? 'cancel', outcome: 'cancelled' };
  }

  // Choosing between similar products / supplying a missing quantity
  if (state.awaiting === 'choose_product' && state.choice) {
    const ch = state.choice;
    let picked: Product | null = null;
    let quantity = ch.item.quantity;
    if (ch.candidates.length === 1) {
      picked = ch.candidates[0];
      const n = p.intent === 'number_answer' ? p.value : p.intent === 'price_answer' ? null : Number(text.match(/\d+/)?.[0]);
      if (!n || !Number.isInteger(n) || n <= 0) return { reply: t(lang, 'Please tell me the number, like "3".', 'Abeg tell me the number, like "3".'), state, intent: ch.kind, outcome: 'clarified' };
      quantity = n;
    } else {
      const n = p.intent === 'number_answer' ? p.value : null;
      if (n && n >= 1 && n <= ch.candidates.length) picked = ch.candidates[n - 1];
      else picked = matchByName(text, ch.candidates, (c) => c.name, 0.5).best;
      if (!picked) return { reply: t(lang, 'Please pick one of the options, or say "cancel".', 'Abeg pick one, or talk "cancel".'), state, intent: ch.kind, outcome: 'clarified', suggestions: ch.candidates.map((c) => c.name) };
    }
    const already = ch.meta.items.map((i) => ({ product: ctx.products.find((x) => x.name === i.phrase)!, quantity: i.quantity ?? 1 })).filter((x) => x.product);
    const resolvedNow = [...already, ...(quantity ? [{ product: picked, quantity }] : [])];
    if (!quantity) {
      return { reply: t(lang, `How many ${pluralUnit(picked.unit, 2)} of ${picked.name}?`, `How many ${pluralUnit(picked.unit, 2)} of ${picked.name}?`), state: { ...state, choice: { ...ch, candidates: [picked], item: { ...ch.item, phrase: picked.name } } }, intent: ch.kind, outcome: 'clarified' };
    }
    const r = resolveItems(ch.kind, ch.remaining, ch.meta, resolvedNow, ctx);
    if (!Array.isArray(r)) return r;
    return buildFromResolved(ch.kind, r, ch.meta, ctx);
  }

  // Answers to a pending question about the current draft
  const d = state.draft;
  if (d) {
    if (p.intent === 'yes' && state.awaiting === 'confirm') {
      return { reply: t(lang, 'Recording it now…', 'I dey record am…'), state: initialState, intent: d.kind, outcome: 'ready', execute: d };
    }
    if (d.kind === 'sale') {
      if (p.intent === 'price_answer' || (p.intent === 'number_answer' && state.awaiting === 'price')) {
        const lines = d.lines.map((l) => ({ ...l }));
        const target = lines.find((l) => !(l.unitPrice > 0)) ?? (lines.length === 1 ? lines[0] : null);
        if (target) {
          const unit = p.intent === 'price_answer' ? p.unitPrice : p.value;
          const total = p.intent === 'price_answer' ? p.totalPrice : null;
          target.unitPrice = unit ?? (total ? Math.round((total / target.quantity) * 100) / 100 : target.unitPrice);
          target.priceSource = 'said';
          return advanceSale({ ...d, lines }, ctx);
        }
      }
      if (p.intent === 'payment_answer') return advanceSale({ ...d, payment: p.payment, amountPaid: p.amountPaid ?? d.amountPaid }, ctx);
      if (state.awaiting === 'payment' && p.intent === 'number_answer') return advanceSale({ ...d, payment: d.payment ?? 'credit', amountPaid: p.value }, ctx);
      if (state.awaiting === 'customer' && p.intent !== 'yes') {
        const name = text.trim().replace(/^(it'?s|na|na im|customer is)\s+/i, '');
        const m = matchCustomer(name, ctx.customers);
        return advanceSale({ ...d, customer: m.best, newCustomerName: m.best ? null : titleCase(name.toLowerCase()) }, ctx);
      }
    }
    if ((d.kind === 'debt' || d.kind === 'debt_payment') && state.awaiting === 'amount') {
      const amount = p.intent === 'number_answer' ? p.value : p.intent === 'price_answer' ? p.totalPrice ?? p.unitPrice : null;
      if (amount) return advance({ ...d, amount } as Draft, ctx);
      return { reply: t(lang, 'Please tell me the amount, like "5000".', 'Abeg tell me the amount, like "5000".'), state, intent: d.kind, outcome: 'clarified' };
    }
    if (p.intent === 'yes') return advance(d, ctx);
    // A brand-new command replaces the pending draft (nothing had been recorded).
    if (!['sale', 'restock', 'debt', 'debt_payment', 'stock_query', 'low_stock', 'sales_summary', 'navigate', 'vendor_search', 'customer_balance', 'slow_items', 'top_items', 'help', 'debtors'].includes(p.intent)) {
      const again = advance(d, ctx);
      return { ...again, reply: t(lang, "Sorry, I didn't catch that. ", 'Sorry, I no catch am. ') + again.reply };
    }
  }

  switch (p.intent) {
    case 'sale':
    case 'restock':
      return startItems(p, ctx);
    case 'debt': {
      const m = matchCustomer(p.customer, ctx.customers);
      return advance({ kind: 'debt', customer: m.best, newCustomerName: m.best ? null : titleCase(p.customer), amount: p.amount }, ctx);
    }
    case 'debt_payment': {
      const m = matchCustomer(p.customer, ctx.customers);
      if (!m.best) return { reply: t(lang, `I can't find a customer called ${titleCase(p.customer)}.`, `I no see customer wey dem dey call ${titleCase(p.customer)}.`), state: initialState, intent: 'debt_payment', outcome: 'failed' };
      return advance({ kind: 'debt_payment', customer: m.best, amount: p.amount }, ctx);
    }
    case 'yes':
      return { reply: t(lang, 'There is nothing waiting for confirmation.', 'Nothing dey wait make you confirm.'), state: initialState, intent: 'yes', outcome: 'answered' };
    case 'no':
      return { reply: t(lang, 'Okay.', 'Okay.'), state: initialState, intent: 'no', outcome: 'answered' };
    case 'payment_answer':
    case 'price_answer':
    case 'number_answer':
      return { reply: t(lang, 'What is that for? Tell me the full thing, like "I sold 2 bags of rice for 35000 each".', 'Na for wetin? Talk am complete, like "I sell 2 bags of rice for 35000 each".'), state: initialState, intent: 'unknown', outcome: 'clarified' };
    default:
      return answer(p, ctx);
  }
}
