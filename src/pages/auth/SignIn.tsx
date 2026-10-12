import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '../../components/ui';
import { useAuth } from '../../state/auth';

export function AuthLayout({ title, subtitle, step, onBack, children }: { title: string; subtitle?: string; step?: { n: number; of: number; label: string }; onBack?: () => void; children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="auth-page">
      <header className="auth-header on-dark">
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <button className="back" onClick={onBack ?? (() => navigate(-1))} aria-label="Go back">←</button>
          {step && (
            <>
              <div className="step-bar" aria-hidden="true">{Array.from({ length: step.of }, (_, i) => <span key={i} className={i < step.n ? 'on' : ''} />)}</div>
              <div className="step-label">Step {step.n} of {step.of} · {step.label}</div>
            </>
          )}
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </header>
      <div className="auth-card">
        <div className="card">{children}</div>
      </div>
    </div>
  );
}

export default function SignIn() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy(true);
    try {
      await auth.signIn(email, password);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your shop." onBack={() => navigate('/welcome')}>
      <form className="form" onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="Email address" required>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="email" autoComplete="email" inputMode="email" prefixIcon="✉️" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="yourname@email.com" />}
        </Field>
        <Field label="Password" required>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="password" autoComplete="current-password" prefixIcon="🔒" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Link to="/forgot-password" className="small">Forgot password?</Link>
        <Button type="submit" size="lg" block loading={busy} loadingText="Signing in…">Sign in →</Button>
        <p className="small center muted">New to Vendora? <Link to="/signup">Create an account</Link></p>
      </form>
    </AuthLayout>
  );
}
