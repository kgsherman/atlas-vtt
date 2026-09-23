-- Atlas VTT: helpers in schema `private` (ARCHITECTURE §6.4).
-- Every function has an empty search_path and schema-qualifies all references. The topic/role
-- helpers called by RLS policies are security definer + stable and are the only ones executable by
-- `authenticated`; generators and normalisers are used by the RPCs only.

-- ---------------------------------------------------------------------------
-- Realtime topic parsing. Topics (ARCHITECTURE §6.1):
--   session:{sid}:req:{uid}   session:{sid}:view:{uid}   session:{sid}:host   session:{sid}:lobby
-- with lowercase canonical uuids. Anything else parses to NULLs (and every policy then denies).
-- ---------------------------------------------------------------------------

create function private.parse_topic(p_topic text, out sid uuid, out kind text, out uid uuid)
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
begin
  m := regexp_match(
    p_topic,
    '^session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    || ':(req|view|host|lobby)'
    || '(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$'
  );
  if m is null then
    return;
  end if;
  -- req/view topics carry a user id; host/lobby topics must not.
  if (m[2] in ('req', 'view')) is distinct from (m[3] is not null) then
    return;
  end if;
  sid := m[1]::uuid;
  kind := m[2];
  uid := m[3]::uuid;
end
$$;

create function private.topic_sid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (private.parse_topic(realtime.topic())).sid
$$;

create function private.topic_kind()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select (private.parse_topic(realtime.topic())).kind
$$;

create function private.topic_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (private.parse_topic(realtime.topic())).uid
$$;

-- ---------------------------------------------------------------------------
-- Session roles. DM-ness comes from sessions.dm_id only; membership from session_members only.
-- ---------------------------------------------------------------------------

create function private.is_session_dm(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = p_session_id
      and s.dm_id = (select auth.uid())
  )
$$;

-- Active member of an ACTIVE session (kicked members and ended sessions grant nothing).
create function private.is_active_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_members m
    join public.sessions s on s.id = m.session_id
    where m.session_id = p_session_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and s.status = 'active'
  )
$$;

-- ---------------------------------------------------------------------------
-- Generators and normalisers used by the RPCs (not callable by API roles).
-- ---------------------------------------------------------------------------

-- 8 characters of Crockford base32 from gen_random_bytes: 5 random bits per character
-- (byte & 31 is uniform because 256 is a multiple of 32) → 40 bits.
create function private.generate_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(bytes, i) & 31) + 1, 1);
  end loop;
  return code;
end
$$;

-- Crockford decoding rules: case-insensitive, separators ignored, I/L read as 1 and O as 0.
create function private.normalize_room_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(upper(regexp_replace(coalesce(p_code, ''), '[[:space:]_-]', '', 'g')), 'ILO', '110')
$$;

-- 144 random bits as unpadded base64url (24 characters).
create function private.generate_share_slug()
returns text
language sql
volatile
set search_path = ''
as $$
  select translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_')
$$;

-- Collapse whitespace and trim; NULL when the result is not a valid 1..32 character display name.
create function private.normalize_display_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when n is not null and char_length(n) between 1 and 32 and n !~ '[[:cntrl:]]' then n
    else null
  end
  from (select btrim(regexp_replace(coalesce(p_name, ''), '[[:space:]]+', ' ', 'g')) as n) t
$$;

-- Collapse whitespace, trim and cap at 200 characters; 'Untitled Scene' when empty.
create function private.normalize_scene_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 200), ''), 'Untitled Scene')
$$;

revoke execute on all functions in schema private from public, anon, authenticated;

-- RLS policies (tables and realtime.messages) are evaluated as the calling role.
grant execute on function private.topic_sid() to authenticated;
grant execute on function private.topic_kind() to authenticated;
grant execute on function private.topic_uid() to authenticated;
grant execute on function private.is_session_dm(uuid) to authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;