-- Map tables (ARCHITECTURE §6.4, §6.8): a session is the TABLE of one map. The DM works on a map (edit or
-- play) at its table; the table's doors are open (status 'active': the room code works and members
-- connect) or closed ('closed': members are disconnected and read nothing, the room code stays reserved,
-- the DM keeps working); 'ended' tables are gone for good. A map is at most one live table's
-- (sessions.scene_id, which follows the table's map changes), so it has one live version: the table's.
--
--   open_map(scene, free_assets)                → the map's table, created closed (seeded from the latest
--                                                 version) when it has none
--   set_table_open(session, open)               → open / close the doors (DM)
--   set_session_scene(session, host_epoch, map) → the table now holds another map (fenced; an idle table
--                                                 holding that map ends; one with players refuses)
--
-- Games in progress each held their own copy of their map: they end here (no live users yet).

delete from public.player_views pv
using public.sessions s
where pv.session_id = s.id
  and s.status = 'active';

update public.sessions
set status = 'ended',
    ended_at = now(),
    host_epoch = host_epoch + 1
where status = 'active';

alter table public.sessions drop constraint sessions_status_check;
alter table public.sessions
  add constraint sessions_status_check check (status in ('active', 'closed', 'ended'));

-- Room codes stay reserved while a table is closed (players come back with the same code).
drop index public.sessions_active_room_code_key;
create unique index sessions_live_room_code_key on public.sessions (room_code) where status <> 'ended';

-- One live table per map.
create unique index sessions_live_scene_key on public.sessions (scene_id)
  where status <> 'ended' and scene_id is not null;

-- ---------------------------------------------------------------------------
-- Fencing and host claims: closed tables are live for the DM.
-- ---------------------------------------------------------------------------

create or replace function private.lock_fenced_session(p_session_id uuid, p_epoch bigint)
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
  if v_status = 'ended' then
    raise exception 'session_ended' using detail = 'the session has ended';
  end if;
  if p_epoch is distinct from v_epoch then
    raise exception 'stale_epoch' using detail = format('current host epoch is %s', v_epoch);
  end if;
end
$$;

create or replace function public.claim_host(p_session_id uuid)
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
    and s.status <> 'ended'
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
-- join_session: as before, but a closed table says so (table_closed) instead of "no such code".
-- ---------------------------------------------------------------------------

create or replace function public.join_session(p_room_code text, p_display_name text)
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
  v_table text;
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

  -- Only live tables are addressable by room code (ended ones release their code).
  select s.id, s.dm_id, s.status
  into v_sid, v_dm, v_table
  from public.sessions s
  where s.room_code = v_code
    and s.status <> 'ended'
  for share;

  if not found then
    raise exception 'session_not_found' using detail = 'no active session with that room code';
  end if;
  if v_dm = v_uid then
    raise exception 'is_dm' using detail = 'you are the DM of this session';
  end if;
  if v_table <> 'active' then
    raise exception 'table_closed' using detail = 'the DM has not opened this table';
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

  -- Serialise joins of one session so two players cannot take the same name at once.
  perform pg_advisory_xact_lock(hashtextextended('atlas_join:' || v_sid::text, 0));
  if private.display_name_taken(v_sid, v_uid, v_name) then
    raise exception 'name_taken' using detail = 'that name is taken in this session';
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
-- open_map(scene, free_assets) → (session_id, room_code, status, created)
-- The DM's table of one of their maps; a new one starts closed, seeded from the map's latest version
-- (free_assets: the categories the game loads, as create_session). At most max_sessions_per_dm() live
-- tables (one per map, so the scene quota bounds them anyway); ended ones beyond the newest go.
-- ---------------------------------------------------------------------------

