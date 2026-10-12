/**
 * Turns spoken/typed number expressions into digits, for English/Pidgin plus the basic
 * counting words (1–10) of Yoruba, Igbo and Hausa. Examples:
 *   "two bags" → "2 bags", "thirty-five thousand" → "35000", "35k" → "35000",
 *   "₦1.5m" → "1500000", "bags meji" → "bags 2", "70,000" → "70000"
 */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/** Local-language counting words (after diacritics are stripped). Deliberately small and conservative. */
export const LOCAL_NUMBERS: Record<string, number> = {
  // Yoruba
  okan: 1, ookan: 1, meji: 2, eeji: 2, meta: 3, eeta: 3, merin: 4, eerin: 4, marun: 5, aarun: 5,
  mefa: 6, eefa: 6, meje: 7, eeje: 7, mejo: 8, eejo: 8, mesan: 9, eesan: 9, mewaa: 10, mewa: 10, eewa: 10,
  // Igbo
  otu: 1, abuo: 2, ato: 3, ano: 4, ise: 5, isii: 6, asaa: 7, asato: 8, itoolu: 9, iri: 10,
  // Hausa
  daya: 1, biyu: 2, uku: 3, hudu: 4, biyar: 5, shida: 6, bakwai: 7, takwas: 8, tara: 9, goma: 10,
};

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ẹ/g, 'e').replace(/ọ/g, 'o');
}

function isNumberWord(w: string): boolean {
  return w in UNITS || w in TENS || w in SCALES;
}

/** Parse a run of English number words; returns null if not a number phrase. */
export function wordsToNumber(words: string[]): number | null {
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const raw of words) {
    const w = raw.replace(/-/g, '');
    if (w === 'and' || w === 'a') continue;
    if (w in UNITS) { current += UNITS[w]; seen = true; }
    else if (w in TENS) { current += TENS[w]; seen = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (w === 'thousand' || w === 'million') {
      total += (current || 1) * SCALES[w];
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

/** Replace number expressions in normalized (lowercase, diacritic-free) text with digits. */
export function normalizeNumbers(text: string): string {
  let s = text;
  // ₦ / naira symbols → spacing
  s = s.replace(/[₦#]\s*(?=\d)/g, ' ');
  // 1,500,000 → 1500000 ; keep decimals
  s = s.replace(/(\d{1,3})(?:,(\d{3}))+(?!\d)/g, (m) => m.replace(/,/g, ''));
  // 35k / 1.5m / 2.5 million
  s = s.replace(/(\d+(?:\.\d+)?)\s*(k|m|million|thousand|hundred)\b/g, (_m, n: string, suf: string) => {
    const mult = suf === 'k' || suf === 'thousand' ? 1000 : suf === 'hundred' ? 100 : 1_000_000;
    return String(Math.round(parseFloat(n) * mult));
  });
  // "half bag" → 0.5 is not supported for stock (whole units only); leave "half" as a word.
  // English number words (e.g. "thirty five thousand", "twenty-five")
  s = s.replace(/-/g, ' - ').replace(/\s+/g, ' ');
  const tokens = s.split(' ');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isNumberWord(t)) {
      const run: string[] = [t];
      let j = i + 1;
      while (j < tokens.length && (isNumberWord(tokens[j]) || tokens[j] === '-' ||
             (tokens[j] === 'and' && j + 1 < tokens.length && isNumberWord(tokens[j + 1])))) {
        if (tokens[j] !== '-') run.push(tokens[j]);
        j++;
      }
      const n = wordsToNumber(run);
      if (n !== null) {
        out.push(String(n));
        i = j - 1;
        continue;
      }
    }
    if (t in LOCAL_NUMBERS) {
      out.push(String(LOCAL_NUMBERS[t]));
      continue;
    }
    if (t === '-') continue;
    out.push(t);
  }
  // "35 thousand" (digits followed by scale words that survived)
  return out.join(' ').replace(/(\d+) (thousand|million|hundred)\b/g, (_m, n: string, w: string) => String(Number(n) * SCALES[w]));
}

/** Speakable form of naira amounts for TTS: "₦70,000" → "70,000 naira". */
export function nairaForSpeech(text: string): string {
  return text.replace(/-?₦([\d,]+(?:\.\d+)?)/g, (_m, n: string) => `${n} naira`);
}
