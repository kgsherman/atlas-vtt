-- Atlas VTT: per-account quotas (ARCHITECTURE §6.4).
--
-- Anonymous sign-ins are free, so every write path that can grow the database or Storage is capped per
-- account (or per session), not just per call:
--   * scenes: at most max_scenes_per_owner() library scenes and max_owner_scene_bytes() of stored
--     versions per owner (create_scene / save_scene_version raise 'quota_exceeded'); a scene's history
--     is pruned by size as well as by count (the latest version always stays);
--   * sessions: a DM keeps at most max_sessions_per_dm() sessions — create_session deletes the oldest
--     ENDED ones beyond that (their state, members and views cascade);
--   * scene-assets: at most max_owner_asset_objects() images / max_owner_asset_bytes() per owner
--     (storage insert policy);
--   * session-tiles: a chunk's player must be a member of the session, and a session holds at most
--     max_session_tile_objects() objects. The old per-cell layout is gone (drop_legacy_tiles).
--
-- Sizes are pg_column_size(): for stored rows the (compressed) on-disk size, so no column is added.
-- Concurrent calls of one owner queue on an advisory lock instead of all passing the check at once.

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------

create function private.max_scenes_per_owner()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 50
$$;

create function private.max_owner_scene_bytes()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 200::bigint * 1024 * 1024
$$;

create function private.max_scene_history_bytes()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 100::bigint * 1024 * 1024
$$;

create function private.max_sessions_per_dm()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 50
$$;

create function private.max_owner_asset_objects()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 300
$$;

create function private.max_owner_asset_bytes()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 1024::bigint * 1024 * 1024
$$;

create function private.max_session_tile_objects()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 20000
$$;

revoke execute on function private.max_scenes_per_owner() from public, anon, authenticated;
revoke execute on function private.max_owner_scene_bytes() from public, anon, authenticated;
revoke execute on function private.max_scene_history_bytes() from public, anon, authenticated;
revoke execute on function private.max_sessions_per_dm() from public, anon, authenticated;
revoke execute on function private.max_owner_asset_objects() from public, anon, authenticated;
revoke execute on function private.max_owner_asset_bytes() from public, anon, authenticated;
revoke execute on function private.max_session_tile_objects() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scene quota
-- ---------------------------------------------------------------------------

-- Refuse ('quota_exceeded') a write of p_new_bytes more scene data by p_uid (p_extra_scene: it also
-- creates a library scene). Serialised per owner for the rest of the transaction. The limits are
-- parameters (defaults: the constants above) so the SQL tests can exercise them at a small scale.
create function private.check_owner_scene_quota(
  p_uid uuid,
  p_new_bytes bigint,
  p_extra_scene boolean,
  p_max_scenes integer default private.max_scenes_per_owner(),
  p_max_bytes bigint default private.max_owner_scene_bytes()
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_scenes integer;
  v_used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || p_uid::text, 0));

  select count(*) into v_scenes from public.scenes s where s.owner_id = p_uid;
  if p_extra_scene and v_scenes >= p_max_scenes then
    raise exception 'quota_exceeded' using detail = format('at most %s scenes per account: delete old scenes first', p_max_scenes);
  end if;

  select coalesce(sum(pg_column_size(v.data)), 0)
  into v_used
  from public.scene_versions v
  join public.scenes s on s.id = v.scene_id
  where s.owner_id = p_uid;
  if v_used + coalesce(p_new_bytes, 0) > p_max_bytes then
    raise exception 'quota_exceeded' using detail = format('scenes and their versions may use at most %s bytes per account', p_max_bytes);
  end if;
end
$$;

-- Delete a scene's oldest versions (never p_latest) until the rest fits in p_max_bytes, newest first.
create function private.prune_scene_history(p_scene_id uuid, p_latest integer, p_max_bytes bigint default private.max_scene_history_bytes())
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.scene_versions v
  where v.scene_id = p_scene_id
    and v.version < p_latest
    and v.version <= (
      select max(h.version)
      from (
        select x.version, sum(pg_column_size(x.data)) over (order by x.version desc) as used
        from public.scene_versions x
        where x.scene_id = p_scene_id
      ) h
      where h.used > p_max_bytes
    );
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function private.check_owner_scene_quota(uuid, bigint, boolean, integer, bigint) from public, anon, authenticated;
revoke execute on function private.prune_scene_history(uuid, integer, bigint) from public, anon, authenticated;

