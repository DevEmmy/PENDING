import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Field, Input, Select } from '../../components/ui';
import { BUSINESS_CATEGORIES, LANGUAGES, type Language } from '../../lib/types';
import { useAuth } from '../../state/auth';
import { useWorkspace } from '../../state/workspace';
import { AuthLayout } from './SignIn';

interface Form {
  fullName: string;
  phone: string;
  email: string;
  businessName: string;
  category: string;
  market: string;
  password: string;
  confirm: string;
  language: Language;
}
type Errors = Partial<Record<keyof Form, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateStep1(f: Form): Errors {
  const e: Errors = {};
  if (f.fullName.trim().length < 2) e.fullName = 'Enter your full name.';
  const digits = f.phone.replace(/\D/g, '');
  if (digits && !/^0?[789][01]\d{8}$/.test(digits)) e.phone = 'Enter a Nigerian number like 080 1234 5678.';
  if (!EMAIL.test(f.email.trim())) e.email = 'Enter a valid email — you will use it to sign in.';
  if (f.businessName.trim().length < 2) e.businessName = 'Enter your business name.';
  if (!f.category) e.category = 'Choose what you sell.';
  return e;
}
export function validateStep2(f: Form): Errors {
  const e: Errors = {};
  if (f.password.length < 8 || !/[a-z]/i.test(f.password) || !/\d/.test(f.password)) e.password = 'Use at least 8 characters with letters and numbers.';
  if (f.confirm !== f.password) e.confirm = 'Passwords do not match.';
  return e;
}

