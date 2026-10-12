import type { Session, User } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppError, authErrorMessage, toAppError } from '../lib/errors';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { Language, Profile } from '../lib/types';

export interface PendingBusiness {
  name: string;
  category: string;
  market_area: string;
  city: string;
}

export interface SignUpInput {
  fullName: string;
  email: string;
  password: string;
  phone: string;
  language: Language;
  business: PendingBusiness;
}

interface AuthState {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  profileError: string | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: SignUpInput): Promise<{ needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  resendConfirmation(email: string): Promise<void>;
  refreshProfile(): Promise<Profile | null>;
  updateProfile(patch: Partial<Pick<Profile, 'full_name' | 'phone' | 'preferred_language' | 'onboarding_step'>>): Promise<void>;
  recoveryMode: boolean;
}

const Ctx = createContext<AuthState | null>(null);

const appUrl = () => `${window.location.origin}${import.meta.env.BASE_URL}`;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(supabaseConfigured);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);

  const loadProfile = useCallback(async (): Promise<Profile | null> => {
    if (!supabase) return null;
    // ensure_profile() recreates a missing profile row (e.g. if the signup trigger failed).
    const { data, error } = await supabase.rpc('ensure_profile');
    if (error) {
      setProfileError(toAppError(error).message);
      return null;
    }
    setProfileError(null);
    const p = data as Profile;
    setProfile(p);
    return p;
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadProfile();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') { setProfile(null); setRecoveryMode(false); }
      if (event === 'SIGNED_IN' && s) {
        // Defer to avoid calling Supabase inside the auth callback (deadlock-safe pattern).
        setTimeout(() => { void loadProfile(); }, 0);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthState>(() => ({
    configured: supabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    profile,
    profileError,
    recoveryMode,
    async signIn(email, password) {
      if (!supabase) throw new AppError('NOT_CONFIGURED', 'Sign-in is not available yet because the database is not connected. Try the demo shop.');
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new AppError('AUTH', authErrorMessage(error));
    },
    async signUp(input) {
      if (!supabase) throw new AppError('NOT_CONFIGURED', 'Sign-up is not available yet because the database is not connected. Try the demo shop.');
      const { data, error } = await supabase.auth.signUp({
        email: input.email.trim(),
        password: input.password,
        options: {
          emailRedirectTo: `${appUrl()}#/onboarding`,
          data: {
            full_name: input.fullName.trim(),
            phone: input.phone ? `+234${input.phone.replace(/\D/g, '').replace(/^0/, '')}` : '',
            preferred_language: input.language,
            pending_business: input.business,
          },
        },
      });
      if (error) throw new AppError('AUTH', authErrorMessage(error));
      // Supabase returns a user with no identities when the email is already registered.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new AppError('AUTH', 'An account already uses this email. Sign in instead, or reset your password.');
      }
      return { needsConfirmation: !data.session };
    },
    async signOut() {
      if (!supabase) return;
      await supabase.auth.signOut();
      setProfile(null);
    },
    async requestPasswordReset(email) {
      if (!supabase) throw new AppError('NOT_CONFIGURED', 'Password reset is not available until the database is connected.');
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${appUrl()}#/reset-password` });
      if (error) throw new AppError('AUTH', authErrorMessage(error));
    },
    async updatePassword(password) {
      if (!supabase) throw new AppError('NOT_CONFIGURED', 'Not connected.');
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new AppError('AUTH', authErrorMessage(error));
      setRecoveryMode(false);
    },
    async resendConfirmation(email) {
      if (!supabase) return;
      const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: `${appUrl()}#/onboarding` } });
      if (error) throw new AppError('AUTH', authErrorMessage(error));
    },
    refreshProfile: loadProfile,
    async updateProfile(patch) {
      if (!supabase || !session) return;
      const { data, error } = await supabase.from('profiles').update(patch).eq('id', session.user.id)
        .select('id,full_name,phone,preferred_language,onboarding_step').single();
      if (error) throw toAppError(error);
      setProfile(data as Profile);
    },
  }), [loading, session, profile, profileError, recoveryMode, loadProfile]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
