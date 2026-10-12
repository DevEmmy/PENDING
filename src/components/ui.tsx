import {
  forwardRef, useCallback, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { naira, nairaCompact } from '../lib/format';
import { stockStatus, type Product } from '../lib/types';

/* ---------------- Button ---------------- */
type Variant = 'primary' | 'cta' | 'secondary' | 'ghost' | 'success' | 'danger' | 'danger-solid' | 'yellow' | 'on-dark';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  loadingText?: string;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, loading, loadingText, className = '', children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} ${size !== 'md' ? `btn-${size}` : ''} ${block ? 'btn-block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <><span className="spinner" aria-hidden="true" /> {loadingText ?? children}</> : children}
    </button>
  );
});

/* ---------------- Form fields ---------------- */
interface FieldProps {
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}
export function Field({ label, required, optional, help, error, children }: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden="true">*</span>}
        {optional && <span className="opt"> (optional)</span>}
      </label>
      {children({ id, describedBy: [helpId, errId].filter(Boolean).join(' ') || undefined, invalid: Boolean(error) })}
      {help && !error && <div className="help" id={helpId}>{help}</div>}
      {error && <div className="field-error" id={errId} role="alert"><span aria-hidden="true">⚠</span>{error}</div>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { prefixIcon?: ReactNode }>(function Input(
  { prefixIcon, className = '', ...rest }, ref,
) {
  if (!prefixIcon) return <input ref={ref} className={`input ${className}`} {...rest} />;
  return (
    <div className="input-wrap">
      <span className="prefix" aria-hidden="true">{prefixIcon}</span>
      <input ref={ref} className={`input ${className}`} {...rest} />
    </div>
  );
});

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`select ${className}`} {...rest}>{children}</select>;
}
export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

/** Money input that accepts "35000", "35,000" or "35k". */
export function parseMoney(v: string): number | null {
  const s = v.trim().toLowerCase().replace(/[₦,\s]/g, '');
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d{1,2})?)(k|m)?$/);
  if (!m) return NaN;
  const n = Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1);
  return Math.round(n * 100) / 100;
}
export function parseWhole(v: string): number | null {
  const s = v.trim().replace(/,/g, '');
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/* ---------------- Badges ---------------- */
export function Badge({ tone = 'neutral', children }: { tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'yellow'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StockBadge({ product }: { product: Pick<Product, 'stock_quantity' | 'low_stock_threshold'> }) {
  const s = stockStatus(product);
  if (s === 'out') return <Badge tone="danger"><span aria-hidden="true">●</span> Out of stock</Badge>;
  if (s === 'low') return <Badge tone="warning"><span aria-hidden="true">▲</span> Low stock</Badge>;
  return <Badge tone="success"><span aria-hidden="true">✓</span> In stock</Badge>;
}

/* ---------------- Feedback states ---------------- */
export function Skeleton({ height = 64, width = '100%', radius }: { height?: number; width?: number | string; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}
export function SkeletonList({ rows = 4, height = 64 }: { rows?: number; height?: number }) {
  return (
    <div className="list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={height} radius={18} />)}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert">
      <span aria-hidden="true">⚠️</span>
      <div className="grow">
        <div>{message}</div>
        {onRetry && <Button variant="danger" size="sm" onClick={onRetry} style={{ marginTop: 8 }}>Try again</Button>}
      </div>
    </div>
  );
}

/* ---------------- Animated number ---------------- */
export function AnimatedNaira({ value, className, compactFrom }: { value: number; className?: string; compactFrom?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from.current === value) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  const text = compactFrom !== undefined && Math.abs(value) >= compactFrom ? nairaCompact(shown) : naira(shown);
  return (
    <span className={`tabular ${className ?? ''}`} title={naira(value)}>
      <span className="sr-only">{naira(value)}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

/* ---------------- Sheet (modal / bottom sheet) ---------------- */
interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Ask before closing (unsaved input) */
  confirmClose?: () => boolean;
  dismissible?: boolean;
}
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, description, children, footer, confirmClose, dismissible = true }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (open) {
      restoreTo.current = document.activeElement as HTMLElement;
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => { setMounted(false); setClosing(false); restoreTo.current?.focus?.(); }, 200);
      return () => clearTimeout(t);
    }
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted || closing) return;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [mounted, closing]);

  const requestClose = useCallback(() => {
    if (!dismissible) return;
    if (confirmClose && !confirmClose()) return;
    onClose();
  }, [confirmClose, dismissible, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
    if (e.key === 'Tab' && panel.current) {
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div className={`backdrop ${closing ? 'closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={panel} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} onKeyDown={onKeyDown}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="stack-sm">
            <h2 id={titleId}>{title}</h2>
            {description && <div id={descId} className="muted small">{description}</div>}
          </div>
          {dismissible && <button className="icon-btn" onClick={requestClose} aria-label="Close">✕</button>}
        </div>
        {children}
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Confirm dialog ---------------- */
export function ConfirmDialog({
  open, title, children, confirmLabel, tone = 'primary', busy, onConfirm, onCancel,
}: { open: boolean; title: string; children: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Sheet open={open} onClose={onCancel} title={title} dismissible={!busy}
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={tone === 'danger' ? 'danger-solid' : 'primary'} onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
      </>}>
      <div className="stack">{children}</div>
    </Sheet>
  );
}

/* ---------------- Tabs ---------------- */
export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          role="tab"
          className="tab"
          aria-selected={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = (i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
            onChange(options[next].value);
            refs.current[next]?.focus();
          }}
        >
          {o.label}{o.count !== undefined ? ` (${o.count})` : ''}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Page header ---------------- */
export function PageHeader({ title, subtitle, eyebrow, actions, overlap, children }: { title: string; subtitle?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; overlap?: boolean; children?: ReactNode }) {
  return (
    <header className={`page-header ${overlap ? 'overlap' : ''}`}>
      <div className="page-header-inner stack">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="stack-sm" style={{ gap: 2 }}>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h1>{title}</h1>
            {subtitle && <div className="subtitle">{subtitle}</div>}
          </div>
          {actions}
        </div>
        {children}
      </div>
    </header>
  );
}
