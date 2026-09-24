-- Atlas VTT: Token Maker tests (ARCHITECTURE §11; migration *_token_maker.sql): the public token-images
-- bucket (own folder only, well-formed names, per-owner quota, no updates) and the image tool allowance
-- (consume_image_tool_quota: service_role only, per guest / account / project per day).
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
  u uuid := gen_random_uuid();   -- a guest
  v uuid := gen_random_uuid();   -- another guest
  a uuid := gen_random_uuid();   -- a permanent account
  k integer;
begin
  insert into auth.users (id, aud, role, is_anonymous) values
    (u, 'authenticated', 'authenticated', true),
    (v, 'authenticated', 'authenticated', true),
    (a, 'authenticated', 'authenticated', false);

  -- ======================= bucket =======================
  perform pg_temp.eq('bucket: token-images is public, 4 MiB, PNG / WebP',
    (select format('%s|%s|%s', public, file_size_limit, array_to_string(allowed_mime_types, ',')) from storage.buckets where id = 'token-images'),
    't|4194304|image/png,image/webp');

  perform pg_temp.login(u);
  perform pg_temp.eq('insert: own folder, hashed name',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/0123456789abcdef0123456789abcdef.webp')), 'ok');
  perform pg_temp.eq('insert: PNG too',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/hero.png')), 'ok');
  perform pg_temp.check('insert: not into another user''s folder',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, v || '/hero.png')) like 'new row violates row-level security policy%');
  perform pg_temp.check('insert: no sub-folders',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/a/hero.png')) like 'new row violates row-level security policy%');
  perform pg_temp.check('insert: no other extensions',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/hero.svg')) like 'new row violates row-level security policy%');
  perform pg_temp.check('insert: no odd names',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/../hero.png')) like 'new row violates row-level security policy%');
  perform pg_temp.check('update: never (content-addressed names)',
    pg_temp.val(format($q$with x as (update storage.objects set name = %L where bucket_id = 'token-images' and name = %L returning 1) select count(*) from x$q$, u || '/other.png', u || '/hero.png')) = '0');
  perform pg_temp.eq('select: own objects are listed',
    pg_temp.val($q$select count(*) from storage.objects where bucket_id = 'token-images'$q$), '2');

  perform pg_temp.login(v);
  perform pg_temp.eq('select: other users'' objects are not listed',
    pg_temp.val($q$select count(*) from storage.objects where bucket_id = 'token-images'$q$), '0');
  perform pg_temp.eq('delete: not other users'' objects',
    pg_temp.val($q$with x as (delete from storage.objects where bucket_id = 'token-images' returning 1) select count(*) from x$q$), '0');

  perform pg_temp.login(u);
  perform pg_temp.eq('delete: own objects',
    pg_temp.val(format($q$with x as (delete from storage.objects where bucket_id = 'token-images' and name = %L returning 1) select count(*) from x$q$, u || '/hero.png')), '1');

  -- quota: 300 objects
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name, metadata)
  select 'token-images', format('%s/img%s.webp', u, g), jsonb_build_object('size', 1000)
  from generate_series(1, 298) g;
  perform pg_temp.login(u);
  perform pg_temp.eq('quota: the 300th image is fine',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/last.webp')), 'ok');
  perform pg_temp.check('quota: the 301st is refused',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, u || '/over.webp')) like 'new row violates row-level security policy%');
  -- quota: 200 MB
  perform pg_temp.logout();
  insert into storage.objects (bucket_id, name, metadata)
  values ('token-images', format('%s/huge.png', v), jsonb_build_object('size', 200::bigint * 1024 * 1024));
  perform pg_temp.login(v);
  perform pg_temp.check('quota: an owner over 200 MB cannot add images',
    pg_temp.try(format($q$insert into storage.objects (bucket_id, name) values ('token-images', %L)$q$, v || '/more.png')) like 'new row violates row-level security policy%');

  -- ======================= image tool allowance =======================
  perform pg_temp.login(u);
  perform pg_temp.check('allowance: clients cannot spend it',
    pg_temp.try(format('select public.consume_image_tool_quota(%L, true)', u)) like 'permission denied%');
  perform pg_temp.check('allowance: clients cannot read the usage table',
    pg_temp.try('select count(*) from private.image_tool_usage') like 'permission denied%');

  perform pg_temp.as_service();
  perform pg_temp.eq('allowance: a guest''s first call leaves 9',
    pg_temp.val(format('select public.consume_image_tool_quota(%L, true)', u)), '9');
  for k in 1..9 loop
    perform pg_temp.val(format('select public.consume_image_tool_quota(%L, true)', u));
  end loop;
  perform pg_temp.eq('allowance: a guest''s 11th call today is refused',
    pg_temp.try(format('select public.consume_image_tool_quota(%L, true)', u)), 'quota_exceeded');
  perform pg_temp.eq('allowance: an account gets 30',
    pg_temp.val(format('select public.consume_image_tool_quota(%L, false)', a)), '29');
  perform pg_temp.eq('allowance: no user is refused',
    pg_temp.try('select public.consume_image_tool_quota(null, false)'), 'invalid_argument');

  perform pg_temp.logout();
  insert into private.image_tool_usage (user_id, day, calls)
  values (gen_random_uuid(), (now() at time zone 'utc')::date - 30, 5);
  perform pg_temp.as_service();
  perform pg_temp.eq('allowance: calls keep counting per user',
    pg_temp.val(format('select public.consume_image_tool_quota(%L, false)', a)), '28');
  perform pg_temp.logout();
  perform pg_temp.eq('allowance: days older than a week are dropped',
    pg_temp.val($q$select count(*) from private.image_tool_usage where day < (now() at time zone 'utc')::date - 7$q$), '0');

  insert into private.image_tool_usage (user_id, day, calls)
  values (gen_random_uuid(), (now() at time zone 'utc')::date, 300);
  perform pg_temp.as_service();
  perform pg_temp.eq('allowance: the project''s daily cap refuses everyone',
    pg_temp.try(format('select public.consume_image_tool_quota(%L, false)', v)), 'quota_exceeded');
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
