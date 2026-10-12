import { describe, expect, it } from 'vitest';
import { matchByName } from './matching';
import { nairaForSpeech, normalizeNumbers } from './numbers';
import { parse } from './parser';

describe('normalizeNumbers', () => {
  it.each([
    ['two bags', '2 bags'],
    ['thirty-five thousand each', '35000 each'],
    ['thirty five thousand', '35000'],
    ['35k', '35000'],
    ['1.5m', '1500000'],
    ['70,000 naira', '70000 naira'],
    ['one hundred and fifty thousand', '150000'],
    ['bags meji', 'bags 2'],
    ['carton biyu', 'carton 2'],
    ['35 thousand', '35000'],
  ])('%s → %s', (input, out) => {
    expect(normalizeNumbers(input)).toBe(out);
  });
  it('formats naira for speech', () => {
    expect(nairaForSpeech('That comes to ₦70,000.')).toBe('That comes to 70,000 naira.');
  });
});

describe('parse — sales', () => {
  it('understands the spec example', () => {
    const p = parse('I sold two bags of rice.');
    expect(p).toMatchObject({ intent: 'sale', payment: null, unitPrice: null, items: [{ phrase: 'rice', quantity: 2, unitWord: 'bags' }] });
  });
  it('parses the Yoruba design example with two items', () => {
    const p = parse('Mo ta bags meji ti rice ati ọkan carton Peak Milk');
    expect(p.intent).toBe('sale');
    if (p.intent !== 'sale') return;
    expect(p.items).toEqual([
      { phrase: 'rice', quantity: 2, unitWord: 'bags' },
      { phrase: 'peak milk', quantity: 1, unitWord: 'carton' },
    ]);
  });
  it('parses Pidgin with price and payment', () => {
    const p = parse('I don sell 3 cartons indomie for 6,000 each, transfer');
    expect(p).toMatchObject({ intent: 'sale', unitPrice: 6000, payment: 'transfer', items: [{ phrase: 'indomie', quantity: 3 }] });
  });
  it('parses credit sale to a named customer with part payment', () => {
    const p = parse('Sold 1 bag of rice on credit to Emeka, paid 10k');
    expect(p).toMatchObject({ intent: 'sale', payment: 'credit', amountPaid: 10000, customer: 'emeka', items: [{ phrase: 'rice', quantity: 1 }] });
  });
  it('treats "for 70000" as a total', () => {
    expect(parse('I sold 2 bags of rice for 70000')).toMatchObject({ intent: 'sale', totalPrice: 70000, unitPrice: null });
  });
});

describe('parse — answers and other intents', () => {
  it.each([
    ['Thirty-five thousand each', { intent: 'price_answer', unitPrice: 35000 }],
    ['cash', { intent: 'payment_answer', payment: 'cash' }],
    ['na transfer', { intent: 'payment_answer', payment: 'transfer' }],
    ['yes', { intent: 'yes' }],
    ['record am', { intent: 'yes' }],
    ['no', { intent: 'no' }],
    ['35000', { intent: 'number_answer', value: 35000 }],
    ['Emeka paid 5000', { intent: 'debt_payment', customer: 'emeka', amount: 5000 }],
    ['Mama Chidi don pay me 2k', { intent: 'debt_payment', customer: 'mama chidi', amount: 2000 }],
    ['Emeka owes me 5k', { intent: 'debt', customer: 'emeka', amount: 5000 }],
    ['How much Emeka owe?', { intent: 'customer_balance', customer: 'emeka' }],
    ['How much Indomie remain?', { intent: 'stock_query', phrase: 'indomie' }],
    ['how many bags of rice do i have left', { intent: 'stock_query' }],
    ['How market today?', { intent: 'sales_summary', period: 'today', focus: 'sales' }],
    ['How much profit this week', { intent: 'sales_summary', period: 'week', focus: 'profit' }],
    ['Which item slow today?', { intent: 'slow_items' }],
    ['wetin dey finish', { intent: 'low_stock' }],
    ['what is running low?', { intent: 'low_stock' }],
    ['I bought 10 bags of rice at 30,000 each', { intent: 'restock', unitCost: 30000, items: [{ phrase: 'rice', quantity: 10 }] }],
    ['find rice supplier', { intent: 'vendor_search', query: 'rice' }],
    ['who sell vegetable oil', { intent: 'vendor_search', query: 'vegetable oil' }],
    ['open stock', { intent: 'navigate', screen: 'stock' }],
    ['show me the vendors hub', { intent: 'navigate', screen: 'hub' }],
    ['sing me a song', { intent: 'unknown' }],
  ])('%s', (input, expected) => {
    expect(parse(input)).toMatchObject(expected);
  });
});

describe('matchByName', () => {
  const products = ['Rice (50kg)', 'Peak Milk', 'Indomie', 'Tomato Paste', 'Sugar (50kg)', 'Vegetable Oil', 'Peak Milk Sachet'].map((name, i) => ({ id: String(i), name }));
  const get = (p: { name: string }) => p.name;
  it.each([
    ['rice', 'Rice (50kg)'],
    ['bags of rice', 'Rice (50kg)'],
    ['indomie', 'Indomie'],
    ['indomi', 'Indomie'],
    ['tomato', 'Tomato Paste'],
    ['veg oil', 'Vegetable Oil'],
    ['peak milk', 'Peak Milk'],
  ])('%s → %s', (q, name) => {
    expect(matchByName(q, products, get).best?.name).toBe(name);
  });
  it('reports ambiguity instead of guessing', () => {
    const r = matchByName('peak', products, get);
    expect(r.best).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['Peak Milk', 'Peak Milk Sachet']);
  });
  it('returns nothing for unknown products', () => {
    expect(matchByName('cement', products, get).best).toBeNull();
  });
});
