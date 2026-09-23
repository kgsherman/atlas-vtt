-- Atlas VTT: per-account quota tests (ARCHITECTURE §6.4; migrations *_owner_quotas.sql,
-- *_drop_legacy_tiles.sql, *_member_names.sql, *_scene_asset_cleanup.sql).
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
  u uuid := gen_random_uuid();   -- an account filling its library
  d uuid := gen_random_uuid();   -- a DM with many sessions
  p uuid := gen_random_uuid();   -- a player of d's session
  x uuid := gen_random_uuid();   -- signed in, never joined
  v_scene uuid;
  v_first uuid;
  v_sid uuid;
  v_code text;
  v_last text;
  v_blob jsonb;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select w, 'authenticated', 'authenticated', true
  from unnest(array[u, d, p, x]) as w;

  -- ======================= catalog =======================
  perform pg_temp.check('catalog: quota helpers are private (no execute for clients)',
    not has_function_privilege('authenticated', 'private.check_owner_scene_quota(uuid, bigint, boolean, integer, bigint)', 'execute')
    and not has_function_privilege('authenticated', 'private.prune_scene_history(uuid, integer, bigint)', 'execute')
    and not has_function_privilege('authenticated', 'private.max_scenes_per_owner()', 'execute'));
  perform pg_temp.eq('catalog: the limits',
    concat_ws(',', private.max_scenes_per_owner(), private.max_owner_scene_bytes(), private.max_scene_history_bytes(), private.max_sessions_per_dm(),
      private.max_owner_asset_objects(), private.max_owner_asset_bytes(), private.max_session_tile_objects()),
    concat_ws(',', 50, 200 * 1024 * 1024, 100 * 1024 * 1024, 50, 300, 1024::bigint * 1024 * 1024, 20000));

  -- ======================= scenes per owner =======================
  perform pg_temp.login(u);
  for n in 1..50 loop
    v_last := pg_temp.val(format($q$select public.create_scene(%L, 1, '{"v": 1}')$q$, 'Scene ' || n));
    if n = 1 then v_first := v_last::uuid; end if;
  end loop;
  perform pg_temp.check('scenes: 50 scenes are fine', v_last ~ '^[0-9a-f-]{36}$', v_last);
  perform pg_temp.eq('scenes: the 51st is refused', pg_temp.try($q$select public.create_scene('One too many', 1, '{"v": 1}')$q$), 'quota_exceeded');
  perform pg_temp.eq('scenes: saving versions of an existing scene still works',
    pg_temp.val(format($q$select public.save_scene_version(%L, 1, '{"v": 2}')$q$, v_first)), '2');
  perform pg_temp.check('scenes: deleting one makes room',
    pg_temp.try(format('delete from public.scenes where id = %L', v_first)) = 'ok'
    and pg_temp.val($q$select public.create_scene('Room again', 1, '{"v": 1}')$q$) ~ '^[0-9a-f-]{36}$');
  perform pg_temp.logout();

  -- ======================= bytes per owner (small limits: the check itself) =======================
  v_scene := (select s.id from public.scenes s where s.owner_id = u order by s.created_at, s.id limit 1);
  perform pg_temp.eq('bytes: within the budget', pg_temp.try(format('select private.check_owner_scene_quota(%L, 10, false, 1000, 1000000)', u)), 'ok');
  perform pg_temp.eq('bytes: a write that would go over the budget is refused',
    pg_temp.try(format('select private.check_owner_scene_quota(%L, 1000000, false, 1000, 1000000)', u)), 'quota_exceeded');
  perform pg_temp.eq('bytes: what is stored counts',
    pg_temp.try(format('select private.check_owner_scene_quota(%L, 0, false, 1000, 100)', u)), 'quota_exceeded');
  perform pg_temp.eq('bytes: the real budget is far away for small scenes',
    pg_temp.try(format('select private.check_owner_scene_quota(%L, 1000, false)', u)), 'ok');
  perform pg_temp.eq('bytes: a single huge save would not fit',
    pg_temp.try(format('select private.check_owner_scene_quota(%L, %s, false)', u, 201 * 1024 * 1024)), 'quota_exceeded');

  -- ======================= history pruned by bytes =======================
  -- Versions 2..7 of ~4 KB each (incompressible), then keep only what fits in 10 KB: the newest two.
  perform pg_temp.login(u);
  for n in 2..7 loop
    v_blob := jsonb_build_object('v', n, 'pad', encode(extensions.gen_random_bytes(1000) || extensions.gen_random_bytes(1000) || extensions.gen_random_bytes(1000), 'base64'));
    perform public.save_scene_version(v_scene, 1, v_blob);
  end loop;
  perform pg_temp.logout();
  perform pg_temp.eq('history: 7 versions before pruning', (select count(*)::text from public.scene_versions where scene_id = v_scene), '7');
  perform pg_temp.check('history: pruning by bytes removes the oldest', private.prune_scene_history(v_scene, 7, 10000) > 0);
  perform pg_temp.eq('history: the newest that fit remain',
    (select string_agg(version::text, ',' order by version) from public.scene_versions where scene_id = v_scene), '6,7');
  perform pg_temp.eq('history: a budget smaller than the latest version removes all the others',
    private.prune_scene_history(v_scene, 7, 1)::text, '1');
  perform pg_temp.eq('history: but keeps the latest',
    (select string_agg(version::text, ',') from public.scene_versions where scene_id = v_scene), '7');

  -- ======================= sessions per DM =======================
  perform pg_temp.login(d);
  v_scene := pg_temp.val($q$select public.create_scene('Keep', 1, '{"v": 1}')$q$)::uuid;
  for n in 1..55 loop
    select s.session_id, s.room_code into v_sid, v_code from public.create_session(v_scene) s;
    if n < 55 then perform public.end_session(v_sid); end if;
  end loop;
  perform pg_temp.eq('sessions: at most 50 kept (the newest; ended ones go first)',
    pg_temp.val('select count(*) || '':'' || count(*) filter (where status = ''active'') from public.sessions'), '50:1');
  perform pg_temp.eq('sessions: their state went with them',
    pg_temp.val('select count(*) from public.session_state'), '50');

  -- ======================= scene-assets per owner =======================
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name, metadata)
  select 'scene-assets', format('%s/doc%s/img%s.webp', u, g % 7, g), jsonb_build_object('size', 1000)
  from generate_series(1, 299) g;
  perform pg_temp.login(u);
  perform pg_temp.eq('assets: the 300th image is fine',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, u || '/docA/last.webp')), 'ok');
  perform pg_temp.check('assets: the 301st is refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, u || '/docA/over.webp')) like 'new row violates row-level security policy%');
  perform pg_temp.login(d);
  perform pg_temp.eq('assets: other accounts are not affected',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, d || '/docB/img.webp')), 'ok');
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name, metadata)
  values ('scene-assets', format('%s/docB/huge.webp', d), jsonb_build_object('size', 1024::bigint * 1024 * 1024));
  perform pg_temp.login(d);
  perform pg_temp.check('assets: an account over 1 GB cannot add images',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('scene-assets', %L)$q$, d || '/docB/more.webp')) like 'new row violates row-level security policy%');

  -- ======================= session-tiles =======================
  select s.id, s.room_code into v_sid, v_code from public.sessions s where s.dm_id = d and s.status = 'active';
  perform pg_temp.login(p);
  perform public.join_session(v_code, 'Pat');
  perform pg_temp.login(d);
  perform pg_temp.eq('tiles: a chunk for a member is fine',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_sid, p))), 'ok');
  perform pg_temp.check('tiles: a chunk for someone who never joined is refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_sid, x))) like 'new row violates row-level security policy%');
  perform pg_temp.check('tiles: the old per-cell layout is refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/L1/0_0.webp', v_sid))) like 'new row violates row-level security policy%');
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name)
  select 'session-tiles', format('%s/%s/S%s/%s_%s.webp', v_sid, p, g / 4096, (g / 64) % 64, g % 64)
  from generate_series(1, 19998) g;
  perform pg_temp.login(d);
  perform pg_temp.eq('tiles: the 20000th object of a session is fine',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/Z/1_1.webp', v_sid, p))), 'ok');
  perform pg_temp.check('tiles: a full session takes no more',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/Z/2_2.webp', v_sid, p))) like 'new row violates row-level security policy%');

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
