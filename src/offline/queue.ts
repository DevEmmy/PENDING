import type { BusinessApi } from '../data/api';
import { AppError, isNetworkError, toAppError } from '../lib/errors';
import type { Product, SaleInput, SaleResult } from '../lib/types';
import { idbAllByIndex, idbDelete, idbGet, idbPut, STORES } from './idb';

/**
 * Offline sale queue.
 * - Every sale carries a stable clientOpId; the server's record_sale is idempotent on it,
 *   so replaying after a dropped connection can never record the same sale twice.
 * - Queued sales are shown as "Saved on this phone — waiting to sync", never as recorded.
 * - A sale the server rejects on sync (e.g. stock ran out) becomes "failed" with the reason,
 *   and stays until the trader retries or discards it.
 */
export interface QueuedSale {
  opId: string;
  businessId: string;
  input: SaleInput;
  summary: string;
  total: number;
  createdAt: string;
  status: 'queued' | 'syncing' | 'failed';
  attempts: number;
  lastError: string | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();
export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((l) => l());

export async function listQueued(businessId: string): Promise<QueuedSale[]> {
  try {
    const rows = await idbAllByIndex<QueuedSale>(STORES.queue, 'businessId', businessId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function enqueueSale(businessId: string, input: SaleInput, summary: string, total: number): Promise<QueuedSale> {
  const existing = await idbGet<QueuedSale>(STORES.queue, input.clientOpId);
  if (existing) return existing;
  const q: QueuedSale = {
    opId: input.clientOpId, businessId, input: { ...input, channel: input.channel === 'pos' ? 'offline' : input.channel },
    summary, total, createdAt: new Date().toISOString(), status: 'queued', attempts: 0, lastError: null,
  };
  await idbPut(STORES.queue, q);
  emit();
  return q;
}

export async function discardQueued(opId: string) {
  await idbDelete(STORES.queue, opId);
  emit();
}

export async function retryQueued(opId: string) {
  const q = await idbGet<QueuedSale>(STORES.queue, opId);
  if (!q) return;
  await idbPut(STORES.queue, { ...q, status: 'queued', lastError: null });
  emit();
}

let syncing = false;
export interface SyncReport {
  synced: SaleResult[];
  failed: { opId: string; reason: string }[];
  stillOffline: boolean;
}

export async function syncQueue(api: BusinessApi): Promise<SyncReport> {
  const report: SyncReport = { synced: [], failed: [], stillOffline: false };
  if (syncing || api.mode !== 'live') return report;
  syncing = true;
  try {
    const items = (await listQueued(api.businessId)).filter((q) => q.status !== 'failed');
    for (const q of items) {
      await idbPut(STORES.queue, { ...q, status: 'syncing', attempts: q.attempts + 1 });
      emit();
      try {
        const result = await api.recordSale(q.input);
        await idbDelete(STORES.queue, q.opId);
        report.synced.push(result);
      } catch (e) {
        if (isNetworkError(e)) {
          await idbPut(STORES.queue, { ...q, status: 'queued', attempts: q.attempts + 1 });
          report.stillOffline = true;
          break;
        }
        const err = toAppError(e);
        await idbPut(STORES.queue, { ...q, status: 'failed', attempts: q.attempts + 1, lastError: err.message });
        report.failed.push({ opId: q.opId, reason: err.message });
      }
      emit();
    }
  } finally {
    syncing = false;
    emit();
  }
  return report;
}

export type SubmitOutcome = { kind: 'recorded'; result: SaleResult } | { kind: 'queued'; queued: QueuedSale };

/**
 * Submit a sale. Online: record it and return the server's confirmation.
 * Offline / connection dropped: queue it locally with the same op id.
 * Business errors (insufficient stock, forbidden...) are thrown, never queued.
 */
export async function submitSale(api: BusinessApi, input: SaleInput, summary: string, total: number): Promise<SubmitOutcome> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (api.mode === 'live' && offline) {
    return { kind: 'queued', queued: await enqueueSale(api.businessId, input, summary, total) };
  }
  try {
    return { kind: 'recorded', result: await api.recordSale(input) };
  } catch (e) {
    if (api.mode === 'live' && isNetworkError(e)) {
      return { kind: 'queued', queued: await enqueueSale(api.businessId, input, summary, total) };
    }
    throw e instanceof AppError ? e : toAppError(e);
  }
}

// ---- product cache for offline viewing ----
interface CachedProducts {
  savedAt: string;
  products: Product[];
}
export async function cacheProducts(businessId: string, products: Product[]) {
  try {
    await idbPut(STORES.cache, { savedAt: new Date().toISOString(), products } satisfies CachedProducts, `products:${businessId}`);
  } catch {
    /* cache is best-effort */
  }
}
export async function getCachedProducts(businessId: string): Promise<CachedProducts | null> {
  try {
    return (await idbGet<CachedProducts>(STORES.cache, `products:${businessId}`)) ?? null;
  } catch {
    return null;
  }
}
