// MOCKED provider tests: these verify request construction and error handling against the
// documented contract. They do NOT prove the live YarnGPT API works (no API key in CI).
import { describe, expect, it, vi } from 'vitest';
import { clientErrorFor, listVoices, synthesize, targetLanguageFor, YarnGptError } from './yarngpt';

const cfg = { apiKey: 'sk_live_test.secret', baseUrl: 'https://yarngpt.ai/', defaultVoice: null };

function audioResponse(bytes: number, headers: Record<string, string> = { 'content-type': 'audio/mpeg' }) {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

describe('YarnGPT adapter (mocked)', () => {
  it('posts the documented body and auth header to the streaming endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(audioResponse(512, { 'content-type': 'audio/mpeg', 'x-synthesis-warning': 'pronunciation' }));
    const r = await synthesize(cfg, { text: '  Your sale has been recorded.  ', targetLanguage: 'yo', idempotencyKey: 'k1' }, fetchMock);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://yarngpt.ai/api/v1/streaming/conversation');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_live_test.secret');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(init.body)).toEqual({ text: 'Your sale has been recorded.', output_format: 'mp3', target_language: 'yo' });
    expect(r.audio.byteLength).toBe(512);
    expect(r.warning).toBe('pronunciation');
  });

  it('omits voice so the provider default applies, but sends an explicit voice when given', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => audioResponse(10));
    await synthesize(cfg, { text: 'hi' }, fetchMock);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('voice');
    await synthesize({ ...cfg, defaultVoice: 'umar' }, { text: 'hi' }, fetchMock);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).voice).toBe('umar');
  });

  it('treats a 200 with zero bytes as an outage', async () => {
    await expect(synthesize(cfg, { text: 'hi' }, vi.fn().mockResolvedValue(audioResponse(0)))).rejects.toMatchObject({ code: 'EMPTY_AUDIO', status: 503 });
  });

  it('parses the documented error envelope', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED', message: 'Top up', service: 'tts', trace_id: 'tr-1', details: {} } }), { status: 402, headers: { 'content-type': 'application/json' } });
    const err = await synthesize(cfg, { text: 'hi' }, vi.fn().mockResolvedValue(res)).catch((e) => e);
    expect(err).toBeInstanceOf(YarnGptError);
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.traceId).toBe('tr-1');
    expect(clientErrorFor(err)).toMatchObject({ code: 'VOICE_QUOTA' });
  });

  it('maps rate limits and auth failures to safe client errors', async () => {
    const rl = await synthesize(cfg, { text: 'hi' }, vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '3' } }))).catch((e) => e);
    expect(rl.retryAfter).toBe(3);
    expect(clientErrorFor(rl).code).toBe('VOICE_BUSY');
    const auth = await synthesize(cfg, { text: 'hi' }, vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))).catch((e) => e);
    expect(clientErrorFor(auth)).toEqual({ status: 503, code: 'VOICE_NOT_CONFIGURED', message: expect.any(String) });
    expect(JSON.stringify(clientErrorFor(auth))).not.toContain('sk_live');
  });

  it('rejects empty and over-long text before calling the provider', async () => {
    const fetchMock = vi.fn();
    await expect(synthesize(cfg, { text: '   ' }, fetchMock)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(synthesize(cfg, { text: 'x'.repeat(5001) }, fetchMock)).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists voices with auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ name: 'umar', default: true }]), { status: 200 }));
    expect(await listVoices(cfg, fetchMock)).toEqual([{ name: 'umar', default: true }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://yarngpt.ai/api/v1/voices');
  });

  it('only translates for Yoruba, Igbo and Hausa', () => {
    expect(targetLanguageFor('yo')).toBe('yo');
    expect(targetLanguageFor('pcm')).toBeNull();
    expect(targetLanguageFor('en')).toBeNull();
  });
});
