-- Worlds (ARCHITECTURE §6.9): a DM's campaign. A world holds scenes, characters and players, and has ONE
-- room code: players join the world once (world_members), and the DM hands them the world's characters
-- there, for every scene of the world at once.
--
--   worlds             id, owner, name, room code (unique, forever)
--   world_members      THE membership (display name per world, active / kicked)
--   characters         the world's player characters (name, colour, portrait)
--   character_players  who plays each character (world members)
--   scenes.world_id    every scene is in exactly one world
--   sessions.world_id  a scene's table belongs to its world; at most ONE table per world has its doors open
--
-- session_members stays what every policy, stored view and tile rule is written against, but it is now the
-- world's roster seated at each live table of the world, kept only here (world_members triggers, open_map,
-- move_scene). A kick from the world therefore reaches every table at once.
--
-- RPCs: create_world, delete_world, create_scene (+ world), move_scene, join_world, world_info,
-- list_joined_worlds, set_world_member_status, set_character_players; changed: open_map, set_table_open (one open table per world),
-- set_session_scene (the same world only), set_member_status (kicks from the world), session_info (+ world),
-- join_session (older clients: join_world, then the open table or table_closed), guest merge (+ worlds).

-- ---------------------------------------------------------------------------
-- Limits and small helpers
-- ---------------------------------------------------------------------------

create function private.max_worlds_per_owner() returns integer language sql immutable set search_path = '' as $$ select 20 $$;
create function private.max_members_per_world() returns integer language sql immutable set search_path = '' as $$ select 64 $$;
-- Rows of a world's roster, removed players included (they stay as the record of the removal).
create function private.max_member_rows_per_world() returns integer language sql immutable set search_path = '' as $$ select 512 $$;
create function private.max_characters_per_world() returns integer language sql immutable set search_path = '' as $$ select 100 $$;
create function private.max_players_per_character() returns integer language sql immutable set search_path = '' as $$ select 8 $$;

