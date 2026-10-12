-- Vendors Hub: vendor profiles, adverts & media, discovery, connections, blocks, reports,
-- business feed, vendor-to-vendor messaging, notifications and verification review.

-- ---------------------------------------------------------------------------
-- Vendor profiles (one per business; created by create_business)
-- ---------------------------------------------------------------------------
create table public.vendor_profiles (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 120),
  description text check (char_length(description) <= 1000),
  category text not null default 'other',
  products_summary text check (char_length(products_summary) <= 300),
  market text check (char_length(market) <= 120),
  city text check (char_length(city) <= 80),
  state text check (char_length(state) <= 40),
  logo_path text,
  photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 8),
  contact_phone text check (char_length(contact_phone) <= 20),
  contact_whatsapp text check (char_length(contact_whatsapp) <= 20),
  allow_messages boolean not null default true,
  is_public boolean not null default false,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(description, '') || ' ' ||
                coalesce(products_summary, '') || ' ' || coalesce(market, '') || ' ' || coalesce(city, '') || ' ' ||
                coalesce(category, ''))) stored
);
create index vendor_profiles_search_idx on public.vendor_profiles using gin (search);
create trigger vendor_profiles_updated_at before update on public.vendor_profiles
  for each row execute function public.tg_set_updated_at();

-- Visible to other vendors? (public and not suspended)
create or replace function public.vendor_is_visible(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vendor_profiles
                 where business_id = p_business_id and is_public and verification_status <> 'suspended');
$$;

create table public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  submitted_by uuid not null references auth.users (id) on delete cascade,
  cac_number text check (char_length(cac_number) <= 30),
  notes text check (char_length(notes) <= 1000),
  document_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_note text check (char_length(reviewer_note) <= 500),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index verification_requests_one_pending
  on public.verification_requests (business_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Adverts
-- ---------------------------------------------------------------------------
create table public.adverts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  headline text not null check (char_length(headline) between 3 and 120),
  description text check (char_length(description) <= 2000),
  category text not null default 'other',
  product_name text check (char_length(product_name) <= 120),
  price_min numeric(14, 2) check (price_min is null or price_min >= 0),
  price_max numeric(14, 2) check (price_max is null or price_max >= 0),
  unit text check (char_length(unit) <= 30),
  min_order_qty integer check (min_order_qty is null or min_order_qty > 0),
  available_qty integer check (available_qty is null or available_qty >= 0),
  pricing_type text not null default 'retail' check (pricing_type in ('retail', 'wholesale', 'both')),
  market text check (char_length(market) <= 120),
  city text check (char_length(city) <= 80),
  state text check (char_length(state) <= 40),
  delivery_info text check (char_length(delivery_info) <= 300),
  allow_messages boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'published', 'paused')),
  moderation_status text not null default 'ok' check (moderation_status in ('ok', 'flagged', 'removed')),
  is_featured boolean not null default false,
  expires_at timestamptz,
  published_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('simple', coalesce(headline, '') || ' ' || coalesce(product_name, '') || ' ' ||
                coalesce(description, '') || ' ' || coalesce(category, '') || ' ' || coalesce(market, '') || ' ' ||
                coalesce(city, ''))) stored,
  check (price_max is null or price_min is null or price_max >= price_min)
);
create index adverts_search_idx on public.adverts using gin (search);
create index adverts_feed_idx on public.adverts (status, published_at desc) where status = 'published';
create index adverts_business_idx on public.adverts (business_id, updated_at desc);
create trigger adverts_updated_at before update on public.adverts
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_adverts_publish()
returns trigger language plpgsql as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    new.published_at := now();
  end if;
  return new;
end $$;
create trigger adverts_publish before insert or update on public.adverts
  for each row execute function public.tg_adverts_publish();

create table public.advert_media (
  id uuid primary key default gen_random_uuid(),
  advert_id uuid not null references public.adverts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  position smallint not null default 0 check (position between 0 and 9),
  size_bytes integer check (size_bytes > 0),
  created_at timestamptz not null default now(),
  unique (advert_id, storage_path)
);
create index advert_media_advert_idx on public.advert_media (advert_id, position);

