-- Integration tests for Vendora's schema, RLS and RPCs against a local PostgreSQL with the
-- Supabase stub. Run via supabase/tests/run-local.sh. Every block either passes silently or
-- aborts the run with "TEST FAILED".
\set ON_ERROR_STOP 1
\set QUIET 1

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;
create or replace function tests.expect_error(p_sql text, p_expected text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'TEST FAILED: expected error % but statement succeeded: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if position(p_expected in sqlerrm) = 0 then
    raise exception 'TEST FAILED: expected error containing "%" but got "%" for: %', p_expected, sqlerrm, p_sql;
  end if;
end $$;
grant execute on function tests.expect_error(text, text) to authenticated, anon;

-- Users -----------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'ada@example.com', '{"full_name":"Ada Okafor","preferred_language":"pcm","phone":"+2348030000001"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bola@example.com', '{"full_name":"Bola Ade"}'),
  ('00000000-0000-0000-0000-00000000000c', 'chidi@example.com', '{"full_name":"Chidi Eze","preferred_language":"klingon"}'),
  ('00000000-0000-0000-0000-00000000000d', 'outsider@example.com', '{}'),
  ('00000000-0000-0000-0000-00000000000e', 'admin@example.com', '{"full_name":"Reviewer"}');
insert into public.app_admins (user_id) values ('00000000-0000-0000-0000-00000000000e');

\echo '1. signup trigger creates profiles (with safe language fallback)'
do $$ begin
  assert (select count(*) from public.profiles) = 5, 'expected 5 profiles';
  assert (select preferred_language from public.profiles where id = '00000000-0000-0000-0000-00000000000a') = 'pcm';
  assert (select preferred_language from public.profiles where id = '00000000-0000-0000-0000-00000000000c') = 'en';
end $$;
-- ensure_profile recovers a missing profile
delete from public.profiles where id = '00000000-0000-0000-0000-00000000000d';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
set role authenticated;
do $$ begin
  assert (select (public.ensure_profile()).id) = '00000000-0000-0000-0000-00000000000d', 'ensure_profile failed';
  assert (select count(*) from public.profiles where id = auth.uid()) = 1;
end $$;
reset role;

\echo '2. anon has no access'
set role anon;
select tests.expect_error('select * from public.products', 'permission denied');
select tests.expect_error('select public.create_business(''x'')', 'permission denied');
reset role;

\echo '3. businesses, membership, products'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
select set_config('test.biz_a', (public.create_business('Ngozi Provisions', 'foodstuff', 'Alaba Market', 'Lagos')).id::text, false);
select public.add_team_member(current_setting('test.biz_a')::uuid, 'bola@example.com', 'assistant');
select tests.expect_error($q$select public.add_team_member(current_setting('test.biz_a')::uuid, 'nobody@example.com', 'assistant')$q$, 'USER_NOT_FOUND');
select set_config('test.rice', (public.create_product(current_setting('test.biz_a')::uuid, 'Rice (50kg)', 'bag', 35000, 30000, 3, 10, 'op-open-rice')).id::text, false);
select set_config('test.indomie', (public.create_product(current_setting('test.biz_a')::uuid, 'Indomie', 'carton', 6000, null, 2, 6)).id::text, false);
select tests.expect_error($q$select public.create_product(current_setting('test.biz_a')::uuid, 'rice (50KG)', 'bag', 1, null, 1, 0)$q$, 'DUPLICATE_NAME');
-- stock can never be edited directly, even by the owner
select tests.expect_error($q$update public.products set stock_quantity = 999 where id = current_setting('test.rice')::uuid$q$, 'permission denied');
update public.products set price = 35000 where id = current_setting('test.rice')::uuid; -- catalogue edits allowed
do $$ begin
  assert (select onboarding_step from public.profiles where id = auth.uid()) = 'products';
  assert (select count(*) from public.inventory_movements where kind = 'opening') = 2;
  assert (select (public.member_role_in(current_setting('test.biz_a')::uuid))) = 'owner';
