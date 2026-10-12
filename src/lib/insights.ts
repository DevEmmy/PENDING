import { naira, quantity } from './format';
import type { DashboardSummary } from './types';

export interface Advice {
  id: string;
  tone: 'orange' | 'blue' | 'green' | 'red';
  icon: string;
  title: string;
  body: string;
  ask: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Rule-based advice. Every sentence is derived from the summary; nothing is invented. */
export function buildAdvice(d: DashboardSummary): Advice[] {
  const out: Advice[] = [];
  const withSales = d.products.filter((p) => p.units_7d > 0).sort((a, b) => b.revenue_7d - a.revenue_7d);
  const top = withSales[0];
  if (top) {
    const byDay = new Map<number, number>();
    for (const day of d.daily) {
      const wd = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      byDay.set(wd, (byDay.get(wd) ?? 0) + day.revenue);
    }
    const best = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    const stockNote = top.stock_quantity <= top.low_stock_threshold
      ? ` Only ${quantity(top.stock_quantity, top.unit)} left — restock before you run out.`
      : ` You have ${quantity(top.stock_quantity, top.unit)} in stock.`;
    const peak = best && best[1] > 0 ? ` Your busiest day in the last 2 weeks was ${WEEKDAYS[best[0]]}.` : '';
    out.push({
      id: 'top', tone: 'orange', icon: '🔥', title: `${top.name} is your top earner`,
      body: `You sold ${quantity(top.units_7d, top.unit)} (${naira(top.revenue_7d)}) in the last 7 days.${stockNote}${peak}`,
      ask: `How much ${top.name} remain?`,
    });
  }
  const slow = d.products.filter((p) => p.stock_quantity > 0 && p.product_id !== top?.product_id)
    .sort((a, b) => a.units_7d - b.units_7d || b.stock_quantity * b.price - a.stock_quantity * a.price)[0];
  if (slow && (slow.units_7d === 0 || slow.units_7d < slow.units_prev_7d || (top && slow.units_7d * 4 < top.units_7d))) {
    const trend = slow.units_prev_7d > 0 ? ` (${slow.units_prev_7d} the week before)` : '';
    out.push({
      id: 'slow', tone: 'blue', icon: '📉', title: `${slow.name} is moving slowly`,
      body: `${slow.units_7d === 0 ? 'None sold' : `Only ${quantity(slow.units_7d, slow.unit)} sold`} in the last 7 days${trend}, with ${quantity(slow.stock_quantity, slow.unit)} still in stock (${naira(slow.stock_quantity * slow.price)} at your price). Consider a bundle, a small discount, or buying less next time.`,
      ask: 'Which item slow today?',
    });
  }
  if (d.week.costed_revenue > 0) {
    const margin = Math.round((d.week.profit / d.week.costed_revenue) * 100);
    const missing = d.stock.missing_cost_count;
    out.push({
      id: 'margin', tone: margin >= 15 ? 'green' : 'red', icon: '💰', title: `Your profit margin is ${margin}%`,
      body: `On items with a cost price, you kept ${naira(d.week.profit)} from ${naira(d.week.costed_revenue)} of sales in the last 7 days.${!d.week.profit_complete || missing ? ' Some items have no cost price, so they are left out — add cost prices for a complete figure.' : ''}`,
      ask: 'How much profit this week?',
    });
  } else if (d.week.count > 0) {
    out.push({ id: 'margin', tone: 'green', icon: '💰', title: 'Add cost prices to see profit', body: 'None of this week\'s sales have a cost price yet, so profit can\'t be worked out. Add cost prices on the Stock page.', ask: 'How market this week?' });
  }
  if (d.stock.out_count > 0) {
    const finished = d.products.filter((p) => p.stock_quantity === 0).map((p) => p.name);
    out.push({ id: 'out', tone: 'red', icon: '⚠️', title: `${finished.length} item${finished.length === 1 ? ' is' : 's are'} finished`, body: `${finished.slice(0, 4).join(', ')}${finished.length > 4 ? '…' : ''}. Customers asking for these are walking away.`, ask: 'Wetin dey finish?' });
  }
  if (d.debts.outstanding > 0) {
    out.push({ id: 'debts', tone: 'orange', icon: '💸', title: `${naira(d.debts.outstanding)} is owed to you`, body: `${d.debts.debtors} customer${d.debts.debtors === 1 ? '' : 's'} still owe${d.debts.debtors === 1 ? 's' : ''} money. Collecting it is cheaper than borrowing.`, ask: 'Who owes me money?' });
  }
  return out;
}
