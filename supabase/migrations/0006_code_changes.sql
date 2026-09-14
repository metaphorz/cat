-- cat — let an agent open a pull request, under tight scope.
--
-- Three separate decisions, deliberately not folded into the one flag that
-- already exists:
--
--   can_invoke_agent    may spend money asking a model a question
--   can_request_changes may cause a branch and a pull request to be written
--   channels.allow_writes  whether this repository may be written to at all
--
-- A channel may only ever write to the repository it is bound to, so the
-- blast radius of this feature is exactly the repo named in the channel row.
-- Adding a writable channel is a deliberate act, not a side effect.

alter table public.members
  add column can_request_changes boolean not null default false;

alter table public.channels
  add column allow_writes boolean not null default false;

-- Column-level grants again: members may edit their own profile, but must not
-- be able to grant themselves the ability to write to a repository.
revoke update on public.members from authenticated;
grant update (display_name, github_login, username, specialty)
  on public.members to authenticated;

-- ---------------------------------------------------------------------------
-- code_requests: one row per pull request an agent was asked to open. Kept
-- separate from messages because it has a lifecycle -- requested, dispatched,
-- opened, failed -- and because it is the audit trail for everything the
-- system has ever written to a repository.
-- ---------------------------------------------------------------------------
create table public.code_requests (
  id           bigint generated always as identity primary key,
  channel_id   uuid not null references public.channels(id) on delete cascade,
  message_id   bigint references public.messages(id) on delete set null,
  requested_by uuid references public.members(id) on delete set null,
  agent_slug   text references public.agents(slug),
  brief        text not null,
  status       text not null default 'dispatched',
  branch       text,
  pr_url       text,
  detail       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint code_requests_status_check
    check (status in ('dispatched', 'running', 'opened', 'failed'))
);

create index code_requests_channel_idx on public.code_requests (channel_id, created_at desc);

alter table public.code_requests enable row level security;

-- Readable by every member -- the audit trail is the point, and a workspace
-- this size has no reason to hide it. Written only by the service role.
create policy code_requests_read on public.code_requests
  for select to authenticated using (public.is_member());

alter table public.code_requests replica identity full;
alter publication supabase_realtime add table public.code_requests;

-- ---------------------------------------------------------------------------
-- Seed: Paul may request changes; #multimodel is writable. Both stay false by
-- default for everyone and everything else.
-- ---------------------------------------------------------------------------
update public.members
set can_request_changes = true
where email = 'metaphorz@gmail.com';

update public.channels
set allow_writes = true
where slug = 'multimodel';