create table public.saved_adverts (
  user_id uuid not null references auth.users (id) on delete cascade,
  advert_id uuid not null references public.adverts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, advert_id)
);

-- ---------------------------------------------------------------------------
-- Connections, blocks, reports
-- ---------------------------------------------------------------------------
create table public.vendor_connections (
  id uuid primary key default gen_random_uuid(),
  requester_business_id uuid not null references public.businesses (id) on delete cascade,
  addressee_business_id uuid not null references public.businesses (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_business_id <> addressee_business_id)
);
create unique index vendor_connections_pair
  on public.vendor_connections (least(requester_business_id, addressee_business_id),
                                greatest(requester_business_id, addressee_business_id));

create table public.business_blocks (
  blocker_business_id uuid not null references public.businesses (id) on delete cascade,
  blocked_business_id uuid not null references public.businesses (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_business_id, blocked_business_id),
  check (blocker_business_id <> blocked_business_id)
);

create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.business_blocks
                 where (blocker_business_id = p_a and blocked_business_id = p_b)
                    or (blocker_business_id = p_b and blocked_business_id = p_a));
$$;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users (id) on delete cascade,
  advert_id uuid references public.adverts (id) on delete set null,
  business_id uuid references public.businesses (id) on delete set null,
  reason text not null check (reason in ('scam', 'fake_product', 'wrong_price', 'offensive', 'spam', 'other')),
  details text check (char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  check (advert_id is not null or business_id is not null)
);

-- ---------------------------------------------------------------------------
-- Feed
-- ---------------------------------------------------------------------------
create table public.feed_posts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in ('update', 'new_stock', 'wholesale_offer', 'announcement', 'new_advert')),
  body text not null check (char_length(body) between 1 and 1000),
  advert_id uuid references public.adverts (id) on delete set null,
  created_at timestamptz not null default now()
);
create index feed_posts_time_idx on public.feed_posts (created_at desc);

create table public.feed_reactions (
  post_id uuid not null references public.feed_posts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.feed_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index feed_comments_post_idx on public.feed_comments (post_id, created_at);

create or replace function public.feed_post_visible(p_post_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.feed_posts f where f.id = p_post_id
                 and (public.vendor_is_visible(f.business_id) or public.is_member(f.business_id)));
$$;

-- ---------------------------------------------------------------------------
-- Messaging (participants are businesses; every member of a participating business can read)
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  advert_id uuid references public.adverts (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  last_message_preview text
);

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  last_read_at timestamptz,
  primary key (conversation_id, business_id)
);
create index conversation_participants_business_idx on public.conversation_participants (business_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_business_id uuid not null references public.businesses (id) on delete cascade,
  sender_user_id uuid references auth.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  client_msg_id text not null check (char_length(client_msg_id) between 8 and 64),
  created_at timestamptz not null default now(),
  unique (conversation_id, client_msg_id)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at desc);

create or replace function public.is_conversation_member(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversation_participants cp
                 join public.business_members m on m.business_id = cp.business_id
                 where cp.conversation_id = p_conversation_id and m.user_id = auth.uid());
$$;

create or replace function public.can_send_message(p_conversation_id uuid, p_sender_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_member(p_sender_business_id)
     and exists (select 1 from public.conversation_participants
                 where conversation_id = p_conversation_id and business_id = p_sender_business_id)
     and not exists (select 1 from public.conversation_participants other
                     where other.conversation_id = p_conversation_id
                       and other.business_id <> p_sender_business_id
                       and public.is_blocked_between(other.business_id, p_sender_business_id));
$$;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('message', 'connection_request', 'connection_accepted', 'verification', 'system')),
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create or replace function public.notify_business(p_business_id uuid, p_kind text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, business_id, kind, title, body, link)
  select m.user_id, p_business_id, p_kind, p_title, left(p_body, 200), p_link
  from public.business_members m
  where m.business_id = p_business_id and m.user_id is distinct from auth.uid();
