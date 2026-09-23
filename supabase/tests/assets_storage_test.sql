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
  p1 uuid := gen_random_uuid();  -- player
  p2 uuid := gen_random_uuid();  -- another player
  k uuid := gen_random_uuid();   -- another member
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
  perform pg_temp.check('catalog: the per-cell tile API is gone (player_tiles, grant_tiles, revoke_tiles, parse_tile_path)',
    to_regclass('public.player_tiles') is null
    and not exists (select 1 from pg_proc p where p.proname in ('grant_tiles', 'revoke_tiles', 'parse_tile_path')));
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

  -- ======================= legacy per-cell tiles (removed) =======================
  -- The old layout {sid}/{level}/{i}_{j}.webp (+ player_tiles grants) is gone: nobody writes it any
  -- more and players never read it; the DM still sees and deletes leftovers under their session folder.
  perform pg_temp.login(d);
  perform pg_temp.check('legacy: the DM cannot upload a per-cell tile',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/5_5.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.eq('legacy: the DM still sees the leftovers under their session folder (to clean them up)',
    pg_temp.val(q_tiles), format('%1$s/L1/0_0.webp,%1$s/L1/1_0.webp,%1$s/L1/notatile.webp,%1$s/L2/0_0.webp', v_sid));
  perform pg_temp.eq('legacy: nor replaceable',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"v":2}' where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, v_sid || '/L1/0_0.webp')), '0');
  perform pg_temp.login(p1);
  perform pg_temp.eq('legacy: a member reads nothing', pg_temp.val(q_tiles), '');
  perform pg_temp.check('legacy: a player cannot upload either',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, v_sid || '/L1/7_7.webp')) like 'new row violates row-level security policy%');
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('legacy: a player cannot delete them',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name like %L returning 1) select count(*) from u$q$, v_sid || '/%')), '0');
  perform pg_temp.login(o);
  perform pg_temp.eq('legacy: another DM cannot delete them',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name like %L returning 1) select count(*) from u$q$, v_sid || '/%')), '0');
  perform set_config('storage.allow_delete_query', 'false', true);

  -- ======================= session end =======================
  perform pg_temp.login(d);
  perform public.end_session(v_sid);
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('end: the DM cleans up every object under the session folder (old layout included)',
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
