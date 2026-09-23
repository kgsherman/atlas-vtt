-- Atlas VTT: the DM sees every object under their session's tile folder (ARCHITECTURE §9).
--
-- Storage lists and deletes run under RLS, and a DELETE only reaches rows the caller can also SELECT.
-- After drop_legacy_tiles the read helper only recognised per-player chunk paths, so objects of the old
-- per-cell layout (or any other stray path) under `{sessionId}/` became invisible to the DM — and
-- therefore impossible to clean up. The DM may read anything in their own session's folder; players
-- still read only their own chunks while active members.

create or replace function private.can_read_session_tile(p_name text)
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
  or coalesce((
    select c.uid = (select auth.uid()) and private.is_active_member(c.sid)
    from private.parse_chunk_path(p_name) c
    where c.sid is not null
  ), false)
$$;
