-- Atlas VTT: Realtime Authorization for private channels (ARCHITECTURE §6.1).
--
-- | Topic                     | INSERT (send)                          | SELECT (receive)          |
-- |---------------------------|----------------------------------------|---------------------------|
-- | session:{sid}:req:{uid}   | that player (active member), broadcast | DM                        |
-- | session:{sid}:view:{uid}  | DM, broadcast                          | that player (active) + DM |
-- | session:{sid}:host        | DM, broadcast + presence               | active members + DM       |
-- | session:{sid}:lobby       | active members, presence only          | active members + DM       |
--
-- realtime.messages.extension is 'broadcast' or 'presence'; any other extension, any topic that does
-- not parse, and any role other than `authenticated` is denied. Clients must join with
-- config.private = true, and the project's Realtime "Allow public access" setting must be OFF.
-- Topic-derived values are wrapped in scalar subqueries so they are computed once per check.

create policy atlas_session_topics_receive on realtime.messages
  for select to authenticated
  using (
    case (select private.topic_kind())
      when 'req' then
        realtime.messages.extension = 'broadcast'
        and (select private.is_session_dm((select private.topic_sid())))
      when 'view' then
        realtime.messages.extension = 'broadcast'
        and (
          (select private.is_session_dm((select private.topic_sid())))
          or (
            (select private.topic_uid()) = (select auth.uid())
            and (select private.is_active_member((select private.topic_sid())))
          )
        )
      when 'host' then
        realtime.messages.extension in ('broadcast', 'presence')
        and (
          (select private.is_session_dm((select private.topic_sid())))
          or (select private.is_active_member((select private.topic_sid())))
        )
      when 'lobby' then
        realtime.messages.extension = 'presence'
        and (
          (select private.is_session_dm((select private.topic_sid())))
          or (select private.is_active_member((select private.topic_sid())))
        )
      else false
    end
  );

create policy atlas_session_topics_send on realtime.messages
  for insert to authenticated
  with check (
    case (select private.topic_kind())
      when 'req' then
        realtime.messages.extension = 'broadcast'
        and (select private.topic_uid()) = (select auth.uid())
        and (select private.is_active_member((select private.topic_sid())))
      when 'view' then
        realtime.messages.extension = 'broadcast'
        and (select private.is_session_dm((select private.topic_sid())))
      when 'host' then
        realtime.messages.extension in ('broadcast', 'presence')
        and (select private.is_session_dm((select private.topic_sid())))
      when 'lobby' then
        realtime.messages.extension = 'presence'
        and (select private.is_active_member((select private.topic_sid())))
      else false
    end
  );
