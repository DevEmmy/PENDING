import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}
interface ToastApi {
  show(kind: ToastKind, message: string, opts?: { action?: Toast['action']; durationMs?: number }): void;
  success(message: string): void;
  error(message: string, action?: Toast['action']): void;
  info(message: string): void;
}

const Ctx = createContext<ToastApi | null>(null);
const ICON: Record<ToastKind, string> = { success: '✅', error: '⚠️', info: 'ℹ️', warning: '⏳' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback<ToastApi['show']>((kind, message, opts = {}) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, kind, message, action: opts.action }]);
    // Errors stay longer: people need time to read what went wrong and what to do.
    setTimeout(() => dismiss(id), opts.durationMs ?? (kind === 'error' ? 8000 : 4500));
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({
    show,
    success: (m) => show('success', m),
    error: (m, action) => show('error', m, { action }),
    info: (m) => show('info', m),
  }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} aria-live={t.kind === 'error' ? 'assertive' : 'polite'}>
            <span aria-hidden="true">{ICON[t.kind]}</span>
            <span className="grow">{t.message}</span>
            {t.action && (
              <button className="toast-action" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>
            )}
            <button className="toast-action" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside provider');
  return v;
}
