-- Atlas VTT: per-player backdrop tile chunks (ARCHITECTURE §9).
--
-- The host now uploads, for EACH player, the explored part of every level's battlemap in chunks of
-- 4×4 grid cells at `session-tiles/{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp` (the object only holds
-- the cells that player explored). A chunk is readable by that user while an active member of the
-- (active) session, and by the session's DM; only the DM of the active session writes them, and the DM
-- may delete them (also after the session ended, for cleanup).
--
-- One object per player chunk instead of one shared object per cell + a grant row per cell: an open
-- outdoor map's first view costs ~70 uploads/downloads instead of ~1000, which Storage rate-limits
-- (HTTP 429 after a few hundred uploads in a burst).
--
-- The per-cell layout `{sessionId}/{levelId}/{i}_{j}.webp` with `player_tiles` grants keeps working
-- (same rules as before); the app no longer uses it.

-- '{sid}/{uid}/{levelId}/{ci}_{cj}.webp' → (sid, uid, level_id, ci, cj); NULLs for anything else.
create function private.parse_chunk_path(p_name text, out sid uuid, out uid uuid, out level_id text, out ci integer, out cj integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
begin
  m := regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([A-Za-z0-9_-]{1,64})/(0|[1-9][0-9]?)_(0|[1-9][0-9]?)\.webp$'
  );
  if m is null or m[4]::integer > 63 or m[5]::integer > 63 then
    return;
  end if;
  sid := m[1]::uuid;
  uid := m[2]::uuid;
  level_id := m[3];
  ci := m[4]::integer;
  cj := m[5]::integer;
end
$$;

revoke execute on function private.parse_chunk_path(text) from public, anon, authenticated;

-- Read: the session's DM; the chunk's own player while an active member; (legacy) granted cell tiles.
create or replace function private.can_read_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.is_session_dm(c.sid)
      or (c.uid = (select auth.uid()) and private.is_active_member(c.sid))
    from private.parse_chunk_path(p_name) c
    where c.sid is not null
  ), false)
  or coalesce((
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

-- Write (upload/replace): the DM of the ACTIVE session the object belongs to.
create or replace function private.can_write_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    where s.dm_id = (select auth.uid())
      and s.status = 'active'
      and s.id = coalesce(
        (select c.sid from private.parse_chunk_path(p_name) c where c.sid is not null),
        (select t.sid from private.parse_tile_path(p_name) t where t.sid is not null)
      )
  )
$$;

-- Delete: the session's DM (also after the session ended, for cleanup).
create or replace function private.can_delete_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.is_session_dm(coalesce(
      (select c.sid from private.parse_chunk_path(p_name) c where c.sid is not null),
      (select t.sid from private.parse_tile_path(p_name) t where t.sid is not null)
    )),
    false
  )
$$;
