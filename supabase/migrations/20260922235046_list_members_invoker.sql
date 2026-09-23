-- Atlas VTT: least privilege for list_session_members().
-- It only reads rows the DM can already SELECT under the session_members RLS policy
-- (own row or private.is_session_dm), so it runs with the caller's rights. The explicit DM check
-- still raises 'forbidden' for everyone else instead of returning just their own row.

alter function public.list_session_members(uuid) security invoker;
