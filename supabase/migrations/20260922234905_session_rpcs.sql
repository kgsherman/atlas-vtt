-- Atlas VTT: session RPCs (ARCHITECTURE §6.3, §6.4).
-- security definer, empty search_path, execute for `authenticated` only; they return ids, booleans
-- or small records, never whole rows. Errors carry a stable MESSAGE code (see the scene_rpcs migration).
--
-- Fencing: sessions.host_epoch is bumped by claim_host() (and end_session()). State writes pass the
-- epoch the host claimed; the session row is locked FOR SHARE while checking it, so a write either
-- commits before a concurrent claim_host() or is rejected with 'stale_epoch'.

create function private.max_state_bytes()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 32 * 1024 * 1024
$$;

create function private.max_view_bytes()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 16 * 1024 * 1024
$$;

-- Lock the caller's session row and verify it can accept a write fenced by p_epoch.
create function private.lock_fenced_session(p_session_id uuid, p_epoch bigint)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_dm uuid;
  v_status text;
  v_epoch bigint;
begin
  select s.dm_id, s.status, s.host_epoch
  into v_dm, v_status, v_epoch
  from public.sessions s
  where s.id = p_session_id
  for share;

  if not found or v_dm is distinct from auth.uid() then
    raise exception 'not_found' using detail = 'session not found';
  end if;
  if v_status <> 'active' then
    raise exception 'session_ended' using detail = 'the session has ended';
  end if;
  if p_epoch is distinct from v_epoch then
    raise exception 'stale_epoch' using detail = format('current host epoch is %s', v_epoch);
  end if;
end
$$;

