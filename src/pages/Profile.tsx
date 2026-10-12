import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Field, Input, Select, Sheet } from '../components/ui';
import { toAppError } from '../lib/errors';
import { initials } from '../lib/format';
import { supabase } from '../lib/supabase';
import { LANGUAGES, type MemberRole } from '../lib/types';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useQuery, useWorkspace } from '../state/workspace';
import { recognitionSupported, recognitionVerified } from '../voice/recognition';
import { useVoice } from '../voice/VoiceProvider';

const VERIFY: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  verified: { label: '✓ Verified vendor', tone: 'success' },
  pending: { label: 'Verification pending', tone: 'warning' },
  unverified: { label: 'Not verified', tone: 'neutral' },
  rejected: { label: 'Verification not approved', tone: 'danger' },
  suspended: { label: 'Suspended', tone: 'danger' },
};

export default function Profile() {
  const ws = useWorkspace();
  const auth = useAuth();
  const voice = useVoice();
  const toast = useToast();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'language' | 'team' | 'help' | 'bank' | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const live = ws.mode === 'live';
  const vp = useQuery(['hub'], async () => {
    if (!live || !supabase || !ws.business) return null;
    const { data } = await supabase.from('vendor_profiles').select('verification_status').eq('business_id', ws.business.id).maybeSingle();
    return data?.verification_status as string | null;
  }, [ws.business?.id]);
  const name = live ? auth.profile?.full_name || auth.user?.email || 'You' : 'Mama Ngozi';
  const status = vp.data ? VERIFY[vp.data] : null;
  const lang = LANGUAGES.find((l) => l.code === ws.language)!;

  return (
    <>
      <header className="page-header">
        <div className="page-header-inner profile-header">
          <span className="avatar avatar-lg" aria-hidden="true">{initials(name)}</span>
          <h1 style={{ fontSize: 22 }}>{name}</h1>
          <div className="subtitle">{[ws.business?.name, ws.business?.market_area].filter(Boolean).join(' · ')}{ws.business && live ? ` · ${ws.business.role}` : ''}</div>
          {ws.mode === 'demo' ? <Badge tone="yellow">Demo shop</Badge> : status && <Badge tone={status.tone}>{status.label}</Badge>}
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 720 }}>
        {ws.businesses.length > 1 && (
          <Field label="Shop">{({ id }) => (
            <Select id={id} value={ws.business?.id} onChange={(e) => { ws.selectBusiness(e.target.value); toast.info('Switched shop.'); }}>
              {ws.businesses.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.role})</option>)}
            </Select>
          )}</Field>
        )}

        <h2 className="section-label">My shop</h2>
        <div className="settings-group">
          {live ? <Link className="settings-item" to="/hub/profile">Edit shop profile <span className="chev">›</span></Link> : null}
          <button className="settings-item" onClick={() => setSheet('language')}>Switch language <span className="muted small">{lang.label} ›</span></button>
          <button className="settings-item" onClick={() => setSheet('bank')}>Linked bank account <span className="muted small">Not linked ›</span></button>
          {live && ws.business?.role === 'owner' && <button className="settings-item" onClick={() => setSheet('team')}>Team members <span className="chev">›</span></button>}
          <Link className="settings-item" to="/stock">Products &amp; prices <span className="chev">›</span></Link>
        </div>

        <h2 className="section-label">Vendora AI</h2>
        <div className="settings-group">
          <label className="settings-item" style={{ cursor: 'pointer' }}>
            <span>Speak replies aloud<br /><span className="xs muted">{live ? 'YarnGPT voice, falls back to the device voice' : 'Device voice in the demo'}</span></span>
            <input type="checkbox" checked={voice.voiceReplies} onChange={(e) => voice.setVoiceReplies(e.target.checked)} style={{ width: 24, height: 24, accentColor: 'var(--blue-600)' }} />
          </label>
          <button className="settings-item" onClick={() => setSheet('language')}>Voice language <span className="muted small">{lang.label} ›</span></button>
          <div className="settings-item" style={{ cursor: 'default' }}>
            <span className="small">Voice input on this device</span>
            <Badge tone={recognitionSupported() ? (recognitionVerified(ws.language) ? 'success' : 'warning') : 'neutral'}>
              {recognitionSupported() ? (recognitionVerified(ws.language) ? 'Available' : 'Experimental') : 'Type only'}
            </Badge>
          </div>
        </div>

        <h2 className="section-label">Support &amp; more</h2>
        <div className="settings-group">
          <button className="settings-item" onClick={() => setSheet('help')}>Help (Pidgin &amp; English) <span className="chev">›</span></button>
          {ws.mode === 'demo' && <button className="settings-item" onClick={() => { ws.resetDemo(); voice.clear(); toast.success('Demo data reset.'); }}>Reset demo data <span className="chev">›</span></button>}
          {ws.mode === 'demo' ? (
            <button className="settings-item" onClick={() => { ws.exitDemo(); navigate('/welcome'); }}><span className="text-danger">Leave demo</span></button>
          ) : (
            <button className="settings-item" onClick={() => setSignOutOpen(true)}><span className="text-danger">Sign out</span></button>
          )}
        </div>
      </div>

      <Sheet open={sheet === 'language'} onClose={() => setSheet(null)} title="Language" description="Used for Vendora's replies and voice recognition.">
        <div className="stack">
          {LANGUAGES.map((l) => (
            <button key={l.code} className="list-row" aria-pressed={ws.language === l.code} onClick={async () => {
              try { await ws.setLanguage(l.code); toast.success(`Language set to ${l.label}.`); setSheet(null); } catch (e) { toast.error(toAppError(e).message); }
            }}>
              <span className="grow"><strong>{l.native}</strong><br /><span className="xs muted">
                {l.code === 'en' || l.code === 'pcm' ? 'Full support for voice and replies' : 'Replies shown in English; voice input & spoken translation experimental'}
              </span></span>
              {ws.language === l.code && <span aria-label="selected">✅</span>}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={sheet === 'bank'} onClose={() => setSheet(null)} title="Bank account">
        <div className="stack">
          <p>Linking a bank account so Vendora can see incoming transfers automatically needs an approved bank partner integration. It is <strong>not switched on yet</strong>.</p>
          <p className="muted small">Until then, record transfers on the Sales page and always confirm in your bank app before releasing goods.</p>
          <Button onClick={() => { setSheet(null); navigate('/sales'); }}>Go to Sales &amp; Payments</Button>
        </div>
      </Sheet>

      <TeamSheet open={sheet === 'team'} onClose={() => setSheet(null)} />

      <Sheet open={sheet === 'help'} onClose={() => setSheet(null)} title="How to use Vendora">
        <div className="stack small">
          <p><strong>Record a sale:</strong> tap the mic and say “I sold 2 bags of rice for 35,000 each, cash”. Vendora shows the details — tap <em>Yes</em> to save.</p>
          <p><strong>Pidgin:</strong> “I don sell 3 cartons Indomie, transfer.” · “How market today?” · “Wetin dey finish?”</p>
          <p><strong>Credit:</strong> “I sold 1 bag of rice on credit to Emeka, he paid 10k.” Later: “Emeka paid 5000.”</p>
          <p><strong>Restock:</strong> “I bought 10 bags of rice at 30,000 each.”</p>
          <p><strong>No network?</strong> Sales from the till are saved on your phone and sync later. They show as “waiting to sync” until they're recorded.</p>
          <p><strong>Mistake?</strong> Open the sale and tap “Reverse sale”. Vendora keeps the history and puts the stock back.</p>
        </div>
      </Sheet>

      <ConfirmDialog open={signOutOpen} title="Sign out?" confirmLabel="Sign out" onCancel={() => setSignOutOpen(false)} onConfirm={async () => {
        const pending = ws.queue.filter((q) => q.status !== 'failed').length;
        if (pending && !window.confirm(`${pending} sale(s) on this phone haven't synced yet. They stay on this phone and sync when you sign in again. Sign out anyway?`)) return;
        await auth.signOut(); voice.clear(); navigate('/welcome');
      }}>
        <p>You can sign in again any time with your email and password.</p>
      </ConfirmDialog>
    </>
  );
}

function TeamSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('assistant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = useQuery(['hub'], async () => {
    if (!supabase || !ws.business || !open) return [];
    const { data, error: e } = await supabase.from('business_members').select('user_id, role').eq('business_id', ws.business.id);
    if (e) throw e;
    const ids = (data ?? []).map((r) => r.user_id as string);
    const { data: profiles } = ids.length ? await supabase.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
    const names = new Map((profiles ?? []).map((p) => [p.id as string, p.full_name as string]));
    return (data ?? []).map((r) => ({ id: r.user_id as string, role: r.role as MemberRole, name: names.get(r.user_id as string) || 'Team member' }));
  }, [open, ws.business?.id]);
  return (
    <Sheet open={open} onClose={onClose} title="Team members" description="Assistants can record sales and payments. Managers can also change stock and prices.">
      <div className="stack">
        {(team.data ?? []).map((m) => <div key={m.id} className="row-between small"><span>{m.name}</span><Badge tone="info">{m.role}</Badge></div>)}
        <form className="form" noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (!supabase || !ws.business) return;
          setBusy(true);
          setError(null);
          try {
            const { error: rpcErr } = await supabase.rpc('add_team_member', { p_business_id: ws.business.id, p_email: email.trim(), p_role: role });
            if (rpcErr) throw rpcErr;
            toast.success(`${email.trim()} added as ${role}.`);
            setEmail('');
            ws.invalidate('hub');
          } catch (err) {
            setError(toAppError(err).message);
          } finally {
            setBusy(false);
          }
        }}>
          <Field label="Their Vendora email" required error={error} help="They must create a Vendora account first.">{({ id, invalid, describedBy }) => <Input id={id} type="email" aria-invalid={invalid} aria-describedby={describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Role">{({ id }) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}><option value="assistant">Shop assistant</option><option value="manager">Manager</option></Select>}</Field>
          <Button type="submit" loading={busy}>Add to team</Button>
        </form>
      </div>
    </Sheet>
  );
}
