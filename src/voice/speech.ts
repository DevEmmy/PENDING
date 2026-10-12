import { nairaForSpeech } from '../assistant/numbers';
import type { Language } from '../lib/types';
import { functionsUrl, supabase } from '../lib/supabase';

export type VoiceSource = 'yarngpt' | 'device' | 'none';

export interface Playback {
  source: VoiceSource;
  /** resolves when speech finishes, is stopped, or fails */
  done: Promise<void>;
  stop(): void;
  /** Human-readable reason when YarnGPT wasn't used */
  note: string | null;
}

let current: Playback | null = null;
export function stopSpeaking() {
  current?.stop();
  current = null;
}

function deviceSpeak(text: string, note: string | null): Playback {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return { source: 'none', done: Promise.resolve(), stop: () => {}, note: note ?? 'Spoken replies are not available on this device.' };
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-NG';
  u.rate = 0.98;
  const done = new Promise<void>((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
  });
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return { source: 'device', done, stop: () => window.speechSynthesis.cancel(), note };
}

/**
 * Speak a reply. Signed-in users get YarnGPT through the authenticated `tts` Edge Function;
 * if that is unavailable (not configured, quota, offline) we fall back to the device voice and
 * say so. The text reply is always shown regardless, so voice is never required.
 */
export async function speak(text: string, lang: Language, opts: { allowYarn: boolean }): Promise<Playback> {
  stopSpeaking();
  const spoken = nairaForSpeech(text);
  let note: string | null = null;
  if (opts.allowYarn && supabase && functionsUrl && navigator.onLine !== false) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`${functionsUrl}/tts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken, language: lang }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0) {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            const done = new Promise<void>((resolve) => {
              audio.onended = () => resolve();
              audio.onerror = () => resolve();
            });
            await audio.play();
            const pb: Playback = {
              source: 'yarngpt',
              done: done.finally(() => URL.revokeObjectURL(url)),
              stop: () => { audio.pause(); audio.currentTime = 0; },
              note: res.headers.get('x-voice-translated') ? 'Spoken translation by YarnGPT — check figures on screen.' : null,
            };
            current = pb;
            return pb;
          }
          note = 'YarnGPT returned no audio, using the device voice.';
        } else {
          const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          note = body?.error?.message ?? 'YarnGPT voice is unavailable, using the device voice.';
        }
      }
    } catch (e) {
      note = (e as Error).name === 'NotAllowedError' ? 'Tap the speaker to hear the reply (your browser blocked autoplay).' : 'YarnGPT voice is unavailable, using the device voice.';
    }
  } else if (!opts.allowYarn) {
    note = 'Demo uses the device voice. Sign in to hear YarnGPT voices.';
  }
  if (lang === 'yo' || lang === 'ig' || lang === 'ha') {
    note = (note ? note + ' ' : '') + 'The device voice reads in English.';
  }
  current = deviceSpeak(spoken, note);
  return current;
}
