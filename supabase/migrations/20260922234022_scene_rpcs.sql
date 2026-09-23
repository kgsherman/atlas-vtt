-- Atlas VTT: scene library RPCs (ARCHITECTURE §3, §6.4).
-- security definer, empty search_path, execute for `authenticated` only. They return ids,
-- version numbers or slugs — never whole rows — except get_shared_scene(), whose purpose is to
-- publish the linked document.
--
-- Errors are raised with a stable machine-readable MESSAGE (e.g. 'not_found') that the client maps
-- to typed errors; human detail goes in DETAIL.

-- Largest accepted scene document (jsonb datum size).
create function private.max_scene_bytes()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 25 * 1024 * 1024
$$;

-- Versions kept per scene; older ones are pruned by save_scene_version().
create function private.max_scene_versions()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 50
$$;

create function private.check_scene_payload(p_schema_version integer, p_data jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_schema_version is null or p_schema_version < 1 then
    raise exception 'invalid_argument' using detail = 'schema_version must be >= 1';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'invalid_argument' using detail = 'scene data must be a JSON object';
  end if;
  if pg_column_size(p_data) > private.max_scene_bytes() then
    raise exception 'payload_too_large' using detail = format('scene data exceeds %s bytes', private.max_scene_bytes());
  end if;
end
$$;

revoke execute on function private.max_scene_bytes() from public, anon, authenticated;
revoke execute on function private.max_scene_versions() from public, anon, authenticated;
revoke execute on function private.check_scene_payload(integer, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_scene(name, schema_version, data) → scene id (with version 1)
-- ---------------------------------------------------------------------------

create function public.create_scene(p_name text, p_schema_version integer, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform private.check_scene_payload(p_schema_version, p_data);

  insert into public.scenes (owner_id, name, latest_version)
  values (v_uid, private.normalize_scene_name(p_name), 1)
  returning id into v_id;

  insert into public.scene_versions (scene_id, version, schema_version, data)
  values (v_id, 1, p_schema_version, p_data);

  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- save_scene_version(scene, schema_version, data, base_version?, name?) → new version number
-- Versions are immutable; latest_version is bumped atomically under a row lock.
-- p_base_version (optional) makes the save conditional: 'version_conflict' if someone saved since.
-- ---------------------------------------------------------------------------

create function public.save_scene_version(
  p_scene_id uuid,
  p_schema_version integer,
  p_data jsonb,
  p_base_version integer default null,
  p_name text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_latest integer;
  v_next integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform private.check_scene_payload(p_schema_version, p_data);

  select s.owner_id, s.latest_version
  into v_owner, v_latest
  from public.scenes s
  where s.id = p_scene_id
  for update;

  if not found or v_owner is distinct from v_uid then
    raise exception 'not_found' using detail = 'scene not found';
  end if;
  if p_base_version is not null and p_base_version <> v_latest then
    raise exception 'version_conflict' using detail = format('latest version is %s', v_latest);
  end if;

  v_next := v_latest + 1;

  insert into public.scene_versions (scene_id, version, schema_version, data)
  values (p_scene_id, v_next, p_schema_version, p_data);

  update public.scenes s
  set latest_version = v_next,
      name = case when p_name is null then s.name else private.normalize_scene_name(p_name) end
  where s.id = p_scene_id;

  delete from public.scene_versions v
  where v.scene_id = p_scene_id
    and v.version <= v_next - private.max_scene_versions();

  return v_next;
end
$$;

-- ---------------------------------------------------------------------------
-- set_scene_visibility(scene, 'private'|'link', rotate?) → share slug (NULL when private)
-- Slugs are generated here only. Going private drops the slug, so re-sharing yields a new link;
-- p_rotate = true replaces an existing link.
-- ---------------------------------------------------------------------------

create function public.set_scene_visibility(p_scene_id uuid, p_visibility text, p_rotate boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_visibility is null or p_visibility not in ('private', 'link') then
    raise exception 'invalid_argument' using detail = 'visibility must be private or link';
  end if;

  select s.owner_id, s.share_slug
  into v_owner, v_slug
  from public.scenes s
  where s.id = p_scene_id
  for update;

  if not found or v_owner is distinct from v_uid then
    raise exception 'not_found' using detail = 'scene not found';
  end if;

  if p_visibility = 'private' then
    v_slug := null;
  elsif v_slug is null or coalesce(p_rotate, false) then
    v_slug := private.generate_share_slug();
  end if;

  update public.scenes s
  set visibility = p_visibility,
      share_slug = v_slug
  where s.id = p_scene_id;

  return v_slug;
end
$$;

-- ---------------------------------------------------------------------------
-- get_shared_scene(slug) → the latest version of a link-shared scene (the FULL DM document).
-- ---------------------------------------------------------------------------

create function public.get_shared_scene(p_slug text)
returns table (name text, version integer, schema_version integer, data jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select s.name, v.version, v.schema_version, v.data
  from public.scenes s
  join public.scene_versions v
    on v.scene_id = s.id
   and v.version = s.latest_version
  where (select auth.uid()) is not null
    and p_slug ~ '^[A-Za-z0-9_-]{24}$'
    and s.share_slug = p_slug
    and s.visibility = 'link'
$$;

revoke execute on function public.create_scene(text, integer, jsonb) from public, anon;
revoke execute on function public.save_scene_version(uuid, integer, jsonb, integer, text) from public, anon;
revoke execute on function public.set_scene_visibility(uuid, text, boolean) from public, anon;
revoke execute on function public.get_shared_scene(text) from public, anon;

grant execute on function public.create_scene(text, integer, jsonb) to authenticated;
grant execute on function public.save_scene_version(uuid, integer, jsonb, integer, text) to authenticated;
grant execute on function public.set_scene_visibility(uuid, text, boolean) to authenticated;
grant execute on function public.get_shared_scene(text) to authenticated;