end $$;
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
set role authenticated;
select set_config('test.biz_b', (public.create_business('Chidi Wholesale', 'foodstuff', 'Mile 12', 'Lagos')).id::text, false);
reset role;

\echo '4. assistant role limits'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
select tests.expect_error($q$select public.create_product(current_setting('test.biz_a')::uuid, 'Sugar', 'bag', 19000)$q$, 'FORBIDDEN');
select tests.expect_error($q$select public.restock_product(current_setting('test.biz_a')::uuid, current_setting('test.rice')::uuid, 5)$q$, 'FORBIDDEN');
update public.products set price = 1 where id = current_setting('test.rice')::uuid; -- RLS: silently 0 rows
reset role;
do $$ begin
  assert (select price from public.products where id = current_setting('test.rice')::uuid) = 35000, 'assistant changed a price';
end $$;

\echo '5. record_sale: totals, stock, idempotent retries'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
select set_config('test.sale1', (public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0001',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 2, 'unit_price', 35000)),
  'cash', null, null, 'voice') ->> 'sale_id'), false);
do $$
declare r jsonb;
begin
  assert (select stock_quantity from public.products where id = current_setting('test.rice')::uuid) = 8, 'stock should be 8';
  assert (select total_amount from public.sales where id = current_setting('test.sale1')::uuid) = 70000;
  assert (select total_cost from public.sales where id = current_setting('test.sale1')::uuid) = 60000;
  -- retry with the same op id: no double sale
  r := public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0001',
    jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 2)), 'cash');
  assert (r ->> 'duplicate')::boolean, 'retry should report duplicate';
  assert (r ->> 'sale_id') = current_setting('test.sale1'), 'retry should return original sale';
  assert (r -> 'items' -> 0 ->> 'stock_remaining')::int = 8, 'remaining stock reported';
  assert (select count(*) from public.sales) = 1, 'duplicate sale created';
  assert (select stock_quantity from public.products where id = current_setting('test.rice')::uuid) = 8;
end $$;

\echo '6. record_sale: insufficient stock rolls back everything'
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0002',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.indomie'), 'quantity', 1),
                    jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 20)), 'cash')$q$, 'INSUFFICIENT_STOCK');
-- duplicate lines are checked cumulatively
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0003',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 5),
                    jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 5)), 'cash')$q$, 'INSUFFICIENT_STOCK');
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0004',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 1)), 'credit')$q$, 'CUSTOMER_REQUIRED');
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0005',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 0)), 'cash')$q$, 'INVALID_INPUT');
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0006',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 1)), 'cash', 999999)$q$, 'INVALID_INPUT');
do $$ begin
  assert (select stock_quantity from public.products where id = current_setting('test.rice')::uuid) = 8;
  assert (select stock_quantity from public.products where id = current_setting('test.indomie')::uuid) = 6;
  assert (select count(*) from public.sales) = 1, 'failed sales must not persist';
end $$;
-- direct writes to financial tables are impossible
select tests.expect_error($q$insert into public.sales (business_id, client_op_id, payment_method, payment_status, total_amount, amount_paid)
  values (current_setting('test.biz_a')::uuid, 'op-forged-01', 'cash', 'paid', 1, 1)$q$, 'permission denied');
select tests.expect_error($q$update public.sales set total_amount = 1$q$, 'permission denied');
select tests.expect_error($q$delete from public.debt_transactions$q$, 'permission denied');

\echo '7. credit sales and debts'
insert into public.customers (business_id, name, phone) values (current_setting('test.biz_a')::uuid, 'Emeka Chukwu', '08030000002');
select set_config('test.emeka', (select id::text from public.customers where name = 'Emeka Chukwu'), false);
select set_config('test.sale2', (public.record_sale(current_setting('test.biz_a')::uuid, 'op-sale-0007',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 1)),
  'credit', 10000, current_setting('test.emeka')::uuid) ->> 'sale_id'), false);
