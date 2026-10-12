import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button, ErrorState, SkeletonList } from '../../components/ui';
import {
  getAdvert, getVendorProfile, listInbox, listMessages, markRead, sendMessage, subscribeMessages,
  type Advert, type Message, type VendorProfile,
} from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { formatDate, formatTime, initials } from '../../lib/format';
import { newId } from '../../lib/ids';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/auth';
import { useWorkspace } from '../../state/workspace';
import { HubGate, priceText, VerificationBadge } from './common';

export default function Conversation() {
  return <HubGate><Thread /></HubGate>;
}

type Local = Message & { state: 'sending' | 'sent' | 'failed'; error?: string };

function Thread() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const ws = useWorkspace();
  const auth = useAuth();
  const me = ws.business!.id;
  const [msgs, setMsgs] = useState<Local[]>([]);
  const [other, setOther] = useState<VendorProfile | null>(null);
  const [advert, setAdvert] = useState<Advert | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [live, setLive] = useState<'connecting' | 'live' | 'polling'>('connecting');
  const [hasOlder, setHasOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const merge = useCallback((incoming: Message[]) => {
    setMsgs((cur) => {
      const byClient = new Map(cur.map((m) => [m.client_msg_id, m]));
      for (const m of incoming) byClient.set(m.client_msg_id, { ...m, state: 'sent' });
      return [...byClient.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }, []);

  const nearBottom = () => {
    const el = document.scrollingElement;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const [rows, inbox] = await Promise.all([listMessages(id), listInbox(me)]);
        if (!active) return;
        merge(rows);
        setHasOlder(rows.length === 40);
        const conv = inbox.find((c) => c.id === id);
        if (!conv) { setError('This conversation was not found.'); return; }
        setOther(conv.other ?? (await getVendorProfile(conv.other_business_id)));
        const advertId = params.get('advert') ?? conv.advert_id;
        if (advertId) getAdvert(advertId).then((d) => active && setAdvert(d?.advert ?? null)).catch(() => {});
        void markRead(id, me);
      } catch (e) {
        if (active) setError(toAppError(e).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id, me, merge, params]);

  // Realtime when available; otherwise poll and say so (no fake "live" indicator).
  useEffect(() => {
    if (!supabase) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const ch = subscribeMessages(id, (m) => {
      const atBottom = nearBottom();
      merge([m]);
      if (m.sender_business_id !== me) { void markRead(id, me); if (!atBottom) setNewBelow(true); }
    }, (status) => {
      if (status === 'SUBSCRIBED') { setLive('live'); if (poll) { clearInterval(poll); poll = null; } }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setLive('polling');
        if (!poll) poll = setInterval(() => { listMessages(id).then(merge).catch(() => {}); }, 15000);
      }
    });
    const fallback = setTimeout(() => setLive((l) => {
      if (l === 'connecting') { poll = setInterval(() => { listMessages(id).then(merge).catch(() => {}); }, 15000); return 'polling'; }
      return l;
    }), 8000);
    return () => { clearTimeout(fallback); if (poll) clearInterval(poll); void supabase?.removeChannel(ch); };
  }, [id, me, merge]);

  useEffect(() => {
    if (nearBottom()) endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length]);

  const send = async (body: string, clientMsgId = `m-${newId()}`) => {
    const optimistic: Local = { id: clientMsgId, conversation_id: id, sender_business_id: me, sender_user_id: auth.user!.id, body, client_msg_id: clientMsgId, created_at: new Date().toISOString(), state: 'sending' };
    setMsgs((cur) => [...cur.filter((m) => m.client_msg_id !== clientMsgId), optimistic]);
    setTimeout(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 0);
    try {
      const saved = await sendMessage(id, me, auth.user!.id, body, clientMsgId);
      merge([saved]);
    } catch (e) {
      const err = toAppError(e).message;
      setMsgs((cur) => cur.map((m) => (m.client_msg_id === clientMsgId ? { ...m, state: 'failed', error: err } : m)));
    }
  };

  const loadOlder = async () => {
    const oldest = msgs[0]?.created_at;
    const before = logRef.current?.scrollHeight ?? 0;
    const rows = await listMessages(id, oldest);
    setHasOlder(rows.length === 40);
    merge(rows);
    requestAnimationFrame(() => window.scrollBy(0, (logRef.current?.scrollHeight ?? 0) - before));
  };

  let lastDay = '';
  return (
    <div className="chat-page">
      <header className="chat-header on-dark">
        <Link to="/hub/messages" className="icon-btn on-dark" aria-label="Back to messages">←</Link>
        <span className="avatar" aria-hidden="true">{initials(other?.display_name ?? 'V')}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18 }}>{other ? <Link to={`/hub/vendors/${other.business_id}`} style={{ color: '#fff' }}>{other.display_name}</Link> : 'Conversation'}</h1>
          <div className="xs" style={{ color: 'var(--on-dark-muted)' }}>
            {other && <VerificationBadge status={other.verification_status} compact />}{' '}
            {live === 'live' ? 'New messages appear instantly' : live === 'polling' ? 'Live updates unavailable — checking every 15 seconds' : 'Connecting…'}
          </div>
        </div>
      </header>
      {advert && (
        <div style={{ padding: '12px 16px 0', maxWidth: 820, margin: '0 auto', width: '100%' }}>
          <Link to={`/hub/adverts/${advert.id}`} className="context-chip">📣 About: <strong>{advert.headline}</strong> · {priceText(advert)}</Link>
        </div>
      )}
      <div className="thread" ref={logRef} role="log" aria-live="polite" aria-label="Messages">
        {error && <ErrorState message={error} />}
        {loading ? <SkeletonList rows={4} height={48} /> : (
          <>
            {hasOlder && <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>Load earlier messages</Button>}
            {msgs.length === 0 && !error && <p className="muted small center">Say hello 👋 — ask about price, quantity or delivery.</p>}
            {msgs.map((m) => {
              const mine = m.sender_business_id === me;
              const day = formatDate(m.created_at);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <div key={m.client_msg_id}>
                  {showDay && <div className="xs muted center" style={{ margin: '8px 0' }}>{day}</div>}
                  <div className={`msg ${mine ? 'user' : 'bot'}`}>
                    <div style={{ maxWidth: 'min(82%, 560px)' }}>
                      <div className="bubble" style={m.state === 'failed' ? { opacity: 0.7 } : undefined}>{m.body}</div>
                      <div className="msg-status" style={{ textAlign: mine ? 'right' : 'left' }}>
                        {formatTime(m.created_at)}
                        {mine && m.state === 'sending' && ' · Sending…'}
                        {mine && m.state === 'sent' && ' · Sent'}
                        {mine && m.state === 'failed' && (
                          <span className="text-danger"> · Not sent ({m.error}) <button className="btn btn-ghost btn-sm" onClick={() => void send(m.body, m.client_msg_id)}>Retry</button></span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
        {newBelow && <button className="new-msg-pill" onClick={() => { setNewBelow(false); endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }}>↓ New message</button>}
        <div ref={endRef} style={{ scrollMarginBottom: 'calc(var(--nav-height) + 96px)' }} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(''); void send(t); }}>
        <div className="composer-inner">
          <label htmlFor="msg-input" className="sr-only">Write a message</label>
          <input id="msg-input" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" maxLength={2000} autoComplete="off" enterKeyHint="send" disabled={Boolean(error)} />
          <button type="submit" className="round-btn send" disabled={!text.trim() || Boolean(error)} aria-label="Send message"><span aria-hidden="true">➜</span></button>
        </div>
      </form>
    </div>
  );
}
