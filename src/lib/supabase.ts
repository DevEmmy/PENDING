import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True only when real project credentials are present. The app never invents a backend. */
export const supabaseConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT-REF'));

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('NOT_CONFIGURED');
  return supabase;
}

export const functionsUrl = url ? `${url.replace(/\/$/, '')}/functions/v1` : null;

export function publicStorageUrl(bucket: string, path: string | null | undefined): string | null {
  if (!path || !supabase) return null;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
