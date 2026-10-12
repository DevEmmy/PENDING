-- Vendora core schema: identity, businesses, membership, inventory, sales, debts, invoices.
-- Financial tables are append-only from the client's perspective: writes go through
-- SECURITY DEFINER RPCs (see 0002) that validate membership/role and run in one transaction.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'manager', 'assistant');
create type public.app_language as enum ('en', 'pcm', 'yo', 'ig', 'ha');

-- ---------------------------------------------------------------------------
-- Utility: updated_at
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users). Passwords live only in auth.users.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,20}$'),
  preferred_language public.app_language not null default 'en',
  onboarding_step text not null default 'business'
    check (onboarding_step in ('business', 'products', 'voice_intro', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- Platform administrators (granted manually via SQL by the project owner).
create table public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Create profile reliably at signup. Idempotent so retries never fail or duplicate.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  lang text := coalesce(new.raw_user_meta_data ->> 'preferred_language', 'en');
begin
  if lang not in ('en', 'pcm', 'yo', 'ig', 'ha') then lang := 'en'; end if;
  insert into public.profiles (id, full_name, phone, preferred_language)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    lang::public.app_language
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Never block account creation on profile problems; the app's ensure_profile()
  -- RPC recreates a missing profile on first sign-in (recoverable onboarding path).
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Businesses & membership
-- ---------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  category text not null default 'other'
    check (category in ('foodstuff', 'clothing', 'electronics', 'pharmacy', 'cosmetics', 'other')),
  market_area text check (char_length(market_area) <= 120),
  city text check (char_length(city) <= 80),
  country text not null default 'NG',
  currency text not null default 'NGN',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger businesses_updated_at before update on public.businesses
  for each row execute function public.tg_set_updated_at();

create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

-- Authorization helpers. SECURITY DEFINER so policies can consult membership
-- without recursive RLS evaluation. They only ever answer about auth.uid().
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.member_role_in(p_business_id uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select role from public.business_members
  where business_id = p_business_id and user_id = auth.uid();
$$;

create or replace function public.is_member(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.business_members
                 where business_id = p_business_id and user_id = auth.uid());
$$;

create or replace function public.has_role(p_business_id uuid, p_roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.business_members
                 where business_id = p_business_id and user_id = auth.uid()
                   and role = any (p_roles));
$$;

create or replace function public.my_business_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select business_id from public.business_members where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Products & inventory
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  unit text not null default 'piece' check (char_length(unit) between 1 and 30),
  price numeric(14, 2) not null check (price >= 0),
  cost_price numeric(14, 2) check (cost_price is null or cost_price >= 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  image_url text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_unique_active_name
  on public.products (business_id, lower(name)) where archived_at is null;
create index products_business_idx on public.products (business_id) where archived_at is null;
create trigger products_updated_at before update on public.products
  for each row execute function public.tg_set_updated_at();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  kind text not null check (kind in ('opening', 'sale', 'restock', 'adjustment', 'sale_reversal')),
  quantity_delta integer not null check (quantity_delta <> 0),
  quantity_after integer not null check (quantity_after >= 0),
  unit_cost numeric(14, 2),
  reason text check (char_length(reason) <= 300),
  sale_id uuid,
  client_op_id text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index inventory_movements_product_idx on public.inventory_movements (product_id, created_at desc);
create unique index inventory_movements_op_idx
  on public.inventory_movements (business_id, client_op_id) where client_op_id is not null and kind in ('restock', 'adjustment', 'opening');

-- ---------------------------------------------------------------------------
-- Customers & debts
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  phone text check (phone is null or char_length(phone) <= 20),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_unique_name on public.customers (business_id, lower(name));
create trigger customers_updated_at before update on public.customers
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_op_id text not null check (char_length(client_op_id) between 8 and 64),
  customer_id uuid references public.customers (id) on delete set null,
  payment_method text not null check (payment_method in ('cash', 'transfer', 'pos', 'credit')),
  payment_status text not null check (payment_status in ('paid', 'part_paid', 'unpaid')),
  total_amount numeric(14, 2) not null check (total_amount >= 0),
  amount_paid numeric(14, 2) not null check (amount_paid >= 0),
  total_cost numeric(14, 2),
  channel text not null default 'pos' check (channel in ('pos', 'voice', 'manual', 'offline')),
  status text not null default 'completed' check (status in ('completed', 'reversed')),
  reversal_reason text check (char_length(reversal_reason) <= 300),
  reversed_at timestamptz,
  note text check (char_length(note) <= 300),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, client_op_id),
  check (amount_paid <= total_amount)
);
create index sales_business_time_idx on public.sales (business_id, created_at desc);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  unit text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  unit_cost numeric(14, 2),
  line_total numeric(14, 2) not null check (line_total >= 0)
);
create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_business_idx on public.sale_items (business_id, product_id);

alter table public.inventory_movements
  add constraint inventory_movements_sale_fk foreign key (sale_id) references public.sales (id) on delete set null;

-- Signed ledger: charge > 0, payment < 0, adjustment either sign. Balance = sum(amount).
create table public.debt_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind text not null check (kind in ('charge', 'payment', 'adjustment')),
  amount numeric(14, 2) not null check (amount <> 0),
  sale_id uuid references public.sales (id) on delete set null,
  client_op_id text,
  note text check (char_length(note) <= 300),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'charge' and amount > 0) or (kind = 'payment' and amount < 0) or kind = 'adjustment')
);
create index debt_transactions_customer_idx on public.debt_transactions (customer_id, created_at desc);
create unique index debt_transactions_op_idx
  on public.debt_transactions (business_id, client_op_id) where client_op_id is not null;

