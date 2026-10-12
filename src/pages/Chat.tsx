import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../lib/format';
import { useWorkspace } from '../state/workspace';
import { useVoice, type ChatMessage } from '../voice/VoiceProvider';

const STARTERS = ['How market today?', 'Which item slow today?', 'How much Indomie remain?', 'I sold 2 bags of rice'];

function BotBubble({ m, onConfirm, onCancel, busy }: { m: ChatMessage; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const voice = useVoice();
  const cls = m.result ? m.result : '';
  return (
    <div className="msg bot">
      <span className="bot-avatar" aria-hidden="true">V</span>
      <div style={{ maxWidth: 'min(82%, 560px)' }}>
        <div className={`bubble ${cls}`}>
          {m.result === 'done' && <span className="sr-only">Saved. </span>}
          {m.result === 'failed' && <strong>⚠️ Not saved. </strong>}
          {m.result === 'queued' && <strong>⏳ Waiting to sync. </strong>}
          {m.text}
          {m.confirm && (
            <div className="confirm-box">
              <strong>{m.confirm.title}</strong>
              <dl className="confirm-lines">
                {m.confirm.lines.map((l) => (<div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>))}
                {m.confirm.total && <div className="total"><dt>Total</dt><dd>{m.confirm.total}</dd></div>}
              </dl>
              {m.confirm.warning && <div className="alert alert-warning">{m.confirm.warning}</div>}
              {m.pending ? (
                <div className="row wrap">
                  <button className="btn btn-success btn-sm" onClick={onConfirm} disabled={busy} aria-busy={busy}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : '✓'} {m.confirm.confirmLabel}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
                </div>
              ) : <span className="xs muted">This confirmation is closed.</span>}
            </div>
          )}
        </div>
        <div className="msg-meta">
          <span>{formatTime(m.at)}</span>
          {voice.speaking ? null : <button onClick={() => voice.replay(m.text)} aria-label="Play this reply aloud">🔊 Play</button>}
          {m.voiceNote && <span>· {m.voiceNote}</span>}
        </div>
        {m.suggestions && !m.confirm && (
          <div className="chip-row" style={{ marginTop: 8 }}>
            {m.suggestions.map((s) => <button key={s} className="chip" onClick={() => void voice.send(s, 'text')} disabled={voice.busy}>{s}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Chat() {
  const ws = useWorkspace();
  const voice = useVoice();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' });
  }, [voice.messages.length, voice.busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    await voice.send(t, 'text');
    inputRef.current?.focus();
  };

  return (
    <div className="chat-page">
      <header className="chat-header on-dark">
        <span className="avatar" aria-hidden="true">V</span>
        <div className="grow">
          <h1 style={{ fontSize: 20 }}>Vendora AI</h1>
          <div className={`status ${ws.online ? '' : 'off'}`}>{ws.online ? 'Online · Ready to help' : 'Offline · sales will be saved on this phone'}</div>
        </div>
        <button className="icon-btn on-dark" onClick={() => voice.setVoiceReplies(!voice.voiceReplies)} aria-pressed={voice.voiceReplies}
          aria-label={voice.voiceReplies ? 'Spoken replies on (tap to turn off)' : 'Spoken replies off (tap to turn on)'} title="Spoken replies">
          {voice.voiceReplies ? '🔊' : '🔇'}
        </button>
        {voice.speaking && <button className="icon-btn on-dark" onClick={voice.stopSpeaking} aria-label="Stop speaking">⏹</button>}
        {voice.messages.length > 0 && <button className="icon-btn on-dark" onClick={voice.clear} aria-label="Clear conversation">🗑</button>}
      </header>

      <div className="chat-log" role="log" aria-live="polite" aria-label="Conversation with Vendora">
        {voice.messages.length === 0 && (
          <div className="msg bot">
            <span className="bot-avatar" aria-hidden="true">V</span>
            <div>
              <div className="bubble">
                {ws.language === 'pcm' ? 'How far! Na me be Vendora. Tell me wetin you sell, buy or wan know about your shop.' : "Hi! I'm Vendora. Tell me what you sold or bought, or ask about your shop."}
                <br /><span className="small muted">I'll always show you the details before saving anything.</span>
              </div>
              <div className="chip-row" style={{ marginTop: 8 }}>
                {STARTERS.map((s) => <button key={s} className="chip" onClick={() => void voice.send(s, 'text')}>{s}</button>)}
              </div>
            </div>
          </div>
        )}
        {voice.messages.map((m) => m.role === 'user' ? (
          <div key={m.id} className="msg user">
            <div>
              <div className="bubble">{m.text}</div>
              <div className="msg-meta" style={{ justifyContent: 'flex-end' }}>{m.inputMode === 'voice' && <span aria-label="spoken">🎙️</span>}{formatTime(m.at)}</div>
            </div>
          </div>
        ) : (
          <BotBubble key={m.id} m={m} busy={voice.executing} onConfirm={() => void voice.confirm()} onCancel={() => void voice.cancel()} />
        ))}
        {(voice.busy || voice.executing) && (
          <div className="msg bot" role="status">
            <span className="bot-avatar" aria-hidden="true">V</span>
            <div className="bubble"><span className="typing" aria-hidden="true"><span /><span /><span /></span><span className="sr-only">{voice.executing ? 'Saving…' : 'Vendora is thinking…'}</span></div>
          </div>
        )}
        <div ref={endRef} style={{ scrollMarginBottom: 'calc(var(--nav-height) + 96px)' }} />
      </div>

      <form className="composer" onSubmit={submit}>
        <div className="composer-inner">
          <button type="button" className="round-btn mic" onClick={() => voice.open()} aria-label="Speak to Vendora"><span aria-hidden="true">🎙️</span></button>
          <label htmlFor="chat-input" className="sr-only">Message Vendora</label>
          <input id="chat-input" ref={inputRef} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything or type a command…" autoComplete="off" enterKeyHint="send" />
          <button type="submit" className="round-btn send" disabled={!text.trim() || voice.busy || voice.executing} aria-label="Send message"><span aria-hidden="true">➜</span></button>
        </div>
      </form>
    </div>
  );
}
