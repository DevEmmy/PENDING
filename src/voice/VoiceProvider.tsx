import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { cardFor, handle, initialState, type ConfirmCard, type Draft, type EngineState } from '../assistant/engine';
import { executeDraft } from '../assistant/executor';
import { newId, newOpId } from '../lib/ids';
import { LANGUAGES, type DashboardSummary } from '../lib/types';
import { useWorkspace } from '../state/workspace';
import { ListeningOverlay } from './ListeningOverlay';
import { speak, stopSpeaking, type VoiceSource } from './speech';

export interface ChatMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
  at: string;
  inputMode?: 'voice' | 'text';
  confirm?: ConfirmCard;
  /** for bot messages that executed something */
  result?: 'done' | 'failed' | 'queued';
  /** confirmation still open? */
  pending?: boolean;
  suggestions?: string[];
  voiceNote?: string | null;
}

interface AssistantApi {
  messages: ChatMessage[];
  busy: boolean;
  executing: boolean;
  awaitingConfirm: boolean;
  speaking: VoiceSource | null;
  voiceReplies: boolean;
  setVoiceReplies(v: boolean): void;
  send(text: string, inputMode: 'voice' | 'text'): Promise<ChatMessage | null>;
  confirm(): Promise<ChatMessage | null>;
  cancel(): Promise<void>;
  replay(text: string): void;
  stopSpeaking(): void;
  clear(): void;
  open(): void;
  lastBot: ChatMessage | null;
}

const Ctx = createContext<AssistantApi | null>(null);
const VOICE_KEY = 'vendora.voiceReplies';

