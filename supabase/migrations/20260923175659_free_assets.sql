-- Atlas VTT: free assets (ARCHITECTURE §6.4, §4.3).
--
-- Files anyone may use in their games, grouped by category ('token-models' for now; maps, audio, …
-- later). The bytes live in the PUBLIC bucket `free-assets` (served from /storage/v1/object/public/…,
-- so player clients can load a token's model without any grant); the catalog is the table
-- public.free_assets, readable by every signed-in user (guests included). Neither has client write
-- policies: assets are published with a secret key (scripts/free-assets).
--
-- A DM chooses which categories a game loads when starting it: create_session(scene, free_assets)
-- stores them in the seed ({kind:'seed', …, freeAssets}), and the host keeps them in GameState.freeAssets.
--
-- Adding a category: extend private.free_asset_categories(), the free_assets.category check and
-- FREE_ASSET_CATEGORIES in src/core/session/freeAssets.ts.

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

create function private.free_asset_categories()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['token-models']
$$;

revoke execute on function private.free_asset_categories() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('free-assets', 'free-assets', true, 20971520, array['model/gltf-binary', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table public.free_assets (
  id text primary key constraint free_assets_id_check check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  category text not null constraint free_assets_category_check check (category in ('token-models')),
  name text not null constraint free_assets_name_check check (char_length(name) between 1 and 64),
  description text not null default '' constraint free_assets_description_check check (char_length(description) <= 500),
  -- Object paths in the free-assets bucket.
  path text not null constraint free_assets_path_check check (path ~ '^[a-z0-9-]+/[A-Za-z0-9._-]+$'),
  thumbnail_path text constraint free_assets_thumbnail_path_check check (thumbnail_path ~ '^[a-z0-9-]+/[A-Za-z0-9._-]+$'),
  bytes integer not null constraint free_assets_bytes_check check (bytes >= 0),
  -- Per category. token-models: {lods: [triangles…], height, radius (footprint sides), size?}.
  metadata jsonb not null default '{}'::jsonb,
  -- Creator / licence credit shown with the asset (null = none required).
  attribution text constraint free_assets_attribution_check check (char_length(attribution) <= 500),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index free_assets_category_idx on public.free_assets (category, sort_order, id);

alter table public.free_assets enable row level security;

create policy free_assets_select on public.free_assets
  for select to authenticated
  using (true);

grant select on public.free_assets to authenticated;

insert into public.free_assets (id, category, name, path, thumbnail_path, bytes, metadata, sort_order)
values
  ('elf-archer', 'token-models', 'Elf archer', 'token-models/elf-archer.glb', 'token-models/elf-archer.png', 154132,
    '{"lods": [23972, 5995, 1458], "height": 1.073, "radius": 0.801}', 0),
  ('halfling-thief', 'token-models', 'Halfling thief', 'token-models/halfling-thief.glb', 'token-models/halfling-thief.png', 148548,
    '{"lods": [23986, 5992, 1484], "height": 1.283, "radius": 0.733, "size": "small"}', 1),
  ('kenku-rogue', 'token-models', 'Kenku rogue', 'token-models/kenku-rogue.glb', 'token-models/kenku-rogue.png', 150404,
    '{"lods": [23998, 5988, 1470], "height": 1, "radius": 0.806}', 2),
  ('warforged-fighter', 'token-models', 'Warforged fighter', 'token-models/warforged-fighter.glb', 'token-models/warforged-fighter.png', 151368,
    '{"lods": [23986, 5988, 1496], "height": 1.532, "radius": 0.694}', 3)
on conflict (id) do update
  set category = excluded.category,
      name = excluded.name,
      path = excluded.path,
      thumbnail_path = excluded.thumbnail_path,
      bytes = excluded.bytes,
      metadata = excluded.metadata,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- create_session(scene, free_assets) → (session_id, room_code)
-- As before (owner check, 20 active / max_sessions_per_dm() sessions, room code, seed), plus the free
-- asset categories the game loads, validated, de-duplicated and sorted, in the seed's `freeAssets`.
-- ---------------------------------------------------------------------------

drop function public.create_session(uuid);

create function public.create_session(p_scene_id uuid, p_free_assets text[] default '{}')
returns table (session_id uuid, room_code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_version integer;
  v_schema_version integer;
  v_data jsonb;
  v_code text;
  v_sid uuid;
  v_free_assets text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if coalesce(cardinality(p_free_assets), 0) > 16
    or exists (select 1 from unnest(p_free_assets) c where c is null or not (c = any (private.free_asset_categories()))) then
    raise exception 'invalid_argument' using detail = 'unknown free asset category';
  end if;
  v_free_assets := array(select distinct c from unnest(coalesce(p_free_assets, '{}')) c order by c);

  select s.latest_version, v.schema_version, v.data
  into v_version, v_schema_version, v_data
  from public.scenes s
  join public.scene_versions v
    on v.scene_id = s.id
   and v.version = s.latest_version
  where s.id = p_scene_id
    and s.owner_id = v_uid;

  if not found then
    raise exception 'not_found' using detail = 'scene not found';
  end if;

  if (select count(*) from public.sessions s where s.dm_id = v_uid and s.status = 'active') >= 20 then
    raise exception 'too_many_sessions' using detail = 'end an existing session first (max 20 active)';
  end if;

  -- Room for the new one: ended sessions beyond the newest (max - 1) sessions (active ones count
  -- first) go, with their state, members and views (cascade). Their tile objects are removed by the
  -- client's cleanup, by path.
  delete from public.sessions s
  where s.dm_id = v_uid
    and s.status = 'ended'
    and s.id not in (
      select k.id
      from public.sessions k
      where k.dm_id = v_uid
      order by (k.status = 'active') desc, k.created_at desc, k.id
      limit private.max_sessions_per_dm() - 1
    );

  -- 40-bit codes collide rarely; retry on the partial unique index.
  for attempt in 1..16 loop
    v_code := private.generate_room_code();
    begin
      insert into public.sessions (dm_id, scene_id, room_code)
      values (v_uid, p_scene_id, v_code)
      returning id into v_sid;
      exit;
    exception when unique_violation then
      v_sid := null;
    end;
  end loop;

  if v_sid is null then
    raise exception 'room_code_unavailable' using detail = 'could not allocate a room code';
  end if;

  insert into public.session_state (session_id, epoch, state)
  values (
    v_sid,
    0,
    jsonb_build_object(
      'kind', 'seed',
      'sceneId', p_scene_id,
      'sceneVersion', v_version,
      'schemaVersion', v_schema_version,
      'scene', v_data,
      'freeAssets', to_jsonb(v_free_assets)
    )
  );

  return query select v_sid, v_code;
end
$$;

revoke execute on function public.create_session(uuid, text[]) from public, anon;
grant execute on function public.create_session(uuid, text[]) to authenticated;
