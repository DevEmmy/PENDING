import type { Language } from '../lib/types';

/**
 * Speech-to-text runs in the browser (Web Speech API) because YarnGPT only provides
 * text-to-speech. Support varies: Chrome/Edge on Android & desktop support it; Firefox does
 * not. Yoruba/Igbo/Hausa locales are requested but recognition quality for them is NOT
 * verified — the trader always sees and can edit the transcript before anything is saved.
 */

// Minimal typings for the Web Speech API (not in lib.dom for all TS versions)
interface SRAlternative { transcript: string; confidence: number }
interface SRResult { isFinal: boolean; length: number; [i: number]: SRAlternative }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SRErrorEvent { error: string }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const LOCALES: Record<Language, string> = { en: 'en-NG', pcm: 'en-NG', yo: 'yo-NG', ig: 'ig-NG', ha: 'ha-NG' };

export function recognitionSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return typeof window !== 'undefined' && Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export const recognitionVerified = (lang: Language) => lang === 'en' || lang === 'pcm';

export interface RecognitionHandle {
  stop(): void; // finish and deliver what was heard
  abort(): void; // cancel without delivering
}

export interface RecognitionCallbacks {
  onInterim(text: string): void;
  onFinal(text: string, confidence: number | null): void;
  onError(message: string, code: string): void;
  onEnd(): void;
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone permission was blocked. Allow the microphone in your browser settings, or type instead.',
  'service-not-allowed': 'Voice input is not allowed on this browser. Please type instead.',
  'no-speech': "I didn't hear anything. Tap the mic and speak a bit louder, or type instead.",
  'audio-capture': 'No microphone was found. Please type instead.',
  network: 'Voice recognition needs internet. Please type instead, or try again when you are online.',
  'language-not-supported': 'This browser cannot recognise that language yet. Please type, or switch to English/Pidgin for voice.',
  aborted: '',
};

export function startRecognition(lang: Language, cb: RecognitionCallbacks): RecognitionHandle | null {
  const w = window as unknown as Record<string, new () => SpeechRecognitionLike>;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = LOCALES[lang];
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let confidence: number | null = null;
  let aborted = false;
  let delivered = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        finalText += r[0].transcript;
        confidence = r[0].confidence || null;
      } else interim += r[0].transcript;
    }
    cb.onInterim((finalText + ' ' + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') return;
    cb.onError(ERROR_MESSAGES[e.error] ?? 'Voice input stopped unexpectedly. Please try again or type instead.', e.error);
  };
  rec.onend = () => {
    if (!aborted && !delivered && finalText.trim()) {
      delivered = true;
      cb.onFinal(finalText.trim(), confidence);
    }
    cb.onEnd();
  };
  try {
    rec.start();
  } catch {
    cb.onError('Voice input could not start. Please try again or type instead.', 'start-failed');
    return null;
  }
  return {
    stop: () => rec.stop(),
    abort: () => {
      aborted = true;
      rec.abort();
    },
  };
}

/** Live microphone level for the waveform. Returns a stop function, or null if unavailable. */
export async function startLevelMeter(onLevel: (levels: number[]) => void, bars = 21): Promise<(() => void) | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const levels = Array.from({ length: bars }, (_, i) => {
        const centre = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
        const v = data[Math.min(data.length - 1, Math.floor((i / bars) * data.length * 0.8) + 1)] / 255;
        return Math.max(0.08, v * (1 - centre * 0.45));
      });
      onLevel(levels);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    };
  } catch {
    return null;
  }
}
