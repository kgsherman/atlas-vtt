-- Atlas VTT: finding map images nothing uses any more (ARCHITECTURE §9).
--
-- Images live in `scene-assets/{ownerId}/{docId}/{assetId}.{ext}`, where docId is the scene document's
-- own id (Scene.id; very old images may sit under the library row id). SQL cannot delete Storage
-- objects, so these RPCs only NAME them; the client removes them through the Storage API. Both are
-- SECURITY INVOKER: they see exactly what the caller's RLS allows (own scenes, versions, sessions and
-- images).

-- The document ids used by this scene's versions that no other scene of the caller and no active
-- session of the caller uses: the image folders to delete together with the scene.
create function public.image_folders_to_free(p_scene_id uuid)
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select d.doc
  from (
    select distinct v.data ->> 'id' as doc
    from public.scene_versions v
    join public.scenes s on s.id = v.scene_id
    where v.scene_id = p_scene_id
      and s.owner_id = (select auth.uid())
  ) d
  where d.doc ~ '^[A-Za-z0-9_-]{1,64}$'
    and not exists (
      select 1
      from public.scene_versions v
      join public.scenes s on s.id = v.scene_id
      where s.owner_id = (select auth.uid())
        and v.scene_id <> p_scene_id
        and v.data ->> 'id' = d.doc
    )
    and not exists (
      select 1
      from public.sessions s
      join public.session_state st on st.session_id = s.id
      where s.dm_id = (select auth.uid())
        and s.status = 'active'
        and st.state -> 'scene' ->> 'id' = d.doc
    )
$$;

-- The caller's images older than p_min_age that no retained scene version and no active session
-- references: (folder, asset) where folder is the document id (or the library row id) and the asset id
-- is a key of the document's `assets`.
create function public.unreferenced_scene_assets(p_min_age interval default interval '7 days')
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select o.name
  from storage.objects o
  cross join lateral (
    select split_part(o.name, '/', 2) as folder,
           regexp_replace(split_part(o.name, '/', 3), '\.(webp|png|jpg)$', '') as asset
  ) k
  where o.bucket_id = 'scene-assets'
    and o.name like (select auth.uid())::text || '/%'
    and split_part(o.name, '/', 1) = (select auth.uid())::text
    and o.created_at < now() - greatest(coalesce(p_min_age, interval '7 days'), interval '0')
    and not exists (
      select 1
      from public.scene_versions v
      join public.scenes s on s.id = v.scene_id
      where s.owner_id = (select auth.uid())
        and (v.data ->> 'id' = k.folder or s.id::text = k.folder)
        and coalesce(v.data -> 'assets', '{}'::jsonb) ? k.asset
    )
    and not exists (
      select 1
      from public.sessions s
      join public.session_state st on st.session_id = s.id
      where s.dm_id = (select auth.uid())
        and s.status = 'active'
        and (st.state -> 'scene' ->> 'id' = k.folder or s.scene_id::text = k.folder)
        and coalesce(st.state -> 'scene' -> 'assets', '{}'::jsonb) ? k.asset
    )
$$;

revoke execute on function public.image_folders_to_free(uuid) from public, anon;
revoke execute on function public.unreferenced_scene_assets(interval) from public, anon;
grant execute on function public.image_folders_to_free(uuid) to authenticated;
grant execute on function public.unreferenced_scene_assets(interval) to authenticated;
