-- Atlas VTT: the player may also RECEIVE on its own request topic.
--
-- Realtime only lets a client join a private channel when it has READ (select) permission on the
-- topic — verified against this project: with only INSERT, joining session:{sid}:req:{uid} fails with
-- "Unauthorized: You do not have permissions to read from this Channel topic". The player must join
-- req:{uid} to send, so it gets SELECT there too. Nothing is exposed: only that player can write the
-- topic (see atlas_session_topics_send) and clients join with broadcast.self = false.
--
-- | Topic                     | INSERT (send)                          | SELECT (receive / join)             |
-- |---------------------------|----------------------------------------|-------------------------------------|
-- | session:{sid}:req:{uid}   | that player (active member), broadcast | DM + that player (active), broadcast |
-- | session:{sid}:view:{uid}  | DM, broadcast                          | that player (active) + DM           |
-- | session:{sid}:host        | DM, broadcast + presence               | active members + DM                 |
-- | session:{sid}:lobby       | active members, presence only          | active members + DM                 |

alter policy atlas_session_topics_receive on realtime.messages
  using (
    case (select private.topic_kind())
      when 'req' then
        realtime.messages.extension = 'broadcast'
        and (
          (select private.is_session_dm((select private.topic_sid())))
          or (
            (select private.topic_uid()) = (select auth.uid())
            and (select private.is_active_member((select private.topic_sid())))
          )
        )
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
