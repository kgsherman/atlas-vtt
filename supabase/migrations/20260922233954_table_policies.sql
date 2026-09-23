-- Atlas VTT: RLS policies on public tables (ARCHITECTURE §6.4).
-- One permissive policy per (table, command) so no policy can widen another by accident.
-- auth.uid() is wrapped in a scalar subquery so it is evaluated once per statement.

-- profiles: own row only.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- scenes: owner only (link shares are read exclusively through get_shared_scene()).
create policy scenes_select_owner on public.scenes
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy scenes_update_owner on public.scenes
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy scenes_delete_owner on public.scenes
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- scene_versions: owner reads; writes only through save_scene_version()/create_scene().
create policy scene_versions_select_owner on public.scene_versions
  for select to authenticated
  using (
    exists (
      select 1
      from public.scenes s
      where s.id = scene_versions.scene_id
        and s.owner_id = (select auth.uid())
    )
  );

-- sessions: the DM only. Players never read this table (session_info() instead).
create policy sessions_select_dm on public.sessions
  for select to authenticated
  using (dm_id = (select auth.uid()));

create policy sessions_delete_dm on public.sessions
  for delete to authenticated
  using (dm_id = (select auth.uid()));

-- session_members: own row or the session's DM; a member may rename themselves while active.
create policy session_members_select_own_or_dm on public.session_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_session_dm(session_id));

create policy session_members_update_own_name on public.session_members
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'active')
  with check (user_id = (select auth.uid()) and status = 'active');

-- session_state: the DM only (writes through save_session_state()).
create policy session_state_select_dm on public.session_state
  for select to authenticated
  using (private.is_session_dm(session_id));

-- player_views: the player's own row while an active member of an active session, or the DM.
-- Writes only through upsert_player_view().
create policy player_views_select_own_or_dm on public.player_views
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and private.is_active_member(session_id))
    or private.is_session_dm(session_id)
  );
