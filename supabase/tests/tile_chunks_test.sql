-- Atlas VTT: per-player tile chunk storage tests (ARCHITECTURE §9; migration *_tile_chunks.sql).
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
  d uuid := gen_random_uuid();   -- DM running the session
  o uuid := gen_random_uuid();   -- another DM with their own session
  p1 uuid := gen_random_uuid();  -- player
  p2 uuid := gen_random_uuid();  -- another player
  k uuid := gen_random_uuid();   -- member who gets kicked
  x uuid := gen_random_uuid();   -- signed in, never joined
  v_scene uuid;
  v_other_scene uuid;
  v_sid uuid;
  v_osid uuid;
  v_code text;
  q_all text;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, o, p1, p2, k, x]) as u;

  perform pg_temp.eq('catalog: chunk path parser is private (no execute for clients)',
    (select has_function_privilege('authenticated', 'private.parse_chunk_path(text)', 'execute')::text), 'false');
  perform pg_temp.eq('catalog: the parser accepts chunk paths and rejects others',
    (select coalesce(c.level_id || ':' || c.ci || ',' || c.cj, 'null') from private.parse_chunk_path('0b0e9c1c-43b1-4e1b-9a53-0d1f5a0f0c11/5f7e3c1a-2b4d-4c6e-8f10-1a2b3c4d5e6f/L1/3_12.webp') c)
    || '|' || (select coalesce(c.level_id, 'null') from private.parse_chunk_path('0b0e9c1c-43b1-4e1b-9a53-0d1f5a0f0c11/5f7e3c1a-2b4d-4c6e-8f10-1a2b3c4d5e6f/L1/64_0.webp') c)
    || '|' || (select coalesce(c.level_id, 'null') from private.parse_chunk_path('0b0e9c1c-43b1-4e1b-9a53-0d1f5a0f0c11/5f7e3c1a-2b4d-4c6e-8f10-1a2b3c4d5e6f/../0_0.webp') c),
    'L1:3,12|null|null');

  -- ======================= setup =======================
  perform pg_temp.login(d);
  v_scene := pg_temp.val($q$select public.create_scene('Vineyard', 1, '{"v": 1}')$q$)::uuid;
  select s.session_id, s.room_code into v_sid, v_code from public.create_session(v_scene) s;
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

  q_all := format($q$select coalesce(string_agg(name, ',' order by name), '') from storage.objects where bucket_id = 'session-tiles' and name like %L$q$, v_sid || '/%');

  -- ======================= writes (the DM uploads chunks for each player) =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('write: the DM uploads a chunk for p1',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_sid, p1))), 'ok');
  perform pg_temp.eq('write: and one for p2',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_sid, p2))), 'ok');
  perform pg_temp.eq('write: and one for k',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/1_1.webp', v_sid, k))), 'ok');
  perform pg_temp.check('write: malformed chunk paths are refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/64_0.webp', v_sid, p1))) like 'new row violates row-level security policy%'
    and pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.png', v_sid, p1))) like 'new row violates row-level security policy%'
    and pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/extra/0_0.webp', v_sid, p1))) like 'new row violates row-level security policy%');
  perform pg_temp.check('write: no chunks for someone who is not a member of the session',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_sid, x))) like 'new row violates row-level security policy%');
  perform pg_temp.check('write: the DM cannot write into another DM''s session',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/0_0.webp', v_osid, p1))) like 'new row violates row-level security policy%');
  perform pg_temp.eq('write: the DM replaces (upserts) a chunk',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"v":2}' where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, format('%s/%s/L1/0_0.webp', v_sid, p1))), '1');
  perform pg_temp.login(p1);
  perform pg_temp.check('write: a player cannot upload, not even into their own folder',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/2_2.webp', v_sid, p1))) like 'new row violates row-level security policy%');
  perform pg_temp.eq('write: a player cannot overwrite their chunk',
    pg_temp.val(format($q$with u as (update storage.objects set metadata = '{"v":3}' where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, format('%s/%s/L1/0_0.webp', v_sid, p1))), '0');
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('write: a player cannot delete their chunk',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name = %L returning 1) select count(*) from u$q$, format('%s/%s/L1/0_0.webp', v_sid, p1))), '0');
  perform set_config('storage.allow_delete_query', 'false', true);

  -- ======================= reads =======================
  perform pg_temp.login(d);
  perform pg_temp.eq('read: the DM reads every player''s chunks',
    pg_temp.val(q_all), (select string_agg(n, ',' order by n) from unnest(array[format('%s/%s/L1/0_0.webp', v_sid, p1), format('%s/%s/L1/0_0.webp', v_sid, p2), format('%s/%s/L1/1_1.webp', v_sid, k)]) n));
  perform pg_temp.login(p1);
  perform pg_temp.eq('read: a player reads only their own chunks', pg_temp.val(q_all), format('%s/%s/L1/0_0.webp', v_sid, p1));
  perform pg_temp.login(p2);
  perform pg_temp.eq('read: another player reads only theirs', pg_temp.val(q_all), format('%s/%s/L1/0_0.webp', v_sid, p2));
  perform pg_temp.login(x);
  perform pg_temp.eq('read: a non-member reads nothing', pg_temp.val(q_all), '');
  perform pg_temp.login(o);
  perform pg_temp.eq('read: another DM reads nothing', pg_temp.val(q_all), '');
  perform pg_temp.login_anon();
  perform pg_temp.eq('read: anon reads nothing', coalesce(nullif(pg_temp.val(q_all), ''), ''), '');
  perform pg_temp.login(d);
  perform public.set_member_status(v_sid, k, 'kicked');
  perform pg_temp.login(k);
  perform pg_temp.eq('read: a kicked member loses their chunks', pg_temp.val(q_all), '');

  -- ======================= session end =======================
  perform pg_temp.login(d);
  perform public.end_session(v_sid);
  perform pg_temp.check('end: the DM can no longer upload',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('session-tiles', %L)$q$, format('%s/%s/L1/3_3.webp', v_sid, p1))) like 'new row violates row-level security policy%');
  perform pg_temp.login(p1);
  perform pg_temp.eq('end: players lose access', pg_temp.val(q_all), '');
  perform pg_temp.login(d);
  perform set_config('storage.allow_delete_query', 'true', true);
  perform pg_temp.eq('end: the DM cleans up every chunk',
    pg_temp.val(format($q$with u as (delete from storage.objects where bucket_id = 'session-tiles' and name like %L returning 1) select count(*) from u$q$, v_sid || '/%')), '3');
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
