-- Atlas VTT: Token Maker (ARCHITECTURE §11, §6.4).
--
--  * Bucket `token-images` (PUBLIC): finished tokens applied to game tokens, at
--    {userId}/{name}.png|webp (names are content hashes). Public, like `free-assets`, so every client at
--    the table loads a token's image by URL without a grant; a player's `token-image` request may only
--    name an image in the player's own folder (checked by the host, core/session/tokenImages.ts).
--    Clients insert into their own folder only (well-formed name, at most max_owner_token_images()
--    objects / max_owner_token_image_bytes() per owner), list and delete their own objects, and never
--    update (content-addressed names: a changed image is a new object).
--  * Image tools (the Edge Function `remove-background`): every call spends from a daily allowance per
--    user (lower for guests, who are free to create) and from a global daily cap, because each call
--    costs money at the model provider. consume_image_tool_quota() is executable by service_role only.

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------

create function private.max_owner_token_images()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 300
$$;

create function private.max_owner_token_image_bytes()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 200::bigint * 1024 * 1024
$$;

-- Image tool calls per UTC day: per guest, per permanent account, and for the whole project.
create function private.max_image_tool_calls_guest()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 10
$$;

create function private.max_image_tool_calls_account()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 30
$$;

create function private.max_image_tool_calls_total()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 300
$$;

revoke execute on function private.max_owner_token_images() from public, anon, authenticated;
revoke execute on function private.max_owner_token_image_bytes() from public, anon, authenticated;
revoke execute on function private.max_image_tool_calls_guest() from public, anon, authenticated;
revoke execute on function private.max_image_tool_calls_account() from public, anon, authenticated;
revoke execute on function private.max_image_tool_calls_total() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('token-images', 'token-images', true, 4194304, array['image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The caller may add this token image: their own folder, a well-formed name, and room left under the
-- owner's object count and byte budgets (the byte total may overshoot by one image of ≤ 4 MB).
create function private.can_insert_token_image(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid text := (select auth.uid())::text;
  v_count integer;
  v_bytes bigint;
begin
  if v_uid is null
     or p_name is null
     or split_part(p_name, '/', 1) <> v_uid
     or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(png|webp)$' then
    return false;
  end if;
  select count(*), coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)
  into v_count, v_bytes
  from storage.objects o
  where o.bucket_id = 'token-images'
    and o.name like v_uid || '/%'
    and split_part(o.name, '/', 1) = v_uid;
  return v_count < private.max_owner_token_images() and v_bytes < private.max_owner_token_image_bytes();
end
$$;

revoke execute on function private.can_insert_token_image(text) from public, anon, authenticated;
grant execute on function private.can_insert_token_image(text) to authenticated;

-- ---------------------------------------------------------------------------
-- storage.objects policies (one per command, every bucket): as before, plus `token-images`
-- ---------------------------------------------------------------------------

drop policy atlas_objects_select on storage.objects;
drop policy atlas_objects_insert on storage.objects;
drop policy atlas_objects_update on storage.objects;
drop policy atlas_objects_delete on storage.objects;

create policy atlas_objects_select on storage.objects
  for select to authenticated
  using (
    (bucket_id = 'scene-assets' and split_part(name, '/', 1) = (select auth.uid())::text)
    or (bucket_id = 'session-tiles' and private.can_read_session_tile(name))
    or (bucket_id = 'token-images' and split_part(name, '/', 1) = (select auth.uid())::text)
  );

create policy atlas_objects_insert on storage.objects
  for insert to authenticated
  with check (
    (bucket_id = 'scene-assets' and private.can_insert_scene_asset(name))
    or (bucket_id = 'session-tiles' and private.can_write_session_tile(name))
    or (bucket_id = 'token-images' and private.can_insert_token_image(name))
  );

-- Token images are never updated (content-addressed names).
create policy atlas_objects_update on storage.objects
  for update to authenticated
  using (
    (bucket_id = 'scene-assets' and split_part(name, '/', 1) = (select auth.uid())::text)
    or (bucket_id = 'session-tiles' and private.can_write_session_tile(name))
  )
  with check (
    (
      bucket_id = 'scene-assets'
      and split_part(name, '/', 1) = (select auth.uid())::text
      and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg)$'
    )
    or (bucket_id = 'session-tiles' and private.can_write_session_tile(name))
  );

create policy atlas_objects_delete on storage.objects
  for delete to authenticated
  using (
    (bucket_id = 'scene-assets' and split_part(name, '/', 1) = (select auth.uid())::text)
    or (bucket_id = 'session-tiles' and private.can_delete_session_tile(name))
    or (bucket_id = 'token-images' and split_part(name, '/', 1) = (select auth.uid())::text)
  );

-- ---------------------------------------------------------------------------
-- Image tool allowance
-- ---------------------------------------------------------------------------

create table private.image_tool_usage (
  user_id uuid not null,
  day date not null,
  calls integer not null default 0 constraint image_tool_usage_calls_check check (calls >= 0),
  primary key (user_id, day)
);

create index image_tool_usage_day_idx on private.image_tool_usage (day);

alter table private.image_tool_usage enable row level security;
revoke all on table private.image_tool_usage from public, anon, authenticated;

-- Spend one image tool call for `p_user` today (UTC). Returns the calls the user has left today.
-- Errors: invalid_argument (no user), quota_exceeded (the user's or the project's allowance is used up).
-- Rows older than a week are dropped on the way.
create function public.consume_image_tool_quota(p_user uuid, p_anonymous boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_limit integer := case when coalesce(p_anonymous, true) then private.max_image_tool_calls_guest() else private.max_image_tool_calls_account() end;
  v_calls integer;
  v_total integer;
begin
  if p_user is null then
    raise exception 'invalid_argument' using detail = 'no user';
  end if;
  -- One queue for the whole project: the global cap cannot be overrun by concurrent calls.
  perform pg_advisory_xact_lock(hashtextextended('atlas_image_tools', 0));

  delete from private.image_tool_usage u where u.day < v_today - 7;

  select coalesce(sum(u.calls), 0) into v_total from private.image_tool_usage u where u.day = v_today;
  if v_total >= private.max_image_tool_calls_total() then
    raise exception 'quota_exceeded' using detail = 'the image tools are busy today; try again tomorrow';
  end if;

  select u.calls into v_calls from private.image_tool_usage u where u.user_id = p_user and u.day = v_today;
  if coalesce(v_calls, 0) >= v_limit then
    raise exception 'quota_exceeded' using detail = format('you have used your %s image tool calls for today', v_limit);
  end if;

  insert into private.image_tool_usage (user_id, day, calls)
  values (p_user, v_today, 1)
  on conflict (user_id, day) do update set calls = private.image_tool_usage.calls + 1
  returning calls into v_calls;

  return v_limit - v_calls;
end
$$;

revoke execute on function public.consume_image_tool_quota(uuid, boolean) from public, anon, authenticated;
grant execute on function public.consume_image_tool_quota(uuid, boolean) to service_role;
