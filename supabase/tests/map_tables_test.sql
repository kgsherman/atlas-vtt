-- Atlas VTT: map tables (ARCHITECTURE §6.8; migration *_map_tables.sql): open_map, set_table_open,
-- set_session_scene, closed tables for players (join, membership, stored views), one live table per map,
-- room codes kept by the world (migration *_worlds.sql), create_session / end_session on tables, and a
-- deleted map ending its table.
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
  d uuid := gen_random_uuid();   -- the DM
  o uuid := gen_random_uuid();   -- another owner
  p uuid := gen_random_uuid();   -- a player
  q uuid := gen_random_uuid();   -- another player
  v_a uuid;
  v_b uuid;
  v_x uuid;
  v_t uuid;
  v_t2 uuid;
  v_t3 uuid;
  v_code text;
  v_code3 text;
  v_epoch bigint;
  v_r record;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, o, p, q]) as u;

  perform pg_temp.login(o);
  v_x := pg_temp.val($q$select public.create_scene('X', 1, '{"id": "docX"}')$q$)::uuid;
  perform pg_temp.login(d);
  v_a := pg_temp.val($q$select public.create_scene('A', 1, '{"id": "docA"}')$q$)::uuid;
  v_b := pg_temp.val($q$select public.create_scene('B', 1, '{"id": "docB"}')$q$)::uuid;

  -- ---- open_map ------------------------------------------------------------------------------------
  select * into v_r from public.open_map(v_a, array['token-models']);
  v_t := v_r.session_id;
  v_code := v_r.room_code;
  perform pg_temp.eq('open_map: a new table starts closed', v_r.status || ':' || v_r.created, 'closed:true');
  perform pg_temp.eq('open_map: seeded from the latest version, with the categories',
    (select format('%s|%s|%s', state->>'kind', state->>'sceneId', state->>'freeAssets') from public.session_state where session_id = v_t),
    format('seed|%s|["token-models"]', v_a));
  select * into v_r from public.open_map(v_a);
  perform pg_temp.eq('open_map: the same table again', v_r.session_id::text || ':' || v_r.created, v_t::text || ':false');
  perform pg_temp.eq('open_map: someone else''s map', pg_temp.try(format('select * from public.open_map(%L)', v_x)), 'not_found');

  -- ---- closed: players stay out ---------------------------------------------------------------------
  perform pg_temp.login(p);
  perform pg_temp.eq('closed: join says so', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Pat')), 'table_closed');
  perform pg_temp.eq('closed: a player cannot open it', pg_temp.try(format('select public.set_table_open(%L, true)', v_t)), 'not_found');
  perform pg_temp.login(d);
  perform pg_temp.eq('open: set_table_open', pg_temp.val(format('select public.set_table_open(%L, true)', v_t)), 'active');
  perform pg_temp.login(p);
  perform pg_temp.eq('open: the player joins', pg_temp.val(format('select public.join_session(%L, %L)', v_code, 'Pat')), v_t::text);
  perform pg_temp.eq('open: an active member', pg_temp.val(format('select private.is_active_member(%L)', v_t)), 'true');
  perform pg_temp.login(d);
  v_epoch := pg_temp.val(format('select public.claim_host(%L)', v_t))::bigint;
  perform public.upsert_player_view(v_t, p, v_epoch, 'w', 1, '{"viewVersion": 1}'::jsonb);
  perform pg_temp.login(p);
  perform pg_temp.eq('open: the player reads their view', pg_temp.val('select count(*) from public.player_views'), '1');
  perform pg_temp.login(d);
  perform pg_temp.eq('close: set_table_open', pg_temp.val(format('select public.set_table_open(%L, false)', v_t)), 'closed');
  perform pg_temp.login(p);
  perform pg_temp.eq('closed: no longer an active member', pg_temp.val(format('select private.is_active_member(%L)', v_t)), 'false');
  perform pg_temp.eq('closed: the stored view is out of reach', pg_temp.val('select count(*) from public.player_views'), '0');
  perform pg_temp.eq('closed: session_info says closed', pg_temp.val(format('select status || '':'' || member_status from public.session_info(%L)', v_t)), 'closed:active');
  perform pg_temp.eq('closed: joining again says so', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Pat')), 'table_closed');

  -- ---- closed: the DM keeps working ----------------------------------------------------------------
  perform pg_temp.login(d);
  perform pg_temp.eq('closed: the state still saves', pg_temp.try(format('select public.save_session_state(%L, %s, %L)', v_t, v_epoch, '{"stateVersion": 1}')), 'ok');
  perform pg_temp.eq('closed: claim_host still works', pg_temp.val(format('select public.claim_host(%L)', v_t)), (v_epoch + 1)::text);
  v_epoch := v_epoch + 1;
  perform pg_temp.logout();
  -- Room codes are the worlds' (migration *_worlds.sql): the world keeps its code while its tables are closed.
  perform pg_temp.check('closed: the room code stays reserved',
    pg_temp.try(format('insert into public.worlds (owner_id, name, room_code) values (%L, %L, %L)', o, 'W', v_code)) like '%worlds_room_code_key%');
  perform pg_temp.check('one live table per map',
    pg_temp.try(format('insert into public.sessions (dm_id, scene_id, world_id, room_code, status) values (%L, %L, %L, %L, %L)', d, v_a, (select world_id from public.scenes where id = v_a), v_code, 'closed')) like '%sessions_live_scene_key%');

  -- ---- set_session_scene ---------------------------------------------------------------------------
  perform pg_temp.login(d);
  select t.session_id into v_t2 from public.open_map(v_b) t;
  perform pg_temp.eq('map change: set_session_scene', pg_temp.val(format('select public.set_session_scene(%L, %s, %L)', v_t, v_epoch, v_b)), 'true');
  perform pg_temp.eq('map change: the idle table on that map ends', (select status from public.sessions where id = v_t2), 'ended');
  perform pg_temp.eq('map change: the table holds the new map', (select scene_id::text from public.sessions where id = v_t), v_b::text);
  select * into v_r from public.open_map(v_b);
  perform pg_temp.eq('map change: opening the new map finds the table', v_r.session_id::text || ':' || v_r.created, v_t::text || ':false');
  select * into v_r from public.open_map(v_a);
  v_t3 := v_r.session_id;
  v_code3 := v_r.room_code;
  perform pg_temp.eq('map change: the map left gets a new table', v_r.created::text, 'true');
  perform public.set_table_open(v_t3, true);
  perform pg_temp.login(q);
  perform public.join_session(v_code3, 'Quin');
  perform pg_temp.login(d);
  perform pg_temp.eq('map change: refused where players sit', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_t, v_epoch, v_a)), 'map_in_use');
  perform pg_temp.eq('map change: fenced', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_t, v_epoch - 1, v_a)), 'stale_epoch');
  perform pg_temp.eq('map change: someone else''s map', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_t, v_epoch, v_x)), 'not_found');
  perform pg_temp.login(p);
  perform pg_temp.eq('map change: DM only', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_t, v_epoch, v_a)), 'not_found');

  -- ---- create_session / end_session ------------------------------------------------------------------
  -- A and B are in the same world (migration *_worlds.sql): one open table per world.
  perform pg_temp.login(d);
  perform pg_temp.eq('create_session: not while another table of the world is open', pg_temp.try(format('select * from public.create_session(%L)', v_b)), 'world_table_open');
  perform public.set_table_open(v_t3, false);
  select c.session_id into v_r from public.create_session(v_b) c;
  perform pg_temp.eq('create_session: the map''s table, opened', (select id::text || ':' || status from public.sessions where id = v_t), v_t::text || ':active');
  perform pg_temp.eq('end_session: a closed table ends', pg_temp.val(format('select public.set_table_open(%L, false)', v_t)) || ':' || pg_temp.val(format('select public.end_session(%L)', v_t)), 'closed:true');
  perform pg_temp.login(p);
  perform pg_temp.eq('end_session: the code still answers for the world', pg_temp.try(format('select public.join_session(%L, %L)', v_code, 'Pat')), 'table_closed');
  perform pg_temp.login(d);

  -- ---- deleting a map ends its table -----------------------------------------------------------------
  v_epoch := pg_temp.val(format('select public.claim_host(%L)', v_t3))::bigint;
  perform public.upsert_player_view(v_t3, q, v_epoch, 'w', 1, '{"viewVersion": 1}'::jsonb);
  perform pg_temp.eq('delete map: allowed', pg_temp.try(format('delete from public.scenes where id = %L', v_a)), 'ok');
  perform pg_temp.eq('delete map: its table ends', (select status from public.sessions where id = v_t3), 'ended');
  perform pg_temp.logout();
  perform pg_temp.eq('delete map: the stored views go', (select count(*)::text from public.player_views where session_id = v_t3), '0');
  perform pg_temp.login(q);
  perform pg_temp.eq('delete map: session_info says ended', pg_temp.val(format('select status from public.session_info(%L)', v_t3)), 'ended');

  perform pg_temp.login_anon();
  perform pg_temp.check('anon cannot call open_map', pg_temp.try(format('select * from public.open_map(%L)', v_b)) like 'permission denied for function%');
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
