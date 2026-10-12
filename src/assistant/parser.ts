import type { PaymentMethod } from '../lib/types';
import { isUnitWord, norm } from './matching';
import { normalizeNumbers, stripDiacritics } from './numbers';

export interface ParsedItem {
  phrase: string; // product words as spoken
  quantity: number | null;
  unitWord: string | null;
}

export type Period = 'today' | 'yesterday' | 'week' | 'month';
export type Screen = 'home' | 'chat' | 'stock' | 'sales' | 'insights' | 'hub' | 'customers' | 'profile' | 'messages' | 'pos';

export type Parsed =
  | { intent: 'yes' }
  | { intent: 'no' }
  | { intent: 'sale'; items: ParsedItem[]; unitPrice: number | null; totalPrice: number | null; payment: PaymentMethod | null; amountPaid: number | null; customer: string | null }
  | { intent: 'restock'; items: ParsedItem[]; unitCost: number | null; totalCost: number | null }
  | { intent: 'debt'; customer: string; amount: number | null }
  | { intent: 'debt_payment'; customer: string; amount: number | null }
  | { intent: 'customer_balance'; customer: string }
  | { intent: 'stock_query'; phrase: string }
  | { intent: 'low_stock' }
  | { intent: 'sales_summary'; period: Period; focus: 'sales' | 'profit' }
  | { intent: 'slow_items' }
  | { intent: 'top_items' }
  | { intent: 'vendor_search'; query: string }
  | { intent: 'navigate'; screen: Screen }
  | { intent: 'help' }
  // Answers to a pending question
  | { intent: 'payment_answer'; payment: PaymentMethod; amountPaid: number | null }
  | { intent: 'price_answer'; unitPrice: number | null; totalPrice: number | null }
  | { intent: 'number_answer'; value: number }
  | { intent: 'unknown'; text: string };

