import { beforeEach, describe, expect, it } from 'vitest';
import { DemoBusinessApi } from '../data/demoApi';
import type { Language } from '../lib/types';
import { handle, initialState, type EngineContext, type EngineState, type Turn } from './engine';
import { executeDraft } from './executor';

let api: DemoBusinessApi;
async function ctx(language: Language = 'en'): Promise<EngineContext> {
  return { products: await api.listProducts(), customers: await api.listCustomers(), language, getDashboard: () => api.dashboard() };
}
async function converse(lines: string[], language: Language = 'en') {
  let state: EngineState = initialState;
  const turns: Turn[] = [];
  for (const line of lines) {
    const turn = await handle(line, state, await ctx(language));
    turns.push(turn);
    state = turn.state;
  }
  return turns;
}

beforeEach(() => {
  api = new DemoBusinessApi({ fresh: true, latencyMs: 0, storage: null });
});

describe('assistant dialog', () => {
  it('follows the spec conversation and records only after confirmation', async () => {
    const before = (await api.listProducts()).find((p) => p.name.startsWith('Rice'))!.stock_quantity;
    const salesBefore = (await api.listSales({ limit: 500 })).length;
    const [t1, t2, t3, t4] = await converse(['I sold two bags of rice', 'Thirty-five thousand each', 'transfer', 'yes']);
    expect(t1.outcome).toBe('clarified');
    expect(t1.reply).toMatch(/₦70,000/);
    expect(t1.reply).toMatch(/cash, transfer/i);
    expect(t2.reply).toMatch(/₦70,000/);
    expect(t3.confirm?.total).toBe('₦70,000');
    expect(t3.execute).toBeUndefined();
    // nothing recorded before "yes"
    expect((await api.listSales({ limit: 500 })).length).toBe(salesBefore);
    expect(t4.execute?.kind).toBe('sale');
    const result = await executeDraft(t4.execute!, api, 'en', 'op-test-spec-1');
    expect(result.ok).toBe(true);
    expect(result.reply).toMatch(/recorded/);
    expect(result.reply).toContain(`${before - 2} bags of Rice (50kg) left`);
    // executing the same confirmation twice does not double-record
    const again = await executeDraft(t4.execute!, api, 'en', 'op-test-spec-1');
    expect(again.reply).toMatch(/already recorded/);
    expect((await api.listSales({ limit: 500 })).length).toBe(salesBefore + 1);
  });

  it('handles the Yoruba two-item example', async () => {
    const [t1, t2] = await converse(['Mo ta bags meji ti rice ati ọkan carton Peak Milk', 'cash']);
    expect(t1.reply).toMatch(/Rice/);
    expect(t2.confirm?.lines.map((l) => l.label)).toEqual(['2 bags · Rice (50kg)', '1 carton · Peak Milk', 'Payment']);
  });

  it('cancels cleanly', async () => {
    const turns = await converse(['I sold 1 carton of indomie cash', 'no']);
    expect(turns[0].confirm).toBeDefined();
    expect(turns[1].outcome).toBe('cancelled');
    expect(turns[1].state.draft).toBeNull();
  });

  it('refuses to sell more than the stock', async () => {
    const [t] = await converse(['I sold 50 bags of rice cash']);
    expect(t.outcome).toBe('failed');
    expect(t.reply).toMatch(/only have 14 bags/);
  });

  it('asks which product when a phrase is ambiguous', async () => {
    await api.createProduct({ name: 'Peak Milk Sachet', unit: 'sachet', price: 150, costPrice: 100, lowStockThreshold: 10, openingQuantity: 50, clientOpId: 'op-x' });
    const [t1, t2] = await converse(['I sold 2 peak', '2']);
    expect(t1.suggestions).toEqual(expect.arrayContaining(['Peak Milk', 'Peak Milk Sachet']));
    expect(t2.reply).toMatch(/Peak Milk Sachet/);
  });

  it('requires a customer for credit and creates a new one on confirm', async () => {
    const [t1, t2, t3] = await converse(['I sold 1 carton of indomie on credit', 'Bisi', 'yes']);
    expect(t1.reply).toMatch(/Which customer/);
    expect(t2.confirm?.lines.find((l) => l.label === 'Customer')?.value).toBe('Bisi (new customer)');
    const r = await executeDraft(t3.execute!, api, 'en');
    expect(r.ok).toBe(true);
    const bisi = (await api.listCustomers()).find((c) => c.name === 'Bisi');
    expect(bisi?.balance).toBe(6000);
  });

  it('records debt payments and blocks overpayment', async () => {
    const [t1] = await converse(['Emeka paid 50000']);
    expect(t1.reply).toMatch(/only owes ₦20,000/);
    const [, t3] = await converse(['Emeka paid 5000', 'yes']);
    const r = await executeDraft(t3.execute!, api, 'en');
    expect(r.reply).toMatch(/still owes ₦15,000/);
  });

  it('answers stock and summary questions from records, in Pidgin', async () => {
    const [stock] = await converse(['How much Indomie remain?'], 'pcm');
    expect(stock.reply).toMatch(/You get 6 cartons of Indomie remaining/);
    const [summary] = await converse(['How market today?'], 'pcm');
    expect(summary.reply).toMatch(/You don sell ₦/);
    const [low] = await converse(['wetin dey finish'], 'pcm');
    expect(low.reply).toMatch(/Sugar \(50kg\) \(finished\)/);
  });

  it('reports failures without claiming success', async () => {
    const [, t2] = await converse(['I sold 2 bags of rice cash', 'yes']);
    // Simulate stock disappearing between confirmation and execution (another till sold it).
    const rice = (await api.listProducts()).find((p) => p.name.startsWith('Rice'))!;
    await api.adjustStock(rice.id, 1, 'Recount', 'op-adj-1');
    const r = await executeDraft(t2.execute!, api, 'en');
    expect(r.ok).toBe(false);
    expect(r.reply).toMatch(/^The sale was not recorded: Only 1 bag of Rice/);
  });

  it('routes vendor searches to the hub', async () => {
    const [t] = await converse(['find rice supplier']);
    expect(t.navigate).toBe('/hub?q=rice');
  });
});