$$;

create or replace function public.tg_message_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sender_name text;
  v_other uuid;
begin
  update public.conversations
     set last_message_at = new.created_at, last_message_preview = left(new.body, 120)
   where id = new.conversation_id;
  update public.conversation_participants set last_read_at = new.created_at
   where conversation_id = new.conversation_id and business_id = new.sender_business_id;
  select display_name into v_sender_name from public.vendor_profiles where business_id = new.sender_business_id;
  for v_other in select business_id from public.conversation_participants
                 where conversation_id = new.conversation_id and business_id <> new.sender_business_id loop
    perform public.notify_business(v_other, 'message', 'New message from ' || coalesce(v_sender_name, 'a vendor'),
                                   new.body, '/hub/messages/' || new.conversation_id);
  end loop;
  return new;
end $$;
create trigger messages_after_insert after insert on public.messages
  for each row execute function public.tg_message_after_insert();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
create or replace function public.search_adverts(
  p_query text default null, p_category text default null, p_location text default null,
  p_min_price numeric default null, p_max_price numeric default null, p_pricing_type text default null,
  p_sort text default 'relevance', p_limit integer default 20, p_offset integer default 0)
returns table (
  id uuid, business_id uuid, headline text, description text, category text, product_name text,
  price_min numeric, price_max numeric, unit text, min_order_qty integer, available_qty integer,
  pricing_type text, market text, city text, state text, delivery_info text, allow_messages boolean,
  is_featured boolean, published_at timestamptz, vendor_name text, vendor_verification text,
  cover_path text, rank real)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_tsq tsquery;
  v_words text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select string_agg(w || ':*', ' & ') into v_words
  from (select regexp_replace(lower(t), '[^[:alnum:]]', '', 'g') as w
        from regexp_split_to_table(coalesce(p_query, ''), '\s+') t) words
  where w <> '';
  if v_words is not null then v_tsq := to_tsquery('simple', v_words); end if;

  return query
  select a.id, a.business_id, a.headline, a.description, a.category, a.product_name,
         a.price_min, a.price_max, a.unit, a.min_order_qty, a.available_qty, a.pricing_type,
         a.market, a.city, a.state, a.delivery_info, a.allow_messages, a.is_featured, a.published_at,
         vp.display_name, vp.verification_status,
         (select m.storage_path from public.advert_media m where m.advert_id = a.id and m.media_type = 'image'
           order by m.position limit 1),
         (case when v_tsq is null then 0
               else ts_rank(a.search, v_tsq) + ts_rank(vp.search, v_tsq) * 0.5 end)::real
  from public.adverts a
  join public.vendor_profiles vp on vp.business_id = a.business_id
  where a.status = 'published' and a.moderation_status = 'ok'
    and (a.expires_at is null or a.expires_at > now())
    and vp.verification_status <> 'suspended'
    and (v_tsq is null or a.search @@ v_tsq or vp.search @@ v_tsq)
    and (p_category is null or a.category = p_category)
    and (p_pricing_type is null or a.pricing_type = p_pricing_type or a.pricing_type = 'both')
    and (p_location is null or a.market ilike '%' || p_location || '%' or a.city ilike '%' || p_location || '%'
         or a.state ilike '%' || p_location || '%')
    and (p_min_price is null or coalesce(a.price_max, a.price_min) >= p_min_price)
    and (p_max_price is null or coalesce(a.price_min, a.price_max) <= p_max_price)
  order by
    case when p_sort = 'relevance' then a.is_featured end desc nulls last,
    case when p_sort = 'relevance' and v_tsq is not null
         then ts_rank(a.search, v_tsq) + ts_rank(vp.search, v_tsq) * 0.5 end desc nulls last,
    case when p_sort = 'price_low' then coalesce(a.price_min, a.price_max) end asc nulls last,
    case when p_sort = 'price_high' then coalesce(a.price_max, a.price_min) end desc nulls last,
    a.published_at desc, a.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.search_vendors(p_query text default null, p_location text default null,
                                                 p_category text default null, p_limit integer default 20,
                                                 p_offset integer default 0)
