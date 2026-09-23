-- Atlas VTT: RLS / RPC / Realtime-authorization tests (ARCHITECTURE §6.1, §6.4).
--
-- Run as `postgres` (Supabase SQL editor, psql, or the MCP execute_sql tool). Everything runs in ONE
-- transaction that is ROLLED BACK: the seeded auth.users rows, scenes, sessions and helper objects
-- all vanish. The last statement before ROLLBACK returns a summary row (passed, failed, failures);
-- `failed` must be 0.
--
-- Users are impersonated the way PostgREST and Realtime do it: role `authenticated` (or `anon`) plus
-- request.jwt.claims carrying the user's `sub`. Realtime checks additionally set `realtime.topic`.
--
-- Realtime: realtime.messages is partitioned by day and its partitions are created by the Realtime
-- service (`postgres` cannot create one). When a partition for now() exists the channel checks run
-- against realtime.messages itself; otherwise they run against a temp clone `pg_temp.messages` whose
-- policies are copied VERBATIM from pg_policies (same expressions, same private.* helpers, same
-- realtime.topic()). The check named "realtime: checks run against …" says which one was used.
-- A check "insert" = may send (broadcast / track presence); "select" = may receive, and is what
-- Realtime requires to JOIN a private channel at all.

begin;

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

create temp table atlas_results (
  n serial primary key,
  name text not null,
  ok boolean not null,
  detail text
) on commit drop;
grant select, insert on atlas_results to authenticated, anon;
grant usage on sequence atlas_results_n_seq to authenticated, anon;

create function pg_temp.check(p_name text, p_ok boolean, p_detail text default null)
returns void
language sql
as $$
  insert into pg_temp.atlas_results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail)
$$;

create function pg_temp.eq(p_name text, p_actual text, p_expected text)
returns void
language sql
as $$
  select pg_temp.check(p_name, p_actual is not distinct from p_expected, format('got %s, expected %s', coalesce(p_actual, 'NULL'), coalesce(p_expected, 'NULL')))
$$;

