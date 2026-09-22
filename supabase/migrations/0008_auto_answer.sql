-- cat — let a channel answer for itself.
--
-- Normally an agent speaks only when someone with can_invoke_agent names it.
-- /answer on suspends that for one channel: any message from anyone other
-- than the person who switched it on gets an answer, with no @mention.
--
-- This is a real widening of who can spend the OpenRouter balance, which is
-- why it is off by default, per channel, and recorded with the name of whoever
-- turned it on. It is meant to be switched on for a conversation and off
-- again afterwards.
--
-- What it deliberately does NOT widen: pull requests. An automatic answer is
-- a reply to a question, never a request for a change, and invoke-agent forces
-- the code-change tool off on this path regardless of anyone's
-- can_request_changes.

alter table public.channels
  add column auto_answer_agent text references public.agents(slug),
  add column auto_answer_by    uuid references public.members(id) on delete set null,
  add column auto_answer_since timestamptz;

comment on column public.channels.auto_answer_agent is
  'Agent that answers unprompted in this channel; null means off.';

-- ---------------------------------------------------------------------------
-- The trigger fires from the database rather than from a browser. Two reasons
-- that matters: it works when nobody has the page open, and it fires exactly
-- once no matter how many clients are connected -- a client-side trigger would
-- race, and every open tab would ask for its own answer to the same question.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.auto_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ch       public.channels%rowtype;
  pending  int;
  fn_url   text;
  secret   text;
  anon_key text;
begin
  -- Agent messages never trigger an answer. Without this the first reply would
  -- provoke the second and the channel would talk to itself until the balance
  -- ran out.
  if new.agent_slug is not null or new.author_id is null then
    return new;
  end if;

  select * into ch from public.channels where id = new.channel_id;
  if not found or ch.auto_answer_agent is null then
    return new;
  end if;

  -- The person who turned it on is steering; they still use @mentions.
  if ch.auto_answer_by is not null and new.author_id = ch.auto_answer_by then
    return new;
  end if;

  -- One answer at a time. A burst of messages while the agent is still
  -- thinking should not buy a reply to each of them.
  select count(*) into pending
  from public.messages
  where channel_id = new.channel_id and status = 'pending';

  if pending > 0 then
    return new;
  end if;

  select decrypted_secret into fn_url
  from vault.decrypted_secrets where name = 'cat_invoke_url';
  select decrypted_secret into secret
  from vault.decrypted_secrets where name = 'cat_callback_secret';
  select decrypted_secret into anon_key
  from vault.decrypted_secrets where name = 'cat_anon_key';

  if fn_url is null or secret is null or anon_key is null then
    raise warning 'auto_answer: vault secrets missing, no answer sent';
    return new;
  end if;

  -- Two separate things. The anon key gets us past the functions gateway,
  -- which turns away any request without a JWT; it proves nothing about who
  -- is calling, and is public anyway. The secret is what the function checks
  -- to know the call is ours.
  perform net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key,
      'x-cat-secret', secret
    ),
    body    := jsonb_build_object(
      'channel_id', new.channel_id,
      'agent',      ch.auto_answer_agent,
      'prompt',     new.body,
      'auto_for',   new.author_id
    )
  );

  return new;
end;
$$;

create trigger messages_auto_answer
  after insert on public.messages
  for each row execute function public.auto_answer();

-- Reference data: members already read channels, and nobody but the service
-- role writes them, so the new columns need no policy of their own.
