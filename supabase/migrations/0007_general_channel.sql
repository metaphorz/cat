-- cat — a channel that is not about a codebase.
--
-- Every channel so far is bound to a repository, and the agent prompt assumes
-- it: read the repo, stay on the subject of the repo. #general is the other
-- kind -- a room for the group to talk in, where @claude can still be asked a
-- question but there is no code under discussion.
--
-- The absence of github_owner/github_repo is what marks it. The edge function
-- reads those columns and drops the repository framing when they are null, so
-- nothing here needs a flag of its own. allow_writes stays false because a
-- channel with no repository has nothing it could write to.
--
-- Paul intends to clear this channel out from time to time. Deleting its
-- messages is safe in a way that deleting the channel is not: the row stays,
-- the history goes. See tools/flush-channel.sh.

insert into public.channels (slug, name, purpose, position)
values (
  'general',
  'general',
  'Anything that is not about a particular codebase. Ask @claude here too.',
  1
)
on conflict (slug) do update
  set name     = excluded.name,
      purpose  = excluded.purpose,
      position = excluded.position;

-- Amended 2026-09-14, after Paul set the house rule: #general is for
-- technical discussion that is not about one particular codebase, not a
-- social channel. The purpose line is what the agent is told the channel is
-- for, so it has to say the same thing the ground rules do.
update public.channels
set purpose = 'Technical discussion that is not about one particular codebase.'
where slug = 'general';
