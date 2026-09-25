-- cat — short answers become the default.
--
-- 0009 added verbose_replies defaulting to true, on the reasoning that an
-- agent should offer everything it has and a channel can ask for less. The
-- reverse turned out to be the useful arrangement: most questions here want a
-- paragraph and get a page, and the one working channel, #multimodel, was
-- switched off by hand. A default every channel overrides is the wrong way up.
--
-- Only the default moves. Existing channels keep the value they are set to,
-- because a channel that was switched by hand was switched deliberately, and
-- a migration that overwrites settings is a migration nobody can trust to run
-- twice. #general, still sitting on the inherited true, was moved separately.
alter table public.channels
  alter column verbose_replies set default false;

comment on column public.channels.verbose_replies is
  'True asks the agents for full-length answers in this channel. Off by default.';
