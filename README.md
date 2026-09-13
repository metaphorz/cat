# cat

A small Slack-like workspace for discussing a GitHub codebase, with an AI agent
that only some people are allowed to summon.

One channel per codebase: `#multimodel` is about
[metaphorz/Multimodel](https://github.com/metaphorz/Multimodel). Anyone in the
workspace can read and talk. Addressing `@claude` brings the agent into the
conversation — but only for members who hold that permission, and that rule is
enforced on the server, not in the interface.

Setup instructions are in [SETUP.md](SETUP.md).

## How it fits together

```
                       GitHub Pages
                  static HTML / CSS / JS
                             |
   Paul  ------------->  # multimodel  <-------------  Alice
                             |
                             |  HTTPS + realtime (websocket)
                             v
                          Supabase
                  auth | Postgres + RLS | realtime
                             |
                             |  invoke-agent (edge function)
                             v
                    is the caller allowed?
                       no --> 403
                       yes --> Anthropic API  <--  GitHub API
                                     |            (repo context)
                                     v
                         reply written back into the
                         channel; realtime fans it out
```

The browser holds no secrets. It has the Supabase URL and anon key, both of
which are meant to be public, and everything they can reach is fenced off by
row level security. The Anthropic key and the GitHub token exist only inside
the edge function.

## What each file is

| File | |
|---|---|
| `index.html`, `style.css`, `app.js` | The whole client. No build step, no framework. |
| `config.js` | Supabase URL and anon key. Public values. |
| `supabase/migrations/0001_init.sql` | Tables, RLS policies, the signup gate, seed data. |
| `supabase/migrations/0002_specialties.sql` | Usernames, specialties, and the per-channel code map. |
| `supabase/functions/invoke-agent/index.ts` | The permission boundary and the model call. |
| `.github/workflows/deploy.yml` | Publishes the client to Pages on push to `main`. |
| `.github/workflows/supabase.yml` | Applies migrations and redeploys the function. Inert until secrets are set. |

## The permission model

|        | Read | Post | Invoke agents |
|--------|:----:|:----:|:-------------:|
| Paul   | yes  | yes  | yes           |
| Others | yes  | yes  | no            |
| Claude | yes  | yes  | —             |

Three separate mechanisms hold this up, and it is worth knowing which does
what:

- **Getting in at all** is the `allowlist` table. An address that is not listed
  cannot create an account, because the signup trigger refuses it.
- **Reading and posting** is row level security. A member may insert messages
  as themselves and nobody else; `agent_slug` messages are rejected outright,
  so a collaborator cannot forge words from Claude.
- **Invoking an agent** is the edge function checking `can_invoke_agent` before
  it will touch the Anthropic key. Hiding the button would not be a control;
  this is.

## Who is who

Every member has a handle and a discipline — meteorologist, statistician,
actuary, geospatial analyst, and so on. This is not decoration. Each channel
also carries a map from discipline to the paths in *that* repository which
concern it, because "the statistics code" means something different in every
codebase.

The agent is given both. So when a statistician asks how the wind field is
generated, it can answer in the vocabulary of sampling and variance and point
at `pipeline/fit_metamodels.py`, and when a meteorologist asks the same thing
it can talk about surface roughness and point at `pipeline/windfield.py`. When
a question lands squarely in someone else's area, it is told to say so and name
the person rather than answer at the edge of its competence.

The people list in the sidebar is grouped the same way, which turns out to be
most of what a member list is for in a mixed group.

## Deliberate limits

The agent reads and discusses. It cannot write files, push branches, or open
pull requests — there is no code path by which it could. Dispatching a GitHub
Action that makes real changes is a plausible next phase, but it is a different
trust decision and deserves to be made on purpose rather than inherited.

Messages are not editable and there are no threads, reactions, or file uploads.
Recreating Slack is not the point; having somewhere to think about a codebase
together is.