do $$ begin
  assert (select payment_status from public.sales where id = current_setting('test.sale2')::uuid) = 'part_paid';
  assert (select balance from public.customer_balances where customer_id = current_setting('test.emeka')::uuid) = 25000, 'balance 25000';
end $$;
select tests.expect_error($q$select public.record_debt_payment(current_setting('test.biz_a')::uuid, current_setting('test.emeka')::uuid, 30000)$q$, 'PAYMENT_EXCEEDS_BALANCE');
select public.record_debt_payment(current_setting('test.biz_a')::uuid, current_setting('test.emeka')::uuid, 5000, 'Paid at shop', 'op-pay-000001');
select public.record_debt_payment(current_setting('test.biz_a')::uuid, current_setting('test.emeka')::uuid, 5000, 'Paid at shop', 'op-pay-000001');
do $$ begin
  assert public.customer_balance(current_setting('test.emeka')::uuid) = 20000, 'payment applied exactly once';
end $$;
-- assistant cannot add arbitrary debt charges
select tests.expect_error($q$select public.record_debt(current_setting('test.biz_a')::uuid, current_setting('test.emeka')::uuid, 100)$q$, 'FORBIDDEN');

\echo '8. invoices: unique, gap-free, idempotent'
do $$
declare a jsonb; b jsonb; c jsonb;
begin
  a := public.issue_invoice(current_setting('test.biz_a')::uuid, current_setting('test.sale1')::uuid);
  b := public.issue_invoice(current_setting('test.biz_a')::uuid, current_setting('test.sale1')::uuid);
  c := public.issue_invoice(current_setting('test.biz_a')::uuid, current_setting('test.sale2')::uuid);
  assert a ->> 'invoice_number' = 'INV-00001', 'first invoice number';
  assert b ->> 'invoice_number' = 'INV-00001' and (b ->> 'duplicate')::boolean, 'reissue returns same number';
  assert c ->> 'invoice_number' = 'INV-00002', 'second invoice number';
end $$;

\echo '9. reversal: owner only, restores stock, offsets debt, voids invoice'
select tests.expect_error($q$select public.reverse_sale(current_setting('test.biz_a')::uuid, current_setting('test.sale2')::uuid, 'wrong item')$q$, 'FORBIDDEN');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
select public.reverse_sale(current_setting('test.biz_a')::uuid, current_setting('test.sale2')::uuid, 'Customer returned bag');
select tests.expect_error($q$select public.reverse_sale(current_setting('test.biz_a')::uuid, current_setting('test.sale2')::uuid, 'again')$q$, 'SALE_ALREADY_REVERSED');
do $$ begin
  assert (select stock_quantity from public.products where id = current_setting('test.rice')::uuid) = 8, 'stock restored to 8';
  -- 25,000 charge offset by -25,000; the 5,000 already paid is now owed back to Emeka (credit balance)
  assert public.customer_balance(current_setting('test.emeka')::uuid) = -5000, 'balance after reversal';
  assert (select status from public.invoices where sale_id = current_setting('test.sale2')::uuid) = 'void';
  assert (select count(*) from public.sales) = 2, 'reversal keeps history';
  assert (select count(*) from public.audit_events where action = 'sale.reversed') = 1;
end $$;

\echo '10. restock & adjustment write movements'
select public.restock_product(current_setting('test.biz_a')::uuid, current_setting('test.rice')::uuid, 4, 31000, 'op-restock-01');
select public.restock_product(current_setting('test.biz_a')::uuid, current_setting('test.rice')::uuid, 4, 31000, 'op-restock-01');
select tests.expect_error($q$select public.adjust_stock(current_setting('test.biz_a')::uuid, current_setting('test.indomie')::uuid, 5, '')$q$, 'INVALID_INPUT');
select public.adjust_stock(current_setting('test.biz_a')::uuid, current_setting('test.indomie')::uuid, 5, 'One carton damaged');
do $$ begin
  assert (select stock_quantity from public.products where id = current_setting('test.rice')::uuid) = 12, 'restock applied once';
  assert (select cost_price from public.products where id = current_setting('test.rice')::uuid) = 31000;
  -- stock always equals the sum of movements
  assert (select bool_and(p.stock_quantity = (select sum(quantity_delta) from public.inventory_movements m where m.product_id = p.id))
          from public.products p where p.business_id = current_setting('test.biz_a')::uuid), 'movement ledger mismatch';
