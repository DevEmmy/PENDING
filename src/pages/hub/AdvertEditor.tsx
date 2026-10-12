import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, ConfirmDialog, ErrorState, Field, Input, parseMoney, parseWhole, Select, Skeleton, Textarea } from '../../components/ui';
import {
  createAdvert, createPost, deleteAdvert, getAdvert, getVendorProfile, mediaUrl, removeAdvertMedia, updateAdvert, uploadAdvertMedia,
  type Advert, type AdvertInput, type AdvertMedia,
} from '../../data/hubApi';
import { toAppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { BUSINESS_CATEGORIES } from '../../lib/types';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { useWorkspace } from '../../state/workspace';
import { HubGate, HubHeader } from './common';

export default function AdvertEditor() {
  return <HubGate><Editor /></HubGate>;
}

interface Pending { key: string; file: File; preview: string; progress: number | null; error: string | null }
interface FormState {
  headline: string; description: string; category: string; product_name: string; price_min: string; price_max: string; unit: string;
  min_order_qty: string; available_qty: string; pricing_type: Advert['pricing_type']; market: string; city: string; state: string;
  delivery_info: string; allow_messages: boolean; expires_at: string;
}
const MAX_IMAGES = 8;

function toForm(a?: Advert | null, defaults?: Partial<FormState>): FormState {
  return {
    headline: a?.headline ?? '', description: a?.description ?? '', category: a?.category ?? defaults?.category ?? 'foodstuff',
    product_name: a?.product_name ?? '', price_min: a?.price_min?.toString() ?? '', price_max: a?.price_max?.toString() ?? '',
    unit: a?.unit ?? 'bag', min_order_qty: a?.min_order_qty?.toString() ?? '', available_qty: a?.available_qty?.toString() ?? '',
    pricing_type: a?.pricing_type ?? 'retail', market: a?.market ?? defaults?.market ?? '', city: a?.city ?? defaults?.city ?? '',
    state: a?.state ?? '', delivery_info: a?.delivery_info ?? '', allow_messages: a?.allow_messages ?? true,
    expires_at: a?.expires_at ? a.expires_at.slice(0, 10) : '',
  };
}

function validate(f: FormState): { errors: Record<string, string>; input: AdvertInput } {
  const e: Record<string, string> = {};
  const min = parseMoney(f.price_min);
  const max = parseMoney(f.price_max);
  const moq = parseWhole(f.min_order_qty);
  const avail = parseWhole(f.available_qty);
  if (f.headline.trim().length < 3) e.headline = 'Write a short headline (at least 3 characters).';
  if (Number.isNaN(min)) e.price_min = 'Enter a price like 32000 or 32k.';
  if (Number.isNaN(max)) e.price_max = 'Enter a price like 34000 or 34k.';
  if (min !== null && max !== null && !Number.isNaN(min) && !Number.isNaN(max) && max < min) e.price_max = 'The highest price must be more than the lowest.';
  if (Number.isNaN(moq) || moq === 0) e.min_order_qty = 'Use a whole number above 0, or leave empty.';
  if (Number.isNaN(avail)) e.available_qty = 'Use a whole number, or leave empty.';
  if (f.expires_at && new Date(f.expires_at) <= new Date()) e.expires_at = 'Choose a future date.';
  return {
    errors: e,
    input: {
      headline: f.headline.trim(), description: f.description.trim() || null, category: f.category, product_name: f.product_name.trim() || null,
      price_min: min === null || Number.isNaN(min) ? null : min, price_max: max === null || Number.isNaN(max) ? null : max,
      unit: f.unit.trim() || null, min_order_qty: moq === null || Number.isNaN(moq) ? null : moq, available_qty: avail === null || Number.isNaN(avail) ? null : avail,
      pricing_type: f.pricing_type, market: f.market.trim() || null, city: f.city.trim() || null, state: f.state.trim() || null,
      delivery_info: f.delivery_info.trim() || null, allow_messages: f.allow_messages,
      expires_at: f.expires_at ? new Date(`${f.expires_at}T23:59:59+01:00`).toISOString() : null,
    },
  };
}

function Editor() {
  const { id } = useParams();
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [advert, setAdvert] = useState<Advert | null>(null);
  const [media, setMedia] = useState<AdvertMedia[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [f, setF] = useState<FormState | null>(id ? null : toForm(null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'publish' | null>(null);
  const [banner, setBanner] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeMedia, setRemoveMedia] = useState<AdvertMedia | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canManage = ws.business?.role !== 'assistant';

  useEffect(() => {
    if (!id) {
      if (ws.business) getVendorProfile(ws.business.id).then((vp) => vp && setF((cur) => cur && !cur.market && !cur.city ? toForm(null, { category: vp.category, market: vp.market ?? '', city: vp.city ?? '' }) : cur)).catch(() => {});
      return;
    }
    getAdvert(id).then((d) => {
      if (!d) { setLoadError('This advert was not found.'); return; }
      if (d.advert.business_id !== ws.business?.id) { setLoadError('You can only edit your own adverts.'); return; }
      setAdvert(d.advert); setMedia(d.media); setF(toForm(d.advert));
    }).catch((e) => setLoadError(toAppError(e).message));
  }, [id, ws.business]);

  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canManage) return <><HubHeader title="Advert" back="/hub" /><div className="page-body"><ErrorState message="Only the shop owner or a manager can create adverts." /></div></>;
  if (loadError) return <><HubHeader title="Edit advert" back="/hub/my-adverts" /><div className="page-body"><ErrorState message={loadError} /></div></>;
  if (!f) return <><HubHeader title="Edit advert" back="/hub/my-adverts" /><div className="page-body"><Skeleton height={400} radius={22} /></div></>;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((cur) => (cur ? { ...cur, [k]: v } : cur));
  const totalMedia = media.length + pending.filter((p) => !p.error || p.progress === null).length;

  const pick = (files: FileList | null) => {
    if (!files) return;
    const next: Pending[] = [];
    for (const file of Array.from(files)) {
      if (totalMedia + next.length >= MAX_IMAGES) { toast.error(`You can add up to ${MAX_IMAGES} photos or videos.`); break; }
      const isImg = /^image\/(jpeg|png|webp)$/.test(file.type);
      const isVid = /^video\/(mp4|webm)$/.test(file.type);
      if (!isImg && !isVid) { toast.error(`${file.name}: use JPG, PNG, WebP photos or MP4 video.`); continue; }
      if (file.size > 10 * 1024 * 1024) { toast.error(`${file.name} is bigger than 10 MB.`); continue; }
      if (isVid && (media.some((m) => m.media_type === 'video') || pending.some((p) => p.file.type.startsWith('video')) || next.some((p) => p.file.type.startsWith('video')))) { toast.error('Only one video per advert.'); continue; }
      next.push({ key: newId(), file, preview: URL.createObjectURL(file), progress: null, error: null });
    }
    setPending((p) => [...p, ...next]);
  };

  /** Save the advert and upload any new media. Publishing happens only if every upload succeeded. */
  const save = async (publish: boolean) => {
    const v = validate(f);
    setErrors(v.errors);
    setBanner(null);
    if (Object.keys(v.errors).length) {
      setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setSaving(publish ? 'publish' : 'draft');
    let current = advert;
    try {
      // 1) Save details (new adverts start as drafts until media is safely uploaded).
      if (!current) current = await createAdvert(ws.business!.id, auth.user!.id, { ...v.input, status: 'draft' });
      else current = await updateAdvert(current.id, v.input); // status changes only in step 3
      setAdvert(current);
      if (!id) window.history.replaceState(null, '', `#/hub/adverts/${current.id}/edit`);

      // 2) Upload new media one by one with real progress.
      let uploadFailed = false;
      let position = media.length;
      const uploaded: AdvertMedia[] = [];
      for (const p of pending) {
        setPending((list) => list.map((x) => (x.key === p.key ? { ...x, progress: 0, error: null } : x)));
        try {
          const m = await uploadAdvertMedia(ws.business!.id, current.id, p.file, position++, (pct) => setPending((list) => list.map((x) => (x.key === p.key ? { ...x, progress: pct } : x))));
          uploaded.push(m);
          URL.revokeObjectURL(p.preview);
          setPending((list) => list.filter((x) => x.key !== p.key));
        } catch (e) {
          uploadFailed = true;
          const msg = toAppError(e).message;
          setPending((list) => list.map((x) => (x.key === p.key ? { ...x, progress: null, error: msg } : x)));
        }
      }
      if (uploaded.length) setMedia((m) => [...m, ...uploaded]);

      // 3) Publish only when everything is in place.
      if (uploadFailed) {
        setBanner({ tone: 'error', text: publish
          ? "Your advert wasn't published because an image upload failed. Your draft is saved. Try uploading the image again."
          : 'Your draft is saved, but an image upload failed. Try uploading it again.' });
        return;
      }
      if (publish && current.status !== 'published') {
        current = await updateAdvert(current.id, { status: 'published' });
        setAdvert(current);
        if (shareToFeed) await createPost(ws.business!.id, auth.user!.id, 'new_advert', `${current.headline}${current.price_min ? ` — from ₦${current.price_min.toLocaleString('en-NG')}` : ''}`, current.id).catch(() => toast.info('Advert published, but the feed post could not be created.'));
      }
      ws.invalidate('hub');
      toast.success(publish ? 'Advert published. Other vendors can now find it.' : 'Saved.');
      navigate(`/hub/adverts/${current.id}`, { replace: true });
    } catch (e) {
      setBanner({ tone: 'error', text: `${current ? 'Your changes were not saved' : 'Your advert was not created'}: ${toAppError(e).message} Nothing you typed has been lost.` });
    } finally {
      setSaving(null);
    }
  };

  const published = advert?.status === 'published';

  return (
    <>
      <HubHeader title={advert ? 'Edit advert' : 'New advert'} subtitle="Tell other traders what you're selling" back={advert ? `/hub/adverts/${advert.id}` : '/hub'} />
      <form className="page-body form" style={{ maxWidth: 760 }} onSubmit={(e) => { e.preventDefault(); void save(!published ? true : false); }} noValidate>
        {banner && <div className={`alert alert-${banner.tone}`} role="alert">{banner.tone === 'error' ? '⚠️' : '✅'} {banner.text}</div>}
        {advert && <p className="small muted">Status: <strong>{advert.status}</strong>{advert.moderation_status !== 'ok' ? ` · ${advert.moderation_status} by review` : ''}</p>}

        <section className="card form" aria-labelledby="photos-h">
          <h2 id="photos-h" className="section-label">Photos &amp; video</h2>
          <div className="upload-grid">
            {media.map((m) => (
              <div key={m.id} className="upload-tile">
                {m.media_type === 'video' ? <video src={mediaUrl(m.storage_path) ?? ''} muted /> : <img src={mediaUrl(m.storage_path) ?? ''} alt="" />}
                <button type="button" className="remove" onClick={() => setRemoveMedia(m)} aria-label="Remove this photo">✕</button>
              </div>
            ))}
            {pending.map((p) => (
              <div key={p.key} className="upload-tile">
                {p.file.type.startsWith('video') ? <video src={p.preview} muted /> : <img src={p.preview} alt="" />}
                {p.progress !== null && <div className="state" role="status">Uploading {p.progress}%</div>}
                {p.progress !== null && <div className="progress on-dark"><span style={{ width: `${p.progress}%` }} /></div>}
                {p.error && <div className="state" role="alert" style={{ background: 'rgba(185,28,28,0.75)' }}>Upload failed</div>}
                {p.progress === null && <button type="button" className="remove" onClick={() => { URL.revokeObjectURL(p.preview); setPending((l) => l.filter((x) => x.key !== p.key)); }} aria-label={`Remove ${p.file.name}`}>✕</button>}
              </div>
            ))}
            {totalMedia < MAX_IMAGES && (
              <button type="button" className="add-tile" onClick={() => fileRef.current?.click()}>📷<br />Add photo</button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
          <p className="xs muted">Up to {MAX_IMAGES} photos (JPG, PNG, WebP) and one short video, 10 MB each. New photos upload when you save.</p>
          {pending.some((p) => p.error) && <p className="small text-danger">{pending.find((p) => p.error)?.error}</p>}
        </section>

        <section className="card form" aria-labelledby="details-h">
          <h2 id="details-h" className="section-label">Details</h2>
          <Field label="Headline" required error={errors.headline}>{({ id: fid, invalid, describedBy }) => <Input id={fid} aria-invalid={invalid} aria-describedby={describedBy} maxLength={120} value={f.headline} onChange={(e) => set('headline', e.target.value)} placeholder="e.g. Mama Gold rice — wholesale" />}</Field>
          <div className="form-grid">
            <Field label="Product">{({ id: fid }) => <Input id={fid} value={f.product_name} onChange={(e) => set('product_name', e.target.value)} placeholder="Rice 50kg" />}</Field>
            <Field label="Category">{({ id: fid }) => <Select id={fid} value={f.category} onChange={(e) => set('category', e.target.value)}>{BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
          </div>
          <Field label="Description" optional>{({ id: fid }) => <Textarea id={fid} rows={4} maxLength={2000} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Brand, quality, condition, anything buyers should know." />}</Field>
        </section>

        <section className="card form" aria-labelledby="price-h">
          <h2 id="price-h" className="section-label">Price &amp; quantity</h2>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Selling</legend>
            <div className="chip-row">
              {(['retail', 'wholesale', 'both'] as const).map((t) => <button type="button" key={t} className="chip" aria-pressed={f.pricing_type === t} onClick={() => set('pricing_type', t)}>{t === 'both' ? 'Retail & wholesale' : t[0].toUpperCase() + t.slice(1)}</button>)}
            </div>
          </fieldset>
          <div className="form-grid">
            <Field label="Price from (₦)" error={errors.price_min}>{({ id: fid, invalid }) => <Input id={fid} aria-invalid={invalid} inputMode="decimal" value={f.price_min} onChange={(e) => set('price_min', e.target.value)} placeholder="32000" />}</Field>
            <Field label="Price up to (₦)" optional error={errors.price_max}>{({ id: fid, invalid }) => <Input id={fid} aria-invalid={invalid} inputMode="decimal" value={f.price_max} onChange={(e) => set('price_max', e.target.value)} placeholder="34000" />}</Field>
            <Field label="Per">{({ id: fid }) => <Input id={fid} value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="bag" />}</Field>
            <Field label="Minimum order" optional error={errors.min_order_qty}>{({ id: fid, invalid }) => <Input id={fid} aria-invalid={invalid} inputMode="numeric" value={f.min_order_qty} onChange={(e) => set('min_order_qty', e.target.value)} placeholder="10" />}</Field>
            <Field label="Available now" optional error={errors.available_qty}>{({ id: fid, invalid }) => <Input id={fid} aria-invalid={invalid} inputMode="numeric" value={f.available_qty} onChange={(e) => set('available_qty', e.target.value)} />}</Field>
            <Field label="Ends on" optional error={errors.expires_at}>{({ id: fid, invalid }) => <Input id={fid} aria-invalid={invalid} type="date" value={f.expires_at} onChange={(e) => set('expires_at', e.target.value)} />}</Field>
          </div>
        </section>

        <section className="card form" aria-labelledby="where-h">
          <h2 id="where-h" className="section-label">Where &amp; how</h2>
          <div className="form-grid">
            <Field label="Market">{({ id: fid }) => <Input id={fid} value={f.market} onChange={(e) => set('market', e.target.value)} placeholder="Mile 12 Market" />}</Field>
            <Field label="City">{({ id: fid }) => <Input id={fid} value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="Lagos" />}</Field>
          </div>
          <Field label="Delivery" optional>{({ id: fid }) => <Input id={fid} value={f.delivery_info} onChange={(e) => set('delivery_info', e.target.value)} placeholder="e.g. Delivery within Lagos for 20+ bags" />}</Field>
          <label className="checkbox"><input type="checkbox" checked={f.allow_messages} onChange={(e) => set('allow_messages', e.target.checked)} /> Let vendors message me about this advert</label>
          {!published && <label className="checkbox"><input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} /> Also share in the activity feed when published</label>}
        </section>

        <div className="row wrap">
          {!published && <Button variant="secondary" onClick={() => void save(false)} loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>}
          <Button type="submit" size="lg" className="grow" loading={saving !== null && (saving === 'publish' || published)} loadingText={pending.length ? 'Uploading…' : 'Saving…'} disabled={Boolean(saving)}>
            {published ? 'Save changes' : 'Publish advert'}
          </Button>
        </div>
        {advert && (
          <div className="row wrap">
            {published && <Button variant="secondary" onClick={async () => { try { setAdvert(await updateAdvert(advert.id, { status: 'paused' })); toast.success('Advert paused. Vendors can no longer see it.'); } catch (e) { toast.error(toAppError(e).message); } }}>⏸ Pause</Button>}
            {advert.status === 'paused' && <Button variant="secondary" onClick={async () => { try { setAdvert(await updateAdvert(advert.id, { status: 'published' })); toast.success('Advert is live again.'); } catch (e) { toast.error(toAppError(e).message); } }}>▶ Resume</Button>}
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete advert</Button>
          </div>
        )}
      </form>
      <ConfirmDialog open={deleteOpen} title="Delete this advert?" confirmLabel="Delete" tone="danger" onCancel={() => setDeleteOpen(false)} onConfirm={async () => {
        try { await deleteAdvert(advert!, media); ws.invalidate('hub'); toast.success('Advert deleted.'); navigate('/hub/my-adverts', { replace: true }); }
        catch (e) { toast.error(`Not deleted: ${toAppError(e).message}`); setDeleteOpen(false); }
      }}>
        <p>The advert and its photos are removed permanently. Conversations about it are kept. To hide it for a while instead, use Pause.</p>
      </ConfirmDialog>
      <ConfirmDialog open={Boolean(removeMedia)} title="Remove this photo?" confirmLabel="Remove" tone="danger" onCancel={() => setRemoveMedia(null)} onConfirm={async () => {
        const m = removeMedia!;
        try { await removeAdvertMedia(m); setMedia((l) => l.filter((x) => x.id !== m.id)); toast.success('Photo removed.'); }
        catch (e) { toast.error(toAppError(e).message); } finally { setRemoveMedia(null); }
      }}>
        <p>The photo is deleted from this advert straight away.</p>
      </ConfirmDialog>
    </>
  );
}
