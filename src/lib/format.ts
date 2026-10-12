export const LAGOS_TZ = 'Africa/Lagos';

const nf0 = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₦42,000 — whole naira shown without kobo; kobo shown only when present. */
export function naira(value: number | string | null | undefined, opts: { signed?: boolean } = {}): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₦—';
  const abs = Math.abs(n);
  const body = Number.isInteger(Math.round(abs * 100) / 100) && Math.round(abs * 100) % 100 === 0 ? nf0.format(abs) : nf2.format(abs);
  const sign = n < 0 ? '-' : opts.signed && n > 0 ? '+' : '';
  return `${sign}₦${body}`;
}

/** Compact naira for chart labels: ₦198.5k, ₦1.2m */
export function nairaCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `₦${trim(value / 1_000_000)}m`;
  if (abs >= 1_000) return `₦${trim(value / 1_000)}k`;
  return naira(value);
}
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

export function quantity(n: number, unit: string): string {
  return `${nf0.format(n)} ${pluralUnit(unit, n)}`;
}

const IRREGULAR: Record<string, string> = { box: 'boxes', crate: 'crates', piece: 'pieces', pack: 'packs', tin: 'tins', bag: 'bags', carton: 'cartons', bottle: 'bottles', sachet: 'sachets', kg: 'kg', litre: 'litres' };
export function pluralUnit(unit: string, n: number): string {
  const u = unit.trim();
  if (n === 1) return u;
  const lower = u.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  if (/(s|x|ch|sh)$/.test(lower)) return `${u}es`;
  return `${u}s`;
}

const dateFmt = new Intl.DateTimeFormat('en-NG', { timeZone: LAGOS_TZ, weekday: 'short', day: 'numeric', month: 'short' });
const longDateFmt = new Intl.DateTimeFormat('en-NG', { timeZone: LAGOS_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-NG', { timeZone: LAGOS_TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const formatDate = (d: string | Date) => dateFmt.format(new Date(d));
export const formatLongDate = (d: string | Date) => longDateFmt.format(new Date(d));
export const formatTime = (d: string | Date) => timeFmt.format(new Date(d)).replace(/\s?([ap])\.?m\.?/i, (_m, p: string) => ` ${p.toUpperCase()}M`);
/** YYYY-MM-DD in Lagos time */
export const lagosDayKey = (d: string | Date) => dayKeyFmt.format(new Date(d));

export function relativeTime(d: string | Date, now: Date = new Date()): string {
  const date = new Date(d);
  const diff = Math.round((now.getTime() - date.getTime()) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  const today = lagosDayKey(now);
  const day = lagosDayKey(date);
  if (day === today) {
    const hrs = Math.round(diff / 3600);
    return hrs <= 1 ? '1 hr ago' : `${hrs} hrs ago`;
  }
  const yesterday = lagosDayKey(new Date(now.getTime() - 86400000));
  if (day === yesterday) return 'Yesterday';
  const days = Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  if (days < 7) return `${days} days ago`;
  return formatDate(date);
}

export function greeting(now: Date = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-NG', { timeZone: LAGOS_TZ, hour: 'numeric', hour12: false }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'V';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}
