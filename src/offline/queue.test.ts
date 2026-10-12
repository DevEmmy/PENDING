import { describe, expect, it, vi } from 'vitest';
import type { BusinessApi } from '../data/api';
import { DemoBusinessApi } from '../data/demoApi';
import { AppError } from '../lib/errors';
import type { SaleInput } from '../lib/types';
import { discardQueued, listQueued, retryQueued, submitSale, syncQueue } from './queue';

/** A "live" API backed by the demo engine, with a switchable network. */
function flakyLiveApi() {
  const inner = new DemoBusinessApi({ fresh: true, latencyMs: 0, storage: null });
  const state = { online: false, commitThenDrop: false };
  const api = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'mode') return 'live';
      if (prop === 'businessId') return `biz-${prefix}`;
      if (prop === 'recordSale') {
        return async (input: SaleInput) => {
          if (!state.online) throw new TypeError('Failed to fetch');
          const r = await target.recordSale(input);
          if (state.commitThenDrop) { state.commitThenDrop = false; throw new TypeError('Failed to fetch'); } // server saved it, reply lost
          return r;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as BusinessApi;
  return { api, inner, state };
}
let prefix = 0;

describe('offline sale queue', () => {
  it('queues a sale when the connection drops and records it exactly once after reconnecting', async () => {
    prefix++;
    const { api, inner, state } = flakyLiveApi();
    const rice = (await inner.listProducts()).find((p) => p.name.startsWith('Rice'))!;
    const before = (await inner.listSales({ limit: 999 })).length;
    const input: SaleInput = { clientOpId: 'op-offline-1', channel: 'pos', paymentMethod: 'cash', items: [{ product_id: rice.id, quantity: 1 }] };

    const outcome = await submitSale(api, input, '1 bag Rice', 35000);
    expect(outcome.kind).toBe('queued');
    expect((await listQueued(api.businessId)).map((q) => q.status)).toEqual(['queued']);
    expect((await inner.listSales({ limit: 999 })).length).toBe(before); // NOT recorded yet

    // Still offline: sync leaves it queued
    expect((await syncQueue(api)).stillOffline).toBe(true);
    expect(await listQueued(api.businessId)).toHaveLength(1);

    // Back online, but the first reply is lost after the server commits
    state.online = true;
    state.commitThenDrop = true;
    expect((await syncQueue(api)).stillOffline).toBe(true);
    // Retrying the same op id returns the original sale instead of selling twice
    const report = await syncQueue(api);
    expect(report.synced).toHaveLength(1);
    expect(report.synced[0].duplicate).toBe(true);
    expect(await listQueued(api.businessId)).toHaveLength(0);
    expect((await inner.listSales({ limit: 999 })).length).toBe(before + 1);
    expect((await inner.listProducts()).find((p) => p.id === rice.id)!.stock_quantity).toBe(rice.stock_quantity - 1);
  });

  it('marks a queued sale failed (not recorded) when the server rejects it, and lets the trader retry or discard', async () => {
    prefix++;
    const { api, inner, state } = flakyLiveApi();
    const tomato = (await inner.listProducts()).find((p) => p.name === 'Tomato Paste')!; // 2 in stock
    await submitSale(api, { clientOpId: 'op-offline-2', channel: 'pos', paymentMethod: 'cash', items: [{ product_id: tomato.id, quantity: 5 }] }, '5 cartons Tomato Paste', 18000);
    state.online = true;
    const report = await syncQueue(api);
    expect(report.failed).toEqual([{ opId: 'op-offline-2', reason: 'Only 2 cartons of Tomato Paste left.' }]);
    const [q] = await listQueued(api.businessId);
    expect(q).toMatchObject({ status: 'failed', lastError: 'Only 2 cartons of Tomato Paste left.' });
    // Failed items are not retried automatically
    expect((await syncQueue(api)).synced).toHaveLength(0);
    await retryQueued('op-offline-2');
    expect((await listQueued(api.businessId))[0].status).toBe('queued');
    await discardQueued('op-offline-2');
    expect(await listQueued(api.businessId)).toHaveLength(0);
  });

  it('never queues business errors — they are shown immediately', async () => {
    prefix++;
    const { api, state } = flakyLiveApi();
    state.online = true;
    await expect(submitSale(api, { clientOpId: 'op-x-3', channel: 'pos', paymentMethod: 'credit', items: [{ product_id: (await api.listProducts())[0].id, quantity: 1 }] }, 'x', 1))
      .rejects.toBeInstanceOf(AppError);
    expect(await listQueued(api.businessId)).toHaveLength(0);
  });

  it('does not queue in demo mode', async () => {
    const demo = new DemoBusinessApi({ fresh: true, latencyMs: 0, storage: null });
    const spy = vi.spyOn(demo, 'recordSale').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(submitSale(demo, { clientOpId: 'op-demo-1', channel: 'pos', paymentMethod: 'cash', items: [] }, 'x', 0)).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalled();
  });
});
