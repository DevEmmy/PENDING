-- Transactional business operations. Every function:
--   * requires an authenticated user and checks membership/role explicitly,
--   * runs in a single transaction (any exception rolls back everything),
--   * is idempotent on a client-supplied operation id where retries are possible,
--   * raises errors with a machine-readable MESSAGE code, JSON DETAIL and human HINT.
-- Error codes: NOT_AUTHENTICATED, FORBIDDEN, INVALID_INPUT, PRODUCT_NOT_FOUND,
--   INSUFFICIENT_STOCK, CUSTOMER_REQUIRED, CUSTOMER_NOT_FOUND, DUPLICATE_NAME,
--   SALE_NOT_FOUND, SALE_ALREADY_REVERSED, PAYMENT_EXCEEDS_BALANCE, USER_NOT_FOUND,
--   ALREADY_MEMBER, LIMIT_REACHED

create or replace function public.require_role(p_business_id uuid, p_roles public.member_role[])
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED', hint = 'Please sign in again.';
  end if;
  if not public.has_role(p_business_id, p_roles) then
    raise exception using errcode = '42501', message = 'FORBIDDEN',
      hint = 'Your role in this business does not allow this action.';
  end if;
end $$;

create or replace function public.invalid_input(p_hint text)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'INVALID_INPUT', hint = p_hint;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles & businesses
-- ---------------------------------------------------------------------------
create or replace function public.ensure_profile()
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_meta jsonb;
  v_lang text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if found then return v_profile; end if;
  select raw_user_meta_data into v_meta from auth.users where id = auth.uid();
  v_lang := coalesce(v_meta ->> 'preferred_language', 'en');
  if v_lang not in ('en', 'pcm', 'yo', 'ig', 'ha') then v_lang := 'en'; end if;
  insert into public.profiles (id, full_name, phone, preferred_language)
  values (auth.uid(), left(coalesce(v_meta ->> 'full_name', ''), 120),
          nullif(v_meta ->> 'phone', ''), v_lang::public.app_language)
  on conflict (id) do nothing;
  select * into v_profile from public.profiles where id = auth.uid();
  return v_profile;
end $$;

create or replace function public.create_business(
  p_name text, p_category text default 'other', p_market_area text default null, p_city text default null)
returns public.businesses language plpgsql security definer set search_path = '' as $$
declare
  v_business public.businesses;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  perform public.ensure_profile();
  if p_name is null or char_length(trim(p_name)) < 2 then
    perform public.invalid_input('Business name must have at least 2 characters.');
  end if;
  if (select count(*) from public.business_members where user_id = auth.uid() and role = 'owner') >= 5 then
    raise exception using errcode = 'P0001', message = 'LIMIT_REACHED', hint = 'You can own up to 5 businesses.';
  end if;
  insert into public.businesses (name, category, market_area, city, created_by)
  values (trim(p_name), coalesce(nullif(p_category, ''), 'other'), nullif(trim(p_market_area), ''),
          nullif(trim(p_city), ''), auth.uid())
  returning * into v_business;
  insert into public.business_members (business_id, user_id, role) values (v_business.id, auth.uid(), 'owner');
  insert into public.invoice_counters (business_id) values (v_business.id);
  insert into public.vendor_profiles (business_id, display_name, category, market, city)
  values (v_business.id, v_business.name, v_business.category, v_business.market_area, v_business.city);
  update public.profiles set onboarding_step = 'products'
    where id = auth.uid() and onboarding_step = 'business';
  perform public.write_audit(v_business.id, 'business.created', 'business', v_business.id, '{}'::jsonb);
  return v_business;
end $$;

create or replace function public.add_team_member(p_business_id uuid, p_email text, p_role public.member_role)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  perform public.require_role(p_business_id, array['owner']::public.member_role[]);
  if p_role = 'owner' then perform public.invalid_input('A business can only have one owner.'); end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0001', message = 'USER_NOT_FOUND',
      hint = 'Ask them to create a Vendora account with this email first.';
  end if;
  if exists (select 1 from public.business_members where business_id = p_business_id and user_id = v_user) then
    raise exception using errcode = 'P0001', message = 'ALREADY_MEMBER', hint = 'This person is already on your team.';
  end if;
  insert into public.business_members (business_id, user_id, role) values (p_business_id, v_user, p_role);
  perform public.write_audit(p_business_id, 'member.added', 'user', v_user, jsonb_build_object('role', p_role));
  return jsonb_build_object('user_id', v_user, 'role', p_role);
