-- Storage buckets and policies. Object paths always start with the owning business id:
--   advert-media/{business_id}/{advert_id}/{uuid}.{ext}
--   business-assets/{business_id}/logo-{uuid}.{ext}
--   receipts/{business_id}/{uuid}.{ext}          (private)
--   verification-docs/{business_id}/{uuid}.{ext} (private; owners + admins)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('advert-media', 'advert-media', true, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']),
  ('business-assets', 'business-assets', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('verification-docs', 'verification-docs', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

create or replace function public.storage_business_id(p_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

-- Public buckets are readable by URL; writes are limited to owners/managers of the folder's business.
create policy "vendora media write" on storage.objects for insert to authenticated
  with check (bucket_id in ('advert-media', 'business-assets')
              and public.has_role(public.storage_business_id(name), array['owner', 'manager']::public.member_role[]));
create policy "vendora media update" on storage.objects for update to authenticated
  using (bucket_id in ('advert-media', 'business-assets')
         and public.has_role(public.storage_business_id(name), array['owner', 'manager']::public.member_role[]));
create policy "vendora media delete" on storage.objects for delete to authenticated
  using (bucket_id in ('advert-media', 'business-assets')
         and public.has_role(public.storage_business_id(name), array['owner', 'manager']::public.member_role[]));

create policy "vendora receipts read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (public.is_member(public.storage_business_id(name)) or public.is_admin()));
create policy "vendora receipts write" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_member(public.storage_business_id(name)));

create policy "vendora verification read" on storage.objects for select to authenticated
  using (bucket_id = 'verification-docs'
         and (public.has_role(public.storage_business_id(name), array['owner']::public.member_role[]) or public.is_admin()));
create policy "vendora verification write" on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-docs'
              and public.has_role(public.storage_business_id(name), array['owner']::public.member_role[]));

-- Realtime: deliver new messages and notifications to subscribed, RLS-authorized clients.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages, public.notifications,
      public.conversation_participants;
  end if;
end $$;