create view public.customer_balances with (security_invoker = true) as
  select c.id as customer_id, c.business_id, c.name, c.phone,
         coalesce(sum(d.amount), 0)::numeric(14, 2) as balance,
         max(d.created_at) as last_activity_at
  from public.customers c
  left join public.debt_transactions d on d.customer_id = c.id
  group by c.id;

-- ---------------------------------------------------------------------------
-- Invoices: gap-free per-business numbering via a locked counter row.
-- ---------------------------------------------------------------------------
create table public.invoice_counters (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  last_seq integer not null default 0
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  sale_id uuid not null unique references public.sales (id) on delete restrict,
  seq integer not null,
  invoice_number text not null,
  status text not null default 'issued' check (status in ('issued', 'void')),
  issued_at timestamptz not null default now(),
  issued_by uuid references auth.users (id) on delete set null,
  unique (business_id, seq),
  unique (business_id, invoice_number)
);

-- ---------------------------------------------------------------------------
-- Payments received (manual records; bank-feed confirmation not integrated yet)
-- ---------------------------------------------------------------------------
create table public.payments_received (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  payer_name text check (char_length(payer_name) <= 120),
  channel text not null check (channel in ('transfer', 'cash', 'pos')),
  source text not null default 'manual' check (source in ('manual', 'bank_feed')),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending_review', 'verified', 'rejected')),
  receipt_path text,
  sale_id uuid references public.sales (id) on delete set null,
  note text check (char_length(note) <= 300),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index payments_received_business_idx on public.payments_received (business_id, created_at desc);

-- Only platform admins (or a future server-side bank integration using the service role)
-- may mark a payment verified/rejected or claim a bank_feed source.
create or replace function public.tg_guard_payment_verification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if; -- service role / server context
  if public.is_admin() then return new; end if;
  if new.source <> 'manual' then
    raise exception 'Only the bank integration can create bank_feed payments' using errcode = '42501';
  end if;
  if new.verification_status in ('verified', 'rejected')
     and (tg_op = 'INSERT' or old.verification_status is distinct from new.verification_status) then
    raise exception 'Payments can only be verified by Vendora review or a bank integration' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.amount <> old.amount or new.business_id <> old.business_id) then
    raise exception 'Payment amount cannot be edited; record a correction instead' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payments_received_guard before insert or update on public.payments_received
  for each row execute function public.tg_guard_payment_verification();