returns setof public.vendor_profiles language plpgsql stable security invoker set search_path = '' as $$
declare
  v_tsq tsquery;
  v_words text;
begin
  select string_agg(w || ':*', ' & ') into v_words
  from (select regexp_replace(lower(t), '[^[:alnum:]]', '', 'g') as w
        from regexp_split_to_table(coalesce(p_query, ''), '\s+') t) words where w <> '';
  if v_words is not null then v_tsq := to_tsquery('simple', v_words); end if;
  return query
  select vp.* from public.vendor_profiles vp
  where vp.is_public and vp.verification_status <> 'suspended'
    and (v_tsq is null or vp.search @@ v_tsq)
    and (p_category is null or vp.category = p_category)
    and (p_location is null or vp.market ilike '%' || p_location || '%' or vp.city ilike '%' || p_location || '%'
         or vp.state ilike '%' || p_location || '%')
  order by case when v_tsq is not null then ts_rank(vp.search, v_tsq) end desc nulls last,
           (vp.verification_status = 'verified') desc, vp.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Rule-based recommendations: public vendors in the same city/market or category,
-- with at least one live advert, excluding self, blocked and already-connected businesses.
create or replace function public.recommended_vendors(p_business_id uuid, p_limit integer default 6)
returns setof public.vendor_profiles language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.vendor_profiles;
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  select * into v_me from public.vendor_profiles where business_id = p_business_id;
  return query
  select vp.* from public.vendor_profiles vp
  where vp.business_id <> p_business_id and vp.is_public and vp.verification_status <> 'suspended'
    and not public.is_blocked_between(vp.business_id, p_business_id)
    and not exists (select 1 from public.vendor_connections c
                    where least(c.requester_business_id, c.addressee_business_id) = least(vp.business_id, p_business_id)
                      and greatest(c.requester_business_id, c.addressee_business_id) = greatest(vp.business_id, p_business_id))
    and exists (select 1 from public.adverts a where a.business_id = vp.business_id and a.status = 'published'
                and a.moderation_status = 'ok' and (a.expires_at is null or a.expires_at > now()))
    and (vp.category = v_me.category or (v_me.city is not null and vp.city ilike v_me.city)
         or (v_me.market is not null and vp.market ilike v_me.market))
  order by (vp.verification_status = 'verified') desc,
           ((v_me.market is not null and vp.market ilike v_me.market))::int desc, vp.updated_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 20);
end $$;

create or replace function public.request_connection(p_business_id uuid, p_target_business_id uuid)
returns public.vendor_connections language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.vendor_connections;
  v_name text;
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_business_id = p_target_business_id then perform public.invalid_input('You cannot connect with yourself.'); end if;
  if not public.vendor_is_visible(p_target_business_id) then
    raise exception using errcode = 'P0001', message = 'VENDOR_NOT_FOUND', hint = 'That vendor is not available.';
  end if;
  if public.is_blocked_between(p_business_id, p_target_business_id) then
    raise exception using errcode = '42501', message = 'BLOCKED', hint = 'You cannot connect with this vendor.';
  end if;
  select * into v_conn from public.vendor_connections
   where least(requester_business_id, addressee_business_id) = least(p_business_id, p_target_business_id)
     and greatest(requester_business_id, addressee_business_id) = greatest(p_business_id, p_target_business_id);
  if found then
    -- A declined request may be re-sent by the original requester; a pending incoming one is accepted.
    if v_conn.status = 'pending' and v_conn.addressee_business_id = p_business_id then
      update public.vendor_connections set status = 'accepted', responded_at = now()
       where id = v_conn.id returning * into v_conn;
    elsif v_conn.status = 'declined' and v_conn.requester_business_id = p_business_id then
      update public.vendor_connections set status = 'pending', created_at = now(), responded_at = null
       where id = v_conn.id returning * into v_conn;
    end if;
    return v_conn;
  end if;
  insert into public.vendor_connections (requester_business_id, addressee_business_id, requested_by)
  values (p_business_id, p_target_business_id, auth.uid()) returning * into v_conn;
  select display_name into v_name from public.vendor_profiles where business_id = p_business_id;
  perform public.notify_business(p_target_business_id, 'connection_request', coalesce(v_name, 'A vendor') || ' wants to connect',
                                 null, '/hub/connections');
  return v_conn;
