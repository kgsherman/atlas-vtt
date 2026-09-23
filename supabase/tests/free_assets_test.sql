-- Atlas VTT: free asset tests (ARCHITECTURE §6.4; migration *_free_assets.sql): the public.free_assets
-- catalog (readable by signed-in users, never writable by clients), the public free-assets bucket
-- (no client writes), and create_session's free asset categories in the seed.
--
-- Run as `postgres` (SQL editor, psql, or the MCP execute_sql tool). Everything runs in ONE transaction
-- that is ROLLED BACK. The last statement before ROLLBACK returns (passed, failed, failures); `failed`
-- must be 0.

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
  d uuid := gen_random_uuid();   -- a DM (guest)
  v_scene uuid;
  v_sid uuid;
begin
  insert into auth.users (id, aud, role, is_anonymous) values (d, 'authenticated', 'authenticated', true);

  -- ---- bucket ---------------------------------------------------------------------------------
  perform pg_temp.eq('bucket: free-assets is public, 20 MiB, GLB / PNG / WebP',
    (select format('%s|%s|%s', public, file_size_limit, array_to_string(allowed_mime_types, ',')) from storage.buckets where id = 'free-assets'),
    't|20971520|model/gltf-binary,image/png,image/webp');

  -- ---- catalog --------------------------------------------------------------------------------
  perform pg_temp.check('catalog: RLS on', (select relrowsecurity from pg_class where oid = 'public.free_assets'::regclass));
  perform pg_temp.check('catalog: every row''s category is a known one',
    not exists (select 1 from public.free_assets a where not (a.category = any (private.free_asset_categories()))));

  perform pg_temp.login(d);
  perform pg_temp.check('catalog: a signed-in user (guest) reads it',
    pg_temp.val($q$select count(*) from public.free_assets where category = 'token-models'$q$)::int >= 1);
  perform pg_temp.check('catalog: no client inserts',
    pg_temp.try($q$insert into public.free_assets (id, category, name, path, bytes) values ('x', 'token-models', 'X', 'token-models/x.glb', 1)$q$) like 'permission denied%');
  perform pg_temp.check('catalog: no client updates',
    pg_temp.try($q$update public.free_assets set name = 'Hacked'$q$) like 'permission denied%');
  perform pg_temp.check('catalog: no client deletes',
    pg_temp.try($q$delete from public.free_assets$q$) like 'permission denied%');
  perform pg_temp.check('bucket: no client uploads',
    pg_temp.try($q$insert into storage.objects (bucket_id, name) values ('free-assets', 'token-models/evil.glb')$q$) like '%row-level security%');
  perform pg_temp.check('private.free_asset_categories() is not callable by clients',
    pg_temp.try($q$select private.free_asset_categories()$q$) like 'permission denied%');

  perform pg_temp.login_anon();
  perform pg_temp.check('catalog: anon (signed out) cannot read it',
    pg_temp.try($q$select count(*) from public.free_assets$q$) like 'permission denied%');

  -- ---- create_session(scene, free_assets) -----------------------------------------------------
  perform pg_temp.login(d);
  v_scene := pg_temp.val($q$select public.create_scene('S', 2, '{"id": "docS"}')$q$)::uuid;

  select s.session_id into v_sid from public.create_session(v_scene) s;
  perform pg_temp.eq('create_session without categories seeds none',
    (select state->>'freeAssets' from public.session_state where session_id = v_sid), '[]');

  select s.session_id into v_sid from public.create_session(v_scene, array['token-models', 'token-models']) s;
  perform pg_temp.eq('create_session seeds the categories, each once',
    (select state->>'freeAssets' from public.session_state where session_id = v_sid), '["token-models"]');
  perform pg_temp.eq('the seed keeps its other fields',
    (select format('%s|%s|%s', state->>'kind', state->>'sceneVersion', state->>'schemaVersion') from public.session_state where session_id = v_sid), 'seed|1|2');

  perform pg_temp.check('create_session refuses an unknown category',
    pg_temp.try(format('select * from public.create_session(%L, array[%L])', v_scene, 'maps')) = 'invalid_argument');
  perform pg_temp.check('create_session refuses a NULL category',
    pg_temp.try(format('select * from public.create_session(%L, array[NULL]::text[])', v_scene)) = 'invalid_argument');
  perform pg_temp.check('create_session refuses more than 16 entries',
    pg_temp.try(format('select * from public.create_session(%L, array_fill(%L::text, array[17]))', v_scene, 'token-models')) = 'invalid_argument');

  perform pg_temp.login_anon();
  perform pg_temp.check('anon cannot call create_session',
    pg_temp.try(format('select * from public.create_session(%L, array[%L])', v_scene, 'token-models')) like 'permission denied for function%');
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
