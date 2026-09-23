-- Atlas VTT: map images (ARCHITECTURE §9).
--
--  * Bucket `scene-assets` (private): DM battlemaps at {ownerId}/{sceneId}/{assetId}.{webp|png|jpg}.
--    Only the owner's own folder is readable/writable.
--  * Bucket `session-tiles` (private): one tile per grid cell at {sessionId}/{levelId}/{i}_{j}.webp,
--    written by the session's DM. A player may read a tile only while a `player_tiles` row grants it
--    to them AND they are an active member of the (active) session. The DM reads everything.
--  * `player_tiles`: grants, written only through the fenced RPC grant_tiles() (and removed by
--    revoke_tiles(), e.g. after a fog reset). Players may read their own rows.
--
-- storage.objects gets ONE permissive policy per command (covering both buckets), matching the rest of
-- the schema. Path parsing is regex-validated; malformed paths parse to NULLs and every check denies.

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('scene-assets', 'scene-assets', false, 52428800, array['image/webp', 'image/png', 'image/jpeg']),
  ('session-tiles', 'session-tiles', false, 2097152, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- player_tiles: which explored-cell tiles each player may download
-- ---------------------------------------------------------------------------

create table public.player_tiles (
  session_id uuid not null,
  user_id uuid not null,
  level_id text not null constraint player_tiles_level_id_check check (level_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  i integer not null constraint player_tiles_i_check check (i between 0 and 199),
  j integer not null constraint player_tiles_j_check check (j between 0 and 199),
  created_at timestamptz not null default now(),
  primary key (session_id, user_id, level_id, i, j),
  -- Leaving / deleting the session drops the grants.
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

alter table public.player_tiles enable row level security;
revoke all on table public.player_tiles from public, anon, authenticated;
-- No client writes: grants go through grant_tiles() / revoke_tiles().
grant select on public.player_tiles to authenticated;

create policy player_tiles_select_own_or_dm on public.player_tiles
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_session_dm(session_id));

-- ---------------------------------------------------------------------------
-- Path helpers
-- ---------------------------------------------------------------------------

-- '{sid}/{levelId}/{i}_{j}.webp' → (sid, level_id, i, j); NULLs for anything else.
create function private.parse_tile_path(p_name text, out sid uuid, out level_id text, out i integer, out j integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
begin
  m := regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([A-Za-z0-9_-]{1,64})/(0|[1-9][0-9]?|1[0-9]{2})_(0|[1-9][0-9]?|1[0-9]{2})\.webp$'
  );
  if m is null then
    return;
  end if;
  sid := m[1]::uuid;
  level_id := m[2];
  i := m[3]::integer;
  j := m[4]::integer;
end
$$;

-- The caller may read this tile: the session's DM, or an active member holding a grant for it.
create function private.can_read_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.is_session_dm(t.sid)
      or (
        private.is_active_member(t.sid)
        and exists (
          select 1
          from public.player_tiles g
          where g.session_id = t.sid
            and g.user_id = (select auth.uid())
            and g.level_id = t.level_id
            and g.i = t.i
            and g.j = t.j
        )
      )
    from private.parse_tile_path(p_name) t
    where t.sid is not null
  ), false)
$$;

-- The caller may write (upload/replace) this tile: the DM of the ACTIVE session it belongs to.
create function private.can_write_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.parse_tile_path(p_name) t
    join public.sessions s on s.id = t.sid
    where s.dm_id = (select auth.uid())
      and s.status = 'active'
  )
$$;

-- The caller may delete tiles of this session: its DM (also after the session ended, for cleanup).
create function private.can_delete_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select private.is_session_dm(t.sid) from private.parse_tile_path(p_name) t where t.sid is not null), false)
$$;

revoke execute on function private.parse_tile_path(text) from public, anon, authenticated;
revoke execute on function private.can_read_session_tile(text) from public, anon, authenticated;
revoke execute on function private.can_write_session_tile(text) from public, anon, authenticated;
revoke execute on function private.can_delete_session_tile(text) from public, anon, authenticated;
-- Storage policies are evaluated as the calling role.
grant execute on function private.can_read_session_tile(text) to authenticated;
grant execute on function private.can_write_session_tile(text) to authenticated;
grant execute on function private.can_delete_session_tile(text) to authenticated;