export default function SignUp() {
  const auth = useAuth();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [f, setF] = useState<Form>({ fullName: '', phone: '', email: '', businessName: '', category: '', market: '', password: '', confirm: '', language: ws.language });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const focusFirstError = (errs: Errors) => {
    const first = Object.keys(errs)[0];
    if (first) setTimeout(() => document.querySelector<HTMLElement>(`[name="${first}"]`)?.focus(), 0);
  };

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateStep1(f);
    setErrors(errs);
    if (Object.keys(errs).length) { focusFirstError(errs); return; }
    setStep(2);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errs = validateStep2(f);
    setErrors(errs);
    if (Object.keys(errs).length) { focusFirstError(errs); return; }
    setBusy(true);
    try {
      await ws.setLanguage(f.language);
      const { needsConfirmation } = await auth.signUp({
        fullName: f.fullName, email: f.email, password: f.password, phone: f.phone, language: f.language,
        business: { name: f.businessName.trim(), category: f.category, market_area: f.market.trim(), city: '' },
      });
      if (needsConfirmation) navigate('/check-email', { replace: true, state: { email: f.email.trim() } });
      else navigate('/onboarding', { replace: true });
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 2) {
    return (
      <AuthLayout title="Secure your account" subtitle="Almost done. Choose a password you'll remember." step={{ n: 2, of: 2, label: 'Password & language' }} onBack={() => setStep(1)}>
        <form className="form" onSubmit={submit} noValidate>
          {formError && <div className="alert alert-error" role="alert">⚠️ {formError}{formError.includes('already') && <> <Link to="/signin">Sign in</Link></>}</div>}
          <Field label="Password" required error={errors.password} help="At least 8 characters, with letters and numbers.">
            {({ id, describedBy, invalid }) => <Input id={id} name="password" aria-describedby={describedBy} aria-invalid={invalid} type="password" autoComplete="new-password" prefixIcon="🔒" value={f.password} onChange={set('password')} />}
          </Field>
          <Field label="Confirm password" required error={errors.confirm}>
            {({ id, describedBy, invalid }) => <Input id={id} name="confirm" aria-describedby={describedBy} aria-invalid={invalid} type="password" autoComplete="new-password" prefixIcon="🔒" value={f.confirm} onChange={set('confirm')} />}
          </Field>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Language for Vendora</legend>
            <div className="chip-row">
              {LANGUAGES.map((l) => (
                <button type="button" key={l.code} className="chip" aria-pressed={f.language === l.code} onClick={() => setF((p) => ({ ...p, language: l.code }))}>{l.label}</button>
              ))}
            </div>
          </fieldset>
          <div className="alert alert-success">🔒 Only you and the team members you add can see your shop's records.</div>
          <Button type="submit" size="lg" block loading={busy} loadingText="Creating your account…">Create account →</Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set up your account" subtitle="Fill in your details to get started. Takes less than 2 minutes." step={{ n: 1, of: 2, label: 'Personal & Business Info' }} onBack={() => navigate('/welcome')}>
      <form className="form" onSubmit={next} noValidate>
        <div className="section-label">Personal details</div>
        <Field label="Full name" required error={errors.fullName}>
          {({ id, describedBy, invalid }) => <Input id={id} name="fullName" aria-describedby={describedBy} aria-invalid={invalid} autoComplete="name" prefixIcon="👤" placeholder="e.g. Ngozi Okafor" value={f.fullName} onChange={set('fullName')} />}
        </Field>
        <Field label="Phone number" optional error={errors.phone}>
          {({ id, describedBy, invalid }) => (
            <div className="phone-row">
              <div className="prefix-box" aria-hidden="true">🇳🇬 +234</div>
              <Input id={id} name="phone" aria-describedby={describedBy} aria-invalid={invalid} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="080 0000 0000" value={f.phone} onChange={set('phone')} />
            </div>
          )}
        </Field>
        <Field label="Email address" required error={errors.email} help="You'll use this to sign in and recover your account.">
          {({ id, describedBy, invalid }) => <Input id={id} name="email" aria-describedby={describedBy} aria-invalid={invalid} type="email" inputMode="email" autoComplete="email" prefixIcon="✉️" placeholder="yourname@email.com" value={f.email} onChange={set('email')} />}
        </Field>
        <hr className="divider" />
        <div className="section-label">Business details</div>
        <Field label="Business name" required error={errors.businessName}>
          {({ id, describedBy, invalid }) => <Input id={id} name="businessName" aria-describedby={describedBy} aria-invalid={invalid} prefixIcon="🏪" placeholder="e.g. Ngozi Provisions Store" value={f.businessName} onChange={set('businessName')} />}
        </Field>
        <Field label="Business type" required error={errors.category}>
          {({ id, describedBy, invalid }) => (
            <div className="stack-sm">
              <Select id={id} name="category" aria-describedby={describedBy} aria-invalid={invalid} value={f.category} onChange={set('category')}>
                <option value="">Select your business type…</option>
                {BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
              <div className="chip-row" aria-hidden="true">
                {BUSINESS_CATEGORIES.map((c) => (
                  <button type="button" tabIndex={-1} key={c.value} className="chip" aria-pressed={f.category === c.value} onClick={() => setF((p) => ({ ...p, category: c.value }))}>{c.label}</button>
                ))}
              </div>
            </div>
          )}
        </Field>
        <Field label="City / Market area" optional>
          {({ id, describedBy }) => <Input id={id} name="market" aria-describedby={describedBy} prefixIcon="📍" placeholder="e.g. Alaba Market, Lagos" value={f.market} onChange={set('market')} />}
        </Field>
        <div className="form-grid">
          <Field label="Country">{({ id }) => <Select id={id} disabled value="NG"><option value="NG">🇳🇬 Nigeria</option></Select>}</Field>
          <Field label="Currency">{({ id }) => <Select id={id} disabled value="NGN"><option value="NGN">₦ Naira (NGN)</option></Select>}</Field>
        </div>
        <div className="alert alert-success">🔒 Only you and the team members you add can see your shop's records.</div>
        <Button type="submit" size="lg" block>Continue →</Button>
        <p className="small center muted">Already have an account? <Link to="/signin">Sign in</Link></p>
      </form>
    </AuthLayout>
  );
}
