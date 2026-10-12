/**
 * YarnGPT text-to-speech adapter (server-side only).
 * Contract per https://www.yarngpt.ai/get-started and https://yarngpt.ai/api-docs (checked 2026-10-12):
 *   base URL  https://yarngpt.ai
 *   auth      Authorization: Bearer sk_live_<id>.<secret>
 *   POST /api/v1/streaming/conversation  {text (1–5000 chars), voice?, output_format: pcm|wav|mp3, target_language?}
 *             → raw audio body; synthesis warnings in X-Synthesis-Warning; a provider outage can return 200 with 0 bytes
 *   GET  /api/v1/voices                  → catalogue; entry with default:true is the default voice
 *   errors    {"error":{"code","message","service","trace_id","details"}}
 * YarnGPT does NOT provide speech-to-text; recognition happens on the device.
 * target_language TRANSLATES the text before speaking (codes include yo, ig, ha, en).
 */

export interface YarnConfig {
  apiKey: string;
  baseUrl?: string;
  defaultVoice?: string | null;
}

export interface SynthesisRequest {
  text: string;
  voice?: string | null;
  targetLanguage?: 'yo' | 'ig' | 'ha' | 'en' | null;
  format?: 'mp3' | 'wav';
  idempotencyKey?: string;
}

export interface SynthesisResult {
  audio: ArrayBuffer;
  contentType: string;
  warning: string | null;
}

export class YarnGptError extends Error {
  constructor(public status: number, public code: string, message: string, public traceId: string | null, public retryAfter: number | null = null) {
    super(message);
    this.name = 'YarnGptError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_STREAM_CHARS = 5000;

async function toError(res: Response): Promise<YarnGptError> {
  let code = `HTTP_${res.status}`;
  let message = `YarnGPT request failed (${res.status})`;
  let traceId: string | null = null;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      traceId = body.error.trace_id ?? null;
    }
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) code = 'UNAUTHORIZED';
  const ra = res.headers.get('retry-after');
  return new YarnGptError(res.status, code, message, traceId, ra ? Number(ra) : null);
}

export async function synthesize(cfg: YarnConfig, req: SynthesisRequest, fetchImpl: FetchLike = fetch): Promise<SynthesisResult> {
  const text = req.text.trim();
  if (!text) throw new YarnGptError(400, 'INVALID_INPUT', 'Nothing to say', null);
  if (text.length > MAX_STREAM_CHARS) throw new YarnGptError(400, 'TEXT_TOO_LONG', 'Text is longer than the streaming limit', null);
  const body: Record<string, string> = { text, output_format: req.format ?? 'mp3' };
  const voice = req.voice ?? cfg.defaultVoice;
  if (voice) body.voice = voice; // omitted → provider default voice
  if (req.targetLanguage) body.target_language = req.targetLanguage;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;
  const res = await fetchImpl(`${(cfg.baseUrl ?? 'https://yarngpt.ai').replace(/\/$/, '')}/api/v1/streaming/conversation`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  const audio = await res.arrayBuffer();
  if (audio.byteLength === 0) {
    // Documented provider-outage behaviour: 200 with an empty body.
    throw new YarnGptError(503, 'EMPTY_AUDIO', 'YarnGPT returned no audio', null);
  }
  return {
    audio,
    contentType: res.headers.get('content-type') ?? (body.output_format === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    warning: res.headers.get('x-synthesis-warning'),
  };
}

export async function listVoices(cfg: YarnConfig, fetchImpl: FetchLike = fetch): Promise<unknown> {
  const res = await fetchImpl(`${(cfg.baseUrl ?? 'https://yarngpt.ai').replace(/\/$/, '')}/api/v1/voices`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** Which languages we send as target_language (spoken translation). en/pcm text is spoken as written. */
export function targetLanguageFor(appLanguage: string): 'yo' | 'ig' | 'ha' | null {
  return appLanguage === 'yo' || appLanguage === 'ig' || appLanguage === 'ha' ? appLanguage : null;
}

/** Map provider errors to a safe client response (never leaks the key or raw provider detail). */
export function clientErrorFor(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof YarnGptError) {
    if (e.code === 'RATE_LIMITED' || e.status === 429) return { status: 429, code: 'VOICE_BUSY', message: 'Voice is busy. Showing text only — try again in a moment.' };
    if (e.code === 'QUOTA_EXCEEDED' || e.status === 402) return { status: 503, code: 'VOICE_QUOTA', message: 'Voice credits are used up. Replies will show as text.' };
    if (e.status === 401 || e.status === 403) return { status: 503, code: 'VOICE_NOT_CONFIGURED', message: 'Voice is not set up correctly. Replies will show as text.' };
    if (e.code === 'TEXT_TOO_LONG' || e.code === 'INVALID_INPUT' || e.status === 422) return { status: 400, code: 'VOICE_BAD_INPUT', message: 'That reply could not be spoken.' };
    return { status: 502, code: 'VOICE_UNAVAILABLE', message: 'Voice is unavailable right now. Replies will show as text.' };
  }
  return { status: 502, code: 'VOICE_UNAVAILABLE', message: 'Voice is unavailable right now. Replies will show as text.' };
}