-- Collapse whitespace and control characters, trim and cap at 200 characters; 'Untitled world' when empty.
create function private.normalize_world_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 200), ''), 'Untitled world')
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.worlds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null
    constraint worlds_name_check check (char_length(name) between 1 and 200 and name !~ '[[:cntrl:]]'),
  -- 8 characters of Crockford base32 (no I, L, O, U); a world keeps its code for good.
  room_code text not null constraint worlds_room_code_check check (room_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index worlds_room_code_key on public.worlds (room_code);
create index worlds_owner_updated_idx on public.worlds (owner_id, updated_at desc);

create trigger worlds_touch_updated_at
  before update on public.worlds
  for each row execute function private.touch_updated_at();

create table public.world_members (
  world_id uuid not null references public.worlds (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null
    constraint world_members_display_name_check
    check (char_length(display_name) between 1 and 32 and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  status text not null default 'active' constraint world_members_status_check check (status in ('active', 'kicked')),
  joined_at timestamptz not null default now(),
  primary key (world_id, user_id)
);

create index world_members_user_idx on public.world_members (user_id);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.worlds (id) on delete cascade,
  name text not null
    constraint characters_name_check check (char_length(name) between 1 and 64 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  color text not null default '#4f9dde' constraint characters_color_check check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- Like Token.imageUrl: an http(s) URL or a same-origin absolute path.
  image_url text
    constraint characters_image_url_check check (image_url is null or (char_length(image_url) <= 2000 and image_url ~* '^(https?://|/[^/])')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint characters_id_world_key unique (id, world_id)
);

create index characters_world_idx on public.characters (world_id, created_at);

create trigger characters_touch_updated_at
  before update on public.characters
  for each row execute function private.touch_updated_at();

create table public.character_players (
  character_id uuid not null,
  world_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (character_id, user_id),
  foreign key (character_id, world_id) references public.characters (id, world_id) on delete cascade,
  foreign key (world_id, user_id) references public.world_members (world_id, user_id) on delete cascade
);

create index character_players_member_idx on public.character_players (world_id, user_id);

-- A world with scenes cannot be deleted (delete_world asks for them to go first, so their images are freed).
alter table public.scenes add column world_id uuid references public.worlds (id);
create index scenes_world_updated_idx on public.scenes (world_id, updated_at desc);

-- A table belongs to its scene's world (ended tables of deleted scenes may have none).
alter table public.sessions add column world_id uuid references public.worlds (id) on delete cascade;
create index sessions_world_idx on public.sessions (world_id);

-- ---------------------------------------------------------------------------
-- Backfill: everyone with scenes or a live table gets "My world", holding their scenes and tables.
-- ---------------------------------------------------------------------------

do $$
declare
  v_owner uuid;
  v_done boolean;
begin
  for v_owner in
    select s.owner_id from public.scenes s
    union
    select t.dm_id from public.sessions t where t.status <> 'ended'
  loop
    v_done := false;
    for attempt in 1..16 loop
      begin
        insert into public.worlds (owner_id, name, room_code) values (v_owner, 'My world', private.generate_room_code());
        v_done := true;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
    if not v_done then
      raise exception 'room_code_unavailable';
    end if;
  end loop;
end
$$;

update public.scenes s set world_id = w.id from public.worlds w where w.owner_id = s.owner_id;
alter table public.scenes alter column world_id set not null;

update public.sessions t set world_id = c.world_id from public.scenes c where c.id = t.scene_id;
update public.sessions t set world_id = w.id
from public.worlds w
where t.world_id is null and t.status <> 'ended' and w.owner_id = t.dm_id;

-- One open table per world: the newest stays open.
update public.sessions t
set status = 'closed'
where t.status = 'active'
  and exists (
    select 1 from public.sessions o
    where o.world_id = t.world_id and o.status = 'active' and (o.created_at, o.id) > (t.created_at, t.id)
  );

-- Room codes are the worlds' now: every table of a world shares its code. The old one-code-per-live-table
-- index goes first (a world with several live tables would violate it below).
drop index public.sessions_live_room_code_key;

-- A live table answers to its world's code.
update public.sessions t set room_code = w.room_code from public.worlds w where w.id = t.world_id and t.status <> 'ended';

alter table public.sessions
  add constraint sessions_live_world_check check (status = 'ended' or world_id is not null);

create unique index sessions_world_open_key on public.sessions (world_id) where status = 'active';

-- The players of a world's live tables become its players (the latest name; kicked anywhere, kicked).
insert into public.world_members (world_id, user_id, display_name, status, joined_at)
select distinct on (t.world_id, m.user_id) t.world_id, m.user_id, m.display_name, m.status, m.joined_at
from public.session_members m
join public.sessions t on t.id = m.session_id
where t.status <> 'ended'
  and m.user_id <> t.dm_id
order by t.world_id, m.user_id, (m.status = 'kicked') desc, m.joined_at desc;

-- ---------------------------------------------------------------------------
-- session_members: the world's roster seated at every live table of the world.
-- ---------------------------------------------------------------------------

-- Seat a table: its world's members (names and statuses), and nobody else.
create function private.seat_table(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.session_members m
  using public.sessions s
  where s.id = p_session_id
    and m.session_id = p_session_id
    and not exists (select 1 from public.world_members w where w.world_id = s.world_id and w.user_id = m.user_id);

  insert into public.session_members (session_id, user_id, display_name, status, joined_at)
  select s.id, w.user_id, w.display_name, w.status, w.joined_at
  from public.sessions s
  join public.world_members w on w.world_id = s.world_id
  where s.id = p_session_id
    and s.status <> 'ended'
    and w.user_id <> s.dm_id
  on conflict (session_id, user_id) do update
    set display_name = excluded.display_name,
        status = excluded.status;
end
$$;

create function private.world_members_seat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.session_members m
    using public.sessions s
    where s.id = m.session_id
      and s.world_id = old.world_id
      and m.user_id = old.user_id;
    return old;
  end if;

  insert into public.session_members (session_id, user_id, display_name, status, joined_at)
  select s.id, new.user_id, new.display_name, new.status, new.joined_at
  from public.sessions s
  where s.world_id = new.world_id
    and s.status <> 'ended'
    and s.dm_id <> new.user_id
  on conflict (session_id, user_id) do update
    set display_name = excluded.display_name,
        status = excluded.status;
  return new;
end
$$;

create trigger world_members_seat
  after insert or update or delete on public.world_members
  for each row execute function private.world_members_seat();

do $$
declare
  v_sid uuid;
begin
  for v_sid in select t.id from public.sessions t where t.status <> 'ended' loop
    perform private.seat_table(v_sid);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Quotas on the DM's own writes (characters and who plays them go through RLS).
-- ---------------------------------------------------------------------------

create function private.check_character_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_characters:' || new.world_id::text, 0));
  if (select count(*) from public.characters c where c.world_id = new.world_id) >= private.max_characters_per_world() then
    raise exception 'quota_exceeded' using detail = format('at most %s characters per world', private.max_characters_per_world());
  end if;
  return new;
end
$$;

create trigger characters_quota
  before insert on public.characters
  for each row execute function private.check_character_quota();

create function private.check_character_players_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_character_players:' || new.character_id::text, 0));
  if (select count(*) from public.character_players c where c.character_id = new.character_id) >= private.max_players_per_character() then
    raise exception 'quota_exceeded' using detail = format('at most %s players per character', private.max_players_per_character());
  end if;
  return new;
end
$$;

create trigger character_players_quota
  before insert on public.character_players
  for each row execute function private.check_character_players_quota();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

create function private.is_world_owner(p_world_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.worlds w
    where w.id = p_world_id
      and w.owner_id = (select auth.uid())
  )
$$;

alter table public.worlds enable row level security;
alter table public.world_members enable row level security;
alter table public.characters enable row level security;
alter table public.character_players enable row level security;

revoke all on table public.worlds, public.world_members, public.characters, public.character_players from public, anon, authenticated;

-- Worlds are created and deleted through RPCs; the owner reads and renames them.
grant select on public.worlds to authenticated;
grant update (name) on public.worlds to authenticated;
-- Memberships are written through RPCs only.
grant select on public.world_members to authenticated;
grant select, delete on public.characters to authenticated;
grant insert (world_id, name, color, image_url) on public.characters to authenticated;
grant update (name, color, image_url) on public.characters to authenticated;
grant select, delete on public.character_players to authenticated;
grant insert (character_id, world_id, user_id) on public.character_players to authenticated;

create policy worlds_select_owner on public.worlds
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy worlds_update_owner on public.worlds
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- A player reads their own memberships; the world's owner reads its roster.
create policy world_members_select_own_or_owner on public.world_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_world_owner(world_id));

create policy characters_select_owner on public.characters
  for select to authenticated
  using (private.is_world_owner(world_id));

create policy characters_insert_owner on public.characters
  for insert to authenticated
  with check (private.is_world_owner(world_id));

create policy characters_update_owner on public.characters
  for update to authenticated
  using (private.is_world_owner(world_id))
  with check (private.is_world_owner(world_id));

create policy characters_delete_owner on public.characters
  for delete to authenticated
  using (private.is_world_owner(world_id));

create policy character_players_select_owner on public.character_players
  for select to authenticated
  using (private.is_world_owner(world_id));

create policy character_players_insert_owner on public.character_players
  for insert to authenticated
  with check (private.is_world_owner(world_id));

create policy character_players_delete_owner on public.character_players
  for delete to authenticated
  using (private.is_world_owner(world_id));

-- ---------------------------------------------------------------------------
-- Worlds
-- ---------------------------------------------------------------------------

-- Insert a world with a fresh room code (callers hold the owner's quota lock).
create function private.insert_world(p_owner uuid, p_name text)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_id uuid;
begin
  for attempt in 1..16 loop
    begin
      insert into public.worlds (owner_id, name, room_code)
      values (p_owner, private.normalize_world_name(p_name), private.generate_room_code())
      returning id into v_id;
      return v_id;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception 'room_code_unavailable' using detail = 'could not allocate a room code';
end
$$;

-- The owner's first world, created ("My world") when they have none: where a scene goes when no world is named.
create function private.default_world(p_owner uuid)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || p_owner::text, 0));
  select w.id into v_id from public.worlds w where w.owner_id = p_owner order by w.created_at, w.id limit 1;
  if found then
    return v_id;
  end if;
  return private.insert_world(p_owner, 'My world');
end
$$;

create function public.create_world(p_name text)
returns uuid
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
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || v_uid::text, 0));
  if (select count(*) from public.worlds w where w.owner_id = v_uid) >= private.max_worlds_per_owner() then
    raise exception 'quota_exceeded' using detail = format('at most %s worlds per account', private.max_worlds_per_owner());
  end if;
  return private.insert_world(v_uid, p_name);
end
$$;

-- Delete an empty world (its scenes go first, through the app, so their images are freed). Its characters,
-- players and ended tables go with it.
create function public.delete_world(p_world_id uuid)
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
  perform 1 from public.worlds w where w.id = p_world_id and w.owner_id = v_uid for update;
  if not found then
    raise exception 'not_found' using detail = 'world not found';
  end if;
  if exists (select 1 from public.scenes s where s.world_id = p_world_id) then
    raise exception 'world_not_empty' using detail = 'delete or move the world''s scenes first';
  end if;
  delete from public.worlds w where w.id = p_world_id;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Scenes in worlds
-- ---------------------------------------------------------------------------

drop function public.create_scene(text, integer, jsonb);

create function public.create_scene(p_name text, p_schema_version integer, p_data jsonb, p_world_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_world uuid := p_world_id;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform private.check_scene_payload(p_schema_version, p_data);
  perform private.check_owner_scene_quota(v_uid, pg_column_size(p_data), true);

  if v_world is null then
    v_world := private.default_world(v_uid);
  elsif not exists (select 1 from public.worlds w where w.id = v_world and w.owner_id = v_uid) then
    raise exception 'not_found' using detail = 'world not found';
  end if;

  insert into public.scenes (owner_id, world_id, name, latest_version)
  values (v_uid, v_world, private.normalize_scene_name(p_name), 1)
  returning id into v_id;

  insert into public.scene_versions (scene_id, version, schema_version, data)
  values (v_id, 1, p_schema_version, p_data);

  update public.worlds w set updated_at = now() where w.id = v_world;
  return v_id;
end
$$;

-- Move a scene to another of the owner's worlds. Its table moves with it while the doors are closed (its
-- players are then the new world's); an open table refuses (table_open).
create function public.move_scene(p_scene_id uuid, p_world_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_from uuid;
  v_code text;
  v_sid uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select s.world_id into v_from from public.scenes s where s.id = p_scene_id and s.owner_id = v_uid for update;
  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;
  select w.room_code into v_code from public.worlds w where w.id = p_world_id and w.owner_id = v_uid for share;
  if not found then
    raise exception 'not_found' using detail = 'world not found';
  end if;
  if v_from = p_world_id then
    return false;
  end if;

  select t.id, t.status into v_sid, v_status
  from public.sessions t
  where t.scene_id = p_scene_id
    and t.status <> 'ended'
  for update;
  if v_status = 'active' then
    raise exception 'table_open' using detail = 'close the scene''s table first';
  end if;

  update public.scenes s set world_id = p_world_id where s.id = p_scene_id;
  update public.worlds w set updated_at = now() where w.id in (v_from, p_world_id);
  if v_sid is not null then
    update public.sessions t set world_id = p_world_id, room_code = v_code where t.id = v_sid;
    perform private.seat_table(v_sid);
  end if;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables in worlds: open_map seats the world's players; one open table per world; map changes stay in
-- the world.
-- ---------------------------------------------------------------------------

create or replace function public.open_map(p_scene_id uuid, p_free_assets text[] default '{}')
returns table (session_id uuid, room_code text, status text, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_world uuid;
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

  -- Lock the scene row: two tabs opening the same scene get the same table.
  select s.world_id, s.latest_version, v.schema_version, v.data
  into v_world, v_version, v_schema_version, v_data
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
    raise exception 'too_many_sessions' using detail = 'too many open scenes';
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

  select w.room_code into v_code from public.worlds w where w.id = v_world;

  insert into public.sessions (dm_id, scene_id, world_id, room_code, status)
  values (v_uid, p_scene_id, v_world, v_code, 'closed')
  returning id into v_sid;

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

  perform private.seat_table(v_sid);
  return query select v_sid, v_code, 'closed'::text, true;
end
$$;

create or replace function public.set_table_open(p_session_id uuid, p_open boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_world uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select s.world_id into v_world
  from public.sessions s
  where s.id = p_session_id
    and s.dm_id = v_uid
    and s.status <> 'ended'
  for update;

  if not found then
    if private.is_session_dm(p_session_id) then
      raise exception 'session_ended' using detail = 'the session has ended';
    end if;
    raise exception 'not_found' using detail = 'session not found';
  end if;

  if p_open then
    -- The world's players are at one table: another scene's open doors must close first.
    perform pg_advisory_xact_lock(hashtextextended('atlas_world_table:' || v_world::text, 0));
    if exists (select 1 from public.sessions o where o.world_id = v_world and o.status = 'active' and o.id <> p_session_id) then
      raise exception 'world_table_open' using detail = 'another scene of this world has its table open';
    end if;
  end if;

  update public.sessions s
  set status = case when p_open then 'active' else 'closed' end
  where s.id = p_session_id
  returning s.status into v_status;

  return v_status;
end
$$;

create or replace function public.set_session_scene(p_session_id uuid, p_host_epoch bigint, p_scene_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_world uuid;
  v_scene_world uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  perform private.lock_fenced_session(p_session_id, p_host_epoch);

  select s.world_id into v_scene_world from public.scenes s where s.id = p_scene_id and s.owner_id = v_uid for update;
  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;
  select t.world_id into v_world from public.sessions t where t.id = p_session_id;
  if v_scene_world is distinct from v_world then
    raise exception 'other_world' using detail = 'the scene is in another world';
  end if;

  select s.id
  into v_other
  from public.sessions s
  where s.scene_id = p_scene_id
    and s.status <> 'ended'
    and s.id <> p_session_id
  for update;

  if found then
    -- Every live table of the world seats its players (session_members), so "players are there" means
    -- its doors are open.
    if exists (select 1 from public.sessions o where o.id = v_other and o.status = 'active') then
      raise exception 'map_in_use' using detail = 'players are at another table on this scene';
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
-- Players join worlds
-- ---------------------------------------------------------------------------

-- Whether p_name (normalised) is unavailable to p_uid in world p_world: names that pose as the DM, the DM's
-- profile name, another member's name (case-insensitive, kicked members included).
create function private.world_display_name_taken(p_world uuid, p_uid uuid, p_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select lower(p_name) in ('dm', 'gm', 'the dm', 'the gm', 'dungeon master', 'game master', 'the dungeon master', 'the game master')
    or exists (
      select 1
      from public.worlds w
      join public.profiles p on p.id = w.owner_id
      where w.id = p_world
        and lower(p.display_name) = lower(p_name)
    )
    or exists (
      select 1
      from public.world_members m
      where m.world_id = p_world
        and m.user_id <> p_uid
        and lower(m.display_name) = lower(p_name)
    )
$$;

-- Join (or rejoin, possibly under another name) the world with this room code. Returns the world and its
-- open table (null while every table of the world is closed: the player waits for the DM).
create function public.join_world(p_room_code text, p_display_name text)
returns table (world_id uuid, session_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_code text := private.normalize_room_code(p_room_code);
  v_name text := private.normalize_display_name(p_display_name);
  v_world uuid;
  v_owner uuid;
  v_status text;
  v_sid uuid;
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

  select w.id, w.owner_id into v_world, v_owner from public.worlds w where w.room_code = v_code for share;
  if not found then
    raise exception 'session_not_found' using detail = 'no world with that room code';
  end if;
  if v_owner = v_uid then
    raise exception 'is_dm' using detail = 'you are the DM of this world';
  end if;

  select m.status into v_status from public.world_members m where m.world_id = v_world and m.user_id = v_uid;
  if v_status = 'kicked' then
    raise exception 'kicked' using detail = 'you were removed from this world';
  end if;
  -- Serialise joins of one world: two players cannot take the same name, or the last seat, at once.
  perform pg_advisory_xact_lock(hashtextextended('atlas_join_world:' || v_world::text, 0));
  -- Removed players do not hold a seat (the DM frees seats by removing players), but the roster is bounded.
  if v_status is null
     and ((select count(*) from public.world_members m where m.world_id = v_world and m.status = 'active') >= private.max_members_per_world()
       or (select count(*) from public.world_members m where m.world_id = v_world) >= private.max_member_rows_per_world()) then
    raise exception 'session_full' using detail = 'this world has too many players';
  end if;
  if private.world_display_name_taken(v_world, v_uid, v_name) then
    raise exception 'name_taken' using detail = 'that name is taken in this world';
  end if;

  -- The WHERE keeps a concurrent kick from being undone by a racing join.
  insert into public.world_members as m (world_id, user_id, display_name, status)
  values (v_world, v_uid, v_name, 'active')
  on conflict (world_id, user_id) do update
    set display_name = excluded.display_name
    where m.status = 'active';
  if not found then
    raise exception 'kicked' using detail = 'you were removed from this world';
  end if;

  select s.id into v_sid from public.sessions s where s.world_id = v_world and s.status = 'active';
  return query select v_world, v_sid;
end
$$;

-- Older clients: join the world, then its open table (table_closed while none is open, joining nothing).
create or replace function public.join_session(p_room_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid uuid;
begin
  select j.session_id into v_sid from public.join_world(p_room_code, p_display_name) j;
  if v_sid is null then
    raise exception 'table_closed' using detail = 'the DM has not opened a table in this world';
  end if;
  return v_sid;
end
$$;

-- A world as its DM or one of its players sees it. `open_session_id`: the table whose doors are open (for
-- the DM and active players); `characters`: the names of the characters the caller plays.
create function public.world_info(p_world_id uuid)
returns table (
  world_id uuid,
  name text,
  room_code text,
  role text,
  member_status text,
  display_name text,
  dm_display_name text,
  open_session_id uuid,
  characters text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.name,
    w.room_code,
    case when w.owner_id = (select auth.uid()) then 'dm' else 'player' end,
    m.status,
    m.display_name,
    p.display_name,
    case
      when w.owner_id = (select auth.uid()) or m.status = 'active' then
        (select s.id from public.sessions s where s.world_id = w.id and s.status = 'active')
    end,
    case
      when m.status = 'active' then
        coalesce((
          select array_agg(c.name order by c.created_at, c.id)
          from public.character_players cp
          join public.characters c on c.id = cp.character_id
          where cp.world_id = w.id
            and cp.user_id = (select auth.uid())
        ), '{}')
      else '{}'::text[]
    end
  from public.worlds w
  left join public.world_members m
    on m.world_id = w.id
   and m.user_id = (select auth.uid())
  left join public.profiles p
    on p.id = w.owner_id
  where w.id = p_world_id
    and (w.owner_id = (select auth.uid()) or m.user_id is not null)
$$;

-- The worlds the caller joined as a player, most recently joined first (world_info for each).
create function public.list_joined_worlds()
returns table (
  world_id uuid,
  name text,
  room_code text,
  role text,
  member_status text,
  display_name text,
  dm_display_name text,
  open_session_id uuid,
  characters text[],
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.*, m.joined_at
  from public.world_members m
  cross join lateral public.world_info(m.world_id) i
  where m.user_id = (select auth.uid())
  order by m.joined_at desc, m.world_id
$$;

-- The world's DM removes a player (from every table of the world at once) or lets them back.
create function public.set_world_member_status(p_world_id uuid, p_user_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('active', 'kicked') then
    raise exception 'invalid_argument' using detail = 'status must be active or kicked';
  end if;
  if not private.is_world_owner(p_world_id) then
    raise exception 'forbidden' using detail = 'only the DM can change member status';
  end if;

  update public.world_members m
  set status = p_status
  where m.world_id = p_world_id
    and m.user_id = p_user_id
    and m.status <> p_status;

  return found;
end
$$;

-- At a table: the kick is from the table's world.
create or replace function public.set_member_status(p_session_id uuid, p_user_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
begin
  if p_status is null or p_status not in ('active', 'kicked') then
    raise exception 'invalid_argument' using detail = 'status must be active or kicked';
  end if;
  if not private.is_session_dm(p_session_id) then
    raise exception 'forbidden' using detail = 'only the DM can change member status';
  end if;
  select s.world_id into v_world from public.sessions s where s.id = p_session_id;

  update public.world_members m
  set status = p_status
  where m.world_id = v_world
    and m.user_id = p_user_id
    and m.status <> p_status;

  return found;
end
$$;

drop function public.session_info(uuid);

create function public.session_info(p_session_id uuid)
returns table (
  session_id uuid,
  status text,
  room_code text,
  role text,
  member_status text,
  display_name text,
  dm_display_name text,
  created_at timestamptz,
  world_id uuid,
  world_name text
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
    s.created_at,
    s.world_id,
    w.name
  from public.sessions s
  left join public.session_members m
    on m.session_id = s.id
   and m.user_id = (select auth.uid())
  left join public.profiles p
    on p.id = s.dm_id
  left join public.worlds w
    on w.id = s.world_id
  where s.id = p_session_id
    and (s.dm_id = (select auth.uid()) or m.user_id is not null)
$$;

-- ---------------------------------------------------------------------------
-- Who plays a character, set in one step (the DM ticking players in quick succession never loses one).
-- ---------------------------------------------------------------------------

create function public.set_character_players(p_character_id uuid, p_user_ids uuid[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_user_ids, '{}')) u where u is not null);
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select c.world_id into v_world
  from public.characters c
  where c.id = p_character_id
    and private.is_world_owner(c.world_id)
  for update;
  if not found then
    raise exception 'not_found' using detail = 'character not found';
  end if;
  if cardinality(v_ids) > private.max_players_per_character() then
    raise exception 'quota_exceeded' using detail = format('at most %s players per character', private.max_players_per_character());
  end if;
  if exists (
    select 1 from unnest(v_ids) u
    where not exists (select 1 from public.world_members m where m.world_id = v_world and m.user_id = u)
  ) then
    raise exception 'invalid_argument' using detail = 'only players of the world can play its characters';
  end if;

  delete from public.character_players cp
  where cp.character_id = p_character_id
    and not (cp.user_id = any (v_ids));
  -- Only the new players: the quota trigger fires even for rows ON CONFLICT then skips, so re-offering the
  -- ones already there would trip it with a full list.
  insert into public.character_players (character_id, world_id, user_id)
  select p_character_id, v_world, u
  from unnest(v_ids) u
  where not exists (select 1 from public.character_players cp where cp.character_id = p_character_id and cp.user_id = u)
  on conflict (character_id, user_id) do nothing;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Guest merge: the guest's worlds move with their scenes.
-- ---------------------------------------------------------------------------

create or replace function private.check_merge_quotas(p_guest uuid, p_target uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scenes integer;
  v_worlds integer;
  v_scene_bytes bigint;
  v_active integer;
  v_objects integer;
  v_object_bytes bigint;
begin
  select count(*) into v_scenes from public.scenes s where s.owner_id in (p_guest, p_target);
  if v_scenes > private.max_scenes_per_owner() then
    raise exception 'quota_exceeded' using detail = format('together the accounts have %s scenes; at most %s fit in one account', v_scenes, private.max_scenes_per_owner());
  end if;

  select count(*) into v_worlds from public.worlds w where w.owner_id in (p_guest, p_target);
  if v_worlds > private.max_worlds_per_owner() then
    raise exception 'quota_exceeded' using detail = format('together the accounts have %s worlds; at most %s fit in one account', v_worlds, private.max_worlds_per_owner());
  end if;

  select coalesce(sum(pg_column_size(v.data)), 0) into v_scene_bytes
  from public.scene_versions v
  join public.scenes s on s.id = v.scene_id
  where s.owner_id in (p_guest, p_target);
  if v_scene_bytes > private.max_owner_scene_bytes() then
    raise exception 'quota_exceeded' using detail = format('together the scenes use more than the %s bytes one account may store', private.max_owner_scene_bytes());
  end if;

  select count(*) into v_active from public.sessions s where s.dm_id in (p_guest, p_target) and s.status = 'active';
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

create or replace function public.finish_guest_merge(p_token text, p_target uuid)
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
  v_worlds integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || least(v_guest, p_target)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('atlas_quota:' || greatest(v_guest, p_target)::text, 0));
  perform private.check_merge_quotas(v_guest, p_target);

  if exists (select 1 from storage.objects o where o.bucket_id = 'scene-assets' and o.name like v_guest::text || '/%') then
    raise exception 'invalid_argument' using detail = 'the guest''s map images have not all been moved yet';
  end if;

  -- The account becomes DM of the guest's worlds; a DM is never also a player of their own world.
  delete from public.world_members m
  using public.worlds w
  where w.id = m.world_id
    and w.owner_id = v_guest
    and m.user_id = p_target;
  update public.worlds w set owner_id = p_target where w.owner_id = v_guest;
  get diagnostics v_worlds = row_count;

  update public.scenes s set owner_id = p_target where s.owner_id = v_guest;
  get diagnostics v_scenes = row_count;

  delete from public.session_members m
  using public.sessions s
  where s.id = m.session_id
    and s.dm_id = v_guest
    and m.user_id = p_target;
  update public.sessions s set dm_id = p_target where s.dm_id = v_guest;
  get diagnostics v_sessions = row_count;

  -- Keep at most max_sessions_per_dm() sessions, like open_map: ended ones beyond go first.
  delete from public.sessions s
  where s.dm_id = p_target
    and s.status = 'ended'
    and s.id not in (
      select k.id
      from public.sessions k
      where k.dm_id = p_target
      order by (k.status <> 'ended') desc, k.created_at desc, k.id
      limit private.max_sessions_per_dm()
    );

  -- The account keeps its own display name; it adopts the guest's only if it has none.
  insert into public.profiles (id, display_name)
  select p_target, p.display_name
  from public.profiles p
  where p.id = v_guest
  on conflict (id) do nothing;

  delete from private.guest_merge_tickets t where t.guest_id = v_guest;
  return jsonb_build_object('guest_id', v_guest, 'scenes', v_scenes, 'sessions', v_sessions, 'worlds', v_worlds);
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function private.max_worlds_per_owner() from public, anon, authenticated;
revoke execute on function private.max_members_per_world() from public, anon, authenticated;
revoke execute on function private.max_member_rows_per_world() from public, anon, authenticated;
revoke execute on function private.max_characters_per_world() from public, anon, authenticated;
revoke execute on function private.max_players_per_character() from public, anon, authenticated;
revoke execute on function private.normalize_world_name(text) from public, anon, authenticated;
revoke execute on function private.seat_table(uuid) from public, anon, authenticated;
revoke execute on function private.world_members_seat() from public, anon, authenticated;
revoke execute on function private.check_character_quota() from public, anon, authenticated;
revoke execute on function private.check_character_players_quota() from public, anon, authenticated;
revoke execute on function private.insert_world(uuid, text) from public, anon, authenticated;
revoke execute on function private.default_world(uuid) from public, anon, authenticated;
revoke execute on function private.world_display_name_taken(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.check_merge_quotas(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.is_world_owner(uuid) from public, anon, authenticated;
grant execute on function private.is_world_owner(uuid) to authenticated;

revoke execute on function public.create_world(text) from public, anon;
revoke execute on function public.delete_world(uuid) from public, anon;
revoke execute on function public.create_scene(text, integer, jsonb, uuid) from public, anon;
revoke execute on function public.move_scene(uuid, uuid) from public, anon;
revoke execute on function public.join_world(text, text) from public, anon;
revoke execute on function public.world_info(uuid) from public, anon;
revoke execute on function public.list_joined_worlds() from public, anon;
revoke execute on function public.set_world_member_status(uuid, uuid, text) from public, anon;
revoke execute on function public.set_character_players(uuid, uuid[]) from public, anon;
revoke execute on function public.session_info(uuid) from public, anon;
revoke execute on function public.finish_guest_merge(text, uuid) from public, anon, authenticated;

grant execute on function public.create_world(text) to authenticated;
grant execute on function public.delete_world(uuid) to authenticated;
grant execute on function public.create_scene(text, integer, jsonb, uuid) to authenticated;
grant execute on function public.move_scene(uuid, uuid) to authenticated;
grant execute on function public.join_world(text, text) to authenticated;
grant execute on function public.world_info(uuid) to authenticated;
grant execute on function public.list_joined_worlds() to authenticated;
grant execute on function public.set_world_member_status(uuid, uuid, text) to authenticated;
grant execute on function public.set_character_players(uuid, uuid[]) to authenticated;
grant execute on function public.session_info(uuid) to authenticated;
grant execute on function public.finish_guest_merge(text, uuid) to service_role;
