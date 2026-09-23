-- Atlas VTT: guest merge tests (ARCHITECTURE §6.4 Identity; migration *_guest_merge.sql).
--
-- Run as `postgres` (SQL editor, psql, or the MCP execute_sql tool). Everything runs in ONE transaction
-- that is ROLLED BACK. The last statement before ROLLBACK returns (passed, failed, failures); `failed`
-- must be 0. Same harness as quotas_test.sql. The Edge Function's Storage moves are simulated by
-- renaming storage.objects rows (fine inside a rolled-back test; the real function uses the Storage API).


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


create function pg_temp.as_service()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
end
$$;

grant execute on function pg_temp.as_service() to authenticated, anon;
grant select, insert on atlas_results to service_role;
grant usage on sequence atlas_results_n_seq to service_role;
grant execute on function pg_temp.check(text, boolean, text) to service_role;
grant execute on function pg_temp.eq(text, text, text) to service_role;
grant execute on function pg_temp.try(text) to service_role;
grant execute on function pg_temp.val(text) to service_role;
grant execute on function pg_temp.login(uuid) to service_role;
grant execute on function pg_temp.logout() to service_role;
grant execute on function pg_temp.as_service() to service_role;

do $$
declare
  g uuid := gen_random_uuid();   -- the guest that made things
  a uuid := gen_random_uuid();   -- the permanent account it signs in to
  o uuid := gen_random_uuid();   -- another guest
  f uuid := gen_random_uuid();   -- a permanent account with a full library
  v_ticket text;
  v_old text;
  v_scene uuid;
  v_sid uuid;
  v_code text;
  v_begin jsonb;
  v_done jsonb;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  values (g, 'authenticated', 'authenticated', true),
         (o, 'authenticated', 'authenticated', true),
         (a, 'authenticated', 'authenticated', false),
         (f, 'authenticated', 'authenticated', false);

  -- ======================= catalog =======================
  perform pg_temp.check('catalog: clients may create tickets but not merge',
    has_function_privilege('authenticated', 'public.create_merge_ticket()', 'execute')
    and not has_function_privilege('anon', 'public.create_merge_ticket()', 'execute')
    and not has_function_privilege('authenticated', 'public.begin_guest_merge(text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.finish_guest_merge(text, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.begin_guest_merge(text, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.finish_guest_merge(text, uuid)', 'execute'));
  perform pg_temp.check('catalog: tickets are not readable by clients',
    not has_table_privilege('authenticated', 'private.guest_merge_tickets', 'select'));

  -- ======================= the guest's things =======================
  perform pg_temp.login(g);
  perform public.set_display_name('Guesty');
  v_scene := public.create_scene('Guest scene', 1, '{"id": "docG"}');
  perform public.create_scene('Second guest scene', 1, '{"id": "docH"}');
  select c.session_id, c.room_code into v_sid, v_code from public.create_session(v_scene) c;
  -- The account had joined the guest's game as a player (e.g. testing in two browsers).
  perform pg_temp.login(a);
  perform public.join_session(v_code, 'Acct');
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name, metadata)
  values ('scene-assets', format('%s/docG/map1.webp', g), '{"size": 1000}'),
         ('scene-assets', format('%s/docH/map2.webp', g), '{"size": 2000}');

  -- ======================= tickets =======================
  perform pg_temp.login(a);
  perform pg_temp.eq('ticket: a permanent account cannot make one', pg_temp.try('select public.create_merge_ticket()'), 'forbidden');
  perform pg_temp.login_anon();
  perform pg_temp.check('ticket: anon cannot make one', pg_temp.try('select public.create_merge_ticket()') like 'permission denied%');
  perform pg_temp.login(g);
  v_old := public.create_merge_ticket();
  v_ticket := public.create_merge_ticket();
  perform pg_temp.check('ticket: 43 base64url characters', v_ticket ~ '^[A-Za-z0-9_-]{43}$', v_ticket);
  perform pg_temp.check('ticket: a new ticket replaces the old one', v_ticket <> v_old);
  perform pg_temp.logout();
  perform pg_temp.check('ticket: only its hash is stored',
    (select t.token_hash = extensions.digest(v_ticket, 'sha256') from private.guest_merge_tickets t where t.guest_id = g));

  -- ======================= begin =======================
  perform pg_temp.login(a);
  perform pg_temp.check('begin: clients cannot call it',
    pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_ticket, a)) like 'permission denied%');
  perform pg_temp.as_service();
  perform pg_temp.eq('begin: a replaced ticket is unknown', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_old, a)), 'not_found');
  perform pg_temp.eq('begin: malformed tickets are refused', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', 'short', a)), 'invalid_argument');
  perform pg_temp.eq('begin: not into itself', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_ticket, g)), 'invalid_argument');
  perform pg_temp.eq('begin: not into another guest', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_ticket, o)), 'forbidden');
  perform pg_temp.logout();
  perform pg_temp.login(f);
  for n in 1..49 loop
    perform public.create_scene('Full ' || n, 1, '{"v": 1}');
  end loop;
  perform pg_temp.as_service();
  perform pg_temp.eq('begin: 49 + 2 scenes do not fit in one account', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_ticket, f)), 'quota_exceeded');
  v_begin := public.begin_guest_merge(v_ticket, a);
  perform pg_temp.eq('begin: names the guest', v_begin ->> 'guest_id', g::text);
  perform pg_temp.eq('begin: lists the guest''s images', v_begin ->> 'objects', format('["%s/docG/map1.webp", "%s/docH/map2.webp"]', g, g));

  -- ======================= finish =======================
  perform pg_temp.eq('finish: refused while images are still in the guest folder',
    pg_temp.try(format('select public.finish_guest_merge(%L, %L)', v_ticket, a)), 'invalid_argument');
  perform pg_temp.logout();
  update storage.objects set name = a::text || substr(name, 37) where bucket_id = 'scene-assets' and name like g::text || '/%';
  perform pg_temp.as_service();
  v_done := public.finish_guest_merge(v_ticket, a);
  perform pg_temp.eq('finish: reports what moved', format('%s/%s', v_done ->> 'scenes', v_done ->> 'sessions'), '2/1');
  perform pg_temp.logout();
  perform pg_temp.eq('finish: the scenes belong to the account', (select count(*)::text from public.scenes where owner_id = a), '2');
  perform pg_temp.eq('finish: the guest owns nothing', (select count(*)::text from public.scenes where owner_id = g), '0');
  perform pg_temp.eq('finish: the account is DM of the guest''s game', (select dm_id::text from public.sessions where id = v_sid), a::text);
  perform pg_temp.check('finish: the account is no longer a player of its own game',
    not exists (select 1 from public.session_members where session_id = v_sid and user_id = a));
  perform pg_temp.eq('finish: an account without a name adopts the guest''s', (select display_name from public.profiles where id = a), 'Guesty');
  perform pg_temp.check('finish: the ticket is consumed', not exists (select 1 from private.guest_merge_tickets where guest_id = g));
  perform pg_temp.as_service();
  perform pg_temp.eq('finish: a used ticket cannot be replayed', pg_temp.try(format('select public.finish_guest_merge(%L, %L)', v_ticket, a)), 'not_found');
  perform pg_temp.logout();

  -- The account can use what it took over.
  perform pg_temp.login(a);
  perform pg_temp.eq('after: the account sees its merged scenes', (select count(*)::text from public.scenes), '2');
  perform pg_temp.check('after: and hosts the game', public.claim_host(v_sid) > 0);
  perform pg_temp.logout();

  -- ======================= expiry, name kept =======================
  perform pg_temp.login(o);
  perform public.set_display_name('Other guest');
  v_ticket := public.create_merge_ticket();
  perform pg_temp.logout();
  update private.guest_merge_tickets set expires_at = now() - interval '1 second' where guest_id = o;
  perform pg_temp.as_service();
  perform pg_temp.eq('expiry: an expired ticket is unknown', pg_temp.try(format('select public.begin_guest_merge(%L, %L)', v_ticket, a)), 'not_found');
  perform pg_temp.logout();
  update private.guest_merge_tickets set expires_at = now() + interval '1 hour' where guest_id = o;
  perform pg_temp.as_service();
  perform public.finish_guest_merge(v_ticket, a);
  perform pg_temp.logout();
  perform pg_temp.eq('name: an account keeps its own display name', (select display_name from public.profiles where id = a), 'Guesty');

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
