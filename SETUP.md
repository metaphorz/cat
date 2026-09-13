# Setting up cat

Roughly thirty minutes, most of it waiting on Supabase. Everything here is on
free tiers except the Anthropic API calls.

## 1. Create the Supabase project

In the [Supabase dashboard](https://supabase.com/dashboard), create a new
project. Any region near you is fine. Note the database password somewhere —
you will not need it for this app, but you will want it eventually.

When it finishes provisioning, go to **Project Settings → API** and copy:

- the **Project URL** (`https://xxxxxxxx.supabase.co`)
- the **anon / publishable key**

Paste both into `config.js`. These two values are public by design — they ship
to every browser. They are safe because every table has row level security, so
the anon key by itself can read nothing.

## 2. Create the schema

Open **SQL Editor** in the dashboard and run the two migrations **in order**:

1. `supabase/migrations/0001_init.sql` — tables, row level security, the signup
   gate, and seeds: you on the allowlist with `can_invoke_agent = true`, the
   `claude` agent on `claude-opus-5`, and `#multimodel` pointed at
   `github.com/metaphorz/Multimodel`.
2. `supabase/migrations/0002_specialties.sql` — usernames, specialties, and the
   per-channel map of which code belongs to which discipline.

Your specialty is seeded as **Modeling and simulation**, which is a guess. To
change it:

```sql
update public.members   set specialty = 'meteorology' where username = 'paul';
update public.allowlist set specialty = 'meteorology' where email = 'metaphorz@gmail.com';
```

Valid slugs are in `public.specialties`: `meteorology`, `statistics`,
`actuarial`, `geospatial`, `visualization`, `engineering`, `simulation`.

## 3. Point auth at wherever the page will live

**Authentication → URL Configuration**:

- **Site URL** — `https://metaphorz.github.io/cat/` (or whatever the Pages URL
  ends up being)
- **Redirect URLs** — add both the Pages URL and `http://localhost:8000/` so
  that local development works too

Magic links only redirect to URLs on this list. Getting this wrong is the most
common reason a link appears to do nothing.

Nothing else in the auth settings needs changing. Email signups must stay
enabled — the allowlist trigger, not Supabase's signup toggle, is what keeps
strangers out.

### Email delivery

Supabase's built-in email sender is capped at roughly **two messages per hour**
for the whole project and is documented as being for testing only. You will hit
"email rate limit exceeded" almost immediately -- signing in twice while
setting things up is enough to do it.

Configure custom SMTP under **Authentication → Emails → SMTP Settings**. Using
the Gmail account this workspace already belongs to is the shortest path:

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | `metaphorz@gmail.com` |
| Password | a Google **App Password**, not the account password |
| Sender email | `metaphorz@gmail.com` |
| Sender name | `cat` |

App Passwords require 2-step verification on the Google account, and are
created at <https://myaccount.google.com/apppasswords>. Gmail's own limit is
around 500 messages a day, which is far beyond anything this workspace will
produce.

Afterwards, raise **Authentication → Rate Limits → emails sent per hour** --
it stays pinned at the low default until custom SMTP exists.

Alternatives if you would rather not use Gmail: Resend, Brevo and Postmark all
have free tiers sized well past this use case.

## 4. Deploy the edge function

Install the CLI and push the function:

```sh
brew install supabase/tap/supabase
supabase login
supabase init          # creates supabase/config.toml; keep the existing folders
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy invoke-agent
```

Then give it its secrets:

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set GITHUB_TOKEN=ghp_...      # see below
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — do not set them yourself.

**The GitHub token.** `Multimodel` is a private repository, so without a token
the agent can talk about the conversation but cannot see the code. A
fine-grained personal access token with **read-only Contents** access to just
the repositories you plan to open channels for is enough. Without it,
everything still works; the agent is simply told it could not read the repo.

**The Anthropic key** comes from the [Anthropic
Console](https://console.anthropic.com/settings/keys). This is the one part of
the system that costs money. It never touches the browser — it lives only here,
which is the whole reason the edge function exists.

## 5. Publish the page

```sh
cd ~/code/social/cat
git init -b main
git add .
git commit -m "cat: shared codebase chat"
gh repo create cat --public --source=. --push
```

Then in the repository's **Settings → Pages**, set **Source** to **GitHub
Actions**. The workflow in `.github/workflows/deploy.yml` publishes on every
push to `main`.

**The repository has to be public.** GitHub Pages from a private repository
requires a paid plan; on the free plan the source repository must be public.

That is safe here, and worth understanding why rather than taking on faith.
The published page contains the project URL and the anon key, both of which
every visitor's browser receives anyway, and both of which are useless without
a member record -- row level security refuses every table to an unauthenticated
caller. The repository additionally exposes the schema and the edge function
source, neither of which is a secret: the function's power comes from
environment variables held by Supabase, not from its code. No credential lives
in any committed file.

What a public repository does expose is the seed row in
`migrations/0001_init.sql`, which contains a real email address. If you would
rather that not be scraped, replace it with a placeholder before pushing and
insert the real allowlist rows from the SQL editor instead -- the migration has
already run, so editing it now changes nothing about the live database.

**A public page is not public access.** Anyone can load the sign-in screen;
only allowlisted addresses can get past it.

## 6. Sign in

Visit the Pages URL, enter `metaphorz@gmail.com`, and follow the link in your
email. You should land in `#multimodel` with a **can invoke agents** badge under
your name.

Try it:

```
@claude what does this codebase actually model, and where would I look first?
```

You should see "Claude is thinking" appear immediately, then the answer replace
it a little while later. Anyone else signed in sees the same thing at the same
moment, without reloading.

---

## Adding people

One row each, in the SQL editor:

```sql
insert into public.allowlist (email, display_name, username, specialty, can_invoke_agent)
values ('alice@example.edu', 'Alice Reyes', 'alice', 'statistics', false);
```

`username` and `specialty` may both be left null — a handle is then derived
from the email address, and the person shows up under "No specialty set" until
someone fills it in. But setting the specialty is what lets the agent pitch its
answers at the right discipline, so it is worth doing up front.

They then sign in themselves — the member record is created on first login.
`can_invoke_agent = false` means they can read everything and talk to everyone,
but cannot spend your Anthropic budget. To change someone's mind later:

```sql
update public.members set can_invoke_agent = true where email = 'alice@example.edu';
```

Note that `allowlist` seeds the initial value and `members` holds the live one,
so an existing member's permissions are changed on `members`.

To remove someone, delete their allowlist row and their user under
**Authentication → Users** — the member row and their `author_id` links fall
away with it, though their messages remain in the transcript.

## Seeing who is in the workspace

Three different states, easy to confuse:

- **Invited** -- on the `allowlist`, but may never have signed in. Invisible in
  the app, because there is no member record yet.
- **Member** -- has signed in at least once. Appears in the sidebar.
- **Present** -- has the app open right now. Green dot in the sidebar. This is
  live presence and is not stored anywhere; when everyone closes the tab, the
  information is simply gone.

To see all of it at once, in the SQL editor:

```sql
select
  a.email,
  coalesce(m.display_name, a.display_name)        as name,
  m.username,
  coalesce(m.specialty, a.specialty)              as specialty,
  coalesce(m.can_invoke_agent, a.can_invoke_agent) as can_invoke_agent,
  (m.id is not null)                              as has_signed_in,
  u.last_sign_in_at
from public.allowlist a
left join public.members m on lower(m.email) = lower(a.email)
left join auth.users   u on u.id = m.id
order by u.last_sign_in_at desc nulls last, a.email;
```

`has_signed_in = false` means the invitation has not been taken up yet --
usually that the magic link was never clicked.

**Authentication → Users** in the dashboard shows the same accounts with their
last sign-in time, but knows nothing about specialties or the allowlist, so the
query above is the fuller picture.

## Adding channels

```sql
insert into public.channels (slug, name, purpose, github_owner, github_repo, position)
values ('hurricane', 'hurricane', 'Storm track generation.', 'metaphorz', 'Hurricane', 1);
```

The channel appears for everyone on their next page load. If the repository is
private, the same `GITHUB_TOKEN` needs read access to it as well.

## Adding @codex later

Three steps, none of which touch the frontend:

1. `insert into public.agents (slug, display_name, provider, model) values ('codex', 'Codex', 'openai', 'gpt-...');`
2. Add an OpenAI branch in `supabase/functions/invoke-agent/index.ts` where it
   currently rejects any `provider` other than `anthropic`.
3. `supabase secrets set OPENAI_API_KEY=...` and redeploy the function.

The permission check, the pending-message mechanism, the transcript, the repo
context and the UI are all provider-agnostic already.

## Connecting GitHub to Supabase

There are two different things this can mean, and they are worth separating.

**Deploying the backend from GitHub** — worth doing. The workflow in
`.github/workflows/supabase.yml` applies migrations and redeploys the edge
function whenever anything under `supabase/` changes, so you stop running SQL
by hand. Add three repository secrets under **Settings → Secrets and variables
→ Actions**:

| Secret | Where it comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase dashboard → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | the project ref in your project's URL |
| `SUPABASE_DB_PASSWORD` | the password set when the project was created |

Until those exist the workflow reports "not configured" and exits cleanly, so
it costs nothing to leave in place.

**Supabase's GitHub integration / branching** — skip it for now. It exists to
give each pull request its own ephemeral database, which is genuinely useful on
a team shipping schema changes continuously. Branching is a paid add-on, and
with two migration files and one person writing them it would be machinery
without a job. The workflow above gets you the part you actually want.

**GitHub as a login provider** is a third, unrelated option — see below.

## Adding GitHub sign-in later

Nothing in the schema assumes magic links, so GitHub OAuth can be added without
migration. Register an OAuth app on GitHub, enter the client ID and secret under
**Authentication → Providers → GitHub** in Supabase, and add a button that calls
`supabase.auth.signInWithOAuth({ provider: "github" })`.

Two things to know before you do:

- The allowlist gate keys on **email**, and GitHub only releases a user's email
  if their account has a public one or the `user:email` scope is requested.
  Without an email the signup trigger has nothing to match and the login fails.
- The payoff is that `github_login` can be populated automatically, which would
  let the agent connect a person in chat to the author of a commit.

For a group this size, the magic-link allowlist is the simpler control. GitHub
sign-in is a convenience, not a security improvement.

## Running locally

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. It talks to the same hosted Supabase
project, so you are working against real data — worth remembering before you
test anything destructive.

## If the project pauses

Free projects pause after a week of no activity. **Resume project** in the
dashboard brings it back with data intact. Nothing in this app needs to be
reconfigured afterwards.
