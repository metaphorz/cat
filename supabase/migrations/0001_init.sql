-- cat — schema, row level security, and seed data.
-- Apply once against a fresh Supabase project (SQL Editor, or `supabase db push`).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- allowlist: who is permitted to sign in at all, and what they may do.
-- Rows here are the source of truth. A person who is not listed cannot create
-- an account, even though magic-link sign-in is otherwise self-service.
-- ---------------------------------------------------------------------------
create table public.allowlist (
  email            text primary key,
  display_name     text,
  can_invoke_agent boolean not null default false,
  is_admin         boolean not null default false,
  added_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- members: an allowlisted person who has actually signed in at least once.
-- Created automatically by the handle_new_user trigger below.
-- ---------------------------------------------------------------------------
create table public.members (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text not null unique,
  display_name     text not null,
  github_login     text,
  can_invoke_agent boolean not null default false,
  is_admin         boolean not null default false,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- channels: one per codebase. slug is what people type (#multimodel).
-- ---------------------------------------------------------------------------
create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  purpose       text,
  github_owner  text,
  github_repo   text,
  github_branch text not null default 'main',
  position      int  not null default 0,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- agents: the registry of addressable AI participants. Adding @codex later is
-- an insert here plus a provider branch in the edge function -- not a rewrite.
-- ---------------------------------------------------------------------------
create table public.agents (
  slug         text primary key,
  display_name text not null,
  provider     text not null,
  model        text not null,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- messages: exactly one of author_id (a human) or agent_slug (an AI) is set.
-- ---------------------------------------------------------------------------
create table public.messages (
  id         bigint generated always as identity primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id  uuid references public.members(id) on delete set null,
  agent_slug text references public.agents(slug),
  body       text not null default '',
  status     text not null default 'complete',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_status_check check (status in ('pending', 'complete', 'error')),
  constraint messages_speaker_check check (
    (author_id is not null and agent_slug is null) or
    (author_id is null and agent_slug is not null)
  )
);

create index messages_channel_created_idx on public.messages (channel_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Signup gate. Runs as the definer so it can read the allowlist and write
-- members while the signing-up user still has no privileges of their own.
-- Raising here aborts the signup, which is how non-allowlisted people are
-- kept out.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.allowlist%rowtype;
begin
  select * into entry from public.allowlist where lower(email) = lower(new.email);

  if not found then
    raise exception using
      errcode = '42501',
      message = format('%s is not on the allowlist for this workspace.', new.email);
  end if;

  insert into public.members (id, email, display_name, can_invoke_agent, is_admin)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(entry.display_name, ''), split_part(new.email, '@', 1)),
    entry.can_invoke_agent,
    entry.is_admin
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Membership test used by every policy below. security definer so that reading
-- members inside a members policy does not recurse.
create or replace function public.is_member()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.members where id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Row level security.
-- Read: any signed-in member sees everything. With fewer than 20 trusted
-- people and a handful of channels, per-channel access lists would be
-- machinery without a purpose.
-- Write: members may post as themselves only. Agent messages carry no
-- author_id and are insertable only by the service role, which bypasses RLS --
-- so a collaborator cannot forge a message from Claude.
-- ---------------------------------------------------------------------------
alter table public.allowlist enable row level security;
alter table public.members   enable row level security;
alter table public.channels  enable row level security;
alter table public.agents    enable row level security;
alter table public.messages  enable row level security;

-- allowlist: no client policies at all. Only the service role and the signup
-- trigger touch it. Manage membership from the SQL editor.

create policy members_read on public.members
  for select to authenticated using (public.is_member());

create policy members_update_self on public.members
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Row level security decides WHICH rows a member may update; it cannot decide
-- which COLUMNS. Without this grant, the policy above would let anyone hand
-- themselves can_invoke_agent and start spending the Anthropic budget. Column
-- privileges are the part of Postgres that closes that.
revoke update on public.members from authenticated;
grant update (display_name, github_login) on public.members to authenticated;

create policy channels_read on public.channels
  for select to authenticated using (public.is_member());

create policy agents_read on public.agents
  for select to authenticated using (public.is_member());

create policy messages_read on public.messages
  for select to authenticated using (public.is_member());

create policy messages_insert_own on public.messages
  for insert to authenticated
  with check (
    public.is_member()
    and author_id = auth.uid()
    and agent_slug is null
    and status = 'complete'
  );

create policy messages_delete_own on public.messages
  for delete to authenticated using (author_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime. replica identity full so that UPDATE events (a pending agent
-- message being filled in) carry enough of the row for RLS to authorize them.
-- ---------------------------------------------------------------------------
alter table public.messages replica identity full;
alter publication supabase_realtime add table public.messages;

-- ---------------------------------------------------------------------------
-- Seed. Edit the email below if it is ever not yours.
-- ---------------------------------------------------------------------------
insert into public.allowlist (email, display_name, can_invoke_agent, is_admin)
values ('metaphorz@gmail.com', 'Paul', true, true);

insert into public.agents (slug, display_name, provider, model) values
  ('claude', 'Claude', 'anthropic', 'claude-opus-5');

insert into public.channels (slug, name, purpose, github_owner, github_repo, github_branch, position) values
  ('multimodel', 'multimodel',
   'Discussion of the Multimodel wind/hurricane codebase.',
   'metaphorz', 'Multimodel', 'main', 0);

-- ---------------------------------------------------------------------------
-- Backfill. Anyone who authenticated before this schema existed -- for
-- instance while testing the sign-in flow against an empty project -- has an
-- auth.users row but no member record, and the trigger above fires only on
-- signup, so it will never run for them again. Give them their member row
-- here, provided they are on the allowlist.
-- ---------------------------------------------------------------------------
insert into public.members (id, email, display_name, can_invoke_agent, is_admin)
select
  u.id,
  lower(u.email),
  coalesce(nullif(a.display_name, ''), split_part(u.email, '@', 1)),
  a.can_invoke_agent,
  a.is_admin
from auth.users u
join public.allowlist a on lower(a.email) = lower(u.email)
on conflict (id) do nothing;
