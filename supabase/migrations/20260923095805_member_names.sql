-- Atlas VTT: player display names are set only through join_session (ARCHITECTURE §6.4).
--
-- Members could PATCH their own session_members.display_name directly (column grant + policy), which
-- skipped join_session's normalisation and let a player take the DM's name or another player's in the
-- middle of a session. Renames now go through join_session only (joining again with another name),
-- which refuses ('name_taken'):
--   * the DM's profile name and names that pose as the DM ("DM", "GM", "Dungeon Master", …);
--   * a name another member of the session already uses (case-insensitive, kicked members included).

drop policy session_members_update_own_name on public.session_members;
revoke update (display_name) on public.session_members from authenticated;

-- Whether p_name (normalised) is unavailable to p_uid in session p_sid.
create function private.display_name_taken(p_sid uuid, p_uid uuid, p_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select lower(p_name) in ('dm', 'gm', 'the dm', 'the gm', 'dungeon master', 'game master', 'the dungeon master', 'the game master')
    or exists (
      select 1
      from public.sessions s
      join public.profiles p on p.id = s.dm_id
      where s.id = p_sid
        and lower(p.display_name) = lower(p_name)
    )
    or exists (
      select 1
      from public.session_members m
      where m.session_id = p_sid
        and m.user_id <> p_uid
        and lower(m.display_name) = lower(p_name)
    )
$$;

revoke execute on function private.display_name_taken(uuid, uuid, text) from public, anon, authenticated;

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