create function public.open_map(p_scene_id uuid, p_free_assets text[] default '{}')
returns table (session_id uuid, room_code text, status text, created boolean)
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
  v_status text;
  v_free_assets text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if coalesce(cardinality(p_free_assets), 0) > 16
    or exists (select 1 from unnest(p_free_assets) c where c is null or not (c = any (private.free_asset_categories()))) then
    raise exception 'invalid_argument' using detail = 'unknown free asset category';
  end if;
  v_free_assets := array(select distinct c from unnest(coalesce(p_free_assets, '{}')) c order by c);

  -- Lock the map row: two tabs opening the same map get the same table.
  select s.latest_version, v.schema_version, v.data
  into v_version, v_schema_version, v_data
  from public.scenes s
  join public.scene_versions v
    on v.scene_id = s.id
   and v.version = s.latest_version
  where s.id = p_scene_id
    and s.owner_id = v_uid
  for update of s;

  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;

  select s.id, s.room_code, s.status
  into v_sid, v_code, v_status
  from public.sessions s
  where s.scene_id = p_scene_id
    and s.status <> 'ended';

  if found then
    return query select v_sid, v_code, v_status, false;
    return;
  end if;

  if (select count(*) from public.sessions s where s.dm_id = v_uid and s.status <> 'ended') >= private.max_sessions_per_dm() then
    raise exception 'too_many_sessions' using detail = 'too many open maps';
  end if;

  delete from public.sessions s
  where s.dm_id = v_uid
    and s.status = 'ended'
    and s.id not in (
      select k.id
      from public.sessions k
      where k.dm_id = v_uid
      order by (k.status <> 'ended') desc, k.created_at desc, k.id
      limit private.max_sessions_per_dm() - 1
    );

  for attempt in 1..16 loop
    v_code := private.generate_room_code();
    begin
      insert into public.sessions (dm_id, scene_id, room_code, status)
      values (v_uid, p_scene_id, v_code, 'closed')
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
      'scene', v_data,
      'freeAssets', to_jsonb(v_free_assets)
    )
  );

  return query select v_sid, v_code, 'closed'::text, true;
end
$$;

-- ---------------------------------------------------------------------------
-- set_table_open(session, open) → the new status. Only the DM; an ended table stays ended.
-- ---------------------------------------------------------------------------

