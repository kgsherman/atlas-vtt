-- Atlas VTT: image cleanup RPC tests (ARCHITECTURE §9; migration *_scene_asset_cleanup.sql):
-- image_folders_to_free(scene) and unreferenced_scene_assets(min_age).
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
  d uuid := gen_random_uuid();   -- DM with scenes, images and a session
  o uuid := gen_random_uuid();   -- another owner
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_e uuid;
  v_sid uuid;
  v_esid uuid;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, o]) as u;

  perform pg_temp.eq('catalog: both RPCs are SECURITY INVOKER',
    (select string_agg(p.proname || '=' || p.prosecdef, ',' order by p.proname) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname in ('image_folders_to_free', 'unreferenced_scene_assets')),
    'image_folders_to_free=false,unreferenced_scene_assets=false');

  perform pg_temp.login(d);
  -- Scene A: v1 is document docA (image a1), v2 document docX. Scene B also uses docX.
  v_a := pg_temp.val($q$select public.create_scene('A', 1, '{"id": "docA", "assets": {"a1": {}}}')$q$)::uuid;
  perform public.save_scene_version(v_a, 1, '{"id": "docX", "assets": {"x1": {}}}');
  v_b := pg_temp.val($q$select public.create_scene('B', 1, '{"id": "docX", "assets": {"x1": {}}}')$q$)::uuid;
  -- Scene C (document docS) runs at its open table.
  v_c := pg_temp.val($q$select public.create_scene('C', 1, '{"id": "docS", "assets": {"s1": {}}}')$q$)::uuid;
  select s.session_id into v_sid from public.create_session(v_c) s;

  perform pg_temp.eq('folders: only what no other scene or session uses',
    pg_temp.val(format('select string_agg(f, '','' order by f) from public.image_folders_to_free(%L) f', v_a)), 'docA');
  perform pg_temp.eq('folders: the map''s own table does not keep them (it ends with the map)',
    pg_temp.val(format('select string_agg(f, '','') from public.image_folders_to_free(%L) f', v_c)), 'docS');
  -- Another map's table whose live map uses docS (e.g. after a map change) keeps it, closed or open.
  v_e := pg_temp.val($q$select public.create_scene('E', 1, '{"id": "docE"}')$q$)::uuid;
  select t.session_id into v_esid from public.open_map(v_e) t;
  perform pg_temp.logout();
  update public.session_state set state = jsonb_build_object('scene', jsonb_build_object('id', 'docS')) where session_id = v_esid;
  perform pg_temp.login(d);
  perform pg_temp.eq('folders: another (closed) table using the document keeps them',
    pg_temp.val(format('select count(*) from public.image_folders_to_free(%L) f', v_c)), '0');
  perform pg_temp.login(o);
  perform pg_temp.eq('folders: nothing for someone else''s scene',
    pg_temp.val(format('select count(*) from public.image_folders_to_free(%L) f', v_a)), '0');

  -- Images (seeded as postgres, a month old unless noted).
  perform pg_temp.logout();
  update public.session_state set state = jsonb_build_object('scene', jsonb_build_object('id', 'docS', 'assets', jsonb_build_object('s2', '{}'::jsonb))) where session_id = v_sid;
  insert into storage.objects (bucket_id, name, created_at) values
    ('scene-assets', format('%s/docA/a1.webp', d), now() - interval '30 days'),
    ('scene-assets', format('%s/docA/orphan.webp', d), now() - interval '30 days'),
    ('scene-assets', format('%s/docA/new.png', d), now() - interval '1 minute'),
    ('scene-assets', format('%s/docX/x1.webp', d), now() - interval '30 days'),
    ('scene-assets', format('%s/docS/s2.jpg', d), now() - interval '30 days'),
    ('scene-assets', format('%s/%s/a1.webp', d, v_a), now() - interval '30 days'),
    ('scene-assets', format('%s/docO/o1.webp', o), now() - interval '30 days');

  perform pg_temp.login(d);
  perform pg_temp.eq('sweep: old images nothing references (versions, active sessions, library-id folders count)',
    pg_temp.val($q$select string_agg(split_part(n, '/', 2) || '/' || split_part(n, '/', 3), ',' order by n) from public.unreferenced_scene_assets(interval '1 day') n$q$),
    'docA/orphan.webp');
  perform pg_temp.eq('sweep: recent uploads count too without an age limit',
    pg_temp.val($q$select string_agg(split_part(n, '/', 3), ',' order by n) from public.unreferenced_scene_assets(interval '0') n$q$),
    'new.png,orphan.webp');
  perform public.end_session(v_sid);
  perform pg_temp.eq('sweep: the session''s image is freed once the session ends',
    pg_temp.val($q$select string_agg(split_part(n, '/', 3), ',' order by n) from public.unreferenced_scene_assets(interval '1 day') n$q$),
    'orphan.webp,s2.jpg');
  perform pg_temp.login(o);
  perform pg_temp.eq('sweep: another owner sees only theirs',
    pg_temp.val($q$select string_agg(split_part(n, '/', 3), ',') from public.unreferenced_scene_assets(interval '1 day') n$q$), 'o1.webp');
  perform pg_temp.login_anon();
  perform pg_temp.check('sweep: anon cannot call it',
    pg_temp.try($q$select * from public.unreferenced_scene_assets(interval '1 day')$q$) like 'permission denied for function%');
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
