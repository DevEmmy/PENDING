import { stripDiacritics } from './numbers';

export function norm(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const UNIT_WORDS = new Set([
  'bag', 'bags', 'carton', 'cartons', 'ctn', 'ctns', 'tin', 'tins', 'crate', 'crates', 'piece', 'pieces', 'pcs', 'pack', 'packs',
  'packet', 'packets', 'bottle', 'bottles', 'sachet', 'sachets', 'kg', 'kilo', 'kilos', 'litre', 'litres', 'liter', 'liters',
  'box', 'boxes', 'dozen', 'dozens', 'roll', 'rolls', 'gallon', 'gallons', 'keg', 'kegs', 'paint', 'paints', 'mudu', 'basket', 'baskets',
]);
export const isUnitWord = (w: string) => UNIT_WORDS.has(w);

const STOP = new Set(['of', 'the', 'a', 'an', 'ti', 'na', 'some', 'and', 'my', 'for', 'to', 'i', 'me', 'don', 'dey', 'mo', 'ta', 'just', 'today']);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('es') && /(ch|sh|x|s)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function tokenMatch(q: string, t: string): number {
  if (q === t) return 1;
  const qs = singular(q);
  const ts = singular(t);
  if (qs === ts) return 1;
  if (qs.length >= 3 && ts.startsWith(qs)) return 0.85;
  if (ts.length >= 3 && qs.startsWith(ts)) return 0.8;
  if (qs.length >= 4 && levenshtein(qs, ts) <= (qs.length >= 7 ? 2 : 1)) return 0.75;
  return 0;
}

export function meaningfulTokens(phrase: string): string[] {
  return norm(phrase).split(' ').filter((w) => w && !STOP.has(w) && !isUnitWord(w) && !/^\d+$/.test(w));
}

export interface MatchResult<T> {
  best: T | null;
  candidates: T[];
  ambiguous: boolean;
  score: number;
}

/**
 * Fuzzy-match a spoken phrase ("peak milk", "indomie", "rice 50kg") to named records.
 * Score = how much of the spoken phrase is covered by the record's name, with a small
 * bonus for covering more of the name. Ties above the threshold are reported as ambiguous.
 */
export function matchByName<T>(phrase: string, items: T[], getName: (t: T) => string, threshold = 0.6): MatchResult<T> {
  const q = meaningfulTokens(phrase);
  if (!q.length) return { best: null, candidates: [], ambiguous: false, score: 0 };
  const scored = items.map((item) => {
    const nameTokens = norm(getName(item)).split(' ').filter((w) => w && !STOP.has(w));
    let covered = 0;
    let nameHits = 0;
    const usedName = new Set<number>();
    for (const qt of q) {
      let bestS = 0;
      let bestIdx = -1;
      nameTokens.forEach((nt, idx) => {
        const s = tokenMatch(qt, nt);
        if (s > bestS) { bestS = s; bestIdx = idx; }
      });
      covered += bestS;
      if (bestIdx >= 0 && !usedName.has(bestIdx)) { usedName.add(bestIdx); nameHits += 1; }
    }
    const coverage = covered / q.length;
    const nameCoverage = nameTokens.length ? nameHits / nameTokens.length : 0;
    const exact = norm(getName(item)) === q.join(' ') ? 0.2 : 0;
    return { item, score: coverage * 0.85 + nameCoverage * 0.15 + exact };
  }).filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score);
  if (!scored.length) return { best: null, candidates: [], ambiguous: false, score: 0 };
  const top = scored[0].score;
  const close = scored.filter((x) => top - x.score < 0.08);
  return { best: close.length === 1 ? scored[0].item : null, candidates: close.map((x) => x.item), ambiguous: close.length > 1, score: top };
}
