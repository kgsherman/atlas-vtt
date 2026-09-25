-- Atlas VTT: worlds (ARCHITECTURE §6.9; migration *_worlds.sql): create_world / delete_world, scenes in worlds
-- (create_scene's world, move_scene), players joining worlds (join_world, world_info, list_joined_worlds,
-- join_session for older clients, seats: 64 players, removed ones don't count, 512 roster rows), the roster
-- seated at every live table (session_members), kicks from the world, one open table per world, map changes
-- within a world, characters and who plays them (RLS, set_character_players, quotas), and session_info's world.
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
  o uuid := gen_random_uuid();   -- another DM
  p uuid := gen_random_uuid();   -- a player
  q uuid := gen_random_uuid();   -- another player
  n uuid := gen_random_uuid();   -- a newcomer (no worlds yet)
  v_w1 uuid;
  v_w2 uuid;
  v_wo uuid;
  v_code1 text;
  v_code2 text;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_x uuid;
  v_y uuid;
  v_ta uuid;
  v_tb uuid;
  v_tc uuid;
  v_char uuid;
  v_char2 uuid;
  v_ids uuid[];
  v_epoch bigint;
  v_r record;
begin
  insert into auth.users (id, aud, role, is_anonymous)
  select u, 'authenticated', 'authenticated', true
  from unnest(array[d, o, p, q, n]) as u;
  insert into public.profiles (id, display_name) values (d, 'Morgan');

  -- ---- worlds -----------------------------------------------------------------------------------------
  perform pg_temp.login(d);
  v_w1 := pg_temp.val($q$select public.create_world('  Tyranny   of Dragons ')$q$)::uuid;
  v_w2 := pg_temp.val($q$select public.create_world('Storm King''s Thunder')$q$)::uuid;
  perform pg_temp.eq('create_world: the name is normalised', (select name from public.worlds where id = v_w1), 'Tyranny of Dragons');
  v_x := public.create_world('   ');
  perform pg_temp.eq('create_world: a blank name', (select name from public.worlds where id = v_x), 'Untitled world');
  v_code1 := (select room_code from public.worlds where id = v_w1);
  v_code2 := (select room_code from public.worlds where id = v_w2);
  perform pg_temp.check('create_world: a room code', v_code1 ~ '^[0-9A-HJKMNP-TV-Z]{8}$' and v_code1 <> v_code2);
  perform pg_temp.eq('worlds: the owner sees their worlds', (select count(*)::text from public.worlds), '3');
  perform pg_temp.eq('worlds: the owner renames', pg_temp.try(format($q$update public.worlds set name = 'ToD' where id = %L$q$, v_w1)), 'ok');
  perform pg_temp.check('worlds: no direct insert', pg_temp.try(format($q$insert into public.worlds (owner_id, name, room_code) values (%L, 'W', 'ABCD1234')$q$, d)) like 'permission denied%');
  perform pg_temp.check('worlds: the room code cannot be changed', pg_temp.try(format($q$update public.worlds set room_code = 'ABCD1234' where id = %L$q$, v_w1)) like 'permission denied%');
  perform pg_temp.eq('worlds: no direct delete', pg_temp.try(format($q$delete from public.worlds where id = %L$q$, v_w1)), 'permission denied for table worlds');
  for i in 4..20 loop
    perform public.create_world('W' || i);
  end loop;
  perform pg_temp.eq('create_world: at most 20 per account', pg_temp.try($q$select public.create_world('One too many')$q$), 'quota_exceeded');

  perform pg_temp.login(o);
  v_wo := public.create_world('Other');
  v_x := pg_temp.val(format($q$select public.create_scene('X', 1, '{"id": "docX"}', %L)$q$, v_wo))::uuid;
  perform pg_temp.eq('worlds: another owner sees only theirs', (select count(*)::text from public.worlds), '1');

  -- ---- scenes in worlds -------------------------------------------------------------------------------
  -- Worlds made in one transaction share created_at: make w1 the DM's first world.
  perform pg_temp.logout();
  update public.worlds set created_at = created_at - interval '1 minute' where id = v_w1;
  perform pg_temp.login(d);
  v_a := pg_temp.val(format($q$select public.create_scene('A', 1, '{"id": "docA"}', %L)$q$, v_w1))::uuid;
  v_b := pg_temp.val(format($q$select public.create_scene('B', 1, '{"id": "docB"}', %L)$q$, v_w1))::uuid;
  v_c := pg_temp.val($q$select public.create_scene('C', 1, '{"id": "docC"}')$q$)::uuid;
  perform pg_temp.eq('create_scene: in the world named', (select world_id::text from public.scenes where id = v_a), v_w1::text);
  perform pg_temp.eq('create_scene: no world named → the first world', (select world_id::text from public.scenes where id = v_c), v_w1::text);
  perform pg_temp.eq('create_scene: not into someone else''s world', pg_temp.try(format($q$select public.create_scene('Y', 1, '{"id": "docY"}', %L)$q$, v_wo)), 'not_found');
  perform pg_temp.login(n);
  v_y := public.create_scene('First', 1, '{"id": "docF"}');
  perform pg_temp.eq('create_scene: a newcomer gets "My world"',
    (select w.name from public.scenes s join public.worlds w on w.id = s.world_id where s.id = v_y), 'My world');
  perform pg_temp.login(d);
  perform pg_temp.eq('move_scene: moves', pg_temp.val(format('select public.move_scene(%L, %L)', v_c, v_w2)), 'true');
  perform pg_temp.eq('move_scene: now in the other world', (select world_id::text from public.scenes where id = v_c), v_w2::text);
  perform pg_temp.eq('move_scene: already there', pg_temp.val(format('select public.move_scene(%L, %L)', v_c, v_w2)), 'false');
  perform pg_temp.eq('move_scene: not into someone else''s world', pg_temp.try(format('select public.move_scene(%L, %L)', v_c, v_wo)), 'not_found');
  perform pg_temp.eq('move_scene: not someone else''s scene', pg_temp.try(format('select public.move_scene(%L, %L)', v_x, v_w1)), 'not_found');
  perform pg_temp.check('scenes: the world cannot be changed directly', pg_temp.try(format('update public.scenes set world_id = %L where id = %L', v_w1, v_c)) like 'permission denied%');

  -- ---- players join worlds ------------------------------------------------------------------------------
  select t.session_id into v_ta from public.open_map(v_a) t;
  perform pg_temp.eq('open_map: the table answers to the world''s code', (select room_code from public.sessions where id = v_ta), v_code1);
  perform pg_temp.eq('open_map: the table is the world''s', (select world_id::text from public.sessions where id = v_ta), v_w1::text);

  perform pg_temp.login(p);
  select * into v_r from public.join_world(v_code1, 'Pat');
  perform pg_temp.eq('join_world: joins with every table closed', v_r.world_id::text || ':' || coalesce(v_r.session_id::text, 'null'), v_w1::text || ':null');
  perform pg_temp.eq('join_world: a member of the world', (select display_name || ':' || status from public.world_members where world_id = v_w1 and user_id = p), 'Pat:active');
  perform pg_temp.eq('join_world: seated at the world''s live tables', pg_temp.val(format('select status from public.session_members where session_id = %L and user_id = %L', v_ta, p)), 'active');
  perform pg_temp.eq('join_world: not active while the doors are closed', pg_temp.val(format('select private.is_active_member(%L)', v_ta)), 'false');
  perform pg_temp.eq('join_session (older clients): table_closed', pg_temp.try(format('select public.join_session(%L, %L)', v_code1, 'Pat')), 'table_closed');
  perform pg_temp.eq('join_world: rejoining renames', pg_temp.val(format('select world_id from public.join_world(%L, %L)', v_code1, 'Patricia')), v_w1::text);
  perform pg_temp.eq('join_world: the new name reaches the tables', (select display_name from public.session_members where session_id = v_ta and user_id = p), 'Patricia');
  perform pg_temp.eq('join_world: an unknown code', pg_temp.try(format('select * from public.join_world(%L, %L)', 'ZZZZ9999', 'Pat')), 'session_not_found');
  perform pg_temp.eq('join_world: a malformed code', pg_temp.try(format('select * from public.join_world(%L, %L)', 'nope', 'Pat')), 'invalid_room_code');
  perform pg_temp.login(q);
  perform pg_temp.eq('join_world: another member''s name', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code1, 'PATRICIA')), 'name_taken');
  perform pg_temp.eq('join_world: the DM''s name', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code1, 'morgan')), 'name_taken');
  perform pg_temp.eq('join_world: posing as the DM', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code1, 'Dungeon Master')), 'name_taken');
  perform public.join_world(v_code1, 'Quin');
  perform pg_temp.login(d);
  perform pg_temp.eq('join_world: the DM cannot join their own world', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code1, 'Me')), 'is_dm');

  -- ---- what players and the DM read ---------------------------------------------------------------------
  perform pg_temp.login(p);
  perform pg_temp.eq('players: no direct read of worlds', (select count(*)::text from public.worlds), '0');
  perform pg_temp.eq('players: only their own membership rows', (select string_agg(display_name, ',') from public.world_members), 'Patricia');
  select * into v_r from public.world_info(v_w1);
  perform pg_temp.eq('world_info: as a player', format('%s|%s|%s|%s|%s|%s', v_r.name, (v_r.room_code = v_code1)::text, v_r.role, v_r.member_status, v_r.dm_display_name, coalesce(v_r.open_session_id::text, 'null')),
    'ToD|true|player|active|Morgan|null');
  perform pg_temp.eq('world_info: not a stranger''s', (select count(*)::text from public.world_info(v_w2)), '0');
  perform pg_temp.eq('list_joined_worlds', (select string_agg(name || ':' || member_status, ',') from public.list_joined_worlds()), 'ToD:active');
  perform pg_temp.login(d);
  perform pg_temp.eq('world_info: as the DM', (select role || ':' || coalesce(member_status, 'null') from public.world_info(v_w1)), 'dm:null');
  perform pg_temp.eq('world_members: the DM reads the roster', (select string_agg(display_name, ',' order by display_name) from public.world_members where world_id = v_w1), 'Patricia,Quin');
  perform pg_temp.eq('list_session_members: the roster at the table', (select string_agg(display_name, ',' order by display_name) from public.list_session_members(v_ta)), 'Patricia,Quin');
  perform pg_temp.login(o);
  perform pg_temp.eq('world_members: another DM reads nothing', (select count(*)::text from public.world_members), '0');

  -- ---- tables in a world ----------------------------------------------------------------------------------
  perform pg_temp.login(d);
  perform pg_temp.eq('open: set_table_open', pg_temp.val(format('select public.set_table_open(%L, true)', v_ta)), 'active');
  select t.session_id into v_tb from public.open_map(v_b) t;
  perform pg_temp.eq('open_map: a new table seats the world''s players', (select string_agg(display_name, ',' order by display_name) from public.session_members where session_id = v_tb), 'Patricia,Quin');
  perform pg_temp.eq('one open table per world', pg_temp.try(format('select public.set_table_open(%L, true)', v_tb)), 'world_table_open');
  select t.session_id into v_tc from public.open_map(v_c) t;
  perform pg_temp.eq('another world''s table may open', pg_temp.val(format('select public.set_table_open(%L, true)', v_tc)), 'active');
  perform pg_temp.eq('world_info: the open table', (select open_session_id::text from public.world_info(v_w1)), v_ta::text);
  perform pg_temp.login(p);
  perform pg_temp.eq('open: an active member', pg_temp.val(format('select private.is_active_member(%L)', v_ta)), 'true');
  perform pg_temp.eq('open: not at the other world''s table', pg_temp.val(format('select private.is_active_member(%L)', v_tc)), 'false');
  perform pg_temp.eq('join_world: the open table', pg_temp.val(format('select session_id from public.join_world(%L, %L)', v_code1, 'Patricia')), v_ta::text);
  perform pg_temp.eq('join_session (older clients): the open table', pg_temp.val(format('select public.join_session(%L, %L)', v_code1, 'Patricia')), v_ta::text);
  perform pg_temp.eq('session_info: the world', (select world_id::text || ':' || world_name from public.session_info(v_ta)), v_w1::text || ':ToD');
  perform pg_temp.eq('world_info: the open table for players', (select open_session_id::text from public.world_info(v_w1)), v_ta::text);

  perform pg_temp.login(d);
  perform pg_temp.eq('move_scene: refused while its table is open', pg_temp.try(format('select public.move_scene(%L, %L)', v_a, v_w2)), 'table_open');
  v_epoch := pg_temp.val(format('select public.claim_host(%L)', v_ta))::bigint;
  perform pg_temp.eq('map change: not to another world''s scene', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_ta, v_epoch, v_c)), 'other_world');
  perform pg_temp.eq('map change: to a scene of the world', pg_temp.val(format('select public.set_session_scene(%L, %s, %L)', v_ta, v_epoch, v_b)), 'true');
  perform pg_temp.eq('map change: that scene''s idle table ends', (select status from public.sessions where id = v_tb), 'ended');
  perform pg_temp.eq('close', pg_temp.val(format('select public.set_table_open(%L, false)', v_ta)), 'closed');
  select t.session_id into v_tb from public.open_map(v_a) t;
  perform pg_temp.eq('another table of the world opens once the first closed', pg_temp.val(format('select public.set_table_open(%L, true)', v_tb)), 'active');
  perform pg_temp.eq('map change: refused where the doors are open', pg_temp.try(format('select public.set_session_scene(%L, %s, %L)', v_ta, v_epoch, v_a)), 'map_in_use');
  perform public.set_table_open(v_tb, false);

  -- ---- kicks reach every table of the world ----------------------------------------------------------------
  perform pg_temp.eq('set_member_status at a table kicks from the world', pg_temp.val(format('select public.set_member_status(%L, %L, %L)', v_ta, q, 'kicked')), 'true');
  perform pg_temp.eq('kick: the world membership', (select status from public.world_members where world_id = v_w1 and user_id = q), 'kicked');
  perform pg_temp.eq('kick: every live table', (select string_agg(distinct m.status, ',') from public.session_members m join public.sessions s on s.id = m.session_id where s.world_id = v_w1 and s.status <> 'ended' and m.user_id = q), 'kicked');
  perform pg_temp.login(q);
  perform pg_temp.eq('kick: cannot rejoin', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code1, 'Quin')), 'kicked');
  perform pg_temp.eq('kick: world_info hides the open table', (select member_status || ':' || coalesce(open_session_id::text, 'null') from public.world_info(v_w1)), 'kicked:null');
  perform pg_temp.login(d);
  perform pg_temp.eq('set_world_member_status: lets them back', pg_temp.val(format('select public.set_world_member_status(%L, %L, %L)', v_w1, q, 'active')), 'true');
  perform pg_temp.eq('let back: every live table', (select string_agg(distinct m.status, ',') from public.session_members m join public.sessions s on s.id = m.session_id where s.world_id = v_w1 and s.status <> 'ended' and m.user_id = q), 'active');
  perform pg_temp.login(o);
  perform pg_temp.eq('set_world_member_status: the DM only', pg_temp.try(format('select public.set_world_member_status(%L, %L, %L)', v_w1, q, 'kicked')), 'forbidden');

  -- ---- a scene moving with its closed table -------------------------------------------------------------------
  perform pg_temp.login(d);
  perform public.set_table_open(v_tc, false);
  perform pg_temp.eq('move_scene: with its closed table', pg_temp.val(format('select public.move_scene(%L, %L)', v_c, v_w1)), 'true');
  perform pg_temp.eq('move_scene: the table follows (world and code)', (select (world_id = v_w1)::text || ':' || (room_code = v_code1)::text from public.sessions where id = v_tc), 'true:true');
  perform pg_temp.eq('move_scene: the new world''s players are seated', (select string_agg(display_name, ',' order by display_name) from public.session_members where session_id = v_tc), 'Patricia,Quin');

  -- ---- characters ---------------------------------------------------------------------------------------------
  v_char := pg_temp.val(format($q$insert into public.characters (world_id, name, color) values (%L, 'Aria', '#AA3355') returning id$q$, v_w1))::uuid;
  v_char2 := pg_temp.val(format($q$insert into public.characters (world_id, name) values (%L, 'Borin') returning id$q$, v_w1))::uuid;
  perform pg_temp.eq('characters: the DM adds them', (select string_agg(name, ',' order by name) from public.characters where world_id = v_w1), 'Aria,Borin');
  perform pg_temp.eq('characters: renamed', pg_temp.try(format($q$update public.characters set name = 'Aria Vey', image_url = 'https://example.com/a.png' where id = %L$q$, v_char)), 'ok');
  perform pg_temp.check('characters: a bad colour', pg_temp.try(format($q$update public.characters set color = 'red' where id = %L$q$, v_char)) like '%characters_color_check%');
  perform pg_temp.check('characters: a javascript: portrait', pg_temp.try(format($q$update public.characters set image_url = 'javascript:alert(1)' where id = %L$q$, v_char)) like '%characters_image_url_check%');
  perform pg_temp.check('characters: a blank name', pg_temp.try(format($q$update public.characters set name = '' where id = %L$q$, v_char)) like '%characters_name_check%');
  perform pg_temp.check('characters: never moved to another world', pg_temp.try(format('update public.characters set world_id = %L where id = %L', v_w2, v_char)) like 'permission denied%');
  perform pg_temp.eq('character_players: a player of the world', pg_temp.try(format('insert into public.character_players (character_id, world_id, user_id) values (%L, %L, %L)', v_char, v_w1, p)), 'ok');
  perform pg_temp.check('character_players: not a player of the world', pg_temp.try(format('insert into public.character_players (character_id, world_id, user_id) values (%L, %L, %L)', v_char2, v_w1, n)) like '%foreign key%');
  perform pg_temp.check('character_players: the character''s world only', pg_temp.try(format('insert into public.character_players (character_id, world_id, user_id) values (%L, %L, %L)', v_char2, v_w2, p)) like '%foreign key%');
  perform pg_temp.eq('set_character_players: sets the list in one step', pg_temp.val(format('select public.set_character_players(%L, array[%L, %L, %L]::uuid[])', v_char2, p, q, p)), 'true');
  perform pg_temp.eq('set_character_players: players of the character', (select string_agg(user_id::text, ',' order by user_id) from public.character_players where character_id = v_char2), (select string_agg(u::text, ',' order by u) from unnest(array[p, q]) u));
  perform pg_temp.eq('set_character_players: replaces the list', pg_temp.val(format('select public.set_character_players(%L, array[%L]::uuid[])', v_char2, q)), 'true');
  perform pg_temp.eq('set_character_players: the new list', (select string_agg(user_id::text, ',') from public.character_players where character_id = v_char2), q::text);
  perform pg_temp.eq('set_character_players: players of the world only', pg_temp.try(format('select public.set_character_players(%L, array[%L]::uuid[])', v_char2, n)), 'invalid_argument');
  perform pg_temp.eq('set_character_players: at most 8', pg_temp.try(format('select public.set_character_players(%L, array(select gen_random_uuid() from generate_series(1, 9)))', v_char2)), 'quota_exceeded');
  perform pg_temp.eq('set_character_players: an empty list', pg_temp.val(format('select public.set_character_players(%L, %L::uuid[])', v_char2, '{}')), 'true');
  perform pg_temp.eq('set_character_players: nobody plays it', (select count(*)::text from public.character_players where character_id = v_char2), '0');
  -- A full list set twice (six more players join the world directly): the players already there are kept, not re-added.
  perform pg_temp.logout();
  with u as (select gen_random_uuid() as id from generate_series(1, 6))
  , users as (insert into auth.users (id, aud, role, is_anonymous) select id, 'authenticated', 'authenticated', true from u returning id)
  insert into public.world_members (world_id, user_id, display_name) select v_w1, users.id, 'Extra ' || row_number() over () from users;
  perform pg_temp.login(d);
  v_ids := array(select user_id from public.world_members where world_id = v_w1 and status = 'active');
  perform pg_temp.eq('set_character_players: 8 players', pg_temp.val(format('select public.set_character_players(%L, %L::uuid[])', v_char2, v_ids)), 'true');
  perform pg_temp.eq('set_character_players: the same 8 again', pg_temp.val(format('select public.set_character_players(%L, %L::uuid[])', v_char2, v_ids)), 'true');
  perform pg_temp.eq('set_character_players: still 8', (select count(*)::text from public.character_players where character_id = v_char2), '8');
  perform public.set_character_players(v_char2, '{}');
  perform pg_temp.login(o);
  perform pg_temp.eq('set_character_players: the DM only', pg_temp.try(format('select public.set_character_players(%L, array[%L]::uuid[])', v_char2, p)), 'not_found');
  perform pg_temp.login(p);
  perform pg_temp.eq('characters: players read none directly', (select count(*)::text from public.characters), '0');
  perform pg_temp.eq('characters: players assign none', pg_temp.try(format('insert into public.character_players (character_id, world_id, user_id) values (%L, %L, %L)', v_char2, v_w1, p)), 'new row violates row-level security policy for table "character_players"');
  perform pg_temp.eq('world_info: the characters I play', (select array_to_string(characters, ',') from public.world_info(v_w1)), 'Aria Vey');
  perform pg_temp.login(o);
  perform pg_temp.eq('characters: not into someone else''s world', pg_temp.try(format($q$insert into public.characters (world_id, name) values (%L, 'Spy')$q$, v_w1)), 'new row violates row-level security policy for table "characters"');
  perform pg_temp.eq('characters: another DM reads none', (select count(*)::text from public.characters), '0');
  perform pg_temp.login(d);
  for i in 3..100 loop
    insert into public.characters (world_id, name) values (v_w1, 'C' || i);
  end loop;
  perform pg_temp.eq('characters: at most 100 per world', pg_temp.try(format($q$insert into public.characters (world_id, name) values (%L, 'One too many')$q$, v_w1)), 'quota_exceeded');
  perform pg_temp.logout();
  perform pg_temp.eq('a player leaving the world', pg_temp.try(format('delete from public.world_members where world_id = %L and user_id = %L', v_w1, p)), 'ok');
  perform pg_temp.eq('a player leaving the world leaves their characters and tables', (select count(*) from public.character_players where user_id = p) || ':' || (select count(*) from public.session_members m join public.sessions s on s.id = m.session_id where s.world_id = v_w1 and m.user_id = p), '0:0');

  -- ---- seats: 64 players, removed ones don't count --------------------------------------------------------
  perform pg_temp.logout();
  with u as (select gen_random_uuid() as id from generate_series(1, 64))
  , users as (insert into auth.users (id, aud, role, is_anonymous) select id, 'authenticated', 'authenticated', true from u returning id)
  insert into public.world_members (world_id, user_id, display_name) select v_w2, users.id, 'P' || row_number() over () from users;
  perform pg_temp.login(n);
  perform pg_temp.eq('join_world: at most 64 players', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code2, 'Newt')), 'session_full');
  perform pg_temp.logout();
  update public.world_members set status = 'kicked' where world_id = v_w2 and user_id = (select user_id from public.world_members where world_id = v_w2 and display_name = 'P1');
  perform pg_temp.login(n);
  perform pg_temp.eq('join_world: a removed player frees a seat', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code2, 'Newt')), 'ok');
  -- The roster, removed players included, is bounded: 512 rows (447 more removed players; one more seat freed).
  perform pg_temp.logout();
  with u as (select gen_random_uuid() as id from generate_series(1, 447))
  , users as (insert into auth.users (id, aud, role, is_anonymous) select id, 'authenticated', 'authenticated', true from u returning id)
  insert into public.world_members (world_id, user_id, display_name, status) select v_w2, users.id, 'R' || row_number() over (), 'kicked' from users;
  update public.world_members set status = 'kicked' where world_id = v_w2 and display_name = 'P2';
  perform pg_temp.login(q);
  perform pg_temp.eq('join_world: at most 512 roster rows', pg_temp.try(format('select * from public.join_world(%L, %L)', v_code2, 'Quin')), 'session_full');

  -- ---- deleting worlds ----------------------------------------------------------------------------------------
  perform pg_temp.login(d);
  perform pg_temp.eq('delete_world: not while it has scenes', pg_temp.try(format('select public.delete_world(%L)', v_w1)), 'world_not_empty');
  perform pg_temp.eq('delete_world: someone else''s', pg_temp.try(format('select public.delete_world(%L)', v_wo)), 'not_found');
  delete from public.scenes where world_id = v_w1;
  perform pg_temp.eq('delete_world: an empty world', pg_temp.val(format('select public.delete_world(%L)', v_w1)), 'true');
  perform pg_temp.logout();
  perform pg_temp.eq('delete_world: its characters, players and tables go', format('%s/%s/%s',
    (select count(*) from public.characters where world_id = v_w1), (select count(*) from public.world_members where world_id = v_w1), (select count(*) from public.sessions where world_id = v_w1)), '0/0/0');
  perform pg_temp.eq('deleting an account deletes its worlds and scenes', pg_temp.try(format('delete from auth.users where id in (%L, %L)', o, n)), 'ok');
  perform pg_temp.eq('deleted accounts: nothing left', format('%s/%s', (select count(*) from public.worlds where owner_id in (o, n)), (select count(*) from public.scenes where owner_id in (o, n))), '0/0');

  perform pg_temp.login_anon();
  perform pg_temp.check('anon cannot call create_world', pg_temp.try($q$select public.create_world('x')$q$) like 'permission denied for function%');
  perform pg_temp.check('anon cannot call join_world', pg_temp.try($q$select * from public.join_world('ABCD1234', 'x')$q$) like 'permission denied for function%');
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
