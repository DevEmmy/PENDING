import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Language } from '../lib/types';
import { recognitionSupported, recognitionVerified, startLevelMeter, startRecognition, type RecognitionHandle } from './recognition';
import { useVoice, type ChatMessage } from './VoiceProvider';

type Phase = 'listening' | 'review' | 'processing' | 'reply' | 'error';

const BARS = 21;
const restingLevels = Array.from({ length: BARS }, (_, i) => 0.18 + 0.5 * Math.sin((i / (BARS - 1)) * Math.PI));

export function ListeningOverlay({ language, languageLabel, onClose, onOpenChat }: { language: Language; languageLabel: string; onClose: () => void; onOpenChat: () => void }) {
  const voice = useVoice();
  const supported = recognitionSupported();
  const [phase, setPhase] = useState<Phase>(supported ? 'listening' : 'review');
  const [transcript, setTranscript] = useState('');
  const [editing, setEditing] = useState(!supported);
  const [error, setError] = useState<string | null>(supported ? null : 'Voice input is not supported on this browser. Type what you want to say instead.');
  const [levels, setLevels] = useState<number[]>(restingLevels);
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const rec = useRef<RecognitionHandle | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  const stopAudio = () => {
    stopMeter.current?.();
    stopMeter.current = null;
  };

  const submit = useCallback(async (text: string, mode: 'voice' | 'text') => {
    if (!text.trim()) return;
    setPhase('processing');
    setEditing(false);
    const msg = await voice.send(text, mode);
    setReply(msg);
    setPhase('reply');
  }, [voice]);

  const listen = useCallback(() => {
    voice.stopSpeaking();
    setError(null);
    setTranscript('');
    setReply(null);
    setEditing(false);
    setPhase('listening');
    const handle = startRecognition(language, {
      onInterim: (t) => setTranscript(t),
      onFinal: (t) => { setTranscript(t); stopAudio(); void submit(t, 'voice'); },
      onError: (message) => { stopAudio(); setError(message); setPhase('error'); },
      onEnd: () => { stopAudio(); setPhase((p) => (p === 'listening' ? 'review' : p)); },
    });
    rec.current = handle;
    if (!handle) { setPhase('error'); setError('Voice input could not start. Type instead.'); return; }
    void startLevelMeter(setLevels, BARS).then((stop) => { stopMeter.current = stop; });
  }, [language, submit, voice]);

  useEffect(() => {
    restore.current = document.activeElement as HTMLElement;
    if (supported) listen();
    return () => {
      rec.current?.abort();
      stopAudio();
      restore.current?.focus?.();
    };
    // run once on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    rec.current?.abort();
    stopAudio();
    voice.stopSpeaking();
    onClose();
  };

  // Keep the overlay's reply in sync with the latest bot message (e.g. after Confirm)
  const latest = voice.lastBot;
  const shown = reply && latest && latest.at >= reply.at ? latest : reply;
  const awaiting = shown?.confirm && shown.pending;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab' && dialog.current) {
      const f = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),textarea,input'));
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };

  const listening = phase === 'listening';
  const verified = recognitionVerified(language);

  return createPortal(
    <div className="listen-screen on-dark" role="dialog" aria-modal="true" aria-label="Talk to Vendora" ref={dialog} onKeyDown={onKeyDown}>
      <div className="listen-top">
        <button className="icon-btn on-dark" onClick={close} aria-label="Close voice assistant">✕</button>
        <button className="btn btn-on-dark btn-sm" onClick={() => { close(); onOpenChat(); }}>Open chat</button>
      </div>

      <div className="listen-head" aria-live="polite">
        <h2 className="listen-title">
          {listening ? 'Vendora is listening…' : phase === 'processing' ? 'Working on it…' : phase === 'reply' ? 'Vendora' : 'Talk to Vendora'}
        </h2>
        <span className="lang-pill"><span aria-hidden="true">🌐</span> {languageLabel}</span>
      </div>

      <div className={`waveform ${listening ? 'live' : ''}`} aria-hidden="true">
        {levels.map((l, i) => (
          <span key={i} className={i >= 7 && i <= 13 ? 'bar accent' : 'bar'} style={{ transform: `scaleY(${listening ? l : restingLevels[i] * 0.35})` }} />
        ))}
      </div>
      {listening && <p className="sr-only" role="status">Microphone is on. Speak now.</p>}

      <div className="listen-body">
        {(transcript || editing) && (
          <div className="said-card">
            <div className="said-label">You said:</div>
            {editing ? (
              <form onSubmit={(e) => { e.preventDefault(); void submit(transcript, supported ? 'voice' : 'text'); }} className="stack-sm">
                <label className="sr-only" htmlFor="edit-transcript">Edit what you said</label>
                <textarea id="edit-transcript" className="textarea said-edit" value={transcript} onChange={(e) => setTranscript(e.target.value)}
                  placeholder='e.g. "I sold 2 bags of rice"' autoFocus rows={2} />
                <div className="row">
                  <button type="submit" className="btn btn-yellow btn-sm" disabled={!transcript.trim()}>Send</button>
                  {supported && <button type="button" className="btn btn-on-dark btn-sm" onClick={listen}>Speak again</button>}
                </div>
              </form>
            ) : (
              <>
                <p className={`said-text ${listening ? 'interim' : ''}`}>“{transcript}”</p>
                <div className="said-meta">
                  Language: {languageLabel} (your setting){!verified && ' · voice recognition for this language is experimental — check the words'}
                </div>
                {!listening && phase !== 'processing' && (
                  <button className="link-on-dark" onClick={() => setEditing(true)}>✏️ Not right? Edit the words</button>
                )}
              </>
            )}
          </div>
        )}

        {phase === 'processing' && (
          <div className="processing-pill" role="status"><span className="spinner" aria-hidden="true" /> Processing your update…</div>
        )}
        {error && <div className="alert alert-error" role="alert">{error}</div>}

        {phase === 'reply' && shown && (
          <div className={`reply-card ${shown.result ? `reply-${shown.result}` : awaiting ? 'reply-confirm' : ''}`} role="status" aria-live="polite">
            {shown.result === 'done' && <div className="reply-title">✅ Done!</div>}
            {shown.result === 'queued' && <div className="reply-title">⏳ Saved on this phone</div>}
            {shown.result === 'failed' && <div className="reply-title">⚠️ Not saved</div>}
            {awaiting && shown.confirm && <div className="reply-title">{shown.confirm.title}</div>}
            <p>{shown.text}</p>
            {awaiting && shown.confirm && (
              <>
                <dl className="confirm-lines">
                  {shown.confirm.lines.map((l) => (<div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>))}
                  {shown.confirm.total && <div className="total"><dt>Total</dt><dd>{shown.confirm.total}</dd></div>}
                </dl>
                {shown.confirm.warning && <div className="alert alert-warning">{shown.confirm.warning}</div>}
                <div className="row">
                  <button className="btn btn-success grow" onClick={() => { setPhase('processing'); void voice.confirm().then(() => setPhase('reply')); }} disabled={voice.executing}>
                    ✓ {shown.confirm.confirmLabel}
                  </button>
                  <button className="btn btn-on-dark" onClick={() => void voice.cancel()} disabled={voice.executing}>✕ Cancel</button>
                </div>
              </>
            )}
            {shown.suggestions && !awaiting && (
              <div className="chip-row">
                {shown.suggestions.map((s) => <button key={s} className="chip on-dark" onClick={() => void submit(s, 'text')}>{s}</button>)}
              </div>
            )}
            {shown.voiceNote && <div className="xs" style={{ opacity: 0.8 }}>{shown.voiceNote}</div>}
            <div className="row">
              {voice.speaking ? (
                <button className="link-on-dark" onClick={voice.stopSpeaking}>⏹ Stop speaking</button>
              ) : (
                <button className="link-on-dark" onClick={() => voice.replay(shown.text)}>🔊 Play again</button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="listen-bottom">
        {supported ? (
          <button
            className={`mic-big ${listening ? 'recording' : ''}`}
            onClick={() => (listening ? rec.current?.stop() : listen())}
            aria-label={listening ? 'Stop listening' : 'Tap to speak'}
            aria-pressed={listening}
            disabled={phase === 'processing'}
          >
            <span aria-hidden="true">🎙️</span>
          </button>
        ) : null}
        <div className="listen-hint">{listening ? 'Tap the mic when you finish' : supported ? 'Tap the mic to speak' : ''}</div>
        {!editing && phase !== 'processing' && (
          <button className="link-on-dark" onClick={() => { rec.current?.abort(); stopAudio(); setEditing(true); setPhase('review'); }}>⌨️ Type instead</button>
        )}
      </div>
    </div>,
    document.body,
  );
}
