-- Atlas VTT: profile display name (ARCHITECTURE §6.4 profiles: own row only).
-- A PostgREST upsert would also SET the primary key, which `authenticated` may not update, so the
-- client calls this instead. SECURITY INVOKER: it runs under the caller's grants and the
-- profiles_*_own RLS policies, so it can only ever touch the caller's own row.

create function public.set_display_name(p_display_name text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := private.normalize_display_name(p_display_name);
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_name is null then
    raise exception 'invalid_display_name' using detail = 'display names are 1 to 32 characters';
  end if;

  insert into public.profiles as p (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update
    set display_name = excluded.display_name;

  return v_name;
end
$$;

-- normalize_display_name() is otherwise RPC-internal; the invoker function above needs it.
grant execute on function private.normalize_display_name(text) to authenticated;

revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated;