create or replace function public.create_scene(p_name text, p_schema_version integer, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform private.check_scene_payload(p_schema_version, p_data);
  perform private.check_owner_scene_quota(v_uid, pg_column_size(p_data), true);

  insert into public.scenes (owner_id, name, latest_version)
  values (v_uid, private.normalize_scene_name(p_name), 1)
  returning id into v_id;

  insert into public.scene_versions (scene_id, version, schema_version, data)
  values (v_id, 1, p_schema_version, p_data);

  return v_id;
end
$$;

create or replace function public.save_scene_version(
  p_scene_id uuid,
  p_schema_version integer,
  p_data jsonb,
  p_base_version integer default null,
  p_name text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_latest integer;
  v_next integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform private.check_scene_payload(p_schema_version, p_data);

  select s.owner_id, s.latest_version
  into v_owner, v_latest
  from public.scenes s
  where s.id = p_scene_id
  for update;

  if not found or v_owner is distinct from v_uid then
    raise exception 'not_found' using detail = 'scene not found';
  end if;
  if p_base_version is not null and p_base_version <> v_latest then
    raise exception 'version_conflict' using detail = format('latest version is %s', v_latest);
  end if;
  perform private.check_owner_scene_quota(v_uid, pg_column_size(p_data), false);

  v_next := v_latest + 1;

  insert into public.scene_versions (scene_id, version, schema_version, data)
  values (p_scene_id, v_next, p_schema_version, p_data);

  update public.scenes s
  set latest_version = v_next,
      name = case when p_name is null then s.name else private.normalize_scene_name(p_name) end
  where s.id = p_scene_id;

  -- History: the newest max_scene_versions() versions …
  delete from public.scene_versions v
  where v.scene_id = p_scene_id
    and v.version <= v_next - private.max_scene_versions();

  -- … and, newest first, only as many as fit in max_scene_history_bytes() (never the latest).
  perform private.prune_scene_history(p_scene_id, v_next);

  return v_next;
end
$$;

-- ---------------------------------------------------------------------------
-- Sessions: keep a bounded number per DM
-- ---------------------------------------------------------------------------

create or replace function public.create_session(p_scene_id uuid)
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

  -- Room for the new one: ended sessions beyond the newest (max - 1) sessions (active ones count
  -- first) go, with their state, members and views (cascade). Their tile objects are removed by the
  -- client's cleanup, by path.
  delete from public.sessions s
  where s.dm_id = v_uid
    and s.status = 'ended'
    and s.id not in (
      select k.id
      from public.sessions k
      where k.dm_id = v_uid
      order by (k.status = 'active') desc, k.created_at desc, k.id
      limit private.max_sessions_per_dm() - 1
    );

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
-- Storage: scene-assets per owner, session-tiles per session
-- ---------------------------------------------------------------------------

-- The caller may add this image: their own folder, a well-formed path, and room left under the
-- owner's object count and byte budgets (the byte total may overshoot by one image of ≤ 50 MB; the
-- count bounds it anyway).
create function private.can_insert_scene_asset(p_name text)
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
     or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg)$' then
    return false;
  end if;
  select count(*), coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)
  into v_count, v_bytes
  from storage.objects o
  where o.bucket_id = 'scene-assets'
    and o.name like v_uid || '/%'
    and split_part(o.name, '/', 1) = v_uid;
  return v_count < private.max_owner_asset_objects() and v_bytes < private.max_owner_asset_bytes();
end
$$;

revoke execute on function private.can_insert_scene_asset(text) from public, anon, authenticated;
grant execute on function private.can_insert_scene_asset(text) to authenticated;

-- Write (upload/replace) a player chunk: the DM of the ACTIVE session, for one of its members, while
-- the session holds fewer than max_session_tile_objects() objects.
create or replace function private.can_write_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.parse_chunk_path(p_name) c
    join public.sessions s on s.id = c.sid
    join public.session_members m on m.session_id = c.sid and m.user_id = c.uid
    where c.sid is not null
      and s.dm_id = (select auth.uid())
      and s.status = 'active'
      and (
        select count(*)
        from storage.objects o
        where o.bucket_id = 'session-tiles'
          and o.name like c.sid::text || '/%'
      ) < private.max_session_tile_objects()
  )
$$;

drop policy atlas_objects_insert on storage.objects;

create policy atlas_objects_insert on storage.objects
  for insert to authenticated
  with check (
    (bucket_id = 'scene-assets' and private.can_insert_scene_asset(name))
    or (bucket_id = 'session-tiles' and private.can_write_session_tile(name))
  );
