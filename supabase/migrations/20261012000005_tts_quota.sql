-- Per-user daily cap on YarnGPT voice replies. Called only by the `tts` Edge Function
-- with the service role; signed-in users cannot call it or edit their own counters.
create or replace function public.consume_tts_quota(p_user_id uuid, p_chars integer, p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'Africa/Lagos')::date;
  v_count integer;
begin
  insert into public.tts_usage (user_id, day) values (p_user_id, v_day) on conflict do nothing;
  update public.tts_usage
     set request_count = request_count + 1, char_count = char_count + greatest(coalesce(p_chars, 0), 0)
   where user_id = p_user_id and day = v_day and request_count < greatest(coalesce(p_limit, 0), 0)
  returning request_count into v_count;
  return v_count is not null;
end $$;

revoke all on function public.consume_tts_quota(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_tts_quota(uuid, integer, integer) to service_role;