end $$;

\echo '11. dashboard figures come from records'
do $$
declare d jsonb;
begin
  d := public.get_dashboard_summary(current_setting('test.biz_a')::uuid);
  assert (d -> 'today' ->> 'revenue')::numeric = 70000, 'today revenue excludes reversed sale: ' || (d -> 'today' ->> 'revenue');
  assert (d -> 'today' ->> 'count')::int = 1;
  assert (d -> 'today' ->> 'profit')::numeric = 10000, 'gross profit';
  assert (d -> 'today' ->> 'profit_complete')::boolean;
  assert (d -> 'stock' ->> 'item_count')::int = 2;
  assert (d -> 'stock' ->> 'missing_cost_count')::int = 1, 'indomie has no cost';
  assert jsonb_array_length(d -> 'daily') = 14;
end $$;

\echo '12. payments: users cannot self-verify'
insert into public.payments_received (business_id, amount, payer_name, channel, recorded_by)
values (current_setting('test.biz_a')::uuid, 8500, 'Emeka', 'transfer', auth.uid());
select tests.expect_error($q$update public.payments_received set verification_status = 'verified'$q$, 'only be verified');
select tests.expect_error($q$insert into public.payments_received (business_id, amount, channel, source, recorded_by)
  values (current_setting('test.biz_a')::uuid, 100, 'transfer', 'bank_feed', auth.uid())$q$, 'bank integration');
update public.payments_received set verification_status = 'pending_review', receipt_path = current_setting('test.biz_a') || '/r.jpg';
select tests.expect_error($q$update public.payments_received set amount = 1$q$, 'permission denied');
reset role;

\echo '13. cross-business isolation'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.products where business_id = current_setting('test.biz_a')::uuid) = 0, 'B sees A products';
  assert (select count(*) from public.sales) = 0, 'B sees A sales';
  assert (select count(*) from public.customers) = 0, 'B sees A customers';
  assert (select count(*) from public.customer_balances) = 0, 'B sees A balances';
  assert (select count(*) from public.payments_received) = 0;
  assert (select count(*) from public.audit_events where business_id = current_setting('test.biz_a')::uuid) = 0;
  assert (select count(*) from public.profiles) = 1, 'B sees other profiles';
end $$;
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_a')::uuid, 'op-evil-0001',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 1)), 'cash')$q$, 'FORBIDDEN');
select tests.expect_error($q$select public.get_dashboard_summary(current_setting('test.biz_a')::uuid)$q$, 'FORBIDDEN');
-- B cannot sell A's product through B's own business
select tests.expect_error($q$select public.record_sale(current_setting('test.biz_b')::uuid, 'op-evil-0002',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('test.rice'), 'quantity', 1)), 'cash')$q$, 'PRODUCT_NOT_FOUND');
select tests.expect_error($q$insert into public.customers (business_id, name) values (current_setting('test.biz_a')::uuid, 'Spy')$q$, 'row-level security');
update public.businesses set name = 'Hacked' where id = current_setting('test.biz_a')::uuid;
reset role;
do $$ begin
  assert (select name from public.businesses where id = current_setting('test.biz_a')::uuid) = 'Ngozi Provisions';
end $$;