export function VoiceProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const storeKey = ws.business ? `vendora.chat.${ws.business.id}` : null;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [engine, setEngine] = useState<EngineState>(initialState);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [speaking, setSpeaking] = useState<VoiceSource | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [voiceReplies, setVoiceRepliesState] = useState(() => {
    try { return localStorage.getItem(VOICE_KEY) !== 'off'; } catch { return true; }
  });
  const opIdRef = useRef<string | null>(null);
  const dashCache = useRef<{ at: number; data: DashboardSummary } | null>(null);

  // Restore this business's recent conversation (this tab only).
  useEffect(() => {
    if (!storeKey) { setMessages([]); return; }
    try {
      const raw = sessionStorage.getItem(storeKey);
      setMessages(raw ? (JSON.parse(raw) as ChatMessage[]).map((m) => ({ ...m, pending: false })) : []);
    } catch { setMessages([]); }
    setEngine(initialState);
  }, [storeKey]);
  useEffect(() => {
    if (!storeKey) return;
    try { sessionStorage.setItem(storeKey, JSON.stringify(messages.slice(-60))); } catch { /* ignore */ }
  }, [messages, storeKey]);
  useEffect(() => { dashCache.current = null; }, [ws.versions.sales, ws.versions.products, ws.versions.dashboard]);

  const say = useCallback(async (text: string, inputMode: 'voice' | 'text'): Promise<string | null> => {
    if (!voiceReplies || (inputMode === 'text' && !overlayOpen)) return null;
    const pb = await speak(text, ws.language, { allowYarn: ws.mode === 'live' });
    setSpeaking(pb.source);
    void pb.done.then(() => setSpeaking(null));
    return pb.note;
  }, [voiceReplies, overlayOpen, ws.language, ws.mode]);

  const push = (m: Omit<ChatMessage, 'id' | 'at'>): ChatMessage => {
    const msg = { ...m, id: newId(), at: new Date().toISOString() };
    setMessages((list) => [...list.map((x) => (x.pending && m.role === 'bot' ? { ...x, pending: false } : x)), msg]);
    return msg;
  };

  const runExecute = useCallback(async (draft: Draft, inputMode: 'voice' | 'text'): Promise<ChatMessage | null> => {
    if (!ws.api) return null;
    setExecuting(true);
    const opId = opIdRef.current ?? newOpId('voice');
    opIdRef.current = opId;
    try {
      const r = await executeDraft(draft, ws.api, ws.language, opId);
      opIdRef.current = r.ok ? null : opIdRef.current; // retry of a failed attempt reuses the op id
      if (r.changed.length) ws.invalidate(...r.changed);
      const msg = push({ role: 'bot', text: r.reply, result: r.queued ? 'queued' : r.ok ? 'done' : 'failed' });
      void ws.api.logVoice({ language: ws.language, inputMode, intent: draft.kind, outcome: r.ok ? 'executed' : 'failed' }).catch(() => {});
      const note = await say(r.reply, inputMode);
      if (note) setMessages((l) => l.map((x) => (x.id === msg.id ? { ...x, voiceNote: note } : x)));
      return msg;
    } finally {
      setExecuting(false);
    }
  }, [ws, say]);

  const send = useCallback(async (raw: string, inputMode: 'voice' | 'text'): Promise<ChatMessage | null> => {
    const text = raw.trim();
    if (!text || !ws.api || busy || executing) return null;
    stopSpeaking();
    setSpeaking(null);
    push({ role: 'user', text, inputMode });
    setBusy(true);
    try {
      const api = ws.api;
      const turn = await handle(text, engine, {
        products: ws.products,
        customers: ws.customers,
        language: ws.language,
        getDashboard: async () => {
          if (dashCache.current && Date.now() - dashCache.current.at < 30000) return dashCache.current.data;
          const data = await api.dashboard();
          dashCache.current = { at: Date.now(), data };
          return data;
        },
      });
      setEngine(turn.state);
      if (turn.execute) {
        push({ role: 'bot', text: turn.reply });
        return await runExecute(turn.execute, inputMode);
      }
      if (turn.confirm) opIdRef.current = newOpId('voice'); // one op id per confirmation card
      const msg = push({ role: 'bot', text: turn.reply, confirm: turn.confirm, pending: Boolean(turn.confirm), suggestions: turn.suggestions });
      if (turn.outcome !== 'ready') void api.logVoice({ language: ws.language, inputMode, intent: turn.intent, outcome: turn.outcome === 'failed' ? 'failed' : turn.outcome }).catch(() => {});
      if (turn.navigate) setTimeout(() => { setOverlayOpen(false); navigate(turn.navigate!); }, 900);
      const note = await say(turn.reply, inputMode);
      if (note) setMessages((l) => l.map((x) => (x.id === msg.id ? { ...x, voiceNote: note } : x)));
      return msg;
    } catch {
      const msg = push({ role: 'bot', text: 'I could not get that information right now. Check your connection and try again.', result: 'failed' });
      return msg;
    } finally {
      setBusy(false);
    }
  }, [ws, busy, executing, engine, runExecute, say, navigate]);

  const confirm = useCallback(async () => {
    if (!engine.draft || engine.awaiting !== 'confirm') return null;
    const draft = engine.draft;
    setEngine(initialState);
    setMessages((l) => l.map((x) => (x.pending ? { ...x, pending: false } : x)));
    push({ role: 'user', text: 'Yes, confirm', inputMode: 'text' });
    return runExecute(draft, 'text');
  }, [engine, runExecute]);

  const cancel = useCallback(async () => {
    if (!engine.draft && !engine.choice) return;
    await send('cancel', 'text');
  }, [engine, send]);

  const value = useMemo<AssistantApi>(() => ({
    messages, busy, executing,
    awaitingConfirm: engine.awaiting === 'confirm',
    speaking,
    voiceReplies,
    setVoiceReplies(v) {
      setVoiceRepliesState(v);
      try { localStorage.setItem(VOICE_KEY, v ? 'on' : 'off'); } catch { /* ignore */ }
      if (!v) stopSpeaking();
    },
    send, confirm, cancel,
    replay(text) {
      void speak(text, ws.language, { allowYarn: ws.mode === 'live' }).then((pb) => { setSpeaking(pb.source); void pb.done.then(() => setSpeaking(null)); });
    },
    stopSpeaking() { stopSpeaking(); setSpeaking(null); },
    clear() { setMessages([]); setEngine(initialState); opIdRef.current = null; },
    open() { setOverlayOpen(true); },
    lastBot: [...messages].reverse().find((m) => m.role === 'bot') ?? null,
  }), [messages, busy, executing, engine.awaiting, speaking, voiceReplies, send, confirm, cancel, ws.language, ws.mode]);

  const langLabel = LANGUAGES.find((l) => l.code === ws.language)?.label ?? 'English';
  return (
    <Ctx.Provider value={value}>
      {children}
      {overlayOpen && ws.api && (
        <ListeningOverlay
          languageLabel={langLabel}
          language={ws.language}
          onClose={() => { setOverlayOpen(false); }}
          onOpenChat={() => { setOverlayOpen(false); navigate('/chat'); }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useVoice(): AssistantApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVoice outside provider');
  return v;
}

export { cardFor };