/** Lowercase, diacritics stripped, numbers converted to digits, punctuation simplified. */
export function prepare(text: string): string {
  const lowered = stripDiacritics(text.toLowerCase()).replace(/[“”"!?]/g, ' ').replace(/[.](?!\d)/g, ' ');
  return normalizeNumbers(lowered.replace(/\s+/g, ' ').trim()).replace(/\s+/g, ' ').trim();
}

const YES = /^(yes|yeah|yea|yep|yup|ok|okay|confirm|confirmed|correct|right|sure|go ahead|do am|record am|save am|na so|e correct|beeni|ee|eh|ehn|to|haka ne|i agree|yes please|please do)$/;
const NO = /^(no|nope|nah|cancel|stop|leave am|leave it|no be so|rara|mba|a a|aa|forget it|never mind|dont|don t|abeg no)$/;

const PAYMENT_PATTERNS: [RegExp, PaymentMethod][] = [
  [/\b(on credit|credit|owe|owing|go pay later|pay later|bashi|gbese)\b/, 'credit'],
  [/\b(transfer|transferred|bank transfer|trf|send money|sent money|alert)\b/, 'transfer'],
  [/\b(pos|card|atm)\b/, 'pos'],
  [/\b(cash|owo|ego|kudi)\b/, 'cash'],
];

export function detectPayment(s: string): PaymentMethod | null {
  for (const [re, m] of PAYMENT_PATTERNS) if (re.test(s)) return m;
  return null;
}

const PERIODS: [RegExp, Period][] = [
  [/\byesterday|yesterday\b/, 'yesterday'],
  [/\b(this week|week|7 days|seven days)\b/, 'week'],
  [/\b(this month|month)\b/, 'month'],
];
function detectPeriod(s: string): Period {
  for (const [re, p] of PERIODS) if (re.test(s)) return p;
  return 'today';
}

/** Pull price clauses out of a sentence. Returns the cleaned text and prices found. */
export function extractPrices(s: string): { rest: string; unitPrice: number | null; totalPrice: number | null; amountPaid: number | null } {
  let unitPrice: number | null = null;
  let totalPrice: number | null = null;
  let amountPaid: number | null = null;
  let rest = s;
  // "paid 10000" / "pay 10000 now" / "deposit 5000"
  rest = rest.replace(/\b(?:paid|pay|deposit(?:ed)?|gave me|don pay)\s+(\d+(?:\.\d+)?)(?:\s*naira)?(?:\s*(?:now|first))?/, (_m, n: string) => {
    amountPaid = Number(n);
    return ' ';
  });
  // "for 35000 each" / "at 35000 per bag" / "35000 each" / "@ 35000 a bag"
  rest = rest.replace(/(?:\b(?:for|at|@)\s+)?(\d+(?:\.\d+)?)\s*(?:naira\s*)?(?:each|per\s+\w+|a\s+(?:bag|carton|tin|crate|piece|pack|bottle)|one)\b/, (_m, n: string) => {
    unitPrice = Number(n);
    return ' ';
  });
  // "for 70000" / "at 70000" / "total 70000" / "70000 naira"
  if (unitPrice === null) {
    rest = rest.replace(/\b(?:for|at|@|total(?:\s+of)?|altogether)\s+(\d+(?:\.\d+)?)(?:\s*naira)?\b|\b(\d+(?:\.\d+)?)\s*naira\b/, (_m, a?: string, b?: string) => {
      totalPrice = Number(a ?? b);
      return ' ';
    });
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), unitPrice, totalPrice, amountPaid };
}

const SALE_VERB = /\b(i\s+)?(sold|sell|selling|don sell|do sell|have sold|i sell|record (?:a )?sale(?: of)?|sale of|mo ta|mo ti ta|a ta|erere m|ere m|ererem|na sayar|na sayar da|sayar)\b/;
const RESTOCK_VERB = /\b(i\s+)?(bought|buy|don buy|restock(?:ed)?|add(?:ed)?(?: to stock)?|received|receive|new stock of|stock up|mo ra|mo ti ra|azuru m|azurum|na saya|na sayo)\b/;

/** Split "2 bags rice and 1 carton peak milk" into item segments and parse each. */
export function parseItems(s: string): ParsedItem[] {
  const segments = s.split(/\s*(?:,|\band\b|\bati\b|\bplus\b|\bwith\b|\bda\b|\bna\b(?=\s+\d)|&)\s*/).map((x) => x.trim()).filter(Boolean);
  const items: ParsedItem[] = [];
  for (const seg of segments) {
    const words = seg.split(' ').filter(Boolean);
    let quantity: number | null = null;
    let unitWord: string | null = null;
    const phrase: string[] = [];
    for (const w of words) {
      if (quantity === null && /^\d+$/.test(w) && Number(w) > 0 && Number(w) <= 100000) { quantity = Number(w); continue; }
      if (unitWord === null && isUnitWord(w)) { unitWord = w; continue; }
      if (['of', 'ti', 'the', 'pieces', 'i', 'me', 'just', 'today', 'now', 'only', 'customer', 'for', 'to'].includes(w)) continue;
      phrase.push(w);
    }
    const p = phrase.join(' ').trim();
    if (p) items.push({ phrase: p, quantity, unitWord });
  }
  return items;
}

/** Extract "to Emeka" / "give Amaka" / "for Mama Chidi" customer names (original casing lost; returned normalized). */
function extractCustomer(input: string): { rest: string; customer: string | null } {
  const s = input.replace(/[,;\s]+$/, '');
  const m = s.match(/\b(?:to|give|gave|for customer|customer)\s+((?:mama|papa|mr|mrs|aunty|uncle|oga|madam|alhaji|chief)?\s*[a-z]+(?:\s+[a-z]+)?)\s*$/);
  if (m) return { rest: s.slice(0, m.index).trim(), customer: m[1].trim() };
  return { rest: s, customer: null };
}

const PAYMENT_STRIP = /\b(?:on credit|credit|by transfer|via transfer|transfer|bank transfer|by pos|pos|card|cash|in cash|paid by|by)\b/g;

export function parse(text: string): Parsed {
  const s = prepare(text);
  if (!s) return { intent: 'unknown', text };
  if (YES.test(s)) return { intent: 'yes' };
  if (NO.test(s)) return { intent: 'no' };

  // Navigation
  const nav = s.match(/^(?:open|go to|show(?: me)?|take me to|carry me go)\s+(?:my\s+|the\s+)?(stock|inventory|sales|payments|insights|hub|vendors hub|vendors|marketplace|customers|debts|money owed|chat|home|profile|settings|messages|new sale|pos)\b/);
  if (nav) {
    const map: Record<string, Screen> = {
      stock: 'stock', inventory: 'stock', sales: 'sales', payments: 'sales', insights: 'insights', hub: 'hub', 'vendors hub': 'hub',
      vendors: 'hub', marketplace: 'hub', customers: 'customers', debts: 'customers', 'money owed': 'customers', chat: 'chat',
      home: 'home', profile: 'profile', settings: 'profile', messages: 'messages', 'new sale': 'pos', pos: 'pos',
    };
    return { intent: 'navigate', screen: map[nav[1]] };
  }
  if (/^(help|what can you do|wetin you fit do|how do i use this|how una dey use am)$/.test(s)) return { intent: 'help' };

  // Vendor discovery questions ("who sell rice?") read like sales, so check them first.
  const vendorFirst = s.match(/^(?:who (?:dey )?sells?|where (?:i fit|can i|to) buy|find|search(?: for)?|look for)\s+(.+)$/);
  if (vendorFirst) return { intent: 'vendor_search', query: vendorFirst[1].replace(/\b(supplier|suppliers|vendor|vendors|wholesale|wholesaler)\b/g, ' ').replace(/\s+/g, ' ').trim() };

  // Debt payment: "Emeka paid 5000" / "Emeka don pay me 5k"
  const pay = s.match(/^([a-z]+(?:\s+[a-z]+)?)\s+(?:has\s+)?(?:paid|pay|don pay|payed|settled|sanwo|kwuru|ya biya)\s+(?:me\s+|back\s+)?(\d+)?/);
  if (pay && !SALE_VERB.test(s) && !/^(i|we|customer)$/.test(pay[1])) {
    return { intent: 'debt_payment', customer: pay[1], amount: pay[2] ? Number(pay[2]) : null };
  }
  // Debt: "Emeka owes me 5000" / "Emeka dey owe 5k"
  const owe = s.match(/^([a-z]+(?:\s+[a-z]+)?)\s+(?:owes|owe|dey owe|de owe|is owing|go pay|took goods worth)\s+(?:me\s+)?(\d+)?/);
  if (owe && !/^how/.test(s)) return { intent: 'debt', customer: owe[1], amount: owe[2] ? Number(owe[2]) : null };
  const bal = s.match(/how much (?:does |do |is )?([a-z]+(?:\s+[a-z]+)?) (?:owe|dey owe|owing|still owe)/);
  if (bal) return { intent: 'customer_balance', customer: bal[1] };

  // Sale
  const saleMatch = s.match(SALE_VERB);
  if (saleMatch && !/\b(how much|how many|what|wetin|which)\b/.test(s.slice(0, saleMatch.index))) {
    const after = s.slice((saleMatch.index ?? 0) + saleMatch[0].length);
    const payment = detectPayment(after);
    const prices = extractPrices(after);
    const cust = extractCustomer(prices.rest.replace(PAYMENT_STRIP, ' ').replace(/\s+/g, ' ').trim());
    cust.rest = cust.rest.replace(/[,;]+/g, ',').replace(/,\s*$/, '');
    return {
      intent: 'sale', items: parseItems(cust.rest), unitPrice: prices.unitPrice, totalPrice: prices.totalPrice,
      payment, amountPaid: prices.amountPaid, customer: cust.customer,
    };
  }

  // Restock
  const restockMatch = s.match(RESTOCK_VERB);
  if (restockMatch && !/\b(how much|how many|what|wetin|which|should)\b/.test(s)) {
    const after = s.slice((restockMatch.index ?? 0) + restockMatch[0].length);
    const prices = extractPrices(after);
    return { intent: 'restock', items: parseItems(prices.rest), unitCost: prices.unitPrice, totalCost: prices.totalPrice };
  }

  // Questions
  if (/\b(low|running out|finishing|wetin dey finish|what (?:is|dey) finish|out of stock|need to restock|should i (?:re)?stock|restock what)\b/.test(s))
    return { intent: 'low_stock' };
  if (/\b(slow|not selling|no dey sell|no dey move|not moving)\b/.test(s)) return { intent: 'slow_items' };
  if (/\b(best seller|top seller|selling most|sell pass|best selling|top item|top earner)\b/.test(s)) return { intent: 'top_items' };
  const stockQ = s.match(/(?:how (?:many|much)|wetin)\s+(.+?)\s+(?:remain|left|dey remain|i get|do i have|we get|is left|are left|still dey)\b/)
    || s.match(/\b(?:stock|quantity) (?:of|for)\s+(.+)$/) || s.match(/^(?:how many|how much)\s+(.+?)\s*(?:remain|left)?$/);
  if (stockQ && !/\b(sell|sold|make|profit|sales|owe)\b/.test(s)) return { intent: 'stock_query', phrase: stockQ[1].replace(/\b(i|we|do|have|get)\b/g, ' ').trim() };
  if (/\b(profit|gain|make profit|how much i gain)\b/.test(s)) return { intent: 'sales_summary', period: detectPeriod(s), focus: 'profit' };
  if (/\b(how (?:is |was )?(?:the )?market|how market|how business|sales|how much (?:did )?(?:i|we) (?:sell|make)|wetin i sell|how far|summary|daily summary|how my shop)\b/.test(s))
    return { intent: 'sales_summary', period: detectPeriod(s), focus: 'sales' };
  const vendor = s.match(/\b(?:find|search(?: for)?|look for|who (?:dey )?sell(?:s)?|where i fit buy|where can i buy|supplier(?:s)? (?:of|for)|wholesaler(?:s)? (?:of|for))\s+(.+)$/);
  if (vendor) return { intent: 'vendor_search', query: vendor[1].replace(/\b(supplier|suppliers|vendor|vendors|wholesale|wholesaler)\b/g, ' ').trim() };

  // Bare answers to a pending question
  const payOnly = detectPayment(s);
  if (payOnly && s.split(' ').length <= 6) {
    const p = extractPrices(s);
    return { intent: 'payment_answer', payment: payOnly, amountPaid: p.amountPaid };
  }
  const priceOnly = extractPrices(s);
  if ((priceOnly.unitPrice !== null || priceOnly.totalPrice !== null) && priceOnly.rest.split(' ').filter(Boolean).length <= 2)
    return { intent: 'price_answer', unitPrice: priceOnly.unitPrice, totalPrice: priceOnly.totalPrice };
  const numOnly = s.match(/^(?:it was |na |e be )?(\d+(?:\.\d+)?)(?: naira)?$/);
  if (numOnly) return { intent: 'number_answer', value: Number(numOnly[1]) };
  return { intent: 'unknown', text };
}

export { norm };