\echo '14. Vendors Hub: visibility, adverts, search'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.vendor_profiles where business_id = current_setting('test.biz_b')::uuid) = 0, 'private profile visible';
end $$;
update public.vendor_profiles set is_public = true, description = 'Provisions and foodstuff' where business_id = current_setting('test.biz_a')::uuid;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
set role authenticated;
update public.vendor_profiles set is_public = true, products_summary = 'Rice, beans, garri wholesale' where business_id = current_setting('test.biz_b')::uuid;
select tests.expect_error($q$update public.vendor_profiles set verification_status = 'verified' where business_id = current_setting('test.biz_b')::uuid$q$, 'permission denied');
select tests.expect_error($q$insert into public.adverts (business_id, headline, status, is_featured, created_by)
  values (current_setting('test.biz_b')::uuid, 'Cheap rice', 'published', true, auth.uid())$q$, 'permission denied');
insert into public.adverts (business_id, headline, product_name, category, price_min, price_max, unit, min_order_qty, pricing_type, market, city, status, created_by)
values (current_setting('test.biz_b')::uuid, 'Mama Gold rice wholesale', 'Rice 50kg', 'foodstuff', 32000, 34000, 'bag', 10, 'wholesale', 'Mile 12', 'Lagos', 'published', auth.uid()),
       (current_setting('test.biz_b')::uuid, 'Draft beans offer', 'Beans', 'foodstuff', 50000, null, 'bag', 1, 'retail', 'Mile 12', 'Lagos', 'draft', auth.uid());
select set_config('test.advert', (select id::text from public.adverts where headline like 'Mama Gold%'), false);
select tests.expect_error($q$insert into public.adverts (business_id, headline, created_by) values (current_setting('test.biz_a')::uuid, 'Fake advert for A', auth.uid())$q$, 'row-level security');
insert into storage.objects (bucket_id, name) values ('advert-media', current_setting('test.biz_b') || '/' || current_setting('test.advert') || '/a.jpg');
select tests.expect_error($q$insert into storage.objects (bucket_id, name) values ('advert-media', current_setting('test.biz_a') || '/x/evil.jpg')$q$, 'row-level security');
insert into public.advert_media (advert_id, business_id, storage_path, media_type)
values (current_setting('test.advert')::uuid, current_setting('test.biz_b')::uuid, current_setting('test.biz_b') || '/' || current_setting('test.advert') || '/a.jpg', 'image');
insert into public.feed_posts (business_id, author_id, kind, body, advert_id)
values (current_setting('test.biz_b')::uuid, auth.uid(), 'new_stock', 'Fresh rice just arrived', current_setting('test.advert')::uuid);
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.search_adverts('rice')) = 1, 'search finds published advert';
  assert (select count(*) from public.search_adverts('mam')) = 1, 'prefix search';
  assert (select count(*) from public.search_adverts('draft')) = 0, 'draft hidden';
  assert (select count(*) from public.search_adverts(null, 'foodstuff', 'mile 12', 30000, 33000)) = 1, 'filters';
  assert (select count(*) from public.search_adverts(null, null, null, 40000)) = 0, 'min price filter';
  assert (select cover_path from public.search_adverts('rice')) like '%/a.jpg', 'cover image';
  assert (select count(*) from public.adverts where headline like 'Draft%') = 0, 'draft visible to other vendor';
  assert (select count(*) from public.search_vendors('garri')) = 1, 'vendor search';
  assert (select count(*) from public.recommended_vendors(current_setting('test.biz_a')::uuid)) = 1, 'recommendation';
  assert (select count(*) from public.feed_posts) = 1;
end $$;
insert into public.feed_reactions (post_id, user_id) select id, auth.uid() from public.feed_posts;
insert into public.saved_adverts (user_id, advert_id) values (auth.uid(), current_setting('test.advert')::uuid);
insert into public.reports (reporter_id, advert_id, reason, details) values (auth.uid(), current_setting('test.advert')::uuid, 'wrong_price', 'test');

