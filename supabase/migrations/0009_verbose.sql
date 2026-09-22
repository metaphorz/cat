-- cat — let a channel ask for shorter answers.
--
-- The agents write at length by default, which suits a question that deserves
-- it and buries one that does not. /verbose off tells them to answer in a few
-- sentences and to stop reaching for headings and tables.
--
-- This is an instruction, not a cap. Lowering max_tokens instead would cut a
-- reply off mid-sentence, which is worse than a long one: an answer that stops
-- in the middle tells you nothing about whether the rest mattered.

-- Named verbose_replies rather than verbose because verbose is a reserved
-- word in Postgres, and a column that must be quoted at every mention is a
-- small tax paid forever.
alter table public.channels
  add column verbose_replies boolean not null default true;

comment on column public.channels.verbose_replies is
  'False asks the agents for short answers in this channel.';