-- ---------------------------------------------------------------------------
-- storage.objects policies (one per command, both buckets)
-- ---------------------------------------------------------------------------

create policy atlas_objects_select on storage.objects
  for select to authenticated
  using (
    (bucket_id = 'scene-assets' and split_part(name, '/', 1) = (select auth.uid())::text)
    or (bucket_id = 'session-tiles' and private.can_read_session_tile(name))
  );

create policy atlas_objects_insert on storage.objects
  for insert to authenticated
  with check (
    (
      bucket_id = 'scene-assets'
      and split_part(name, '/', 1) = (select auth.uid())::text
      and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg)$'
    )
    or (bucket_id = 'session-tiles' and private.can_write_session_tile(name))
  );

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
  );

-- ---------------------------------------------------------------------------
-- grant_tiles / revoke_tiles (fenced by sessions.host_epoch; see the session_rpcs migration)
-- ---------------------------------------------------------------------------

-- Grant `p_user_id` read access to the tiles of cells `p_cells` ([[i, j], …], ≤ 5000 per call) on
-- level `p_level_id`. Returns the number of NEW grants. Errors: not_authenticated, not_found (not the
-- DM), session_ended, stale_epoch, not_member, invalid_argument, payload_too_large.
create function public.grant_tiles(p_session_id uuid, p_host_epoch bigint, p_user_id uuid, p_level_id text, p_cells jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  perform private.lock_fenced_session(p_session_id, p_host_epoch);
  if p_level_id is null or p_level_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_argument' using detail = 'invalid level id';
  end if;
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' then
    raise exception 'invalid_argument' using detail = 'cells must be an array of [i, j] pairs';
  end if;
  if jsonb_array_length(p_cells) > 5000 then
    raise exception 'payload_too_large' using detail = 'at most 5000 cells per call';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_cells) e
    where jsonb_typeof(e) <> 'array'
      or jsonb_array_length(e) <> 2
      or jsonb_typeof(e -> 0) <> 'number'
      or jsonb_typeof(e -> 1) <> 'number'
      or (e ->> 0) !~ '^(0|[1-9][0-9]?|1[0-9]{2})$'
      or (e ->> 1) !~ '^(0|[1-9][0-9]?|1[0-9]{2})$'
  ) then
    raise exception 'invalid_argument' using detail = 'cells must be [i, j] integer pairs in 0..199';
  end if;

  select m.status
  into v_status
  from public.session_members m
  where m.session_id = p_session_id
    and m.user_id = p_user_id;
  if v_status is distinct from 'active' then
    raise exception 'not_member' using detail = 'grants are only for active members';
  end if;

  insert into public.player_tiles (session_id, user_id, level_id, i, j)
  select p_session_id, p_user_id, p_level_id, (e ->> 0)::integer, (e ->> 1)::integer
  from jsonb_array_elements(p_cells) e
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Remove grants (fog reset): one player (or everyone when p_user_id is null), one level (or all).
-- Returns the number of grants removed.
create function public.revoke_tiles(p_session_id uuid, p_host_epoch bigint, p_user_id uuid default null, p_level_id text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  perform private.lock_fenced_session(p_session_id, p_host_epoch);
  delete from public.player_tiles g
  where g.session_id = p_session_id
    and (p_user_id is null or g.user_id = p_user_id)
    and (p_level_id is null or g.level_id = p_level_id);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.grant_tiles(uuid, bigint, uuid, text, jsonb) from public, anon;
revoke execute on function public.revoke_tiles(uuid, bigint, uuid, text) from public, anon;
grant execute on function public.grant_tiles(uuid, bigint, uuid, text, jsonb) to authenticated;
grant execute on function public.revoke_tiles(uuid, bigint, uuid, text) to authenticated;
