// Supabase Edge Function: authenticated, rate-limited proxy to YarnGPT text-to-speech.
// The YarnGPT key lives only in this function's secrets (never in the browser bundle).
// Deploy: supabase functions deploy tts
// Secrets: supabase secrets set YARNGPT_API_KEY=... [YARNGPT_DEFAULT_VOICE=...] [YARNGPT_DAILY_LIMIT_PER_USER=60]
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clientErrorFor, listVoices, synthesize, targetLanguageFor } from '../_shared/yarngpt.ts';

const MAX_CHARS = 800;

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'x-synthesis-warning, x-voice-provider, x-voice-translated',
  Vary: 'Origin',
});

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });

  const apiKey = Deno.env.get('YARNGPT_API_KEY');
  if (!apiKey) return json(503, { error: { code: 'VOICE_NOT_CONFIGURED', message: 'Voice is not set up yet. Replies will show as text.' } }, origin);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(401, { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in again.' } }, origin);

  const cfg = { apiKey, baseUrl: Deno.env.get('YARNGPT_BASE_URL') ?? 'https://yarngpt.ai', defaultVoice: Deno.env.get('YARNGPT_DEFAULT_VOICE') || null };

  try {
    if (req.method === 'GET') {
      return json(200, { voices: await listVoices(cfg) }, origin);
    }
    if (req.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, origin);

    const body = await req.json().catch(() => null) as { text?: string; language?: string; voice?: string } | null;
    const text = (body?.text ?? '').toString().trim();
    if (!text || text.length > MAX_CHARS) return json(400, { error: { code: 'VOICE_BAD_INPUT', message: `Text must be 1–${MAX_CHARS} characters.` } }, origin);

    // Per-user daily cap, counted in the database with the service role.
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const limit = Number(Deno.env.get('YARNGPT_DAILY_LIMIT_PER_USER') ?? '60');
    const { data: allowed, error: usageError } = await admin.rpc('consume_tts_quota', { p_user_id: userData.user.id, p_chars: text.length, p_limit: limit });
    if (usageError) return json(503, { error: { code: 'VOICE_UNAVAILABLE', message: 'Voice is unavailable right now. Replies will show as text.' } }, origin);
    if (!allowed) return json(429, { error: { code: 'VOICE_DAILY_LIMIT', message: 'You have used today\'s voice replies. Replies will show as text until tomorrow.' } }, origin);

    const target = targetLanguageFor(body?.language ?? 'en');
    const result = await synthesize(cfg, { text, targetLanguage: target, voice: body?.voice || null, idempotencyKey: crypto.randomUUID() });
    const headers: Record<string, string> = { ...cors(origin), 'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'x-voice-provider': 'yarngpt' };
    if (result.warning) headers['x-synthesis-warning'] = result.warning;
    if (target) headers['x-voice-translated'] = target;
    return new Response(result.audio, { status: 200, headers });
  } catch (e) {
    const mapped = clientErrorFor(e);
    // Log only non-sensitive metadata (never the text or key).
    console.error('tts_error', { code: (e as { code?: string }).code, status: (e as { status?: number }).status, trace: (e as { traceId?: string }).traceId });
    return json(mapped.status, { error: { code: mapped.code, message: mapped.message } }, origin);
  }
});