end $$;

-- ---------------------------------------------------------------------------
-- Products & stock
-- ---------------------------------------------------------------------------
create or replace function public.create_product(
  p_business_id uuid, p_name text, p_unit text, p_price numeric,
  p_cost_price numeric default null, p_low_stock_threshold integer default 5,
  p_opening_quantity integer default 0, p_client_op_id text default null)
returns public.products language plpgsql security definer set search_path = '' as $$
declare
  v_product public.products;
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_name is null or char_length(trim(p_name)) = 0 then perform public.invalid_input('Product name is required.'); end if;
  if p_price is null or p_price < 0 then perform public.invalid_input('Selling price must be zero or more.'); end if;
  if p_cost_price is not null and p_cost_price < 0 then perform public.invalid_input('Cost price cannot be negative.'); end if;
  if coalesce(p_opening_quantity, 0) < 0 then perform public.invalid_input('Opening stock cannot be negative.'); end if;
  begin
    insert into public.products (business_id, name, unit, price, cost_price, low_stock_threshold, stock_quantity)
    values (p_business_id, trim(p_name), coalesce(nullif(trim(p_unit), ''), 'piece'), round(p_price, 2),
            round(p_cost_price, 2), coalesce(p_low_stock_threshold, 5), coalesce(p_opening_quantity, 0))
    returning * into v_product;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_NAME',
      hint = format('You already have a product called "%s".', trim(p_name));
  end;
  if coalesce(p_opening_quantity, 0) > 0 then
    insert into public.inventory_movements (business_id, product_id, kind, quantity_delta, quantity_after,
                                            unit_cost, client_op_id, created_by)
    values (p_business_id, v_product.id, 'opening', p_opening_quantity, p_opening_quantity,
            p_cost_price, p_client_op_id, auth.uid());
  end if;
  perform public.write_audit(p_business_id, 'product.created', 'product', v_product.id,
                             jsonb_build_object('opening_quantity', coalesce(p_opening_quantity, 0)));
  return v_product;
end $$;

create or replace function public.restock_product(
  p_business_id uuid, p_product_id uuid, p_quantity integer,
  p_unit_cost numeric default null, p_client_op_id text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_product public.products;
  v_after integer;
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    perform public.invalid_input('Restock quantity must be a whole number above zero.');
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then perform public.invalid_input('Cost cannot be negative.'); end if;
  if p_client_op_id is not null and exists (
       select 1 from public.inventory_movements
       where business_id = p_business_id and client_op_id = p_client_op_id and kind = 'restock') then
    select * into v_product from public.products where id = p_product_id;
    return jsonb_build_object('duplicate', true, 'product_id', v_product.id, 'name', v_product.name,
                              'unit', v_product.unit, 'stock_quantity', v_product.stock_quantity);
  end if;
  select * into v_product from public.products
    where id = p_product_id and business_id = p_business_id and archived_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND', hint = 'That product no longer exists.';
  end if;
  update public.products
     set stock_quantity = stock_quantity + p_quantity,
         cost_price = coalesce(round(p_unit_cost, 2), cost_price)
   where id = p_product_id
   returning stock_quantity into v_after;
  insert into public.inventory_movements (business_id, product_id, kind, quantity_delta, quantity_after,
                                          unit_cost, reason, client_op_id, created_by)
  values (p_business_id, p_product_id, 'restock', p_quantity, v_after, p_unit_cost, p_note, p_client_op_id, auth.uid());
  return jsonb_build_object('duplicate', false, 'product_id', v_product.id, 'name', v_product.name,
                            'unit', v_product.unit, 'stock_quantity', v_after);
end $$;

create or replace function public.adjust_stock(
  p_business_id uuid, p_product_id uuid, p_new_quantity integer, p_reason text, p_client_op_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_product public.products;
  v_delta integer;
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_new_quantity is null or p_new_quantity < 0 then perform public.invalid_input('Stock count cannot be negative.'); end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    perform public.invalid_input('Please say why the stock count is changing (e.g. "damaged", "recount").');
  end if;
  if p_client_op_id is not null and exists (
       select 1 from public.inventory_movements
       where business_id = p_business_id and client_op_id = p_client_op_id and kind = 'adjustment') then
    select * into v_product from public.products where id = p_product_id;
    return jsonb_build_object('duplicate', true, 'product_id', v_product.id, 'stock_quantity', v_product.stock_quantity);
  end if;
  select * into v_product from public.products
    where id = p_product_id and business_id = p_business_id and archived_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND', hint = 'That product no longer exists.';
  end if;
  v_delta := p_new_quantity - v_product.stock_quantity;
  if v_delta = 0 then
    return jsonb_build_object('duplicate', false, 'unchanged', true, 'product_id', v_product.id,
                              'stock_quantity', v_product.stock_quantity);
  end if;
  update public.products set stock_quantity = p_new_quantity where id = p_product_id;
  insert into public.inventory_movements (business_id, product_id, kind, quantity_delta, quantity_after,
                                          reason, client_op_id, created_by)
  values (p_business_id, p_product_id, 'adjustment', v_delta, p_new_quantity, trim(p_reason), p_client_op_id, auth.uid());
  perform public.write_audit(p_business_id, 'stock.adjusted', 'product', p_product_id,
                             jsonb_build_object('from', v_product.stock_quantity, 'to', p_new_quantity, 'reason', trim(p_reason)));
  return jsonb_build_object('duplicate', false, 'product_id', v_product.id, 'name', v_product.name,
                            'stock_quantity', p_new_quantity, 'delta', v_delta);
end $$;

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create or replace function public.sale_result(p_sale_id uuid, p_duplicate boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sale_id', s.id, 'duplicate', p_duplicate, 'total_amount', s.total_amount,
    'amount_paid', s.amount_paid, 'payment_status', s.payment_status, 'payment_method', s.payment_method,
    'customer_id', s.customer_id, 'created_at', s.created_at, 'status', s.status,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', i.product_id, 'product_name', i.product_name, 'unit', i.unit,
               'quantity', i.quantity, 'unit_price', i.unit_price, 'line_total', i.line_total,
               'stock_remaining', p.stock_quantity, 'low_stock_threshold', p.low_stock_threshold)
             order by i.product_name)
      from public.sale_items i left join public.products p on p.id = i.product_id
      where i.sale_id = s.id), '[]'::jsonb))
  from public.sales s where s.id = p_sale_id;
