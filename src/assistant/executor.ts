import type { BusinessApi } from '../data/api';
import { AppError, toAppError } from '../lib/errors';
import { naira, quantity as qty } from '../lib/format';
import { newOpId } from '../lib/ids';
import type { Language } from '../lib/types';
import { submitSale } from '../offline/queue';
import type { Draft } from './engine';

export interface ExecutionResult {
  ok: boolean;
  /** true when stored on the phone but NOT yet recorded on the server */
  queued?: boolean;
  reply: string;
  changed: ('products' | 'sales' | 'customers' | 'dashboard')[];
}

const t = (lang: Language, en: string, pcm: string) => (lang === 'pcm' ? pcm : en);

/**
 * Execute a confirmed draft against the real API. Success wording is generated ONLY from the
 * server's response, never from the draft, so Vendora can't claim a record that wasn't saved.
 * opId is generated once per confirmation; callers retrying the same confirmation must pass it back.
 */
export async function executeDraft(d: Draft, api: BusinessApi, lang: Language, opId = newOpId()): Promise<ExecutionResult> {
  try {
    switch (d.kind) {
      case 'sale': {
        let customerId = d.customer?.customer_id ?? null;
        if (!customerId && d.newCustomerName) customerId = (await api.createCustomer(d.newCustomerName)).customer_id;
        const total = d.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
        const outcome = await submitSale(api, {
          clientOpId: opId, channel: 'voice', paymentMethod: d.payment ?? 'cash', amountPaid: d.amountPaid, customerId,
          items: d.lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity, unit_price: l.unitPrice })),
        }, d.lines.map((l) => `${qty(l.quantity, l.product.unit)} ${l.product.name}`).join(', '), total);
        if (outcome.kind === 'queued') {
          return {
            ok: true, queued: true, changed: [],
            reply: t(lang,
              'No internet right now. I saved this sale on your phone — it is not recorded yet. It will sync automatically when you are back online.',
              'Network no dey now. I save this sale for your phone — e never record. E go sync by itself when network come back.'),
          };
        }
        const r = outcome.result;
        if (r.duplicate) {
          return { ok: true, changed: ['products', 'sales', 'dashboard'], reply: t(lang, 'That sale was already recorded, so I did not record it twice.', 'That sale don already record, so I no record am twice.') };
        }
        const left = r.items.map((i) => (i.stock_remaining === null ? null : `${qty(i.stock_remaining, i.unit)} of ${i.product_name}`)).filter(Boolean).join(' and ');
        const owing = r.total_amount - r.amount_paid;
        let reply = t(lang, `Your sale of ${naira(r.total_amount)} has been recorded.`, `I don record your sale of ${naira(r.total_amount)}.`);
        if (owing > 0) reply += t(lang, ` ${naira(owing)} is recorded as owing.`, ` I write ${naira(owing)} as debt.`);
        if (left) reply += t(lang, ` You have ${left} left.`, ` You get ${left} remaining.`);
        const low = r.items.find((i) => i.stock_remaining !== null && i.low_stock_threshold !== null && i.stock_remaining <= i.low_stock_threshold);
        if (low) reply += t(lang, ` ${low.product_name} is running low — restock soon.`, ` ${low.product_name} dey finish — restock soon.`);
        return { ok: true, reply, changed: ['products', 'sales', 'customers', 'dashboard'] };
      }
      case 'restock': {
        const parts: string[] = [];
        for (const [i, l] of d.lines.entries()) {
          try {
            const r = await api.restock(l.product.id, l.quantity, l.unitCost, `${opId}-${i}`);
            parts.push(`${r.name}: ${qty(r.stock_quantity, r.unit)}`);
          } catch (e) {
            // Each restock is its own transaction: report exactly what did and didn't save.
            if (!parts.length) throw e;
            const err = toAppError(e);
            return {
              ok: false, changed: ['products', 'dashboard'],
              reply: t(lang, `Partly done. Updated: ${parts.join(', ')}. Not updated: ${l.product.name} — ${err.message}`,
                `Half don work. E update: ${parts.join(', ')}. E no update: ${l.product.name} — ${err.message}`),
            };
          }
        }
        return { ok: true, changed: ['products', 'dashboard'], reply: t(lang, `Stock updated. ${parts.join(', ')} now.`, `Stock don update. ${parts.join(', ')} now.`) };
      }
      case 'debt': {
        let customerId = d.customer?.customer_id ?? null;
        let name = d.customer?.name ?? d.newCustomerName ?? '';
        if (!customerId) {
          const c = await api.createCustomer(d.newCustomerName!);
          customerId = c.customer_id;
          name = c.name;
        }
        const r = await api.recordDebt(customerId, d.amount!, 'Recorded by voice', opId);
        return { ok: true, changed: ['customers', 'dashboard'], reply: t(lang, `Recorded. ${name} now owes ${naira(r.balance)}.`, `I don write am. ${name} dey owe ${naira(r.balance)} now.`) };
      }
      case 'debt_payment': {
        const r = await api.recordDebtPayment(d.customer.customer_id, d.amount!, 'Recorded by voice', opId);
        const rest = r.balance > 0 ? t(lang, `${d.customer.name} still owes ${naira(r.balance)}.`, `${d.customer.name} still dey owe ${naira(r.balance)}.`) : t(lang, `${d.customer.name} has now paid everything.`, `${d.customer.name} don pay everything finish.`);
        return { ok: true, changed: ['customers', 'dashboard'], reply: t(lang, `Payment recorded. ${rest}`, `I don record the payment. ${rest}`) };
      }
    }
  } catch (e) {
    const err = e instanceof AppError ? e : toAppError(e);
    const what = d.kind === 'sale' ? t(lang, 'The sale was not recorded', 'The sale no record') : t(lang, 'Nothing was recorded', 'Nothing record');
    return { ok: false, changed: [], reply: `${what}: ${err.message}` };
  }
}