end $$;

create or replace function public.respond_connection(p_connection_id uuid, p_accept boolean)
returns public.vendor_connections language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.vendor_connections;
  v_name text;
begin
  select * into v_conn from public.vendor_connections where id = p_connection_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  perform public.require_role(v_conn.addressee_business_id, array['owner', 'manager']::public.member_role[]);
  if v_conn.status <> 'pending' then return v_conn; end if;
  update public.vendor_connections set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now() where id = p_connection_id returning * into v_conn;
  if p_accept then
    select display_name into v_name from public.vendor_profiles where business_id = v_conn.addressee_business_id;
    perform public.notify_business(v_conn.requester_business_id, 'connection_accepted',
                                   coalesce(v_name, 'A vendor') || ' accepted your connection', null, '/hub/connections');
  end if;
  return v_conn;
end $$;

create or replace function public.block_business(p_business_id uuid, p_target_business_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_business_id = p_target_business_id then perform public.invalid_input('You cannot block yourself.'); end if;
  insert into public.business_blocks (blocker_business_id, blocked_business_id)
  values (p_business_id, p_target_business_id) on conflict do nothing;
  delete from public.vendor_connections
   where least(requester_business_id, addressee_business_id) = least(p_business_id, p_target_business_id)
     and greatest(requester_business_id, addressee_business_id) = greatest(p_business_id, p_target_business_id);
end $$;

create or replace function public.start_conversation(p_business_id uuid, p_other_business_id uuid, p_advert_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_conv uuid;
  v_allow boolean;
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  if p_business_id = p_other_business_id then perform public.invalid_input('You cannot message yourself.'); end if;
  if public.is_blocked_between(p_business_id, p_other_business_id) then
    raise exception using errcode = '42501', message = 'BLOCKED', hint = 'You cannot message this vendor.';
  end if;
  select allow_messages into v_allow from public.vendor_profiles
   where business_id = p_other_business_id and is_public and verification_status <> 'suspended';
  if not found then
    raise exception using errcode = 'P0001', message = 'VENDOR_NOT_FOUND', hint = 'That vendor is not available.';
  end if;
  -- Reuse the existing 1:1 thread between these two businesses.
  select cp1.conversation_id into v_conv
  from public.conversation_participants cp1
  join public.conversation_participants cp2 on cp2.conversation_id = cp1.conversation_id
  where cp1.business_id = p_business_id and cp2.business_id = p_other_business_id
  limit 1;
  if v_conv is not null then return v_conv; end if;
  if not v_allow then
    raise exception using errcode = 'P0001', message = 'MESSAGES_DISABLED', hint = 'This vendor is not accepting messages.';
  end if;
  insert into public.conversations (advert_id, created_by) values (p_advert_id, auth.uid()) returning id into v_conv;
  insert into public.conversation_participants (conversation_id, business_id)
  values (v_conv, p_business_id), (v_conv, p_other_business_id);
  return v_conv;
end $$;

create or replace function public.request_vendor_verification(p_business_id uuid, p_cac_number text, p_notes text,
                                                              p_document_path text default null)
returns public.verification_requests language plpgsql security definer set search_path = '' as $$
declare
  v_req public.verification_requests;
begin
  perform public.require_role(p_business_id, array['owner']::public.member_role[]);
  if exists (select 1 from public.vendor_profiles where business_id = p_business_id
             and verification_status in ('verified', 'suspended')) then
    perform public.invalid_input('This business cannot request verification right now.');
  end if;
  insert into public.verification_requests (business_id, submitted_by, cac_number, notes, document_path)
  values (p_business_id, auth.uid(), nullif(trim(p_cac_number), ''), nullif(trim(p_notes), ''), p_document_path)
  returning * into v_req;
  -- "pending" means submitted for review. It is NOT a verified badge.
  update public.vendor_profiles set verification_status = 'pending' where business_id = p_business_id;
  return v_req;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'ALREADY_PENDING', hint = 'Your verification request is already being reviewed.';
end $$;

-- Only platform admins can decide verification. A vendor can never grant themselves a badge.
create or replace function public.review_verification(p_request_id uuid, p_approve boolean, p_note text default null)
returns public.verification_requests language plpgsql security definer set search_path = '' as $$
declare
  v_req public.verification_requests;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'FORBIDDEN', hint = 'Only Vendora reviewers can do this.';
  end if;
  update public.verification_requests
     set status = case when p_approve then 'approved' else 'rejected' end, reviewer_note = p_note,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_request_id and status = 'pending' returning * into v_req;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  update public.vendor_profiles
     set verification_status = case when p_approve then 'verified' else 'rejected' end,
         verified_at = case when p_approve then now() else null end
   where business_id = v_req.business_id;
  perform public.notify_business(v_req.business_id, 'verification',
    case when p_approve then 'Your business is now verified' else 'Verification was not approved' end, p_note, '/profile');
  return v_req;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.vendor_profiles enable row level security;
alter table public.verification_requests enable row level security;
alter table public.adverts enable row level security;
alter table public.advert_media enable row level security;
alter table public.saved_adverts enable row level security;
alter table public.vendor_connections enable row level security;
alter table public.business_blocks enable row level security;
alter table public.reports enable row level security;
alter table public.feed_posts enable row level security;
alter table public.feed_reactions enable row level security;
alter table public.feed_comments enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;

create policy vendor_profiles_select on public.vendor_profiles for select to authenticated
  using (public.is_member(business_id) or public.is_admin()
         or (is_public and verification_status <> 'suspended')
         or exists (select 1 from public.conversation_participants cp
                    where cp.business_id = vendor_profiles.business_id
                      and public.is_conversation_member(cp.conversation_id)));
create policy vendor_profiles_update on public.vendor_profiles for update to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]))
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy verification_select on public.verification_requests for select to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]) or public.is_admin());

