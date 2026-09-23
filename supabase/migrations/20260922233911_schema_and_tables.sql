-- Atlas VTT: base schema (ARCHITECTURE §6.4).
-- Tables, constraints, indexes, RLS enablement and explicit grants. Policies, helpers and RPCs
-- live in later migrations. Every table is reachable only through RLS policies or RPCs.

-- ---------------------------------------------------------------------------
-- Privileges hardening
-- ---------------------------------------------------------------------------

-- Helper functions used by RLS policies. Not exposed through the Data API (PostgREST only serves
-- `public`), but `authenticated` needs USAGE so policies evaluated as the caller can call them.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Objects created by the migration role in `public` get NO implicit privileges for the API roles:
-- every table/function below is granted explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
-- PUBLIC's implicit EXECUTE on new functions comes from the global defaults, not the per-schema ones.
alter default privileges revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Trigger helpers
-- ---------------------------------------------------------------------------

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create function private.forbid_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable_row' using detail = format('%I.%I rows cannot be updated', tg_table_schema, tg_table_name);
end
$$;

revoke execute on function private.touch_updated_at() from public, anon, authenticated;
revoke execute on function private.forbid_update() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- profiles: own row only
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
    constraint profiles_display_name_check
    check (char_length(display_name) between 1 and 32 and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- scenes + immutable scene_versions: owner only
-- ---------------------------------------------------------------------------

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null
    constraint scenes_name_check check (char_length(name) between 1 and 200 and name !~ '[[:cntrl:]]'),
  visibility text not null default 'private'
    constraint scenes_visibility_check check (visibility in ('private', 'link')),
  -- 18 random bytes (144 bits) as unpadded base64url. Generated server-side only.
  share_slug text unique
    constraint scenes_share_slug_check check (share_slug ~ '^[A-Za-z0-9_-]{24}$'),
  latest_version integer not null default 0
    constraint scenes_latest_version_check check (latest_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scenes_link_has_slug check ((visibility = 'link') = (share_slug is not null))
);

create index scenes_owner_updated_idx on public.scenes (owner_id, updated_at desc);

create trigger scenes_touch_updated_at
  before update on public.scenes
  for each row execute function private.touch_updated_at();

create table public.scene_versions (
  scene_id uuid not null references public.scenes (id) on delete cascade,
  version integer not null constraint scene_versions_version_check check (version >= 1),
  schema_version integer not null constraint scene_versions_schema_version_check check (schema_version >= 1),
  data jsonb not null constraint scene_versions_data_check check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (scene_id, version)
);

-- Versions are immutable (defence in depth: no API role has UPDATE either).
create trigger scene_versions_immutable
  before update on public.scene_versions
  for each row execute function private.forbid_update();

-- ---------------------------------------------------------------------------
-- sessions: DM full access; players use session_info()
-- ---------------------------------------------------------------------------

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  dm_id uuid not null references auth.users (id) on delete cascade,
  scene_id uuid references public.scenes (id) on delete set null,
  -- 8 characters of Crockford base32 (no I, L, O, U).
  room_code text not null constraint sessions_room_code_check check (room_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  status text not null default 'active' constraint sessions_status_check check (status in ('active', 'ended')),
  -- Fencing token for the single-host rule: bumped by claim_host() and end_session().
  host_epoch bigint not null default 0 constraint sessions_host_epoch_check check (host_epoch >= 0),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

-- Room codes are unique among ACTIVE sessions only (codes of ended sessions can be reissued).
create unique index sessions_active_room_code_key on public.sessions (room_code) where status = 'active';
create index sessions_dm_idx on public.sessions (dm_id);
create index sessions_scene_idx on public.sessions (scene_id);

create table public.session_members (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null
    constraint session_members_display_name_check
    check (char_length(display_name) between 1 and 32 and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  status text not null default 'active' constraint session_members_status_check check (status in ('active', 'kicked')),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index session_members_user_idx on public.session_members (user_id);

-- ---------------------------------------------------------------------------
-- session_state (DM only) and player_views (own row while active member; DM writes)
-- ---------------------------------------------------------------------------

create table public.session_state (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  -- host_epoch of the host that wrote `state` (0 = the seed written by create_session()).
  epoch bigint not null default 0,
  state jsonb not null constraint session_state_state_check check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.player_views (
  session_id uuid not null,
  user_id uuid not null,
  -- Fencing token (sessions.host_epoch) of the writer.
  host_epoch bigint not null,
  -- Wire epoch string of the host run that produced `view` (HostToClient.epoch).
  epoch text not null constraint player_views_epoch_check check (char_length(epoch) between 1 and 64),
  seq bigint not null constraint player_views_seq_check check (seq >= 0),
  view jsonb not null constraint player_views_view_check check (jsonb_typeof(view) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- RLS on every table + explicit grants (column-level where clients may write)
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.scenes enable row level security;
alter table public.scene_versions enable row level security;
alter table public.sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.session_state enable row level security;
alter table public.player_views enable row level security;

revoke all on table
  public.profiles,
  public.scenes,
  public.scene_versions,
  public.sessions,
  public.session_members,
  public.session_state,
  public.player_views
from public, anon, authenticated;

grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Scenes are created/versioned/shared through RPCs; clients may read, rename and delete their own.
grant select, delete on public.scenes to authenticated;
grant update (name) on public.scenes to authenticated;
grant select on public.scene_versions to authenticated;

-- Sessions are created/updated through RPCs.
grant select, delete on public.sessions to authenticated;

-- Members are written through RPCs, except a member renaming themselves.
grant select on public.session_members to authenticated;
grant update (display_name) on public.session_members to authenticated;

grant select on public.session_state to authenticated;
grant select on public.player_views to authenticated;
