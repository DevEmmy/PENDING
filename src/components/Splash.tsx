export function Splash({ label = 'Loading Vendora…' }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-logo" aria-hidden="true">🛒</div>
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
