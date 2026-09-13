-- cat — route every agent through OpenRouter.
--
-- One key, one bill, three vendors. The edge function already dispatches on
-- agents.provider, so this migration is the whole change: no redeploy is
-- needed to add a model, only to add a *provider*.
--
-- Model slugs are OpenRouter's, taken from its live catalogue. To change any
-- of them later, update the row -- nothing in the code names a model.

update public.agents
set provider = 'openrouter',
    model    = 'anthropic/claude-opus-5'
where slug = 'claude';

insert into public.agents (slug, display_name, provider, model) values
  ('codex',  'Codex',  'openrouter', 'openai/gpt-5.3-codex'),
  ('gemini', 'Gemini', 'openrouter', 'google/gemini-3.1-pro-preview')
on conflict (slug) do update
  set display_name = excluded.display_name,
      provider     = excluded.provider,
      model        = excluded.model,
      enabled      = true;

-- Worth knowing, since it is invisible from the chat window: only members with
-- can_invoke_agent may summon any of these. Adding agents widens what you can
-- ask for; it does not widen who can ask.