revoke execute on function private.max_state_bytes() from public, anon, authenticated;
revoke execute on function private.max_view_bytes() from public, anon, authenticated;
revoke execute on function private.lock_fenced_session(uuid, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_session(scene) → (session_id, room_code)
-- Owner check; copies the scene's latest version into session_state as a seed
-- ({kind:'seed', sceneId, sceneVersion, schemaVersion, scene}) that the host turns into a GameState.
-- ---------------------------------------------------------------------------

create function public.create_session(p_scene_id uuid)
returns table (session_id uuid, room_code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_version integer;
  v_schema_version integer;
  v_data jsonb;
  v_code text;
  v_sid uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select s.latest_version, v.schema_version, v.data
  into v_version, v_schema_version, v_data
  from public.scenes s
  join public.scene_versions v
    on v.scene_id = s.id
   and v.version = s.latest_version
  where s.id = p_scene_id
    and s.owner_id = v_uid;

  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;

  if (select count(*) from public.sessions s where s.dm_id = v_uid and s.status = 'active') >= 20 then
    raise exception 'too_many_sessions' using detail = 'end an existing session first (max 20 active)';
  end if;

  -- 40-bit codes collide rarely; retry on the partial unique index.
  for attempt in 1..16 loop
    v_code := private.generate_room_code();
    begin
      insert into public.sessions (dm_id, scene_id, room_code)
      values (v_uid, p_scene_id, v_code)
      returning id into v_sid;
      exit;
    exception when unique_violation then
      v_sid := null;
    end;
  end loop;

  if v_sid is null then
    raise exception 'room_code_unavailable' using detail = 'could not allocate a room code';
  end if;

  insert into public.session_state (session_id, epoch, state)
  values (
    v_sid,
    0,
    jsonb_build_object(
      'kind', 'seed',
      'sceneId', p_scene_id,
      'sceneVersion', v_version,
      'schemaVersion', v_schema_version,
      'scene', v_data
    )
  );

  return query select v_sid, v_code;
end
$$;

-- ---------------------------------------------------------------------------
-- join_session(room_code, display_name) → session_id
-- Upserts the caller's OWN member row. Rejects unknown/ended sessions, kicked callers and the DM.
-- ---------------------------------------------------------------------------

create function public.join_session(p_room_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := private.normalize_room_code(p_room_code);
  v_name text := private.normalize_display_name(p_display_name);
  v_sid uuid;
  v_dm uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    raise exception 'invalid_room_code' using detail = 'room codes are 8 characters';
  end if;
  if v_name is null then
    raise exception 'invalid_display_name' using detail = 'display names are 1 to 32 characters';
  end if;

  -- Only ACTIVE sessions are addressable by room code (ended sessions release their code).
  select s.id, s.dm_id
  into v_sid, v_dm
  from public.sessions s
  where s.room_code = v_code
    and s.status = 'active'
  for share;

  if not found then
    raise exception 'session_not_found' using detail = 'no active session with that room code';
  end if;
  if v_dm = v_uid then
    raise exception 'is_dm' using detail = 'you are the DM of this session';
  end if;

  select m.status
  into v_status
  from public.session_members m
  where m.session_id = v_sid
    and m.user_id = v_uid;

  if v_status = 'kicked' then
    raise exception 'kicked' using detail = 'you were removed from this session';
  end if;

  if v_status is null
     and (select count(*) from public.session_members m where m.session_id = v_sid) >= 64 then
    raise exception 'session_full' using detail = 'this session has too many members';
  end if;

  -- The WHERE keeps a concurrent kick from being undone by a racing join.
  insert into public.session_members as m (session_id, user_id, display_name, status)
  values (v_sid, v_uid, v_name, 'active')
  on conflict (session_id, user_id) do update
    set display_name = excluded.display_name
    where m.status = 'active';

  if not found then
    raise exception 'kicked' using detail = 'you were removed from this session';
  end if;

  return v_sid;
end
$$;

-- ---------------------------------------------------------------------------
-- session_info(session) → one small record for the DM or a member (kicked members included, so
-- the client can explain why it cannot rejoin); no rows for anyone else.
-- ---------------------------------------------------------------------------

create function public.session_info(p_session_id uuid)
returns table (
  session_id uuid,
  status text,
  room_code text,
  role text,
  member_status text,
  display_name text,
  dm_display_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.status,
    s.room_code,
    case when s.dm_id = (select auth.uid()) then 'dm' else 'player' end,
    m.status,
    m.display_name,
    p.display_name,
    s.created_at
  from public.sessions s
  left join public.session_members m
    on m.session_id = s.id
   and m.user_id = (select auth.uid())
  left join public.profiles p
    on p.id = s.dm_id
  where s.id = p_session_id
    and (s.dm_id = (select auth.uid()) or m.user_id is not null)
$$;

-- ---------------------------------------------------------------------------
-- list_session_members(session) → members (DM only)
-- ---------------------------------------------------------------------------

create function public.list_session_members(p_session_id uuid)
returns table (user_id uuid, display_name text, status text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_session_dm(p_session_id) then
    raise exception 'forbidden' using detail = 'only the DM can list members';
  end if;
  return query
    select m.user_id, m.display_name, m.status, m.joined_at
    from public.session_members m
    where m.session_id = p_session_id
    order by m.joined_at, m.user_id;
end
$$;

-- ---------------------------------------------------------------------------
-- set_member_status(session, user, 'active'|'kicked') → whether a member row changed (DM only)
-- ---------------------------------------------------------------------------

create function public.set_member_status(p_session_id uuid, p_user_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('active', 'kicked') then
    raise exception 'invalid_argument' using detail = 'status must be active or kicked';
  end if;
  if not private.is_session_dm(p_session_id) then
    raise exception 'forbidden' using detail = 'only the DM can change member status';
  end if;

  update public.session_members m
  set status = p_status
  where m.session_id = p_session_id
    and m.user_id = p_user_id
    and m.status <> p_status;

  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- claim_host(session) → the new host_epoch (DM only, active sessions). Any previous host's fenced
-- writes fail from now on.
-- ---------------------------------------------------------------------------

create function public.claim_host(p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_epoch bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  update public.sessions s
  set host_epoch = s.host_epoch + 1
  where s.id = p_session_id
    and s.dm_id = v_uid
    and s.status = 'active'
  returning s.host_epoch into v_epoch;

  if not found then
    if private.is_session_dm(p_session_id) then
      raise exception 'session_ended' using detail = 'the session has ended';
    end if;
    raise exception 'not_found' using detail = 'session not found';
  end if;

  return v_epoch;
end
$$;

-- ---------------------------------------------------------------------------
-- save_session_state(session, epoch, state) → true (fenced; 'stale_epoch' when superseded)
-- ---------------------------------------------------------------------------

create function public.save_session_state(p_session_id uuid, p_epoch bigint, p_state jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'invalid_argument' using detail = 'state must be a JSON object';
  end if;
  if pg_column_size(p_state) > private.max_state_bytes() then
    raise exception 'payload_too_large' using detail = format('state exceeds %s bytes', private.max_state_bytes());
  end if;

  perform private.lock_fenced_session(p_session_id, p_epoch);

  insert into public.session_state as ss (session_id, epoch, state, updated_at)
  values (p_session_id, p_epoch, p_state, now())
  on conflict (session_id) do update
    set epoch = excluded.epoch,
        state = excluded.state,
        updated_at = excluded.updated_at;

  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- upsert_player_view(session, user, host_epoch, epoch, seq, view) → whether the row was written
-- Fenced by host_epoch. Within one wire epoch an older seq never overwrites a newer one (false).
-- ---------------------------------------------------------------------------

create function public.upsert_player_view(
  p_session_id uuid,
  p_user_id uuid,
  p_host_epoch bigint,
  p_epoch text,
  p_seq bigint,
  p_view jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if p_epoch is null or char_length(p_epoch) not between 1 and 64 then
    raise exception 'invalid_argument' using detail = 'epoch must be 1 to 64 characters';
  end if;
  if p_seq is null or p_seq < 0 then
    raise exception 'invalid_argument' using detail = 'seq must be >= 0';
  end if;
  if p_view is null or jsonb_typeof(p_view) <> 'object' then
    raise exception 'invalid_argument' using detail = 'view must be a JSON object';
  end if;
  if pg_column_size(p_view) > private.max_view_bytes() then
    raise exception 'payload_too_large' using detail = format('view exceeds %s bytes', private.max_view_bytes());
  end if;

  perform private.lock_fenced_session(p_session_id, p_host_epoch);

  if not exists (
    select 1
    from public.session_members m
    where m.session_id = p_session_id
      and m.user_id = p_user_id
      and m.status = 'active'
  ) then
    raise exception 'not_member' using detail = 'the user is not an active member of this session';
  end if;

  insert into public.player_views as pv (session_id, user_id, host_epoch, epoch, seq, view, updated_at)
  values (p_session_id, p_user_id, p_host_epoch, p_epoch, p_seq, p_view, now())
  on conflict (session_id, user_id) do update
    set host_epoch = excluded.host_epoch,
        epoch = excluded.epoch,
        seq = excluded.seq,
        view = excluded.view,
        updated_at = excluded.updated_at
    where pv.host_epoch < excluded.host_epoch
       or pv.epoch <> excluded.epoch
       or pv.seq <= excluded.seq;

  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- end_session(session) → whether the session was active (DM only). Bumps host_epoch so a running
-- host's fenced writes fail, releases the room code and drops the per-player views.
-- ---------------------------------------------------------------------------

create function public.end_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  update public.sessions s
  set status = 'ended',
      ended_at = now(),
      host_epoch = s.host_epoch + 1
  where s.id = p_session_id
    and s.dm_id = v_uid
    and s.status = 'active';

  if not found then
    if private.is_session_dm(p_session_id) then
      return false;
    end if;
    raise exception 'not_found' using detail = 'session not found';
  end if;

  delete from public.player_views pv where pv.session_id = p_session_id;
  return true;
end
$$;

revoke execute on function public.create_session(uuid) from public, anon;
revoke execute on function public.join_session(text, text) from public, anon;
revoke execute on function public.session_info(uuid) from public, anon;
revoke execute on function public.list_session_members(uuid) from public, anon;
revoke execute on function public.set_member_status(uuid, uuid, text) from public, anon;
revoke execute on function public.claim_host(uuid) from public, anon;
revoke execute on function public.save_session_state(uuid, bigint, jsonb) from public, anon;
revoke execute on function public.upsert_player_view(uuid, uuid, bigint, text, bigint, jsonb) from public, anon;
revoke execute on function public.end_session(uuid) from public, anon;

grant execute on function public.create_session(uuid) to authenticated;
grant execute on function public.join_session(text, text) to authenticated;
grant execute on function public.session_info(uuid) to authenticated;
grant execute on function public.list_session_members(uuid) to authenticated;
grant execute on function public.set_member_status(uuid, uuid, text) to authenticated;
grant execute on function public.claim_host(uuid) to authenticated;
grant execute on function public.save_session_state(uuid, bigint, jsonb) to authenticated;
grant execute on function public.upsert_player_view(uuid, uuid, bigint, text, bigint, jsonb) to authenticated;
grant execute on function public.end_session(uuid) to authenticated;
