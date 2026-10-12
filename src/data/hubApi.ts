import type { RealtimeChannel } from '@supabase/supabase-js';
import { AppError, toAppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { publicStorageUrl, requireSupabase } from '../lib/supabase';

export type Verification = 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';

export interface VendorProfile {
  business_id: string;
  display_name: string;
  description: string | null;
  category: string;
  products_summary: string | null;
  market: string | null;
  city: string | null;
  state: string | null;
  logo_path: string | null;
  photo_paths: string[];
  contact_phone: string | null;
  contact_whatsapp: string | null;
  allow_messages: boolean;
  is_public: boolean;
  verification_status: Verification;
  verified_at: string | null;
  updated_at: string;
}

export interface AdvertSummary {
  id: string;
  business_id: string;
  headline: string;
  description: string | null;
  category: string;
  product_name: string | null;
  price_min: number | null;
  price_max: number | null;
  unit: string | null;
  min_order_qty: number | null;
  available_qty: number | null;
  pricing_type: 'retail' | 'wholesale' | 'both';
  market: string | null;
  city: string | null;
  state: string | null;
  delivery_info: string | null;
  allow_messages: boolean;
  is_featured: boolean;
  published_at: string | null;
  vendor_name: string;
  vendor_verification: Verification;
  cover_path: string | null;
}

export interface Advert extends Omit<AdvertSummary, 'vendor_name' | 'vendor_verification' | 'cover_path'> {
  status: 'draft' | 'published' | 'paused';
  moderation_status: 'ok' | 'flagged' | 'removed';
  expires_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface AdvertMedia {
  id: string;
  advert_id: string;
  storage_path: string;
  media_type: 'image' | 'video';
  position: number;
}

export type AdvertInput = Partial<Pick<Advert, 'headline' | 'description' | 'category' | 'product_name' | 'price_min' | 'price_max' | 'unit' | 'min_order_qty' | 'available_qty' | 'pricing_type' | 'market' | 'city' | 'state' | 'delivery_info' | 'allow_messages' | 'status' | 'expires_at'>>;

export interface SearchParams {
  query?: string;
  category?: string;
  location?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  pricingType?: string;
  sort?: 'relevance' | 'recent' | 'price_low' | 'price_high';
}

export const PAGE_SIZE = 12;
export const mediaUrl = (path: string | null | undefined) => publicStorageUrl('advert-media', path);
export const assetUrl = (path: string | null | undefined) => publicStorageUrl('business-assets', path);

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function normAdvert<T extends { price_min: number | null; price_max: number | null }>(a: T): T {
  return { ...a, price_min: num(a.price_min), price_max: num(a.price_max) };
}

async function q<T>(p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  let res;
  try { res = await p; } catch (e) { throw toAppError(e); }
  if (res.error) throw toAppError(res.error);
  return res.data as T;
}

// ---------------- Vendor profiles ----------------
const VP_COLS = 'business_id,display_name,description,category,products_summary,market,city,state,logo_path,photo_paths,contact_phone,contact_whatsapp,allow_messages,is_public,verification_status,verified_at,updated_at';

export async function getVendorProfile(businessId: string): Promise<VendorProfile | null> {
  return q(requireSupabase().from('vendor_profiles').select(VP_COLS).eq('business_id', businessId).maybeSingle()) as Promise<VendorProfile | null>;
}
export async function getVendorProfiles(ids: string[]): Promise<Map<string, VendorProfile>> {
  if (!ids.length) return new Map();
  const rows = await q(requireSupabase().from('vendor_profiles').select(VP_COLS).in('business_id', [...new Set(ids)])) as VendorProfile[];
  return new Map(rows.map((r) => [r.business_id, r]));
}
export async function updateVendorProfile(businessId: string, patch: Partial<Omit<VendorProfile, 'business_id' | 'verification_status' | 'verified_at' | 'updated_at'>>) {
  const rows = await q(requireSupabase().from('vendor_profiles').update(patch).eq('business_id', businessId).select('business_id')) as unknown[];
  if (!rows.length) throw new AppError('FORBIDDEN', 'Only the owner or a manager can edit the shop profile.');
}
export async function searchVendors(query: string, location: string, category: string, page: number): Promise<VendorProfile[]> {
  return q(requireSupabase().rpc('search_vendors', { p_query: query || null, p_location: location || null, p_category: category || null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE })) as Promise<VendorProfile[]>;
}
export async function recommendedVendors(businessId: string): Promise<VendorProfile[]> {
  return q(requireSupabase().rpc('recommended_vendors', { p_business_id: businessId, p_limit: 6 })) as Promise<VendorProfile[]>;
}
export async function requestVerification(businessId: string, cacNumber: string, notes: string) {
  await q(requireSupabase().rpc('request_vendor_verification', { p_business_id: businessId, p_cac_number: cacNumber, p_notes: notes }));
}

// ---------------- Adverts ----------------
export async function searchAdverts(p: SearchParams, page: number): Promise<AdvertSummary[]> {
  const rows = await q(requireSupabase().rpc('search_adverts', {
    p_query: p.query || null, p_category: p.category || null, p_location: p.location || null,
    p_min_price: p.minPrice ?? null, p_max_price: p.maxPrice ?? null, p_pricing_type: p.pricingType || null,
    p_sort: p.sort === 'recent' ? 'recent' : p.sort ?? 'relevance', p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
  })) as AdvertSummary[];
  return rows.map(normAdvert);
}

const ADVERT_COLS = 'id,business_id,headline,description,category,product_name,price_min,price_max,unit,min_order_qty,available_qty,pricing_type,market,city,state,delivery_info,allow_messages,is_featured,published_at,status,moderation_status,expires_at,updated_at,created_at';
export async function getAdvert(id: string): Promise<{ advert: Advert; media: AdvertMedia[]; vendor: VendorProfile | null } | null> {
  const advert = await q(requireSupabase().from('adverts').select(ADVERT_COLS).eq('id', id).maybeSingle()) as Advert | null;
  if (!advert) return null;
  const [media, vendor] = await Promise.all([
    q(requireSupabase().from('advert_media').select('id,advert_id,storage_path,media_type,position').eq('advert_id', id).order('position')) as Promise<AdvertMedia[]>,
    getVendorProfile(advert.business_id),
  ]);
  return { advert: normAdvert(advert), media, vendor };
}
export async function listMyAdverts(businessId: string): Promise<(Advert & { cover_path: string | null })[]> {
  const ads = await q(requireSupabase().from('adverts').select(ADVERT_COLS).eq('business_id', businessId).order('updated_at', { ascending: false }).limit(100)) as Advert[];
  const media = ads.length ? await q(requireSupabase().from('advert_media').select('advert_id,storage_path,position,media_type').in('advert_id', ads.map((a) => a.id)).order('position')) as AdvertMedia[] : [];
  return ads.map((a) => ({ ...normAdvert(a), cover_path: media.find((m) => m.advert_id === a.id && m.media_type === 'image')?.storage_path ?? null }));
}
export async function listVendorAdverts(businessId: string): Promise<AdvertSummary[]> {
  const ads = await q(requireSupabase().from('adverts').select(ADVERT_COLS).eq('business_id', businessId).eq('status', 'published').order('published_at', { ascending: false }).limit(50)) as Advert[];
  const media = ads.length ? await q(requireSupabase().from('advert_media').select('advert_id,storage_path,position,media_type').in('advert_id', ads.map((a) => a.id)).order('position')) as AdvertMedia[] : [];
  return ads.map((a) => ({ ...normAdvert(a), vendor_name: '', vendor_verification: 'unverified', cover_path: media.find((m) => m.advert_id === a.id && m.media_type === 'image')?.storage_path ?? null }));
}
export async function createAdvert(businessId: string, userId: string, input: AdvertInput): Promise<Advert> {
  return normAdvert(await q(requireSupabase().from('adverts').insert({ ...input, business_id: businessId, created_by: userId }).select(ADVERT_COLS).single()) as Advert);
}
export async function updateAdvert(id: string, input: AdvertInput): Promise<Advert> {
  const rows = await q(requireSupabase().from('adverts').update(input).eq('id', id).select(ADVERT_COLS)) as Advert[];
  if (!rows.length) throw new AppError('FORBIDDEN', 'You cannot edit this advert.');
  return normAdvert(rows[0]);
}
export async function deleteAdvert(advert: { id: string; business_id: string }, media: AdvertMedia[]) {
  await q(requireSupabase().from('adverts').delete().eq('id', advert.id));
  if (media.length) await requireSupabase().storage.from('advert-media').remove(media.map((m) => m.storage_path));
}

/** Upload with real progress (XHR to the Storage REST API using the user's session). */
export async function uploadWithProgress(bucket: string, path: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  const db = requireSupabase();
  const { data } = await db.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('NOT_AUTHENTICATED', 'Please sign in again.');
  const base = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/$/, '');
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY as string);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 95)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(100); resolve(); return; }
      let msg = `upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).message ?? msg; } catch { /* ignore */ }
      reject(new AppError('UPLOAD_FAILED', /exceeded|too large|size/i.test(msg) ? 'That file is too big. Images must be under 10 MB.' : /mime|type/i.test(msg) ? 'That file type is not allowed. Use JPG, PNG, WebP or MP4.' : `The upload did not finish (${msg}).`, { retryable: true }));
    };
    xhr.onerror = () => reject(new AppError('NETWORK', 'The upload stopped because the connection dropped. Try again.', { retryable: true }));
    xhr.send(file);
  });
}

export async function uploadAdvertMedia(businessId: string, advertId: string, file: File, position: number, onProgress: (pct: number) => void): Promise<AdvertMedia> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const path = `${businessId}/${advertId}/${newId()}.${ext}`;
  await uploadWithProgress('advert-media', path, file, onProgress);
  try {
    return await q(requireSupabase().from('advert_media').insert({
      advert_id: advertId, business_id: businessId, storage_path: path,
      media_type: file.type.startsWith('video/') ? 'video' : 'image', position, size_bytes: file.size,
    }).select('id,advert_id,storage_path,media_type,position').single()) as AdvertMedia;
  } catch (e) {
    // Don't leave an orphaned file if the record couldn't be saved.
    await requireSupabase().storage.from('advert-media').remove([path]);
    throw e;
  }
}
export async function removeAdvertMedia(m: AdvertMedia) {
  await q(requireSupabase().from('advert_media').delete().eq('id', m.id));
  await requireSupabase().storage.from('advert-media').remove([m.storage_path]);
}
export async function uploadBusinessAsset(businessId: string, file: File, onProgress: (pct: number) => void): Promise<string> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const path = `${businessId}/${newId()}.${ext}`;
  await uploadWithProgress('business-assets', path, file, onProgress);
  return path;
}

// ---------------- Saved & reports ----------------
export async function isSaved(userId: string, advertId: string) {
  const rows = await q(requireSupabase().from('saved_adverts').select('advert_id').eq('user_id', userId).eq('advert_id', advertId)) as unknown[];
  return rows.length > 0;
}
export async function setSaved(userId: string, advertId: string, saved: boolean) {
  if (saved) await q(requireSupabase().from('saved_adverts').upsert({ user_id: userId, advert_id: advertId }));
  else await q(requireSupabase().from('saved_adverts').delete().eq('user_id', userId).eq('advert_id', advertId));
}
export async function report(userId: string, target: { advertId?: string; businessId?: string }, reason: string, details: string) {
  await q(requireSupabase().from('reports').insert({ reporter_id: userId, advert_id: target.advertId ?? null, business_id: target.businessId ?? null, reason, details: details || null }));
}

// ---------------- Connections ----------------
export interface Connection {
  id: string;
  requester_business_id: string;
  addressee_business_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
}
export async function listConnections(businessId: string): Promise<{ conn: Connection; other: VendorProfile | null; incoming: boolean }[]> {
  const rows = await q(requireSupabase().from('vendor_connections').select('id,requester_business_id,addressee_business_id,status,created_at')
    .or(`requester_business_id.eq.${businessId},addressee_business_id.eq.${businessId}`).order('created_at', { ascending: false })) as Connection[];
  const others = rows.map((c) => (c.requester_business_id === businessId ? c.addressee_business_id : c.requester_business_id));
  const profiles = await getVendorProfiles(others);
  return rows.map((c, i) => ({ conn: c, other: profiles.get(others[i]) ?? null, incoming: c.addressee_business_id === businessId }));
}
export async function connectionWith(businessId: string, other: string): Promise<Connection | null> {
  const rows = await q(requireSupabase().from('vendor_connections').select('id,requester_business_id,addressee_business_id,status,created_at')
    .or(`and(requester_business_id.eq.${businessId},addressee_business_id.eq.${other}),and(requester_business_id.eq.${other},addressee_business_id.eq.${businessId})`)) as Connection[];
  return rows[0] ?? null;
}
export const requestConnection = (businessId: string, target: string) => q(requireSupabase().rpc('request_connection', { p_business_id: businessId, p_target_business_id: target })) as Promise<Connection>;
export const respondConnection = (id: string, accept: boolean) => q(requireSupabase().rpc('respond_connection', { p_connection_id: id, p_accept: accept })) as Promise<Connection>;
export const removeConnection = (id: string) => q(requireSupabase().from('vendor_connections').delete().eq('id', id));
export const blockBusiness = (businessId: string, target: string) => q(requireSupabase().rpc('block_business', { p_business_id: businessId, p_target_business_id: target }));

// ---------------- Feed ----------------
export interface FeedPost {
  id: string;
  business_id: string;
  kind: 'update' | 'new_stock' | 'wholesale_offer' | 'announcement' | 'new_advert';
  body: string;
  advert_id: string | null;
  created_at: string;
  vendor: VendorProfile | null;
  likes: number;
  liked: boolean;
  comments: number;
}
export async function listFeed(userId: string, before?: string): Promise<FeedPost[]> {
  let query = requireSupabase().from('feed_posts').select('id,business_id,kind,body,advert_id,created_at').order('created_at', { ascending: false }).limit(PAGE_SIZE);
  if (before) query = query.lt('created_at', before);
  const posts = await q(query) as Omit<FeedPost, 'vendor' | 'likes' | 'liked' | 'comments'>[];
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const [profiles, reactions, comments] = await Promise.all([
    getVendorProfiles(posts.map((p) => p.business_id)),
    q(requireSupabase().from('feed_reactions').select('post_id,user_id').in('post_id', ids)) as Promise<{ post_id: string; user_id: string }[]>,
    q(requireSupabase().from('feed_comments').select('post_id').in('post_id', ids)) as Promise<{ post_id: string }[]>,
  ]);
  return posts.map((p) => ({
    ...p,
    vendor: profiles.get(p.business_id) ?? null,
    likes: reactions.filter((r) => r.post_id === p.id).length,
    liked: reactions.some((r) => r.post_id === p.id && r.user_id === userId),
    comments: comments.filter((c) => c.post_id === p.id).length,
  }));
}
export const createPost = (businessId: string, userId: string, kind: FeedPost['kind'], body: string, advertId?: string | null) =>
  q(requireSupabase().from('feed_posts').insert({ business_id: businessId, author_id: userId, kind, body, advert_id: advertId ?? null }));
export async function setLiked(postId: string, userId: string, liked: boolean) {
  if (liked) await q(requireSupabase().from('feed_reactions').upsert({ post_id: postId, user_id: userId }));
  else await q(requireSupabase().from('feed_reactions').delete().eq('post_id', postId).eq('user_id', userId));
}
export interface FeedComment { id: string; post_id: string; business_id: string; user_id: string; body: string; created_at: string; vendor_name?: string }
export async function listComments(postId: string): Promise<FeedComment[]> {
  const rows = await q(requireSupabase().from('feed_comments').select('id,post_id,business_id,user_id,body,created_at').eq('post_id', postId).order('created_at')) as FeedComment[];
  const profiles = await getVendorProfiles(rows.map((r) => r.business_id));
  return rows.map((r) => ({ ...r, vendor_name: profiles.get(r.business_id)?.display_name }));
}
export const addComment = (postId: string, businessId: string, userId: string, body: string) =>
  q(requireSupabase().from('feed_comments').insert({ post_id: postId, business_id: businessId, user_id: userId, body }));

// ---------------- Messaging ----------------
export interface InboxItem {
  id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  advert_id: string | null;
  other: VendorProfile | null;
  other_business_id: string;
  unread: boolean;
}
export async function listInbox(businessId: string): Promise<InboxItem[]> {
  const mine = await q(requireSupabase().from('conversation_participants').select('conversation_id,last_read_at').eq('business_id', businessId)) as { conversation_id: string; last_read_at: string | null }[];
  if (!mine.length) return [];
  const convIds = mine.map((m) => m.conversation_id);
  const [convs, parts] = await Promise.all([
    q(requireSupabase().from('conversations').select('id,last_message_at,last_message_preview,advert_id').in('id', convIds)) as Promise<{ id: string; last_message_at: string | null; last_message_preview: string | null; advert_id: string | null }[]>,
    q(requireSupabase().from('conversation_participants').select('conversation_id,business_id').in('conversation_id', convIds).neq('business_id', businessId)) as Promise<{ conversation_id: string; business_id: string }[]>,
  ]);
  const profiles = await getVendorProfiles(parts.map((p) => p.business_id));
  return convs.map((c) => {
    const other = parts.find((p) => p.conversation_id === c.id)?.business_id ?? '';
    const read = mine.find((m) => m.conversation_id === c.id)?.last_read_at;
    return { ...c, other_business_id: other, other: profiles.get(other) ?? null, unread: Boolean(c.last_message_at && (!read || read < c.last_message_at)) };
  }).sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
}
export const startConversation = (businessId: string, other: string, advertId?: string | null) =>
  q(requireSupabase().rpc('start_conversation', { p_business_id: businessId, p_other_business_id: other, p_advert_id: advertId ?? null })) as Promise<string>;

export interface Message {
  id: string;
  conversation_id: string;
  sender_business_id: string;
  sender_user_id: string | null;
  body: string;
  client_msg_id: string;
  created_at: string;
}
export async function listMessages(conversationId: string, before?: string): Promise<Message[]> {
  let query = requireSupabase().from('messages').select('id,conversation_id,sender_business_id,sender_user_id,body,client_msg_id,created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(40);
  if (before) query = query.lt('created_at', before);
  const rows = await q(query) as Message[];
  return rows.reverse();
}
export async function sendMessage(conversationId: string, businessId: string, userId: string, body: string, clientMsgId: string): Promise<Message> {
  const db = requireSupabase();
  const { data, error } = await db.from('messages').insert({ conversation_id: conversationId, sender_business_id: businessId, sender_user_id: userId, body, client_msg_id: clientMsgId })
    .select('id,conversation_id,sender_business_id,sender_user_id,body,client_msg_id,created_at').single();
  if (error) {
    if (error.code === '23505') {
      // Already delivered on a previous attempt (idempotent retry).
      return q(db.from('messages').select('id,conversation_id,sender_business_id,sender_user_id,body,client_msg_id,created_at').eq('conversation_id', conversationId).eq('client_msg_id', clientMsgId).single()) as Promise<Message>;
    }
    if (/row-level security/i.test(error.message)) throw new AppError('BLOCKED', 'This message could not be sent. The vendor may have blocked messages from your shop.');
    throw toAppError(error);
  }
  return data as Message;
}
export async function markRead(conversationId: string, businessId: string) {
  await requireSupabase().from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('business_id', businessId);
}
export function subscribeMessages(conversationId: string, onInsert: (m: Message) => void, onStatus: (s: string) => void): RealtimeChannel {
  // Unique topic per subscriber: supabase-js reuses channels by name and rejects callbacks added after subscribe().
  return requireSupabase().channel(`conv:${conversationId}:${newId()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, (payload) => onInsert(payload.new as Message))
    .subscribe((status) => onStatus(status));
}

// ---------------- Notifications ----------------
export interface Notification { id: string; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }
export async function listNotifications(): Promise<Notification[]> {
  return q(requireSupabase().from('notifications').select('id,kind,title,body,link,read_at,created_at').order('created_at', { ascending: false }).limit(30)) as Promise<Notification[]>;
}
export async function markNotificationsRead(ids: string[]) {
  if (ids.length) await requireSupabase().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
}
export async function unreadCount(): Promise<number> {
  const { count } = await requireSupabase().from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  return count ?? 0;
}
export function subscribeNotifications(userId: string, onInsert: () => void): RealtimeChannel {
  return requireSupabase().channel(`notif:${userId}:${newId()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, () => onInsert())
    .subscribe();
}