create policy adverts_select on public.adverts for select to authenticated
  using (public.is_member(business_id) or public.is_admin()
         or (status = 'published' and moderation_status = 'ok' and (expires_at is null or expires_at > now())
             and public.vendor_is_visible(business_id)));
create policy adverts_insert on public.adverts for insert to authenticated
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]) and created_by = auth.uid());
create policy adverts_update on public.adverts for update to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]))
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));
create policy adverts_delete on public.adverts for delete to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy advert_media_select on public.advert_media for select to authenticated
  using (exists (select 1 from public.adverts a where a.id = advert_media.advert_id));
create policy advert_media_insert on public.advert_media for insert to authenticated
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[])
              and exists (select 1 from public.adverts a where a.id = advert_id and a.business_id = advert_media.business_id)
              and split_part(storage_path, '/', 1) = business_id::text);
create policy advert_media_delete on public.advert_media for delete to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy saved_adverts_all on public.saved_adverts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy connections_select on public.vendor_connections for select to authenticated
  using (public.is_member(requester_business_id) or public.is_member(addressee_business_id));
create policy connections_delete on public.vendor_connections for delete to authenticated
  using (public.has_role(requester_business_id, array['owner', 'manager']::public.member_role[])
         or public.has_role(addressee_business_id, array['owner', 'manager']::public.member_role[]));

create policy blocks_select on public.business_blocks for select to authenticated
  using (public.is_member(blocker_business_id));
create policy blocks_delete on public.business_blocks for delete to authenticated
  using (public.has_role(blocker_business_id, array['owner', 'manager']::public.member_role[]));

create policy reports_insert on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy reports_select on public.reports for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

create policy feed_select on public.feed_posts for select to authenticated
  using (public.vendor_is_visible(business_id) or public.is_member(business_id));
