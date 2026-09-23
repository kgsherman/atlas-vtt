-- Atlas VTT: map image storage tests (ARCHITECTURE §9; migration *_map_assets_storage.sql).
--
-- Run as `postgres` (SQL editor, psql, or the MCP execute_sql tool). Everything runs in ONE transaction
-- that is ROLLED BACK. The last statement before ROLLBACK returns (passed, failed, failures); `failed`
-- must be 0.
--
-- Users are impersonated like PostgREST / Storage do it: role `authenticated` (or `anon`) plus
-- request.jwt.claims carrying the user's `sub`. Storage objects are seeded as `postgres` (which
-- bypasses RLS) and visibility is checked by querying storage.objects as each user — the same queries
-- the Storage API runs under the caller's role. Deletes need `storage.allow_delete_query` (the
-- protect_delete trigger otherwise refuses direct deletes).

begin;

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
end
$$;

create function pg_temp.login_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end
$$;

create function pg_temp.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

grant execute on function pg_temp.check(text, boolean, text) to authenticated, anon;
grant execute on function pg_temp.eq(text, text, text) to authenticated, anon;
grant execute on function pg_temp.try(text) to authenticated, anon;
grant execute on function pg_temp.val(text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.login_anon() to authenticated, anon;
grant execute on function pg_temp.logout() to authenticated, anon;

do $$
declare
  d uuid := gen_random_uuid();   -- DM: owns the scene and its images, runs the session
  o uuid := gen_random_uuid();   -- another DM with their own images and session
  p1 uuid := gen_random_uuid();  -- player who gets grants
  p2 uuid := gen_random_uuid();  -- active player without grants
  k uuid := gen_random_uuid();   -- member who gets kicked (holding a grant)
  x uuid := gen_random_uuid();   -- signed in, never joined
  v_scene uuid;
  v_other_scene uuid;
  v_sid uuid;
  v_osid uuid;
  v_code text;
  v_epoch text;
  q_tiles text;
  q_assets text;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, o, p1, p2, k, x]) as u;

  -- ======================= catalog =======================
  perform pg_temp.eq('catalog: both buckets exist and are private',
    (select string_agg(id || '=' || public::text, ',' order by id) from storage.buckets where id in ('scene-assets', 'session-tiles')),
    'scene-assets=false,session-tiles=false');
  perform pg_temp.eq('catalog: tile bucket accepts only small images',
    (select file_size_limit || ':' || array_to_string(allowed_mime_types, '|') from storage.buckets where id = 'session-tiles'), '2097152:image/webp|image/png');
  perform pg_temp.check('catalog: RLS on player_tiles',
    (select relrowsecurity from pg_class where oid = 'public.player_tiles'::regclass));
  perform pg_temp.eq('catalog: authenticated may only SELECT player_tiles',
    (select string_agg(p, ',' order by p) from unnest(array['select', 'insert', 'update', 'delete']) p
      where has_table_privilege('authenticated', 'public.player_tiles', p)), 'select');
  perform pg_temp.check('catalog: anon has no privilege on player_tiles',
    not has_table_privilege('anon', 'public.player_tiles', 'select, insert, update, delete'));
  perform pg_temp.check('catalog: anon cannot call grant_tiles / revoke_tiles',
    not has_function_privilege('anon', 'public.grant_tiles(uuid, bigint, uuid, text, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.revoke_tiles(uuid, bigint, uuid, text)', 'execute'));
  perform pg_temp.eq('catalog: tile helpers are security definer with an empty search_path',
    (select string_agg(p.proname || '=' || p.prosecdef || '/' || coalesce(p.proconfig @> array['search_path=""'], false), ',' order by p.proname)
      from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'can_%_session_tile'),
    'can_delete_session_tile=true/true,can_read_session_tile=true/true,can_write_session_tile=true/true');
  perform pg_temp.eq('catalog: one storage.objects policy per command',
    (select string_agg(cmd, ',' order by cmd) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'atlas_%'),
    'DELETE,INSERT,SELECT,UPDATE');

  -- ======================= setup: scene, sessions, members =======================
  perform pg_temp.login(d);
  v_scene := pg_temp.val($q$select public.create_scene('Vineyard', 1, '{"v": 1}')$q$)::uuid;
  select s.session_id, s.room_code into v_sid, v_code from public.create_session(v_scene) s;
  v_epoch := pg_temp.val(format('select public.claim_host(%L)', v_sid));
  perform pg_temp.eq('setup: claim_host gives epoch 1', v_epoch, '1');
  perform pg_temp.login(p1);
  perform public.join_session(v_code, 'Alice');
  perform pg_temp.login(p2);
  perform public.join_session(v_code, 'Bob');
  perform pg_temp.login(k);
  perform public.join_session(v_code, 'Kim');
  perform pg_temp.login(o);
  v_other_scene := pg_temp.val($q$select public.create_scene('Other', 1, '{"v": 1}')$q$)::uuid;
  select s.session_id into v_osid from public.create_session(v_other_scene) s;
  perform pg_temp.logout();

  -- Seed objects as postgres (bypasses RLS), as if uploaded through the Storage API.
  insert into storage.objects (bucket_id, name) values
    ('scene-assets', format('%s/sceneA/img1.webp', d)),
    ('scene-assets', format('%s/sceneB/img2.png', o)),
    ('session-tiles', format('%s/L1/0_0.webp', v_sid)),
    ('session-tiles', format('%s/L1/1_0.webp', v_sid)),
    ('session-tiles', format('%s/L2/0_0.webp', v_sid)),
    ('session-tiles', format('%s/L1/0_0.webp', v_osid)),
    ('session-tiles', format('%s/L1/notatile.webp', v_sid));

  q_assets := $q$select count(*) from storage.objects where bucket_id = 'scene-assets'$q$;
  q_tiles := format($q$select coalesce(string_agg(name, ',' order by name), '') from storage.objects where bucket_id = 'session-tiles' and name like %L$q$, v_sid || '/%');

  -- ======================= scene-assets: owner folder only =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('assets: owner sees only their own images', pg_temp.val($q$select string_agg(split_part(name, '/', 3), ',') from storage.objects where bucket_id = 'scene-assets'$q$), 'img1.webp');
  perform pg_temp.eq('assets: owner uploads into their folder',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, d || '/sceneA/img3.webp')), 'ok');
  perform pg_temp.check('assets: cannot upload into another owner''s folder',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, o || '/sceneB/evil.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.check('assets: path must be {owner}/{scene}/{asset}.{webp|png|jpg}',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, d || '/loose.webp')) like 'new row violates row-level security policy%'
    and pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, d || '/sceneA/x.svg')) like 'new row violates row-level security policy%');
  perform pg_temp.eq('assets: owner can update their own object',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"a":1}' where bucket_id = 'scene-assets' and name = %L returning 1) select count(*) from u$q$, d || '/sceneA/img1.webp')), '1');
  perform pg_temp.eq('assets: cannot update another owner''s object',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"a":1}' where bucket_id = 'scene-assets' and name = %L returning 1) select count(*) from u$q$, o || '/sceneB/img2.png')), '0');
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('assets: cannot delete another owner''s object',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'scene-assets' and name = %L returning 1) select count(*) from u$q$, o || '/sceneB/img2.png')), '0');
  perform pg_temp.eq('assets: owner deletes their own object',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'scene-assets' and name = %L returning 1) select count(*) from u$q$, d || '/sceneA/img3.webp')), '1');
  perform set_config('storage.allow_delete_query', 'false', true);
  perform pg_temp.login(p1);
  perform pg_temp.eq('assets: players (session members) never see DM images', pg_temp.val(q_assets), '0');
  perform pg_temp.login(o);
  perform pg_temp.eq('assets: other owner sees only theirs', pg_temp.val($q$select string_agg(split_part(name, '/', 3), ',') from storage.objects where bucket_id = 'scene-assets'$q$), 'img2.png');
  perform pg_temp.login_anon();
  perform pg_temp.eq('assets: anon sees nothing', coalesce(nullif(pg_temp.val('select count(*) from storage.objects'), '0'), '0'), '0');

  -- ======================= grant_tiles =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('grant: stale epoch is refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 0, %L, 'L1', '[[0,0]]')$q$, v_sid, p1)), 'stale_epoch');
  perform pg_temp.eq('grant: DM grants a cell (1 new grant)',
    pg_temp.val(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[0,0]]')$q$, v_sid, p1)), '1');
  perform pg_temp.eq('grant: granting again is a no-op (0 new)',
    pg_temp.val(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[0,0],[0,0]]')$q$, v_sid, p1)), '0');
  perform pg_temp.eq('grant: cells out of range are refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[0,200]]')$q$, v_sid, p1)), 'invalid_argument');
  perform pg_temp.eq('grant: non-integer cells are refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1.5,0]]')$q$, v_sid, p1)), 'invalid_argument');
  perform pg_temp.eq('grant: malformed cell lists are refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '{"i":0}')$q$, v_sid, p1)), 'invalid_argument');
  perform pg_temp.eq('grant: invalid level ids are refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, '../L1', '[[0,0]]')$q$, v_sid, p1)), 'invalid_argument');
  perform pg_temp.eq('grant: more than 5000 cells per call is refused',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', (select jsonb_agg(jsonb_build_array(g %% 200, g / 200)) from generate_series(0, 5000) g))$q$, v_sid, p1)), 'payload_too_large');
  perform pg_temp.eq('grant: only active members can be granted (never joined)',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[0,0]]')$q$, v_sid, x)), 'not_member');
  perform pg_temp.login(p1);
  perform pg_temp.eq('grant: a player cannot grant (not the DM)',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1,0]]')$q$, v_sid, p1)), 'not_found');
  perform pg_temp.eq('grant: a player cannot insert grants directly',
    pg_temp.try(format($q$insert into public.player_tiles (session_id, user_id, level_id, i, j) values (%L, %L, 'L1', 1, 0)$q$, v_sid, p1)), 'permission denied for table player_tiles');
  perform pg_temp.login(o);
  perform pg_temp.eq('grant: another DM cannot grant in this session',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1,0]]')$q$, v_sid, p1)), 'not_found');
  perform pg_temp.login_anon();
  perform pg_temp.check('grant: anon cannot call grant_tiles',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1,0]]')$q$, v_sid, p1)) like 'permission denied for function grant_tiles%');

  -- k holds a grant, then gets kicked.
  perform pg_temp.login(d);
  perform public.grant_tiles(v_sid, 1, k, 'L1', '[[0,0]]');
  perform public.set_member_status(v_sid, k, 'kicked');
  perform pg_temp.eq('grant: kicked members cannot be granted',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1,0]]')$q$, v_sid, k)), 'not_member');

  -- ======================= session-tiles: reads =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('tiles: the DM reads every (well-formed) tile of their session',
    pg_temp.val(q_tiles), format('%1$s/L1/0_0.webp,%1$s/L1/1_0.webp,%1$s/L2/0_0.webp', v_sid));
  perform pg_temp.eq('tiles: the DM does not see another DM''s session tiles',
    pg_temp.val(format($q$select count(*) from storage.objects where bucket_id = 'session-tiles' and name like %L$q$, v_osid || '/%')), '0');
  perform pg_temp.login(p1);
  perform pg_temp.eq('tiles: a player reads exactly the granted tile', pg_temp.val(q_tiles), format('%s/L1/0_0.webp', v_sid));
  perform pg_temp.eq('tiles: a grant is per level (L2 0_0 stays hidden)',
    pg_temp.val(format($q$select count(*) from storage.objects where bucket_id = 'session-tiles' and name = %L$q$, v_sid || '/L2/0_0.webp')), '0');
  perform pg_temp.eq('tiles: player_tiles shows the player only their own grants',
    pg_temp.val('select count(*) || '':'' || count(*) filter (where user_id = auth.uid()) from public.player_tiles'), '1:1');
  perform pg_temp.login(p2);
  perform pg_temp.eq('tiles: another member without grants reads nothing', pg_temp.val(q_tiles), '');
  perform pg_temp.eq('tiles: and sees no grants', pg_temp.val('select count(*) from public.player_tiles'), '0');
  perform pg_temp.login(k);
  perform pg_temp.eq('tiles: a kicked member loses access despite the grant', pg_temp.val(q_tiles), '');
  perform pg_temp.login(x);
  perform pg_temp.eq('tiles: non-members read nothing', pg_temp.val(q_tiles), '');
  perform pg_temp.login_anon();
  perform pg_temp.eq('tiles: anon reads nothing', coalesce(nullif(pg_temp.val(q_tiles), ''), ''), '');

  perform pg_temp.login(d);
  perform public.grant_tiles(v_sid, 1, p1, 'L1', '[[1,0]]');
  perform pg_temp.login(p1);
  perform pg_temp.eq('tiles: a new grant becomes readable', pg_temp.val(q_tiles), format('%1$s/L1/0_0.webp,%1$s/L1/1_0.webp', v_sid));
  perform pg_temp.login(d);
  perform pg_temp.eq('tiles: the DM sees every grant', pg_temp.val('select count(*) from public.player_tiles'), '3');

  -- ======================= session-tiles: writes =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('tiles: the DM uploads a tile',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/5_5.webp')), 'ok');
  perform pg_temp.check('tiles: malformed tile paths are refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/5-5.webp')) like 'new row violates row-level security policy%'
    and pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/200_0.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.check('tiles: the DM cannot write into another session',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_osid || '/L1/1_1.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.eq('tiles: the DM can replace (upsert) a tile',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"v":2}' where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, v_sid || '/L1/0_0.webp')), '1');
  perform pg_temp.login(p1);
  perform pg_temp.check('tiles: a player cannot upload tiles',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/7_7.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.eq('tiles: a player cannot overwrite a granted tile',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"v":3}' where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, v_sid || '/L1/0_0.webp')), '0');
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('tiles: a player cannot delete a granted tile',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, v_sid || '/L1/0_0.webp')), '0');
  perform set_config('storage.allow_delete_query', 'false', true);

  -- ======================= revoke_tiles =======================
  perform pg_temp.login(p1);
  perform pg_temp.eq('revoke: a player cannot revoke',
    pg_temp.try(format($q$select public.revoke_tiles(%L, 1, %L, 'L1')$q$, v_sid, p1)), 'not_found');
  perform pg_temp.login(d);
  perform pg_temp.eq('revoke: stale epoch is refused', pg_temp.try(format($q$select public.revoke_tiles(%L, 0)$q$, v_sid)), 'stale_epoch');
  perform pg_temp.eq('revoke: the DM revokes one player''s level grants',
    pg_temp.val(format($q$select public.revoke_tiles(%L, 1, %L, 'L1')$q$, v_sid, p1)), '2');
  perform pg_temp.login(p1);
  perform pg_temp.eq('revoke: revoked tiles are unreadable', pg_temp.val(q_tiles), '');
  perform pg_temp.login(d);
  perform public.grant_tiles(v_sid, 1, p1, 'L1', '[[0,0]]');

  -- ======================= host epoch fence =======================
  perform pg_temp.eq('fence: a new host claim bumps the epoch', pg_temp.val(format('select public.claim_host(%L)', v_sid)), '2');
  perform pg_temp.eq('fence: the old host can no longer grant',
    pg_temp.try(format($q$select public.grant_tiles(%L, 1, %L, 'L1', '[[1,0]]')$q$, v_sid, p1)), 'stale_epoch');
  perform pg_temp.eq('fence: the new host can',
    pg_temp.val(format($q$select public.grant_tiles(%L, 2, %L, 'L1', '[[1,0]]')$q$, v_sid, p1)), '1');

  -- ======================= session end =======================
  perform public.end_session(v_sid);
  perform pg_temp.eq('end: grants are refused after the session ended',
    pg_temp.try(format($q$select public.grant_tiles(%L, 3, %L, 'L1', '[[2,0]]')$q$, v_sid, p1)), 'session_ended');
  perform pg_temp.check('end: the DM can no longer upload tiles',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/9_9.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.login(p1);
  perform pg_temp.eq('end: players lose access to granted tiles', pg_temp.val(q_tiles), '');
  perform pg_temp.login(d);
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('end: the DM can still clean up the session''s tiles',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name like %L returning 1) select count(*) from u$q$, v_sid || '/%')), '4');
  perform set_config('storage.allow_delete_query', 'false', true);

  perform pg_temp.logout();
end
$$;

-- One summary row: every check must pass. (For the full list: select * from atlas_results order by n.)
select
  count(*) filter (where ok) as passed,
  count(*) filter (where not ok) as failed,
  (select json_agg(json_build_object('n', n, 'name', name, 'detail', left(detail, 200)) order by n) from atlas_results where not ok) as failures
from atlas_results;

rollback;
