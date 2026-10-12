import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ErrorState, Field, Input, Select, Skeleton, Textarea } from '../../components/ui';
import { assetUrl, getVendorProfile, requestVerification, updateVendorProfile, uploadBusinessAsset, type VendorProfile } from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { initials } from '../../lib/format';
import { BUSINESS_CATEGORIES } from '../../lib/types';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { HubGate, HubHeader, VerificationBadge } from './common';

export default function EditVendorProfile() {
  return <HubGate><Edit /></HubGate>;
}

function Edit() {
  const ws = useWorkspace();
  const toast = useToast();
  const [vp, setVp] = useState<VendorProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoProgress, setLogoProgress] = useState<number | null>(null);
  const [cac, setCac] = useState('');
  const [notes, setNotes] = useState('');
  const [verifying, setVerifying] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const isOwner = ws.business?.role === 'owner';
  const canEdit = ws.business?.role !== 'assistant';

  useEffect(() => { getVendorProfile(ws.business!.id).then(setVp).catch((e) => setError(toAppError(e).message)); }, [ws.business]);
  if (error) return <><HubHeader title="Shop profile" back="/hub" /><div className="page-body"><ErrorState message={error} /></div></>;
  if (!vp) return <><HubHeader title="Shop profile" back="/hub" /><div className="page-body"><Skeleton height={400} radius={22} /></div></>;
  const set = <K extends keyof VendorProfile>(k: K, v: VendorProfile[K]) => setVp({ ...vp, [k]: v });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (vp.display_name.trim().length < 2) { toast.error('Shop name must have at least 2 characters.'); return; }
    setSaving(true);
    try {
      await updateVendorProfile(vp.business_id, {
        display_name: vp.display_name.trim(), description: vp.description?.trim() || null, category: vp.category,
        products_summary: vp.products_summary?.trim() || null, market: vp.market?.trim() || null, city: vp.city?.trim() || null,
        state: vp.state?.trim() || null, contact_phone: vp.contact_phone?.trim() || null, contact_whatsapp: vp.contact_whatsapp?.trim() || null,
        allow_messages: vp.allow_messages, is_public: vp.is_public, logo_path: vp.logo_path,
      });
      ws.invalidate('hub');
      toast.success(vp.is_public ? 'Profile saved. Your shop is visible in the Hub.' : 'Profile saved. Your shop is hidden from the Hub.');
    } catch (err) {
      toast.error(`Profile not saved: ${toAppError(err).message}`);
    } finally { setSaving(false); }
  };

  const uploadLogo = async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) { toast.error('Use a JPG, PNG or WebP image under 5 MB.'); return; }
    setLogoProgress(0);
    try {
      const path = await uploadBusinessAsset(vp.business_id, file, setLogoProgress);
      await updateVendorProfile(vp.business_id, { logo_path: path });
      setVp({ ...vp, logo_path: path });
      toast.success('Logo updated.');
    } catch (err) { toast.error(`Logo not uploaded: ${toAppError(err).message}`); } finally { setLogoProgress(null); }
  };

  return (
    <>
      <HubHeader title="Shop profile" subtitle="What other vendors see in the Hub" back="/hub" />
      <form className="page-body form" style={{ maxWidth: 720 }} onSubmit={save} noValidate>
        {!canEdit && <div className="alert alert-info">Only the owner or a manager can edit the shop profile.</div>}
        <section className="card row">
          <span className="avatar avatar-lg" aria-hidden="true">{vp.logo_path ? <img src={assetUrl(vp.logo_path) ?? ''} alt="" /> : initials(vp.display_name)}</span>
          <div className="stack-sm grow">
            <Button variant="secondary" size="sm" onClick={() => logoRef.current?.click()} disabled={!canEdit} loading={logoProgress !== null} loadingText={`Uploading ${logoProgress ?? 0}%`}>Change logo</Button>
            {logoProgress !== null && <div className="progress" role="progressbar" aria-valuenow={logoProgress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${logoProgress}%` }} /></div>}
            <input ref={logoRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = ''; }} />
          </div>
        </section>
        <section className="card form">
          <label className="checkbox"><input type="checkbox" checked={vp.is_public} disabled={!canEdit} onChange={(e) => set('is_public', e.target.checked)} /> <span><strong>Show my shop in the Vendors Hub</strong><br /><span className="xs muted">Your sales, stock and customers are never shown — only this profile and your adverts.</span></span></label>
          <label className="checkbox"><input type="checkbox" checked={vp.allow_messages} disabled={!canEdit} onChange={(e) => set('allow_messages', e.target.checked)} /> Allow other vendors to message me</label>
        </section>
        <section className="card form">
          <Field label="Shop name" required>{({ id }) => <Input id={id} disabled={!canEdit} value={vp.display_name} onChange={(e) => set('display_name', e.target.value)} />}</Field>
          <Field label="Category">{({ id }) => <Select id={id} disabled={!canEdit} value={vp.category} onChange={(e) => set('category', e.target.value)}>{BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
          <Field label="What you sell" optional help="e.g. Rice, beans, garri — wholesale and retail">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} disabled={!canEdit} maxLength={300} value={vp.products_summary ?? ''} onChange={(e) => set('products_summary', e.target.value)} />}</Field>
          <Field label="About your shop" optional>{({ id }) => <Textarea id={id} rows={3} disabled={!canEdit} maxLength={1000} value={vp.description ?? ''} onChange={(e) => set('description', e.target.value)} />}</Field>
          <div className="form-grid">
            <Field label="Market">{({ id }) => <Input id={id} disabled={!canEdit} value={vp.market ?? ''} onChange={(e) => set('market', e.target.value)} />}</Field>
            <Field label="City">{({ id }) => <Input id={id} disabled={!canEdit} value={vp.city ?? ''} onChange={(e) => set('city', e.target.value)} />}</Field>
            <Field label="State" optional>{({ id }) => <Input id={id} disabled={!canEdit} value={vp.state ?? ''} onChange={(e) => set('state', e.target.value)} />}</Field>
            <Field label="WhatsApp" optional help="Shown publicly if set">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="tel" disabled={!canEdit} value={vp.contact_whatsapp ?? ''} onChange={(e) => set('contact_whatsapp', e.target.value)} />}</Field>
          </div>
        </section>
        {canEdit && <Button type="submit" size="lg" loading={saving}>Save profile</Button>}

        <section className="card stack" aria-labelledby="verify-h">
          <div className="row-between"><h2 id="verify-h" style={{ fontSize: 17 }}>Verification</h2><VerificationBadge status={vp.verification_status} /></div>
          <p className="small muted">A verified badge appears only after the Vendora team checks your business documents. Submitting this form does not verify you.</p>
          {vp.verification_status === 'pending' && <Badge tone="warning">Your request is being reviewed.</Badge>}
          {(vp.verification_status === 'unverified' || vp.verification_status === 'rejected') && isOwner && (
            <div className="form">
              <Field label="CAC registration number" optional>{({ id }) => <Input id={id} value={cac} onChange={(e) => setCac(e.target.value)} placeholder="e.g. RC 1234567 or BN 1234567" />}</Field>
              <Field label="Anything that helps us check" optional>{({ id }) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shop number, market association, etc." />}</Field>
              <Button variant="secondary" loading={verifying} onClick={async () => {
                setVerifying(true);
                try { await requestVerification(vp.business_id, cac, notes); setVp({ ...vp, verification_status: 'pending' }); toast.success('Request sent. You will get a notification when it is reviewed.'); }
                catch (err) { toast.error(toAppError(err).message); } finally { setVerifying(false); }
              }}>Request verification</Button>
            </div>
          )}
          {!isOwner && vp.verification_status !== 'verified' && <p className="xs muted">Only the shop owner can request verification.</p>}
        </section>
      </form>
    </>
  );
}