create function public.set_table_open(p_session_id uuid, p_open boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  update public.sessions s
  set status = case when p_open then 'active' else 'closed' end
  where s.id = p_session_id
    and s.dm_id = v_uid
    and s.status <> 'ended'
  returning s.status into v_status;

  if not found then
    if private.is_session_dm(p_session_id) then
      raise exception 'session_ended' using detail = 'the session has ended';
    end if;
    raise exception 'not_found' using detail = 'session not found';
  end if;

  return v_status;
end
$$;

-- ---------------------------------------------------------------------------
-- set_session_scene(session, host_epoch, scene) → the table now holds this map (after a map change).
-- Fenced like the state saves. Another live table holding the map: ended when nobody plays there (the
-- caller took its live map from its session_state first), else map_in_use.
-- ---------------------------------------------------------------------------

create function public.set_session_scene(p_session_id uuid, p_host_epoch bigint, p_scene_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  perform private.lock_fenced_session(p_session_id, p_host_epoch);

  perform 1 from public.scenes s where s.id = p_scene_id and s.owner_id = v_uid for update;
  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;

  select s.id
  into v_other
  from public.sessions s
  where s.scene_id = p_scene_id
    and s.status <> 'ended'
    and s.id <> p_session_id
  for update;

  if found then
    if exists (select 1 from public.session_members m where m.session_id = v_other and m.status = 'active') then
      raise exception 'map_in_use' using detail = 'players are at another table on this map';
    end if;
    update public.sessions s
    set status = 'ended',
        ended_at = now(),
        host_epoch = s.host_epoch + 1
    where s.id = v_other;
    delete from public.player_views pv where pv.session_id = v_other;
  end if;

  update public.sessions s
  set scene_id = p_scene_id
  where s.id = p_session_id;

  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- create_session (older clients' "Start session"): the map's table, opened.
-- ---------------------------------------------------------------------------

create or replace function public.create_session(p_scene_id uuid, p_free_assets text[] default '{}')
returns table (session_id uuid, room_code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_sid uuid;
  v_code text;
begin
  select t.session_id, t.room_code into v_sid, v_code from public.open_map(p_scene_id, p_free_assets) t;
  perform public.set_table_open(v_sid, true);
  return query select v_sid, v_code;
end
$$;

-- ---------------------------------------------------------------------------
-- end_session: open or closed tables end.
-- ---------------------------------------------------------------------------

create or replace function public.end_session(p_session_id uuid)
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
    and s.status <> 'ended';

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

-- ---------------------------------------------------------------------------
-- Deleting a map ends its table (players are disconnected; the map is gone).
-- ---------------------------------------------------------------------------

create function private.end_scene_tables()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.player_views pv
  using public.sessions s
  where pv.session_id = s.id
    and s.scene_id = old.id
    and s.status <> 'ended';
  update public.sessions s
  set status = 'ended',
      ended_at = now(),
      host_epoch = s.host_epoch + 1
  where s.scene_id = old.id
    and s.status <> 'ended';
  return old;
end
$$;

revoke execute on function private.end_scene_tables() from public, anon, authenticated;

create trigger scenes_end_tables
  before delete on public.scenes
  for each row execute function private.end_scene_tables();

-- ---------------------------------------------------------------------------
-- Map images a closed table's map uses are still in use. The table of the map being deleted does not
-- count (it ends with the map).
-- ---------------------------------------------------------------------------

create or replace function public.image_folders_to_free(p_scene_id uuid)
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select d.doc
  from (
    select distinct v.data ->> 'id' as doc
    from public.scene_versions v
    join public.scenes s on s.id = v.scene_id
    where v.scene_id = p_scene_id
      and s.owner_id = (select auth.uid())
  ) d
  where d.doc ~ '^[A-Za-z0-9_-]{1,64}$'
    and not exists (
      select 1
      from public.scene_versions v
      join public.scenes s on s.id = v.scene_id
      where s.owner_id = (select auth.uid())
        and v.scene_id <> p_scene_id
        and v.data ->> 'id' = d.doc
    )
    and not exists (
      select 1
      from public.sessions s
      join public.session_state st on st.session_id = s.id
      where s.dm_id = (select auth.uid())
        and s.status <> 'ended'
        and s.scene_id is distinct from p_scene_id
        and st.state -> 'scene' ->> 'id' = d.doc
    )
$$;

create or replace function public.unreferenced_scene_assets(p_min_age interval default interval '7 days')
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select o.name
  from storage.objects o
  cross join lateral (
    select split_part(o.name, '/', 2) as folder,
           regexp_replace(split_part(o.name, '/', 3), '\.(webp|png|jpg)$', '') as asset
  ) k
  where o.bucket_id = 'scene-assets'
    and o.name like (select auth.uid())::text || '/%'
    and split_part(o.name, '/', 1) = (select auth.uid())::text
    and o.created_at < now() - greatest(coalesce(p_min_age, interval '7 days'), interval '0')
    and not exists (
      select 1
      from public.scene_versions v
      join public.scenes s on s.id = v.scene_id
      where s.owner_id = (select auth.uid())
        and (v.data ->> 'id' = k.folder or s.id::text = k.folder)
        and coalesce(v.data -> 'assets', '{}'::jsonb) ? k.asset
    )
    and not exists (
      select 1
      from public.sessions s
      join public.session_state st on st.session_id = s.id
      where s.dm_id = (select auth.uid())
        and s.status <> 'ended'
        and (st.state -> 'scene' ->> 'id' = k.folder or s.scene_id::text = k.folder)
        and coalesce(st.state -> 'scene' -> 'assets', '{}'::jsonb) ? k.asset
    )
$$;

revoke execute on function public.open_map(uuid, text[]) from public, anon;
revoke execute on function public.set_table_open(uuid, boolean) from public, anon;
revoke execute on function public.set_session_scene(uuid, bigint, uuid) from public, anon;
grant execute on function public.open_map(uuid, text[]) to authenticated;
grant execute on function public.set_table_open(uuid, boolean) to authenticated;
grant execute on function public.set_session_scene(uuid, bigint, uuid) to authenticated;