-- ---------------------------------------------------------------------------
-- Audit, voice metadata, TTS usage
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id bigint generated always as identity primary key,
  business_id uuid references public.businesses (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  entity text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_business_idx on public.audit_events (business_id, created_at desc);

create or replace function public.write_audit(p_business_id uuid, p_action text, p_entity text, p_entity_id uuid, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (business_id, actor_id, action, entity, entity_id, details)
  values (p_business_id, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Metadata only: no transcript text or audio is stored.
create table public.voice_interactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  language public.app_language not null,
  input_mode text not null check (input_mode in ('voice', 'text')),
  intent text not null check (char_length(intent) <= 40),
  outcome text not null check (outcome in ('executed', 'answered', 'cancelled', 'clarified', 'failed')),
  created_at timestamptz not null default now()
);

create table public.tts_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  request_count integer not null default 0,
  char_count integer not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.app_admins enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.debt_transactions enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.payments_received enable row level security;
alter table public.audit_events enable row level security;
alter table public.voice_interactions enable row level security;
alter table public.tts_usage enable row level security;

-- profiles
create policy profiles_select_self on public.profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_select_teammates on public.profiles for select to authenticated
  using (exists (select 1 from public.business_members m
                 where m.user_id = profiles.id and m.business_id in (select public.my_business_ids())));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- app_admins: an admin may see the list; nobody writes via the API.
create policy app_admins_select on public.app_admins for select to authenticated using (public.is_admin());

-- businesses
create policy businesses_select_member on public.businesses for select to authenticated
  using (public.is_member(id));
create policy businesses_update_owner on public.businesses for update to authenticated
  using (public.has_role(id, array['owner', 'manager']::public.member_role[]))
  with check (public.has_role(id, array['owner', 'manager']::public.member_role[]));
-- creation goes through create_business() so the owner membership is atomic.

-- business_members
create policy members_select on public.business_members for select to authenticated
  using (user_id = auth.uid() or public.is_member(business_id));
create policy members_owner_update on public.business_members for update to authenticated
  using (public.has_role(business_id, array['owner']::public.member_role[]) and user_id <> auth.uid())
  with check (public.has_role(business_id, array['owner']::public.member_role[]) and role <> 'owner');
create policy members_owner_delete on public.business_members for delete to authenticated
  using (public.has_role(business_id, array['owner']::public.member_role[]) and user_id <> auth.uid());

-- products: everyone in the business reads; owners/managers manage catalogue fields.
create policy products_select on public.products for select to authenticated
  using (public.is_member(business_id));
create policy products_update on public.products for update to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]))
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy inventory_select on public.inventory_movements for select to authenticated
  using (public.is_member(business_id));

-- customers: any member can add/see customers (needed at the till); owners/managers edit.
create policy customers_select on public.customers for select to authenticated
  using (public.is_member(business_id));
create policy customers_insert on public.customers for insert to authenticated
  with check (public.is_member(business_id));
create policy customers_update on public.customers for update to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]))
  with check (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy sales_select on public.sales for select to authenticated using (public.is_member(business_id));
create policy sale_items_select on public.sale_items for select to authenticated using (public.is_member(business_id));
create policy debts_select on public.debt_transactions for select to authenticated using (public.is_member(business_id));
create policy invoices_select on public.invoices for select to authenticated using (public.is_member(business_id));

create policy payments_select on public.payments_received for select to authenticated
  using (public.is_member(business_id));
create policy payments_insert on public.payments_received for insert to authenticated
  with check (public.is_member(business_id) and recorded_by = auth.uid());
create policy payments_update on public.payments_received for update to authenticated
  using (public.is_member(business_id)) with check (public.is_member(business_id));

create policy audit_select on public.audit_events for select to authenticated
  using (public.has_role(business_id, array['owner', 'manager']::public.member_role[]));

create policy voice_insert on public.voice_interactions for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(business_id));
create policy voice_select on public.voice_interactions for select to authenticated
  using (user_id = auth.uid());

create policy tts_usage_select on public.tts_usage for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privileges: no anonymous access; financial/stock writes only via RPCs.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;

revoke insert, update, delete on public.inventory_movements, public.sales, public.sale_items,
  public.debt_transactions, public.invoices, public.invoice_counters, public.audit_events,
  public.tts_usage, public.app_admins, public.businesses, public.business_members, public.products
  from authenticated;
revoke insert, update, delete on public.profiles from authenticated;
revoke update on public.customers from authenticated;
grant update (name, phone, notes) on public.customers to authenticated;

-- Catalogue fields are editable; stock_quantity is only changed by RPCs that write a movement.
grant update (name, unit, price, cost_price, low_stock_threshold, image_url, archived_at)
  on public.products to authenticated;
grant update (name, category, market_area, city) on public.businesses to authenticated;
grant update (role) on public.business_members to authenticated;
grant delete on public.business_members to authenticated;
grant update (full_name, phone, preferred_language, onboarding_step) on public.profiles to authenticated;
revoke update on public.payments_received from authenticated;
grant update (verification_status, receipt_path, sale_id, note) on public.payments_received to authenticated;
revoke delete on public.payments_received, public.customers from authenticated;