$$;

create or replace function public.record_sale(
  p_business_id uuid, p_client_op_id text, p_items jsonb, p_payment_method text,
  p_amount_paid numeric default null, p_customer_id uuid default null,
  p_channel text default 'pos', p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_sale_id uuid;
  v_item jsonb;
  v_product public.products;
  v_qty integer;
  v_price numeric(14, 2);
  v_line numeric(14, 2);
  v_after integer;
  v_total numeric(14, 2) := 0;
  v_cost numeric(14, 2) := 0;
  v_cost_known boolean := true;
  v_paid numeric(14, 2);
  v_status text;
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  if p_client_op_id is null or char_length(p_client_op_id) not between 8 and 64 then
    perform public.invalid_input('Missing operation id.');
  end if;

  -- Idempotency: a retried submission returns the original sale instead of selling twice.
  select id into v_existing from public.sales where business_id = p_business_id and client_op_id = p_client_op_id;
  if found then return public.sale_result(v_existing, true); end if;

  if p_payment_method not in ('cash', 'transfer', 'pos', 'credit') then
    perform public.invalid_input('Choose cash, transfer, POS or credit.');
  end if;
  if coalesce(p_channel, 'pos') not in ('pos', 'voice', 'manual', 'offline') then
    perform public.invalid_input('Unknown sale channel.');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    perform public.invalid_input('A sale needs between 1 and 50 items.');
  end if;
  if p_customer_id is not null and not exists (
       select 1 from public.customers where id = p_customer_id and business_id = p_business_id) then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_NOT_FOUND', hint = 'That customer was not found.';
  end if;

  -- Lock every product in a stable order to avoid deadlocks between concurrent tills.
  perform 1 from public.products
   where business_id = p_business_id
     and id in (select (x ->> 'product_id')::uuid from jsonb_array_elements(p_items) x)
   order by id for update;

  insert into public.sales (business_id, client_op_id, customer_id, payment_method, payment_status,
                            total_amount, amount_paid, channel, note, recorded_by)
  values (p_business_id, p_client_op_id, p_customer_id, p_payment_method, 'paid', 0, 0,
          coalesce(p_channel, 'pos'), nullif(trim(p_note), ''), auth.uid())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_qty := (v_item ->> 'quantity')::integer;
    exception when others then
      perform public.invalid_input('Quantities must be whole numbers.');
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      perform public.invalid_input('Each quantity must be a whole number above zero.');
    end if;
    select * into v_product from public.products
     where id = (v_item ->> 'product_id')::uuid and business_id = p_business_id and archived_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND',
        hint = 'One of the products in this sale no longer exists.';
    end if;
    v_price := round(coalesce((v_item ->> 'unit_price')::numeric, v_product.price), 2);
    if v_price < 0 then perform public.invalid_input('Prices cannot be negative.'); end if;
    if v_product.stock_quantity < v_qty then
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_STOCK',
        detail = jsonb_build_object('product_id', v_product.id, 'name', v_product.name, 'unit', v_product.unit,
                                    'available', v_product.stock_quantity, 'requested', v_qty)::text,
        hint = format('Only %s %s of %s left.', v_product.stock_quantity, v_product.unit, v_product.name);
    end if;
    update public.products set stock_quantity = stock_quantity - v_qty
     where id = v_product.id returning stock_quantity into v_after;
    v_line := round(v_qty * v_price, 2);
    insert into public.sale_items (sale_id, business_id, product_id, product_name, unit, quantity,
                                   unit_price, unit_cost, line_total)
    values (v_sale_id, p_business_id, v_product.id, v_product.name, v_product.unit, v_qty,
            v_price, v_product.cost_price, v_line);
    insert into public.inventory_movements (business_id, product_id, kind, quantity_delta, quantity_after,
                                            unit_cost, sale_id, created_by)
    values (p_business_id, v_product.id, 'sale', -v_qty, v_after, v_product.cost_price, v_sale_id, auth.uid());
    v_total := v_total + v_line;
    if v_product.cost_price is null then v_cost_known := false;
    else v_cost := v_cost + round(v_qty * v_product.cost_price, 2); end if;
  end loop;

  v_paid := case when p_payment_method = 'credit' then coalesce(p_amount_paid, 0)
                 else coalesce(p_amount_paid, v_total) end;
  v_paid := round(v_paid, 2);
  if v_paid < 0 or v_paid > v_total then
    perform public.invalid_input('Amount paid must be between zero and the sale total.');
  end if;
  v_status := case when v_paid = v_total then 'paid' when v_paid = 0 then 'unpaid' else 'part_paid' end;

  if v_paid < v_total then
    if p_customer_id is null then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_REQUIRED',
        hint = 'Choose the customer who owes the balance.';
    end if;
    insert into public.debt_transactions (business_id, customer_id, kind, amount, sale_id, note, recorded_by)
    values (p_business_id, p_customer_id, 'charge', v_total - v_paid, v_sale_id, 'Unpaid balance on sale', auth.uid());
  end if;

  update public.sales
     set total_amount = v_total, amount_paid = v_paid, payment_status = v_status,
         total_cost = case when v_cost_known then v_cost else null end
   where id = v_sale_id;

  perform public.write_audit(p_business_id, 'sale.recorded', 'sale', v_sale_id,
                             jsonb_build_object('total', v_total, 'channel', coalesce(p_channel, 'pos')));
  return public.sale_result(v_sale_id, false);
end $$;

-- Corrections never rewrite history: a reversal restores stock with new movements,
-- offsets any credit charge with an adjustment, and voids the invoice.
create or replace function public.reverse_sale(p_business_id uuid, p_sale_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales;
  v_item public.sale_items;
  v_after integer;
  v_charged numeric(14, 2);
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    perform public.invalid_input('Please give a reason for reversing this sale.');
  end if;
  select * into v_sale from public.sales where id = p_sale_id and business_id = p_business_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND', hint = 'That sale was not found.';
  end if;
  if v_sale.status = 'reversed' then
    raise exception using errcode = 'P0001', message = 'SALE_ALREADY_REVERSED', hint = 'This sale was already reversed.';
  end if;
  perform 1 from public.products where id in (select product_id from public.sale_items where sale_id = p_sale_id)
    order by id for update;
  for v_item in select * from public.sale_items where sale_id = p_sale_id and product_id is not null loop
    update public.products set stock_quantity = stock_quantity + v_item.quantity
     where id = v_item.product_id returning stock_quantity into v_after;
    insert into public.inventory_movements (business_id, product_id, kind, quantity_delta, quantity_after,
                                            reason, sale_id, created_by)
    values (p_business_id, v_item.product_id, 'sale_reversal', v_item.quantity, v_after, trim(p_reason), p_sale_id, auth.uid());
  end loop;
  select coalesce(sum(amount), 0) into v_charged from public.debt_transactions
   where sale_id = p_sale_id and kind = 'charge';
  if v_charged > 0 then
    insert into public.debt_transactions (business_id, customer_id, kind, amount, sale_id, note, recorded_by)
    values (p_business_id, v_sale.customer_id, 'adjustment', -v_charged, p_sale_id,
            'Sale reversed: ' || trim(p_reason), auth.uid());
  end if;
  update public.sales set status = 'reversed', reversal_reason = trim(p_reason), reversed_at = now()
   where id = p_sale_id;
  update public.invoices set status = 'void' where sale_id = p_sale_id;
  perform public.write_audit(p_business_id, 'sale.reversed', 'sale', p_sale_id, jsonb_build_object('reason', trim(p_reason)));
  return public.sale_result(p_sale_id, false);
end $$;

-- ---------------------------------------------------------------------------
-- Debts
-- ---------------------------------------------------------------------------
create or replace function public.customer_balance(p_customer_id uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0)::numeric(14, 2) from public.debt_transactions where customer_id = p_customer_id;
$$;

create or replace function public.record_debt(
  p_business_id uuid, p_customer_id uuid, p_amount numeric, p_note text default null, p_client_op_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public.require_role(p_business_id, array['owner', 'manager']::public.member_role[]);
  if p_amount is null or p_amount <= 0 then perform public.invalid_input('Amount owed must be above zero.'); end if;
  perform 1 from public.customers where id = p_customer_id and business_id = p_business_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_NOT_FOUND', hint = 'That customer was not found.';
  end if;
  if p_client_op_id is not null then
    select id into v_id from public.debt_transactions where business_id = p_business_id and client_op_id = p_client_op_id;
    if found then
      return jsonb_build_object('duplicate', true, 'transaction_id', v_id, 'balance', public.customer_balance(p_customer_id));
    end if;
  end if;
  insert into public.debt_transactions (business_id, customer_id, kind, amount, note, client_op_id, recorded_by)
  values (p_business_id, p_customer_id, 'charge', round(p_amount, 2), nullif(trim(p_note), ''), p_client_op_id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('duplicate', false, 'transaction_id', v_id, 'balance', public.customer_balance(p_customer_id));
end $$;

create or replace function public.record_debt_payment(
  p_business_id uuid, p_customer_id uuid, p_amount numeric, p_note text default null, p_client_op_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_balance numeric(14, 2);
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  if p_amount is null or p_amount <= 0 then perform public.invalid_input('Payment must be above zero.'); end if;
  perform 1 from public.customers where id = p_customer_id and business_id = p_business_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_NOT_FOUND', hint = 'That customer was not found.';
  end if;
  if p_client_op_id is not null then
    select id into v_id from public.debt_transactions where business_id = p_business_id and client_op_id = p_client_op_id;
    if found then
      return jsonb_build_object('duplicate', true, 'transaction_id', v_id, 'balance', public.customer_balance(p_customer_id));
    end if;
  end if;
  v_balance := public.customer_balance(p_customer_id);
  if round(p_amount, 2) > v_balance then
    raise exception using errcode = 'P0001', message = 'PAYMENT_EXCEEDS_BALANCE',
      detail = jsonb_build_object('balance', v_balance)::text,
      hint = format('This customer only owes ₦%s.', to_char(v_balance, 'FM999,999,999,990.00'));
  end if;
  insert into public.debt_transactions (business_id, customer_id, kind, amount, note, client_op_id, recorded_by)
  values (p_business_id, p_customer_id, 'payment', -round(p_amount, 2), nullif(trim(p_note), ''), p_client_op_id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('duplicate', false, 'transaction_id', v_id, 'balance', public.customer_balance(p_customer_id));
end $$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create or replace function public.issue_invoice(p_business_id uuid, p_sale_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invoices;
  v_seq integer;
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  select * into v_inv from public.invoices where sale_id = p_sale_id;
  if found then
    if v_inv.business_id <> p_business_id then
      raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
    end if;
    return jsonb_build_object('duplicate', true, 'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
                              'issued_at', v_inv.issued_at, 'status', v_inv.status);
  end if;
  if not exists (select 1 from public.sales where id = p_sale_id and business_id = p_business_id and status = 'completed') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND', hint = 'Only completed sales can be invoiced.';
  end if;
  insert into public.invoice_counters (business_id) values (p_business_id) on conflict do nothing;
  update public.invoice_counters set last_seq = last_seq + 1 where business_id = p_business_id returning last_seq into v_seq;
  insert into public.invoices (business_id, sale_id, seq, invoice_number, issued_by)
  values (p_business_id, p_sale_id, v_seq, 'INV-' || lpad(v_seq::text, 5, '0'), auth.uid())
  returning * into v_inv;
  return jsonb_build_object('duplicate', false, 'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
                            'issued_at', v_inv.issued_at, 'status', v_inv.status);
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard & insights (all figures computed from persisted records, Lagos time)
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(p_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz constant text := 'Africa/Lagos';
  v_today date := (now() at time zone v_tz)::date;
  v_today_start timestamptz := (v_today::timestamp) at time zone v_tz;
  v_week_start timestamptz := ((v_today - 6)::timestamp) at time zone v_tz;
  v_prev_week_start timestamptz := ((v_today - 13)::timestamp) at time zone v_tz;
  v_month_start timestamptz := (date_trunc('month', v_today)::timestamp) at time zone v_tz;
  v_result jsonb;
begin
  perform public.require_role(p_business_id, array['owner', 'manager', 'assistant']::public.member_role[]);
  with s as (
    select * from public.sales where business_id = p_business_id and status = 'completed'
      and created_at >= v_prev_week_start - interval '31 days'
  ), items as (
    select i.*, s.created_at from public.sale_items i join s on s.id = i.sale_id
  ), period as (
    select
      coalesce(sum(total_amount) filter (where created_at >= v_today_start), 0) as today_revenue,
      count(*) filter (where created_at >= v_today_start) as today_count,
      coalesce(sum(total_amount) filter (where created_at >= v_today_start - interval '1 day'
                                           and created_at < v_today_start), 0) as yesterday_revenue,
      coalesce(sum(total_amount) filter (where created_at >= v_week_start), 0) as week_revenue,
      count(*) filter (where created_at >= v_week_start) as week_count,
      coalesce(sum(total_amount) filter (where created_at >= v_prev_week_start and created_at < v_week_start), 0) as prev_week_revenue,
      coalesce(sum(total_amount) filter (where created_at >= v_month_start), 0) as month_revenue,
      count(*) filter (where created_at >= v_month_start) as month_count
    from s
  ), profit as (
    select
      coalesce(sum(line_total - quantity * unit_cost) filter (where created_at >= v_today_start and unit_cost is not null), 0) as today_profit,
      bool_or(unit_cost is null) filter (where created_at >= v_today_start) as today_missing_cost,
      coalesce(sum(line_total - quantity * unit_cost) filter (where created_at >= v_week_start and unit_cost is not null), 0) as week_profit,
      coalesce(sum(line_total) filter (where created_at >= v_week_start and unit_cost is not null), 0) as week_costed_revenue,
      bool_or(unit_cost is null) filter (where created_at >= v_week_start) as week_missing_cost,
      coalesce(sum(line_total - quantity * unit_cost) filter (where created_at >= v_month_start and unit_cost is not null), 0) as month_profit,
      bool_or(unit_cost is null) filter (where created_at >= v_month_start) as month_missing_cost
    from items
  ), debts as (
    select coalesce(sum(balance) filter (where balance > 0), 0) as outstanding,
           count(*) filter (where balance > 0) as debtors
    from (select customer_id, sum(amount) as balance from public.debt_transactions
          where business_id = p_business_id group by customer_id) b
  ), stock as (
    select count(*) as item_count,
           count(*) filter (where stock_quantity = 0) as out_count,
           count(*) filter (where stock_quantity > 0 and stock_quantity <= low_stock_threshold) as low_count,
           coalesce(sum(stock_quantity * cost_price) filter (where cost_price is not null), 0) as value_at_cost,
           count(*) filter (where cost_price is null and stock_quantity > 0) as missing_cost_count,
           coalesce(sum(stock_quantity * price), 0) as value_at_price
    from public.products where business_id = p_business_id and archived_at is null
  ), daily as (
    select jsonb_agg(jsonb_build_object('date', d::date, 'revenue', coalesce(r.revenue, 0), 'count', coalesce(r.cnt, 0)) order by d) as series
    from generate_series(v_today - 13, v_today, interval '1 day') d
    left join (select (created_at at time zone v_tz)::date as day, sum(total_amount) as revenue, count(*) as cnt
               from s group by 1) r on r.day = d::date
  ), product_stats as (
    select jsonb_agg(row_to_json(ps) order by ps.revenue_7d desc, ps.name) as stats from (
      select p.id as product_id, p.name, p.unit, p.stock_quantity, p.low_stock_threshold, p.price, p.cost_price,
             coalesce(sum(i.quantity) filter (where i.created_at >= v_week_start), 0) as units_7d,
             coalesce(sum(i.line_total) filter (where i.created_at >= v_week_start), 0) as revenue_7d,
             coalesce(sum(i.quantity) filter (where i.created_at >= v_prev_week_start and i.created_at < v_week_start), 0) as units_prev_7d,
             coalesce(sum(i.quantity) filter (where i.created_at >= v_today_start), 0) as units_today,
             p.updated_at
      from public.products p left join items i on i.product_id = p.id
      where p.business_id = p_business_id and p.archived_at is null
      group by p.id
      limit 300
    ) ps
  )
  select jsonb_build_object(
    'generated_at', now(), 'timezone', v_tz,
    'today', jsonb_build_object('revenue', period.today_revenue, 'count', period.today_count,
               'profit', profit.today_profit, 'profit_complete', not coalesce(profit.today_missing_cost, false),
               'yesterday_revenue', period.yesterday_revenue),
    'week', jsonb_build_object('revenue', period.week_revenue, 'count', period.week_count,
               'prev_revenue', period.prev_week_revenue, 'profit', profit.week_profit,
               'costed_revenue', profit.week_costed_revenue,
               'profit_complete', not coalesce(profit.week_missing_cost, false)),
    'month', jsonb_build_object('revenue', period.month_revenue, 'count', period.month_count,
               'profit', profit.month_profit, 'profit_complete', not coalesce(profit.month_missing_cost, false)),
    'debts', jsonb_build_object('outstanding', debts.outstanding, 'debtors', debts.debtors),
    'stock', jsonb_build_object('item_count', stock.item_count, 'out_count', stock.out_count, 'low_count', stock.low_count,
               'value_at_cost', stock.value_at_cost, 'missing_cost_count', stock.missing_cost_count,
               'value_at_price', stock.value_at_price),
    'daily', coalesce(daily.series, '[]'::jsonb),
    'products', coalesce(product_stats.stats, '[]'::jsonb)
  ) into v_result
  from period, profit, debts, stock, daily, product_stats;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: RPCs callable by signed-in users only.
-- ---------------------------------------------------------------------------
revoke all on function public.ensure_profile(), public.create_business(text, text, text, text),
  public.add_team_member(uuid, text, public.member_role),
  public.create_product(uuid, text, text, numeric, numeric, integer, integer, text),
  public.restock_product(uuid, uuid, integer, numeric, text, text),
  public.adjust_stock(uuid, uuid, integer, text, text),
  public.record_sale(uuid, text, jsonb, text, numeric, uuid, text, text),
  public.reverse_sale(uuid, uuid, text),
  public.record_debt(uuid, uuid, numeric, text, text),
  public.record_debt_payment(uuid, uuid, numeric, text, text),
  public.issue_invoice(uuid, uuid), public.get_dashboard_summary(uuid)
  from public, anon;
grant execute on function public.ensure_profile(), public.create_business(text, text, text, text),
  public.add_team_member(uuid, text, public.member_role),
  public.create_product(uuid, text, text, numeric, numeric, integer, integer, text),
  public.restock_product(uuid, uuid, integer, numeric, text, text),
  public.adjust_stock(uuid, uuid, integer, text, text),
  public.record_sale(uuid, text, jsonb, text, numeric, uuid, text, text),
  public.reverse_sale(uuid, uuid, text),
  public.record_debt(uuid, uuid, numeric, text, text),
  public.record_debt_payment(uuid, uuid, numeric, text, text),
  public.issue_invoice(uuid, uuid), public.get_dashboard_summary(uuid)
  to authenticated;
-- Internal helpers are not part of the API surface.
revoke all on function public.write_audit(uuid, text, text, uuid, jsonb), public.sale_result(uuid, boolean),
  public.invalid_input(text), public.require_role(uuid, public.member_role[]) from public, anon, authenticated;
