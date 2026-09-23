-- Atlas VTT: merge a guest (anonymous) account into a permanent one (ARCHITECTURE §6.4 Identity).
--
-- A guest who signs in to an account that already exists (linking failed with identity_already_exists)
-- takes what it made along:
--  1. Still signed in as the guest, the client calls create_merge_ticket(): a random one-time secret
--     (only its SHA-256 is stored), valid for one hour. Holding it proves the guest agreed.
--  2. Signed in to the account, the client calls the `merge-guest` Edge Function with the ticket. The
--     function (secret key) calls begin_guest_merge() (validates, checks the combined quotas, names the
--     guest's map images), moves those images from `{guest}/…` to `{account}/…` through the Storage API
--     (SQL cannot move Storage objects), calls finish_guest_merge() (hands over scenes and hosted
--     sessions, consumes the ticket) and finally deletes the guest user.
-- Both steps can be retried with the same ticket until finish_guest_merge() consumes it: a partly moved
-- image folder is simply moved further.
--
-- Not merged: the guest's memberships in other DMs' games (their game state refers to the guest's
-- user id; the player rejoins with the room code) and its session-tiles chunks (they belong to those
-- sessions and go when the DM ends them).

create table private.guest_merge_tickets (
  guest_id uuid primary key references auth.users (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

revoke all on table private.guest_merge_tickets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guest side
-- ---------------------------------------------------------------------------

-- A fresh ticket for the calling guest (replacing any earlier one). 256 random bits, base64url.
create function public.create_merge_ticket()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- auth.users, not the JWT: a token issued before the guest linked an identity still says anonymous.
  if not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
    raise exception 'forbidden' using detail = 'only guest accounts can be merged into another account';
  end if;

  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into private.guest_merge_tickets (guest_id, token_hash, expires_at)
  values (v_uid, extensions.digest(v_token, 'sha256'), now() + interval '1 hour')
  on conflict (guest_id) do update
    set token_hash = excluded.token_hash,
        created_at = now(),
        expires_at = excluded.expires_at;
  return v_token;
end
$$;

revoke execute on function public.create_merge_ticket() from public, anon;
grant execute on function public.create_merge_ticket() to authenticated;

-- ---------------------------------------------------------------------------
-- Server side (secret key only)
-- ---------------------------------------------------------------------------

-- The guest a valid ticket names, after checking that guest → target is a legal merge.
create function private.resolve_merge_ticket(p_token text, p_target uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_guest uuid;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' or p_target is null then
    raise exception 'invalid_argument' using detail = 'malformed merge ticket';
  end if;
  select t.guest_id into v_guest
  from private.guest_merge_tickets t
  where t.token_hash = extensions.digest(p_token, 'sha256')
    and t.expires_at > now();
  if v_guest is null then
    raise exception 'not_found' using detail = 'the merge ticket is unknown, used or expired';
  end if;
  if v_guest = p_target then
    raise exception 'invalid_argument' using detail = 'cannot merge an account into itself';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_guest and u.is_anonymous) then
    raise exception 'forbidden' using detail = 'the source account is no longer a guest';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_target and not coalesce(u.is_anonymous, false)) then
    raise exception 'forbidden' using detail = 'guests can only be merged into a permanent account';
  end if;
  return v_guest;
end
$$;

-- Would guest + target fit in one account? Raises quota_exceeded (with the limit that failed).
create function private.check_merge_quotas(p_guest uuid, p_target uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scenes integer;
  v_scene_bytes bigint;
  v_active integer;
  v_objects integer;
  v_object_bytes bigint;
begin
  select count(*) into v_scenes from public.scenes s where s.owner_id in (p_guest, p_target);
  if v_scenes > private.max_scenes_per_owner() then
    raise exception 'quota_exceeded' using detail = format('together the accounts have %s scenes; at most %s fit in one account', v_scenes, private.max_scenes_per_owner());
  end if;

  select coalesce(sum(pg_column_size(v.data)), 0) into v_scene_bytes
  from public.scene_versions v
  join public.scenes s on s.id = v.scene_id
  where s.owner_id in (p_guest, p_target);
  if v_scene_bytes > private.max_owner_scene_bytes() then
    raise exception 'quota_exceeded' using detail = format('together the scenes use more than the %s bytes one account may store', private.max_owner_scene_bytes());
  end if;

  select count(*) into v_active from public.sessions s where s.dm_id in (p_guest, p_target) and s.status = 'active';
  -- create_session allows 20 active games per DM (max_sessions_per_dm() caps ended ones too).
  if v_active > 20 then
    raise exception 'too_many_sessions' using detail = format('together the accounts host %s active games; end some first', v_active);
  end if;

  select count(*), coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)
  into v_objects, v_object_bytes
  from storage.objects o
  where o.bucket_id = 'scene-assets'
    and (o.name like p_guest::text || '/%' or o.name like p_target::text || '/%');
  if v_objects > private.max_owner_asset_objects() or v_object_bytes > private.max_owner_asset_bytes() then
    raise exception 'quota_exceeded' using detail = 'together the map images exceed what one account may store';
  end if;
end
$$;

-- Step 1: validate, check quotas, and name the guest's map images still to move (bucket scene-assets).
create function public.begin_guest_merge(p_token text, p_target uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_guest uuid := private.resolve_merge_ticket(p_token, p_target);
begin
  perform private.check_merge_quotas(v_guest, p_target);
  return jsonb_build_object(
    'guest_id', v_guest,
    'objects', coalesce((
      select jsonb_agg(o.name order by o.name)
      from storage.objects o
      where o.bucket_id = 'scene-assets'
        and o.name like v_guest::text || '/%'
    ), '[]'::jsonb)
  );
end
$$;

-- Step 2 (after the images moved): hand over scenes, hosted sessions and a missing display name, and
-- consume the ticket. One transaction; both accounts' quota locks are held (in id order).
create function public.finish_guest_merge(p_token text, p_target uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_guest uuid := private.resolve_merge_ticket(p_token, p_target);
  v_scenes integer;
  v_sessions integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || least(v_guest, p_target)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || greatest(v_guest, p_target)::text, 0));
  perform private.check_merge_quotas(v_guest, p_target);

  if exists (select 1 from storage.objects o where o.bucket_id = 'scene-assets' and o.name like v_guest::text || '/%') then
    raise exception 'invalid_argument' using detail = 'the guest''s map images have not all been moved yet';
  end if;

  update public.scenes s set owner_id = p_target where s.owner_id = v_guest;
  get diagnostics v_scenes = row_count;

  -- The account becomes DM of the guest's games; a DM is never also a member of their own game.
  delete from public.session_members m
  using public.sessions s
  where s.id = m.session_id
    and s.dm_id = v_guest
    and m.user_id = p_target;
  update public.sessions s set dm_id = p_target where s.dm_id = v_guest;
  get diagnostics v_sessions = row_count;

  -- Keep at most max_sessions_per_dm() sessions, like create_session: ended ones beyond go first.
  delete from public.sessions s
  where s.dm_id = p_target
    and s.status = 'ended'
    and s.id not in (
      select k.id
      from public.sessions k
      where k.dm_id = p_target
      order by (k.status = 'active') desc, k.created_at desc, k.id
      limit private.max_sessions_per_dm()
    );

  -- The account keeps its own display name; it adopts the guest's only if it has none.
  insert into public.profiles (id, display_name)
  select p_target, p.display_name
  from public.profiles p
  where p.id = v_guest
  on conflict (id) do nothing;

  delete from private.guest_merge_tickets t where t.guest_id = v_guest;
  return jsonb_build_object('guest_id', v_guest, 'scenes', v_scenes, 'sessions', v_sessions);
end
$$;

revoke execute on function private.resolve_merge_ticket(text, uuid) from public, anon, authenticated;
revoke execute on function private.check_merge_quotas(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.begin_guest_merge(text, uuid) from public, anon, authenticated;
revoke execute on function public.finish_guest_merge(text, uuid) from public, anon, authenticated;
grant execute on function public.begin_guest_merge(text, uuid) to service_role;
grant execute on function public.finish_guest_merge(text, uuid) to service_role;