-- Run dynamic SQL as the CURRENT role: 'ok', or the error message (SQLERRM).
create function pg_temp.try(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end
$$;

-- First column of the first row of a query run as the CURRENT role, or 'ERROR: <message>'.
create function pg_temp.val(p_sql text)
returns text
language plpgsql
as $$
declare
  v text;
begin
  execute p_sql into v;
  return v;
exception when others then
  return 'ERROR: ' || sqlerrm;
end
$$;

create function pg_temp.login(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform set_config('realtime.topic', '', true);
end
$$;

create function pg_temp.login_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('realtime.topic', '', true);
end
$$;

create function pg_temp.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('realtime.topic', '', true);
end
$$;

-- One Realtime authorization check: as p_uid (NULL = anon) on channel p_topic, may the user
-- p_op ('select' = receive, 'insert' = send) messages of extension p_ext?
create function pg_temp.rt(p_label text, p_uid uuid, p_topic text, p_op text, p_ext text, p_expect boolean)
returns void
language plpgsql
as $$
declare
  v_target text := current_setting('atlas.rt_target');
  v_res text;
  v_allowed boolean;
begin
  if p_uid is null then
    perform pg_temp.login_anon();
  else
    perform pg_temp.login(p_uid);
  end if;
  perform set_config('realtime.topic', p_topic, true);
  if p_op = 'select' then
    -- A fixture row exists for every (topic, extension); RLS hides it unless the policy passes.
    v_res := pg_temp.val(format('select count(*) from %s where topic = %L and extension = %L', v_target, p_topic, p_ext));
    v_allowed := v_res ~ '^[0-9]+$' and v_res::int > 0;
  else
    v_res := pg_temp.try(format(
      'insert into %s (topic, extension, payload, event, private) values (%L, %L, %L::jsonb, %L, true)',
      v_target, p_topic, p_ext, '{}', 'atlas-test'
    ));
    v_allowed := v_res = 'ok';
  end if;
  perform pg_temp.logout();
  perform pg_temp.check(
    format('realtime: %s %s %s on %s → %s', p_label, p_op, p_ext, p_topic, case when p_expect then 'allowed' else 'denied' end),
    v_allowed = p_expect,
    v_res
  );
end
$$;

grant execute on function pg_temp.check(text, boolean, text) to authenticated, anon;
grant execute on function pg_temp.eq(text, text, text) to authenticated, anon;
grant execute on function pg_temp.try(text) to authenticated, anon;
grant execute on function pg_temp.val(text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.login_anon() to authenticated, anon;
grant execute on function pg_temp.logout() to authenticated, anon;
grant execute on function pg_temp.rt(text, uuid, text, text, text, boolean) to authenticated, anon;

-- Clone of realtime.messages carrying a verbatim copy of every policy on the real table.
create temp table messages (
  id uuid not null default gen_random_uuid(),
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamp not null default now()
) on commit drop;
alter table pg_temp.messages enable row level security;
grant select, insert, update on pg_temp.messages to authenticated, anon;

do $$
declare
  r record;
begin
  for r in
    select policyname, permissive, cmd, roles, qual, with_check
    from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
  loop
    execute format(
      'create policy %I on pg_temp.messages as %s for %s to %s %s %s',
      r.policyname,
      r.permissive,
      r.cmd,
      array_to_string(r.roles, ', '),
      case when r.qual is not null then format('using (%s)', r.qual) else '' end,
      case when r.with_check is not null then format('with check (%s)', r.with_check) else '' end
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Tests
-- ---------------------------------------------------------------------------

do $$
declare
  d uuid := gen_random_uuid();   -- DM: owns the scene, runs the session
  p1 uuid := gen_random_uuid();  -- the player whose req/view topics are tested
  p2 uuid := gen_random_uuid();  -- another active member
  k uuid := gen_random_uuid();   -- member who gets kicked
  x uuid := gen_random_uuid();   -- signed in, never joined
  v_scene uuid;
  v_slug text;
  v_sid uuid;
  v_code text;
  v_target text;
  v_topic text;
  r record;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, p1, p2, k, x]) as u;

  -- ======================= catalog =======================
  perform pg_temp.eq('catalog: RLS enabled on every public table',
    (select coalesce(string_agg(c.relname, ','), '') from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity), '');
  perform pg_temp.eq('catalog: anon has no privilege on any public table',
    (select coalesce(string_agg(c.relname, ','), '') from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')), '');
  perform pg_temp.eq('catalog: anon can execute no public/private function',
    (select coalesce(string_agg(p.proname, ','), '') from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and has_function_privilege('anon', p.oid, 'execute')), '');
  perform pg_temp.eq('catalog: authenticated can execute exactly the RPCs',
    (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')),
    'claim_host,create_scene,create_session,end_session,get_shared_scene,join_session,list_session_members,save_scene_version,save_session_state,session_info,set_display_name,set_member_status,set_scene_visibility,upsert_player_view');
  perform pg_temp.eq('catalog: authenticated can execute only the policy helpers in private',
    (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
      where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')),
    'is_active_member,is_session_dm,normalize_display_name,topic_kind,topic_sid,topic_uid');
  perform pg_temp.eq('catalog: every public/private function pins an empty search_path',
    (select coalesce(string_agg(p.proname, ','), '') from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and not coalesce(p.proconfig @> array['search_path=""'], false)), '');
  perform pg_temp.eq('catalog: policy helpers are security definer',
    (select string_agg(p.proname || '=' || p.prosecdef, ',' order by p.proname) from pg_proc p
      where p.pronamespace = 'private'::regnamespace
        and p.proname in ('topic_sid', 'topic_kind', 'topic_uid', 'is_session_dm', 'is_active_member')),
    'is_active_member=true,is_session_dm=true,topic_kind=true,topic_sid=true,topic_uid=true');

  -- ======================= profiles =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('profiles: set_display_name normalises whitespace',
    pg_temp.val($q$select public.set_display_name('  Dungeon   Master ')$q$), 'Dungeon Master');
  perform pg_temp.eq('profiles: set_display_name is an upsert',
    pg_temp.val($q$select public.set_display_name('Dungeon Master')$q$), 'Dungeon Master');
  perform pg_temp.eq('profiles: set_display_name rejects blank names',
    pg_temp.try($q$select public.set_display_name('   ')$q$), 'invalid_display_name');
  perform pg_temp.eq('profiles: owner reads own row', pg_temp.val('select count(*) from public.profiles'), '1');
  perform pg_temp.check('profiles: cannot insert a row for someone else',
    pg_temp.try(format('insert into public.profiles (id, display_name) values (%L, %L)', p1, 'Mallory')) like 'new row violates row-level security policy%');
  perform pg_temp.login(p1);
  perform pg_temp.eq('profiles: other users cannot read it', pg_temp.val('select count(*) from public.profiles'), '0');
  perform pg_temp.eq('profiles: other users cannot update it',
    pg_temp.val(format($q$with u as (update public.profiles set display_name = 'x' where id = %L returning 1) select count(*) from u$q$, d)), '0');
  perform pg_temp.login_anon();
  perform pg_temp.eq('profiles: anon has no access', pg_temp.try('select 1 from public.profiles'), 'permission denied for table profiles');

  -- ======================= scenes =======================
  perform pg_temp.login(d);
  v_scene := pg_temp.val($q$select public.create_scene('  My   Keep ', 1, '{"v": 1}')$q$)::uuid;
  perform pg_temp.eq('scenes: create_scene normalises the name',
    pg_temp.val(format('select name || '':'' || latest_version from public.scenes where id = %L', v_scene)), 'My Keep:1');
  perform pg_temp.eq('scenes: save_scene_version returns the new version',
    pg_temp.val(format($q$select public.save_scene_version(%L, 1, '{"v": 2}')$q$, v_scene)), '2');
  perform pg_temp.eq('scenes: save_scene_version with a stale base version conflicts',
    pg_temp.try(format($q$select public.save_scene_version(%L, 1, '{"v": 3}', 1)$q$, v_scene)), 'version_conflict');
  perform pg_temp.eq('scenes: save_scene_version rejects non-object data',
    pg_temp.try(format($q$select public.save_scene_version(%L, 1, '[1]')$q$, v_scene)), 'invalid_argument');
  perform pg_temp.eq('scenes: owner reads the scene row', pg_temp.val('select latest_version from public.scenes'), '2');
  perform pg_temp.eq('scenes: owner reads every version',
    pg_temp.val($q$select string_agg(version || '=' || (data->>'v'), ',' order by version) from public.scene_versions$q$), '1=1,2=2');
  perform pg_temp.eq('scenes: versions are immutable (no UPDATE grant)',
    pg_temp.try(format($q$update public.scene_versions set data = '{}' where scene_id = %L$q$, v_scene)), 'permission denied for table scene_versions');
  perform pg_temp.eq('scenes: versions cannot be inserted directly',
    pg_temp.try(format($q$insert into public.scene_versions (scene_id, version, schema_version, data) values (%L, 9, 1, '{}')$q$, v_scene)), 'permission denied for table scene_versions');
  perform pg_temp.eq('scenes: no direct INSERT', pg_temp.try($q$insert into public.scenes (owner_id, name) values (auth.uid(), 'x')$q$), 'permission denied for table scenes');
  perform pg_temp.eq('scenes: latest_version is not client-writable',
    pg_temp.try(format('update public.scenes set latest_version = 99 where id = %L', v_scene)), 'permission denied for table scenes');
  perform pg_temp.eq('scenes: share_slug is not client-writable',
    pg_temp.try(format($q$update public.scenes set share_slug = 'aaaaaaaaaaaaaaaaaaaaaaaa', visibility = 'link' where id = %L$q$, v_scene)), 'permission denied for table scenes');
  perform pg_temp.eq('scenes: owner can rename',
    pg_temp.val(format($q$with u as (update public.scenes set name = 'Keep' where id = %L returning 1) select count(*) from u$q$, v_scene)), '1');
  v_slug := pg_temp.val(format($q$select public.set_scene_visibility(%L, 'link')$q$, v_scene));
  perform pg_temp.check('scenes: link share slug is 24 base64url chars (144 random bits)', v_slug ~ '^[A-Za-z0-9_-]{24}$', v_slug);
  perform pg_temp.eq('scenes: sharing again keeps the slug',
    pg_temp.val(format($q$select public.set_scene_visibility(%L, 'link')$q$, v_scene)), v_slug);
  perform pg_temp.check('scenes: rotating the link issues a new slug',
    pg_temp.val(format($q$select public.set_scene_visibility(%L, 'link', true)$q$, v_scene)) is distinct from v_slug);
  v_slug := pg_temp.val(format('select share_slug from public.scenes where id = %L', v_scene));

  perform pg_temp.login(p1);
  perform pg_temp.eq('scenes: other user cannot read scenes', pg_temp.val('select count(*) from public.scenes'), '0');
  perform pg_temp.eq('scenes: other user cannot read versions', pg_temp.val('select count(*) from public.scene_versions'), '0');
  perform pg_temp.eq('scenes: other user cannot rename',
    pg_temp.val(format($q$with u as (update public.scenes set name = 'pwned' where id = %L returning 1) select count(*) from u$q$, v_scene)), '0');
  perform pg_temp.eq('scenes: other user cannot delete',
    pg_temp.val(format('with u as (delete from public.scenes where id = %L returning 1) select count(*) from u', v_scene)), '0');
  perform pg_temp.eq('scenes: other user cannot save a version',
    pg_temp.try(format($q$select public.save_scene_version(%L, 1, '{}')$q$, v_scene)), 'not_found');
  perform pg_temp.eq('scenes: other user cannot change visibility',
    pg_temp.try(format($q$select public.set_scene_visibility(%L, 'private')$q$, v_scene)), 'not_found');
  perform pg_temp.eq('scenes: link share is readable through get_shared_scene',
    pg_temp.val(format($q$select name || ':' || version || ':' || (data->>'v') from public.get_shared_scene(%L)$q$, v_slug)), 'Keep:2:2');
  perform pg_temp.eq('scenes: unknown slug returns nothing',
    pg_temp.val($q$select count(*) from public.get_shared_scene('AAAAAAAAAAAAAAAAAAAAAAAA')$q$), '0');
  perform pg_temp.eq('scenes: link share grants no table access', pg_temp.val('select count(*) from public.scene_versions'), '0');
  perform pg_temp.eq('sessions: create_session requires owning the scene',
    pg_temp.try(format('select * from public.create_session(%L)', v_scene)), 'not_found');

  perform pg_temp.login_anon();
  perform pg_temp.eq('scenes: anon has no table access', pg_temp.try('select 1 from public.scenes'), 'permission denied for table scenes');
  perform pg_temp.eq('scenes: anon cannot read versions', pg_temp.try('select 1 from public.scene_versions'), 'permission denied for table scene_versions');
  perform pg_temp.eq('scenes: anon cannot call get_shared_scene',
    pg_temp.try(format('select * from public.get_shared_scene(%L)', v_slug)), 'permission denied for function get_shared_scene');

  -- ======================= sessions: create & join =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('sessions: create_session rejects unknown scenes',
    pg_temp.try(format('select * from public.create_session(%L)', gen_random_uuid())), 'not_found');
  select s.session_id, s.room_code into v_sid, v_code from public.create_session(v_scene) as s;
  perform pg_temp.check('sessions: room code is 8 Crockford base32 chars', v_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$', v_code);
  perform pg_temp.eq('sessions: session_state is seeded from the latest scene version',
    pg_temp.val(format($q$select concat_ws(':', state->>'kind', state->>'sceneId', state->>'sceneVersion', state->>'schemaVersion', state->'scene'->>'v', epoch) from public.session_state where session_id = %L$q$, v_sid)),
    concat_ws(':', 'seed', v_scene, 2, 1, 2, 0));
  perform pg_temp.eq('sessions: DM reads own session', pg_temp.val('select status || '':'' || host_epoch from public.sessions'), 'active:0');
  perform pg_temp.eq('sessions: DM cannot write sessions directly',
    pg_temp.try(format('update public.sessions set host_epoch = 99 where id = %L', v_sid)), 'permission denied for table sessions');
  perform pg_temp.eq('sessions: DM cannot join own session as a player',
    pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'DM')), 'is_dm');
  perform pg_temp.eq('sessions: session_info for the DM',
    pg_temp.val(format('select concat_ws('':'', role, status, room_code, dm_display_name) from public.session_info(%L)', v_sid)),
    concat_ws(':', 'dm', 'active', v_code, 'Dungeon Master'));

  perform pg_temp.login(p1);
  perform pg_temp.eq('join: room code is case- and separator-insensitive',
    pg_temp.val(format('select public.join_session(%L, %L)', lower(left(v_code, 4)) || '-' || lower(right(v_code, 4)), '  Alice ')), v_sid::text);
  perform pg_temp.eq('join: rejoining is idempotent', pg_temp.val(format('select public.join_session(%L, %L)', v_code, 'Alice')), v_sid::text);
  perform pg_temp.eq('join: unknown room code', pg_temp.try($q$select public.join_session('ZZZZZZZZ', 'Alice')$q$), 'session_not_found');
  perform pg_temp.eq('join: malformed room code', pg_temp.try($q$select public.join_session('abc', 'Alice')$q$), 'invalid_room_code');
  perform pg_temp.eq('join: display name longer than 32', pg_temp.try(format('select public.join_session(%L, %L)', v_code, repeat('x', 33))), 'invalid_display_name');
  perform pg_temp.login(p2);
  perform pg_temp.eq('join: second player', pg_temp.val(format('select public.join_session(%L, %L)', v_code, 'Bob')), v_sid::text);
  perform pg_temp.login(k);
  perform pg_temp.eq('join: third player', pg_temp.val(format('select public.join_session(%L, %L)', v_code, 'Kay')), v_sid::text);

  -- ======================= sessions: what a player can do =======================
  perform pg_temp.login(p1);
  perform pg_temp.eq('player: no SELECT on sessions', pg_temp.val('select count(*) from public.sessions'), '0');
  perform pg_temp.eq('player: no SELECT on session_state', pg_temp.val('select count(*) from public.session_state'), '0');
  perform pg_temp.eq('player: sees only own session_members row',
    pg_temp.val('select string_agg(display_name, '','') from public.session_members'), 'Alice');
  perform pg_temp.eq('player: session_info returns a small record',
    pg_temp.val(format('select concat_ws('':'', role, status, member_status, display_name, dm_display_name) from public.session_info(%L)', v_sid)),
    'player:active:active:Alice:Dungeon Master');
  perform pg_temp.eq('player: list_session_members is DM only', pg_temp.try(format('select * from public.list_session_members(%L)', v_sid)), 'forbidden');
  perform pg_temp.eq('player: set_member_status is DM only',
    pg_temp.try(format($q$select public.set_member_status(%L, %L, 'kicked')$q$, v_sid, p2)), 'forbidden');
  perform pg_temp.eq('player: claim_host is DM only', pg_temp.try(format('select public.claim_host(%L)', v_sid)), 'not_found');
  perform pg_temp.eq('player: save_session_state is DM only',
    pg_temp.try(format($q$select public.save_session_state(%L, 0, '{}')$q$, v_sid)), 'not_found');
  perform pg_temp.eq('player: upsert_player_view is DM only',
    pg_temp.try(format($q$select public.upsert_player_view(%L, %L, 0, 'e', 1, '{}')$q$, v_sid, p1)), 'not_found');
  perform pg_temp.eq('player: end_session is DM only', pg_temp.try(format('select public.end_session(%L)', v_sid)), 'not_found');
  perform pg_temp.eq('player: cannot insert member rows directly',
    pg_temp.try(format($q$insert into public.session_members (session_id, user_id, display_name) values (%L, %L, 'X')$q$, v_sid, x)),
    'permission denied for table session_members');
  perform pg_temp.eq('player: cannot change own member status',
    pg_temp.try(format($q$update public.session_members set status = 'active' where session_id = %L$q$, v_sid)),
    'permission denied for table session_members');
  perform pg_temp.eq('player: can rename self',
    pg_temp.val(format($q$with u as (update public.session_members set display_name = 'Alicia' where session_id = %L returning 1) select count(*) from u$q$, v_sid)), '1');
  perform pg_temp.eq('player: cannot rename others',
    pg_temp.val(format($q$with u as (update public.session_members set display_name = 'x' where session_id = %L and user_id = %L returning 1) select count(*) from u$q$, v_sid, p2)), '0');
  perform pg_temp.eq('player: cannot delete the session',
    pg_temp.val(format('with u as (delete from public.sessions where id = %L returning 1) select count(*) from u', v_sid)), '0');
  perform pg_temp.eq('player: cannot write player_views directly',
    pg_temp.try(format($q$insert into public.player_views (session_id, user_id, host_epoch, epoch, seq, view) values (%L, %L, 0, 'e', 0, '{}')$q$, v_sid, p1)),
    'permission denied for table player_views');

  perform pg_temp.login(x);
  perform pg_temp.eq('non-member: session_info returns nothing', pg_temp.val(format('select count(*) from public.session_info(%L)', v_sid)), '0');
  perform pg_temp.eq('non-member: sees no member rows', pg_temp.val('select count(*) from public.session_members'), '0');
  perform pg_temp.eq('non-member: sees no sessions', pg_temp.val('select count(*) from public.sessions'), '0');

  perform pg_temp.login_anon();
  perform pg_temp.eq('anon: no access to sessions', pg_temp.try('select 1 from public.sessions'), 'permission denied for table sessions');
  perform pg_temp.eq('anon: no access to session_members', pg_temp.try('select 1 from public.session_members'), 'permission denied for table session_members');
  perform pg_temp.eq('anon: no access to session_state', pg_temp.try('select 1 from public.session_state'), 'permission denied for table session_state');
  perform pg_temp.eq('anon: no access to player_views', pg_temp.try('select 1 from public.player_views'), 'permission denied for table player_views');
  perform pg_temp.eq('anon: cannot join', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Anon')), 'permission denied for function join_session');

  -- ======================= sessions: DM, fencing =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('dm: list_session_members',
    pg_temp.val(format('select string_agg(display_name || ''='' || status, '','' order by display_name) from public.list_session_members(%L)', v_sid)),
    'Alicia=active,Bob=active,Kay=active');
  perform pg_temp.eq('dm: reads all member rows', pg_temp.val('select count(*) from public.session_members'), '3');
  perform pg_temp.eq('dm: claim_host increments host_epoch', pg_temp.val(format('select public.claim_host(%L)', v_sid)), '1');
  perform pg_temp.eq('dm: claim_host increments again', pg_temp.val(format('select public.claim_host(%L)', v_sid)), '2');
  perform pg_temp.eq('dm: stale epoch save_session_state is rejected',
    pg_temp.try(format($q$select public.save_session_state(%L, 1, '{"stateVersion": 1}')$q$, v_sid)), 'stale_epoch');
  perform pg_temp.eq('dm: current epoch save_session_state succeeds',
    pg_temp.val(format($q$select public.save_session_state(%L, 2, '{"stateVersion": 1}')$q$, v_sid)), 'true');
  perform pg_temp.eq('dm: session_state holds the saved state',
    pg_temp.val(format($q$select epoch || ':' || (state->>'stateVersion') from public.session_state where session_id = %L$q$, v_sid)), '2:1');
  perform pg_temp.eq('dm: upsert_player_view (current epoch)',
    pg_temp.val(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 5, '{"who": "p1"}')$q$, v_sid, p1)), 'true');
  perform pg_temp.eq('dm: upsert_player_view ignores an older seq',
    pg_temp.val(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 4, '{"who": "old"}')$q$, v_sid, p1)), 'false');
  perform pg_temp.eq('dm: stale epoch upsert_player_view is rejected',
    pg_temp.try(format($q$select public.upsert_player_view(%L, %L, 1, 'wire-a', 6, '{"who": "stale"}')$q$, v_sid, p1)), 'stale_epoch');
  perform pg_temp.eq('dm: upsert_player_view needs an active member',
    pg_temp.try(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 1, '{}')$q$, v_sid, x)), 'not_member');
  perform pg_temp.eq('dm: upsert_player_view for p2',
    pg_temp.val(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 1, '{"who": "p2"}')$q$, v_sid, p2)), 'true');
  perform pg_temp.eq('dm: upsert_player_view for k',
    pg_temp.val(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 1, '{"who": "k"}')$q$, v_sid, k)), 'true');
  perform pg_temp.eq('dm: cannot write session_state directly',
    pg_temp.try(format($q$update public.session_state set state = '{}' where session_id = %L$q$, v_sid)), 'permission denied for table session_state');
  perform pg_temp.eq('dm: cannot write player_views directly',
    pg_temp.try(format($q$update public.player_views set seq = 0 where session_id = %L$q$, v_sid)), 'permission denied for table player_views');

  perform pg_temp.login(p1);
  perform pg_temp.eq('player_views: player reads only own row',
    pg_temp.val($q$select string_agg((view->>'who') || ':' || epoch || ':' || seq, ',') from public.player_views$q$), 'p1:wire-a:5');
  perform pg_temp.login(p2);
  perform pg_temp.eq('player_views: another member reads only own row',
    pg_temp.val($q$select string_agg((view->>'who') || ':' || seq, ',') from public.player_views$q$), 'p2:1');
  perform pg_temp.login(x);
  perform pg_temp.eq('player_views: non-member reads nothing', pg_temp.val('select count(*) from public.player_views'), '0');
  perform pg_temp.login(k);
  perform pg_temp.eq('player_views: k reads own row before the kick',
    pg_temp.val($q$select string_agg(view->>'who', ',') from public.player_views$q$), 'k');

  -- ======================= realtime: target + fixtures =======================
  perform pg_temp.logout();
  begin
    insert into realtime.messages (topic, extension, payload, event, private)
    values ('atlas-probe', 'broadcast', '{}', 'probe', true);
    v_target := 'realtime.messages';
  exception when others then
    v_target := 'pg_temp.messages';
  end;
  perform set_config('atlas.rt_target', v_target, true);
  perform pg_temp.check('realtime: checks run against ' || v_target, true,
    case when v_target = 'pg_temp.messages' then 'no realtime.messages partition for now(); verbatim policy clone used' end);

  for v_topic in
    select t from unnest(array[
      format('session:%s:req:%s', v_sid, p1),
      format('session:%s:view:%s', v_sid, p1),
      format('session:%s:host', v_sid),
      format('session:%s:lobby', v_sid),
      -- malformed / foreign topics
      format('session:%s:view', v_sid),
      format('session:%s:req', v_sid),
      format('session:%s:host:%s', v_sid, p1),
      format('session:%s:lobby:%s', v_sid, p1),
      format('session:%s:view:%s:x', v_sid, p1),
      format('session:%s:view:%s', upper(v_sid::text), p1),
      format('session:%s:req:%s', v_sid, upper(p1::text)),
      format('session:%s:HOST', v_sid),
      format('session:%s:host ', v_sid),
      format('xsession:%s:host', v_sid),
      format('session:%s:host', gen_random_uuid()),
      'session:*:host'
    ]) as t
  loop
    execute format(
      'insert into %s (topic, extension, payload, event, private) values (%L, ''broadcast'', ''{}'', ''fixture'', true), (%L, ''presence'', ''{}'', ''fixture'', true)',
      v_target, v_topic, v_topic
    );
  end loop;

  perform pg_temp.rt('kicked member (before kick)', k, format('session:%s:host', v_sid), 'select', 'broadcast', true);
  perform pg_temp.rt('kicked member (before kick)', k, format('session:%s:lobby', v_sid), 'insert', 'presence', true);

  -- ======================= kick =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('kick: set_member_status kicked', pg_temp.val(format($q$select public.set_member_status(%L, %L, 'kicked')$q$, v_sid, k)), 'true');
  perform pg_temp.eq('kick: repeating is a no-op', pg_temp.val(format($q$select public.set_member_status(%L, %L, 'kicked')$q$, v_sid, k)), 'false');
  perform pg_temp.eq('kick: rejects bad status', pg_temp.try(format($q$select public.set_member_status(%L, %L, 'banned')$q$, v_sid, k)), 'invalid_argument');
  perform pg_temp.eq('kick: kicked user loses fenced view writes',
    pg_temp.try(format($q$select public.upsert_player_view(%L, %L, 2, 'wire-a', 2, '{}')$q$, v_sid, k)), 'not_member');
  perform pg_temp.login(k);
  perform pg_temp.eq('kick: kicked user cannot rejoin', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Kay')), 'kicked');
  perform pg_temp.eq('kick: session_info tells the kicked user why',
    pg_temp.val(format('select member_status from public.session_info(%L)', v_sid)), 'kicked');
  perform pg_temp.eq('kick: kicked user cannot read own player_views row', pg_temp.val('select count(*) from public.player_views'), '0');
  perform pg_temp.eq('kick: kicked user cannot rename self',
    pg_temp.val(format($q$with u as (update public.session_members set display_name = 'K2' where session_id = %L returning 1) select count(*) from u$q$, v_sid)), '0');

  -- ======================= realtime matrix (ARCHITECTURE §6.1) =======================
  create temp table atlas_rt_allowed (who text, kind text, op text, ext text) on commit drop;
  insert into atlas_rt_allowed values
    ('dm', 'req', 'select', 'broadcast'),
    ('player', 'req', 'select', 'broadcast'), -- joining needs read permission (req_topic_player_read)
    ('player', 'req', 'insert', 'broadcast'),
    ('dm', 'view', 'insert', 'broadcast'),
    ('dm', 'view', 'select', 'broadcast'),
    ('player', 'view', 'select', 'broadcast'),
    ('dm', 'host', 'insert', 'broadcast'),
    ('dm', 'host', 'insert', 'presence'),
    ('dm', 'host', 'select', 'broadcast'),
    ('dm', 'host', 'select', 'presence'),
    ('player', 'host', 'select', 'broadcast'),
    ('player', 'host', 'select', 'presence'),
    ('other member', 'host', 'select', 'broadcast'),
    ('other member', 'host', 'select', 'presence'),
    ('dm', 'lobby', 'select', 'presence'),
    ('player', 'lobby', 'insert', 'presence'),
    ('player', 'lobby', 'select', 'presence'),
    ('other member', 'lobby', 'insert', 'presence'),
    ('other member', 'lobby', 'select', 'presence');

  for r in
    select u.who, u.uid, t.kind, t.topic, o.op, e.ext
    from (values ('dm', d), ('player', p1), ('other member', p2), ('kicked member', k), ('non-member', x), ('anon', null::uuid)) as u (who, uid)
    cross join (values
      ('req', format('session:%s:req:%s', v_sid, p1)),
      ('view', format('session:%s:view:%s', v_sid, p1)),
      ('host', format('session:%s:host', v_sid)),
      ('lobby', format('session:%s:lobby', v_sid))
    ) as t (kind, topic)
    cross join (values ('select'), ('insert')) as o (op)
    cross join (values ('broadcast'), ('presence')) as e (ext)
  loop
    perform pg_temp.rt(r.who, r.uid, r.topic, r.op, r.ext,
      exists (select 1 from atlas_rt_allowed a where a.who = r.who and a.kind = r.kind and a.op = r.op and a.ext = r.ext));
  end loop;

  -- Malformed or foreign topics grant nothing, even to the DM and the player.
  for r in
    select u.who, u.uid, t.topic, o.op, e.ext
    from (values ('dm', d), ('player', p1)) as u (who, uid)
    cross join unnest(array[
      format('session:%s:view', v_sid),
      format('session:%s:req', v_sid),
      format('session:%s:host:%s', v_sid, p1),
      format('session:%s:lobby:%s', v_sid, p1),
      format('session:%s:view:%s:x', v_sid, p1),
      format('session:%s:view:%s', upper(v_sid::text), p1),
      format('session:%s:req:%s', v_sid, upper(p1::text)),
      format('session:%s:HOST', v_sid),
      format('session:%s:host ', v_sid),
      format('xsession:%s:host', v_sid),
      format('session:%s:host', gen_random_uuid()),
      'session:*:host'
    ]) as t (topic)
    cross join (values ('select'), ('insert')) as o (op)
    cross join (values ('broadcast'), ('presence')) as e (ext)
  loop
    perform pg_temp.rt(r.who || ' (bad topic)', r.uid, r.topic, r.op, r.ext, false);
  end loop;

  -- ======================= end session =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('end: end_session', pg_temp.val(format('select public.end_session(%L)', v_sid)), 'true');
  perform pg_temp.eq('end: ending twice returns false', pg_temp.val(format('select public.end_session(%L)', v_sid)), 'false');
  perform pg_temp.eq('end: end_session bumps host_epoch', pg_temp.val(format('select status || '':'' || host_epoch from public.sessions where id = %L', v_sid)), 'ended:3');
  perform pg_temp.eq('end: claim_host on an ended session', pg_temp.try(format('select public.claim_host(%L)', v_sid)), 'session_ended');
  perform pg_temp.eq('end: fenced writes on an ended session',
    pg_temp.try(format($q$select public.save_session_state(%L, 3, '{}')$q$, v_sid)), 'session_ended');
  perform pg_temp.eq('end: player_views are dropped', pg_temp.val(format('select count(*) from public.player_views where session_id = %L', v_sid)), '0');
  perform pg_temp.login(p1);
  perform pg_temp.eq('end: the room code no longer resolves', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Alice')), 'session_not_found');
  perform pg_temp.eq('end: session_info reports ended', pg_temp.val(format('select status from public.session_info(%L)', v_sid)), 'ended');
  perform pg_temp.rt('player (after end)', p1, format('session:%s:host', v_sid), 'select', 'broadcast', false);
  perform pg_temp.rt('player (after end)', p1, format('session:%s:view:%s', v_sid, p1), 'select', 'broadcast', false);
  perform pg_temp.rt('player (after end)', p1, format('session:%s:req:%s', v_sid, p1), 'insert', 'broadcast', false);
  perform pg_temp.rt('player (after end)', p1, format('session:%s:req:%s', v_sid, p1), 'select', 'broadcast', false);
  perform pg_temp.rt('player (after end)', p1, format('session:%s:lobby', v_sid), 'insert', 'presence', false);
  perform pg_temp.rt('dm (after end)', d, format('session:%s:host', v_sid), 'insert', 'broadcast', true);

  -- ======================= scene sharing off, scene deletion =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('share: going private returns no slug',
    coalesce(pg_temp.val(format($q$select public.set_scene_visibility(%L, 'private')$q$, v_scene)), 'NULL'), 'NULL');
  perform pg_temp.login(p1);
  perform pg_temp.eq('share: old slug stops working', pg_temp.val(format('select count(*) from public.get_shared_scene(%L)', v_slug)), '0');
  perform pg_temp.login(d);
  perform pg_temp.eq('scenes: owner can delete',
    pg_temp.val(format('with u as (delete from public.scenes where id = %L returning 1) select count(*) from u', v_scene)), '1');
  perform pg_temp.eq('scenes: versions are deleted with the scene', pg_temp.val('select count(*) from public.scene_versions'), '0');

  perform pg_temp.logout();
end
$$;

-- One summary row: every check must pass. (For the full list: select * from atlas_results order by n.)
select
  count(*) filter (where ok) as passed,
  count(*) filter (where not ok) as failed,
  (select json_agg(json_build_object('n', n, 'name', name, 'detail', left(detail, 200)) order by n) from atlas_results where not ok) as failures,
  (select name || coalesce(' (' || detail || ')', '') from atlas_results where name like 'realtime: checks run against%') as realtime_target
from atlas_results;

rollback;