\echo '15. connections and messaging'
select set_config('test.conn', (public.request_connection(current_setting('test.biz_a')::uuid, current_setting('test.biz_b')::uuid)).id::text, false);
select set_config('test.conv', public.start_conversation(current_setting('test.biz_a')::uuid, current_setting('test.biz_b')::uuid, current_setting('test.advert')::uuid)::text, false);
do $$ begin
  assert public.start_conversation(current_setting('test.biz_a')::uuid, current_setting('test.biz_b')::uuid) = current_setting('test.conv')::uuid, 'thread reused';
end $$;
insert into public.messages (conversation_id, sender_business_id, sender_user_id, body, client_msg_id)
values (current_setting('test.conv')::uuid, current_setting('test.biz_a')::uuid, auth.uid(), 'How much for 20 bags?', 'msg-000000001');
select tests.expect_error($q$insert into public.messages (conversation_id, sender_business_id, sender_user_id, body, client_msg_id)
  values (current_setting('test.conv')::uuid, current_setting('test.biz_b')::uuid, auth.uid(), 'Impersonating B', 'msg-000000002')$q$, 'row-level security');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
set role authenticated;
select public.respond_connection(current_setting('test.conn')::uuid, true);
do $$ begin
  assert (select count(*) from public.messages where conversation_id = current_setting('test.conv')::uuid) = 1, 'B reads message';
  assert (select count(*) from public.notifications where kind = 'message') = 1, 'B notified of message';
  assert (select count(*) from public.notifications where kind = 'connection_request') = 1;
  assert (select status from public.vendor_connections where id = current_setting('test.conn')::uuid) = 'accepted';
end $$;
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.messages) = 0, 'outsider reads messages';
  assert (select count(*) from public.conversations) = 0, 'outsider sees conversations';
  assert (select count(*) from public.vendor_connections) = 0;
end $$;
reset role;

\echo '16. blocking stops messages'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
set role authenticated;
select public.block_business(current_setting('test.biz_b')::uuid, current_setting('test.biz_a')::uuid);
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
select tests.expect_error($q$insert into public.messages (conversation_id, sender_business_id, sender_user_id, body, client_msg_id)
  values (current_setting('test.conv')::uuid, current_setting('test.biz_a')::uuid, auth.uid(), 'hello?', 'msg-000000003')$q$, 'row-level security');
select tests.expect_error($q$select public.request_connection(current_setting('test.biz_a')::uuid, current_setting('test.biz_b')::uuid)$q$, 'BLOCKED');

\echo '17. verification only by admin'
select public.request_vendor_verification(current_setting('test.biz_a')::uuid, 'RC123456', 'Shop at Alaba');
select tests.expect_error($q$select public.request_vendor_verification(current_setting('test.biz_a')::uuid, 'RC1', 'again')$q$, 'ALREADY_PENDING');
select tests.expect_error($q$select public.review_verification((select id from public.verification_requests limit 1), true)$q$, 'FORBIDDEN');
do $$ begin
  assert (select verification_status from public.vendor_profiles where business_id = current_setting('test.biz_a')::uuid) = 'pending';
end $$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', false);
set role authenticated;
select public.review_verification((select id from public.verification_requests limit 1), true, 'CAC checked');
reset role;
do $$ begin
  assert (select verification_status from public.vendor_profiles where business_id = current_setting('test.biz_a')::uuid) = 'verified';
end $$;

\echo '18. TTS quota: service role only, capped per day'
set role authenticated;
select tests.expect_error($q$select public.consume_tts_quota(auth.uid(), 10, 100)$q$, 'permission denied');
reset role;
set role service_role;
do $$ begin
  assert public.consume_tts_quota('00000000-0000-0000-0000-00000000000a', 20, 2);
  assert public.consume_tts_quota('00000000-0000-0000-0000-00000000000a', 20, 2);
  assert not public.consume_tts_quota('00000000-0000-0000-0000-00000000000a', 20, 2), 'third call should be refused';
end $$;
reset role;
do $$ begin
  assert (select request_count from public.tts_usage where user_id = '00000000-0000-0000-0000-00000000000a') = 2;
end $$;

\echo 'ALL DATABASE TESTS PASSED'
