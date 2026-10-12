import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '../../components/ui';
import { useAuth } from '../../state/auth';
import { AuthLayout } from './SignIn';

export function CheckEmail() {
  const auth = useAuth();
  const email = (useLocation().state as { email?: string } | null)?.email ?? '';
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  return (
    <AuthLayout title="Check your email" subtitle="One last step to protect your account.">
      <div className="stack">
        <p>We sent a confirmation link to <strong>{email || 'your email'}</strong>. Open it on this phone to finish setting up your shop.</p>
        <p className="muted small">Can't find it? Check spam or promotions. Your business details are saved and will be ready when you confirm.</p>
        {status === 'sent' && <div className="alert alert-success" role="status">✅ A new link is on its way.</div>}
        {status === 'error' && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        {email && (
          <Button variant="secondary" loading={status === 'sending'} onClick={async () => {
            setStatus('sending');
            try { await auth.resendConfirmation(email); setStatus('sent'); } catch (e) { setError((e as Error).message); setStatus('error'); }
          }}>Resend the link</Button>
        )}
        <Link to="/signin" className="center">Back to sign in</Link>
      </div>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthLayout title="Reset password" subtitle="We'll email you a link to choose a new password.">
      {state === 'sent' ? (
        <div className="stack">
          <div className="alert alert-success" role="status">✅ If an account uses {email}, a reset link is on its way. It expires in about an hour.</div>
          <Link to="/signin">Back to sign in</Link>
        </div>
      ) : (
        <form className="form" noValidate onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) { setError('Enter the email you signed up with.'); return; }
          setState('busy');
          try { await auth.requestPasswordReset(email); setState('sent'); } catch (err) { setError((err as Error).message); setState('idle'); }
        }}>
          <Field label="Email address" required error={error}>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} type="email" autoComplete="email" prefixIcon="✉️" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" size="lg" block loading={state === 'busy'}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!auth.loading && !auth.session) {
    return (
      <AuthLayout title="Link expired" subtitle="This reset link is no longer valid.">
        <div className="stack">
          <p>Reset links work once and expire after about an hour. Request a new one.</p>
          <Link to="/forgot-password">Send a new link</Link>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password">
      <form className="form" noValidate onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (pw.length < 8 || !/[a-z]/i.test(pw) || !/\d/.test(pw)) { setError('Use at least 8 characters with letters and numbers.'); return; }
        if (pw !== confirm) { setError('Passwords do not match.'); return; }
        setBusy(true);
        try { await auth.updatePassword(pw); navigate('/', { replace: true }); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}>
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        <Field label="New password" required>{({ id }) => <Input id={id} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <Field label="Confirm new password" required>{({ id }) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        <Button type="submit" size="lg" block loading={busy}>Save password</Button>
      </form>
    </AuthLayout>
  );
}