create policy feed_insert on public.feed_posts for insert to authenticated
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]) and author_id = auth.uid()
              and (advert_id is null or exists (select 1 from public.adverts a
                                                where a.id = advert_id and a.business_id = feed_posts.business_id)));
create policy feed_delete on public.feed_posts for delete to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy reactions_select on public.feed_reactions for select to authenticated
  using (public.feed_post_visible(post_id));
create policy reactions_insert on public.feed_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.feed_post_visible(post_id));
create policy reactions_delete on public.feed_reactions for delete to authenticated using (user_id = auth.uid());

create policy comments_select on public.feed_comments for select to authenticated
  using (public.feed_post_visible(post_id));
create policy comments_insert on public.feed_comments for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(business_id) and public.feed_post_visible(post_id));
create policy comments_delete on public.feed_comments for delete to authenticated using (user_id = auth.uid());

create policy conversations_select on public.conversations for select to authenticated
  using (public.is_conversation_member(id));
create policy participants_select on public.conversation_participants for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy participants_update on public.conversation_participants for update to authenticated
  using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy messages_select on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_user_id = auth.uid() and public.can_send_message(conversation_id, sender_business_id));

create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.vendor_profiles, public.verification_requests, public.adverts, public.advert_media,
  public.saved_adverts, public.vendor_connections, public.business_blocks, public.reports, public.feed_posts,
  public.feed_reactions, public.feed_comments, public.conversations, public.conversation_participants,
  public.messages, public.notifications from anon;

revoke insert, update, delete on public.vendor_profiles, public.verification_requests, public.vendor_connections,
  public.business_blocks, public.conversations, public.conversation_participants, public.messages,
  public.notifications, public.adverts from authenticated;

-- verification_status / verified_at deliberately excluded: only review_verification() changes them.
grant update (display_name, description, category, products_summary, market, city, state, logo_path, photo_paths,
              contact_phone, contact_whatsapp, allow_messages, is_public) on public.vendor_profiles to authenticated;
-- moderation_status / is_featured / published_at excluded: platform-controlled.
grant insert (business_id, headline, description, category, product_name, price_min, price_max, unit, min_order_qty,
              available_qty, pricing_type, market, city, state, delivery_info, allow_messages, status, expires_at,
              created_by) on public.adverts to authenticated;
grant update (headline, description, category, product_name, price_min, price_max, unit, min_order_qty,
              available_qty, pricing_type, market, city, state, delivery_info, allow_messages, status, expires_at)
  on public.adverts to authenticated;
grant delete on public.adverts, public.vendor_connections, public.business_blocks to authenticated;
grant insert (conversation_id, sender_business_id, sender_user_id, body, client_msg_id) on public.messages to authenticated;
grant update (last_read_at) on public.conversation_participants to authenticated;
grant update (read_at) on public.notifications to authenticated;
revoke update on public.advert_media, public.feed_posts, public.feed_comments, public.reports from authenticated;

revoke all on function public.search_adverts(text, text, text, numeric, numeric, text, text, integer, integer),
  public.search_vendors(text, text, text, integer, integer), public.recommended_vendors(uuid, integer),
  public.request_connection(uuid, uuid), public.respond_connection(uuid, boolean), public.block_business(uuid, uuid),
  public.start_conversation(uuid, uuid, uuid), public.request_vendor_verification(uuid, text, text, text),
  public.review_verification(uuid, boolean, text) from public, anon;
grant execute on function public.search_adverts(text, text, text, numeric, numeric, text, text, integer, integer),
  public.search_vendors(text, text, text, integer, integer), public.recommended_vendors(uuid, integer),
  public.request_connection(uuid, uuid), public.respond_connection(uuid, boolean), public.block_business(uuid, uuid),
  public.start_conversation(uuid, uuid, uuid), public.request_vendor_verification(uuid, text, text, text),
  public.review_verification(uuid, boolean, text) to authenticated;
revoke all on function public.notify_business(uuid, text, text, text, text) from public, anon, authenticated;
