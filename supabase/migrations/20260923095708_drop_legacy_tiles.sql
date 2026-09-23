-- Atlas VTT: remove the superseded per-cell tile API (ARCHITECTURE §9).
--
-- Sessions use per-player chunks (`session-tiles/{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`, see the
-- tile_chunks migration). The earlier layout — one shared object per cell at
-- `{sessionId}/{levelId}/{i}_{j}.webp` plus `player_tiles` grants written by grant_tiles() /
-- revoke_tiles() — is no longer used by the app, so it goes: less attack surface to maintain.
--
-- The storage helpers keep only the chunk branch. Deleting stays possible for the session's DM for any
-- object under `{sessionId}/` (including leftovers of the old layout), so cleanup after a session keeps
-- working.

-- Read: the session's DM; the chunk's own player while an active member.
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
$$;

-- Write (upload/replace): the DM of the ACTIVE session the chunk belongs to (per-player chunks only).
-- (Tightened further by the owner_quotas migration: the chunk's player must be a member, and a
-- session's object count is capped.)
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
    where c.sid is not null
      and s.dm_id = (select auth.uid())
      and s.status = 'active'
  )
$$;

-- Delete: the DM of the session named by the first path segment (also after the session ended, and
-- for objects of the old per-cell layout).
create or replace function private.can_delete_session_tile(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then coalesce(private.is_session_dm(split_part(p_name, '/', 1)::uuid), false)
    else false
  end
$$;

drop function public.grant_tiles(uuid, bigint, uuid, text, jsonb);
drop function public.revoke_tiles(uuid, bigint, uuid, text);
drop table public.player_tiles;
drop function private.parse_tile_path(text);
