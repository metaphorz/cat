// admin-command — the slash commands, and the boundary that keeps them yours.
//
// The palette in the composer only appears for admins, but that is cosmetic,
// exactly as the agent button is. This function is the part that enforces it:
// every command below refuses anyone whose members.is_admin is false, so a
// member who reads app.js and posts the request by hand gets a 403 rather
// than a model switch.
//
// Commands never become messages. The client renders the reply locally and
// throws it away on refresh, which is what keeps them invisible to everyone
// else -- and, just as importantly, keeps them out of the transcript that
// invoke-agent feeds the model as conversation history.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ok(text: string): Response {
  return json({ text });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Missing bearer token." }, 401);
  }

  // The same two-client split invoke-agent uses: the scoped client answers
  // "who is calling?" with only the caller's own privileges, and the admin
  // client is never reachable until the is_admin check below has passed.
  const scoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await scoped.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Not signed in." }, 401);

  const { data: member } = await admin
    .from("members")
    .select("id, display_name, is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!member) return json({ error: "You are not a member of this workspace." }, 403);
  if (!member.is_admin) {
    return json({ error: "Slash commands are limited to workspace admins." }, 403);
  }

  let payload: { command?: string; args?: string[]; channel_id?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const command = (payload.command ?? "").toLowerCase().replace(/^\//, "");
  const args = (payload.args ?? []).filter((a) => a.trim() !== "");

  try {
    switch (command) {
      case "model":
        return await modelCommand(admin, args);
      case "resolve":
        return await resolveCommand(args);
      case "answer":
        return await answerCommand(admin, args, member, payload.channel_id ?? "");
      case "clear":
        return await clearCommand(admin, args, payload.channel_id ?? "");
      case "verbose":
        return await verboseCommand(admin, args, payload.channel_id ?? "");
      case "status":
        return await statusCommand(admin);
      case "who":
        return await whoCommand(admin);
      case "cost":
        return await costCommand();
      case "invite":
        return await inviteCommand(admin, args);
      default:
        return json({ error: `Unknown command /${command}.` }, 400);
    }
  } catch (e) {
    return json({ error: `/${command} failed: ${(e as Error).message}` }, 500);
  }
});

// ---------------------------------------------------------------- /model

type ORModel = {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
};

// OpenRouter lists a few hundred models and around one in six cannot do tool
// calls. Those are not merely a worse choice here -- the agent reads the
// repository through tool use, so switching to one would look like an agent
// that had gone vague rather than a model that cannot fetch a file. They are
// filtered out of both the listing and the switch.
async function openRouterModels(): Promise<ORModel[]> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}.`);

  const body = await res.json() as { data: ORModel[] };
  return (body.data ?? [])
    .filter((m) => (m.supported_parameters ?? []).includes("tools"))
    // OpenRouter lists a :batch twin of most models at half price. They are
    // asynchronous, so a chat reply cannot wait on one -- the discount is for
    // work collected later. Offering them here would only invite a switch
    // that looks cheap and then never answers.
    .filter((m) => !m.id.endsWith(":batch"))
    // Floating aliases: real, but they change under you. A stored default
    // should name the model it means.
    .filter((m) => !m.id.startsWith("~"))
    .filter((m) => !NON_CHAT.some((s) => m.id.includes(s)));
}

// Variants that are not a chat model at all, whatever else they support.
const NON_CHAT = ["-image", "-audio", "-tts", "-embed", "-search", "-realtime", "-customtools"];

// Version comparison on the digits in the name: 5.3 beats 5.1, and 4.5 beats
// 4. Compared position by position rather than as a decimal, so 3.10 would
// sort above 3.9 as intended.
function version(id: string): number[] {
  return ((id.split("/")[1] ?? id).match(/\d+/g) ?? []).map(Number);
}

function newer(a: string, b: string): boolean {
  const x = version(a), y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? -1, q = y[i] ?? -1;
    if (p !== q) return p > q;
  }
  return false;
}

// The model line a name belongs to, with version and preview status removed:
// claude-opus-5 and claude-opus-4.1 are one family, and so are
// gemini-3.1-pro-preview and gemini-2.5-pro.
function family(id: string): string {
  return id
    .replace(/-preview/g, "")
    .replace(/[\d.]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/-$/, "");
}

function outPrice(m: ORModel): number {
  return Number(m.pricing?.completion ?? 0);
}

// What a vendor is actually offering, rather than everything it has ever
// shipped. One model per family -- the newest -- ranked by output price,
// which is the closest thing to a capability ordering the catalogue gives us:
// it puts Opus above Sonnet above Haiku without hardcoding that Opus exists.
function shortlist(models: ORModel[], cap = 6): ORModel[] {
  const best = new Map<string, ORModel>();
  for (const m of models) {
    const k = family(m.id);
    const cur = best.get(k);
    if (!cur || newer(m.id, cur.id)) best.set(k, m);
  }
  return [...best.values()].sort((a, b) => outPrice(b) - outPrice(a)).slice(0, cap);
}

function perMillion(raw: string | undefined): string {
  const n = Number(raw ?? "0");
  if (!Number.isFinite(n) || n === 0) return "--";
  const dollars = n * 1_000_000;
  return "$" + (dollars < 1 ? dollars.toFixed(2) : dollars.toFixed(2));
}

function modelRows(models: ORModel[]): string {
  return models
    .map((m) =>
      `| \`${m.id}\` | ${((m.context_length ?? 0) / 1000).toFixed(0)}k | ` +
      `${perMillion(m.pricing?.prompt)} | ${perMillion(m.pricing?.completion)} |`
    )
    .join("\n");
}

async function modelCommand(
  admin: SupabaseClient,
  rawArgs: string[],
): Promise<Response> {
  const { data: agents } = await admin
    .from("agents")
    .select("slug, display_name, provider, model, enabled")
    .order("slug");

  const known = new Set((agents ?? []).map((a) => a.slug as string));

  // A trailing "all" opts out of the shortlist. Stripped before anything else
  // looks at the arguments, so it can never be mistaken for a model to set.
  const showAll = rawArgs[rawArgs.length - 1]?.toLowerCase() === "all";
  const args = showAll ? rawArgs.slice(0, -1) : rawArgs;

  // `/model` on its own: what is each agent running right now.
  if (args.length === 0) {
    const rows = (agents ?? [])
      .map((a) =>
        `| @${a.slug} | \`${a.model}\` | ${a.enabled ? "on" : "off"} |`
      )
      .join("\n");
    return ok(
      "**Agents now**\n\n| agent | model | |\n|---|---|---|\n" + rows +
        "\n\n`/model <term>` to search, `/model <agent> <model-id>` to switch.",
    );
  }

  // `/model <agent> <model-id>`: the switch. One UPDATE, no redeploy.
  if (known.has(args[0].toLowerCase()) && args.length >= 2) {
    const slug = args[0].toLowerCase();
    const wanted = args[1];
    const models = await openRouterModels();
    const match = models.find((m) => m.id === wanted);

    if (!match) {
      const near = models
        .filter((m) => m.id.includes(wanted.replace(/^.*\//, "")))
        .slice(0, 8);
      return ok(
        `\`${wanted}\` is not an OpenRouter model that supports tool use, so the ` +
          `agent could not read the repository with it. Switch refused.` +
          (near.length
            ? "\n\nDid you mean:\n\n| model | ctx | in $/M | out $/M |\n|---|---|---|---|\n" +
              modelRows(near)
            : ""),
      );
    }

    const before = (agents ?? []).find((a) => a.slug === slug);
    const { error } = await admin
      .from("agents")
      .update({ model: match.id })
      .eq("slug", slug);

    if (error) throw new Error(error.message);

    return ok(
      `**@${slug}** switched\n\n\`${before?.model}\` → \`${match.id}\`\n\n` +
        `${((match.context_length ?? 0) / 1000).toFixed(0)}k context, ` +
        `${perMillion(match.pricing?.prompt)}/M in, ` +
        `${perMillion(match.pricing?.completion)}/M out. ` +
        `This is the default for every channel and every member until changed back.`,
    );
  }

  // Anything else is a search term. `/model claude` is deliberately not an
  // error even though `claude` is also an agent: it reads naturally as "what
  // could @claude run?", so it answers both -- what that agent is on now,
  // then what it could be moved to.
  const term = args.join(" ").toLowerCase();
  const models = await openRouterModels();
  const all = models
    .filter((m) => m.id.toLowerCase().includes(term))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!all.length) return ok(`No tool-capable model matches \`${term}\`.`);

  const hits = showAll ? all.slice(0, 40) : shortlist(all);
  const agent = (agents ?? []).find((a) => a.slug === term);

  return ok(
    (agent ? `**@${agent.slug}** is on \`${agent.model}\`.\n\n` : "") +
      (showAll
        ? `**Every tool-capable model matching \`${term}\`** (${all.length})`
        : `**Current line for \`${term}\`** -- newest of each family, ` +
          `best first, out of ${all.length}`) +
      "\n\n| model | ctx | in $/M | out $/M |\n|---|---|---|---|\n" + modelRows(hits) +
      `\n\n\`/model ${agent?.slug ?? "<agent>"} <model-id>\` to switch` +
      (agent ? "" : " one") + (showAll ? "." : `, \`/model ${term} all\` for the rest.`),
  );
}

// ------------------------------------------------------------ /retry lookup

// /retry runs a real answer that everyone in the channel watches arrive, so a
// mistyped model must fail here, in a note only the admin sees, rather than
// downstream as an errored agent message the whole room reads.
async function resolveCommand(args: string[]): Promise<Response> {
  const term = (args[0] ?? "").toLowerCase().trim();
  if (!term) return json({ error: "No model given." }, 400);

  const models = await openRouterModels();

  const exact = models.find((m) => m.id.toLowerCase() === term);
  if (exact) return json({ model: exact.id });

  const hits = models.filter((m) => m.id.toLowerCase().includes(term));
  if (hits.length === 1) return json({ model: hits[0].id });
  if (!hits.length) {
    return ok(`No tool-capable model matches \`${term}\`, so nothing was run.`);
  }

  return ok(
    `\`${term}\` matches ${hits.length} models -- name one exactly:\n\n` +
      "| model | ctx | in $/M | out $/M |\n|---|---|---|---|\n" +
      modelRows(hits.slice(0, 15)),
  );
}

// ---------------------------------------------------------------- /verbose

// Asks the agents for shorter answers in this channel. An instruction rather
// than a token cap: a cap would cut a reply off mid-sentence, and a truncated
// answer tells you nothing about whether the rest of it mattered.
async function verboseCommand(
  admin: SupabaseClient,
  args: string[],
  channelId: string,
): Promise<Response> {
  if (!channelId) return json({ error: "No channel." }, 400);

  const { data: channel } = await admin
    .from("channels")
    .select("id, slug, verbose_replies")
    .eq("id", channelId)
    .maybeSingle();

  if (!channel) return json({ error: "Unknown channel." }, 404);

  const want = (args[0] ?? "").toLowerCase();

  if (!want) {
    return ok(
      `Replies in #${channel.slug} are **${channel.verbose_replies ? "full length" : "short"}**.\n\n` +
        "`/verbose off` for a few sentences an answer, `/verbose on` for the full treatment.",
    );
  }

  if (want !== "on" && want !== "off") {
    return ok("Usage: `/verbose`, `/verbose on`, `/verbose off`.");
  }

  const { error } = await admin
    .from("channels")
    .update({ verbose_replies: want === "on" })
    .eq("id", channelId);

  if (error) throw new Error(error.message);

  return ok(
    want === "on"
      ? `Full-length replies in #${channel.slug}. Agents will structure a long answer where it has parts.`
      : `Short replies in #${channel.slug}. Agents are asked for a few sentences, ` +
        `no headings or tables, and to offer the long version rather than deliver it unasked. ` +
        `It steers them rather than truncating them, so expect the odd long answer to a ` +
        `question that genuinely needs one.`,
  );
}

// ---------------------------------------------------------------- /clear

// Empties a channel without destroying it: the channel row, its repository
// binding and its specialty mapping all stay, and it can be talked in again a
// second later. That is a different act from archiving, which removes the
// channel itself.
//
// Two steps, always. The first hands back the transcript and changes nothing;
// the second deletes, and only up to the message the transcript ended at --
// so anything posted while the decision was being made survives rather than
// being silently swept up with the rest.
async function clearCommand(
  admin: SupabaseClient,
  args: string[],
  channelId: string,
): Promise<Response> {
  if (!channelId) return json({ error: "No channel." }, 400);

  const { data: channel } = await admin
    .from("channels")
    .select("id, slug")
    .eq("id", channelId)
    .maybeSingle();

  if (!channel) return json({ error: "Unknown channel." }, 404);

  if ((args[0] ?? "").toLowerCase() === "confirm") {
    const upTo = Number(args[1] ?? "");
    if (!Number.isFinite(upTo)) {
      return ok("Run `/clear` first -- it gives you the transcript, and only then will this work.");
    }

    const { data: gone, error } = await admin
      .from("messages")
      .delete()
      .eq("channel_id", channelId)
      .lte("id", upTo)
      .select("id");

    if (error) throw new Error(error.message);

    const { count: left } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", channelId);

    return ok(
      `**#${channel.slug} cleared.** ${gone?.length ?? 0} messages deleted` +
        (left ? `, ${left} posted since the transcript and kept` : "") +
        `.\n\nThe channel, its repository binding and its code areas are untouched.`,
    );
  }

  const { data: messages } = await admin
    .from("messages")
    .select("id, body, status, agent_slug, created_at, members(display_name, username)")
    .eq("channel_id", channelId)
    .order("created_at");

  if (!messages?.length) return ok(`#${channel.slug} is already empty.`);

  const { data: agents } = await admin.from("agents").select("slug, display_name");
  const agentName = new Map((agents ?? []).map((a) => [a.slug as string, a.display_name as string]));

  // deno-lint-ignore no-explicit-any
  const lines = (messages as any[]).map((m) => {
    const who = m.agent_slug
      ? (agentName.get(m.agent_slug) ?? m.agent_slug) + " (agent)"
      : m.members?.display_name ?? "someone who has since left";
    const when = String(m.created_at).slice(0, 16).replace("T", " ");
    return `### ${who} -- ${when}\n\n${m.body || "_(empty)_"}\n`;
  });

  const upTo = messages[messages.length - 1].id;
  const transcript =
    `# #${channel.slug}\n\n` +
    `${messages.length} messages, ${String(messages[0].created_at).slice(0, 10)} to ` +
    `${String(messages[messages.length - 1].created_at).slice(0, 10)}. ` +
    `Saved before clearing on ${new Date().toISOString().slice(0, 10)}.\n\n---\n\n` +
    lines.join("\n");

  return json({
    text: `**${messages.length} messages** in #${channel.slug}, ` +
      `${String(messages[0].created_at).slice(0, 10)} to ` +
      `${String(messages[messages.length - 1].created_at).slice(0, 10)}. ` +
      `The transcript has been saved to your downloads.\n\n` +
      `Nothing has been deleted. Check the file is readable, then run ` +
      `\`/clear confirm\` to empty the channel. Deleted messages cannot be ` +
      `recovered from Supabase.`,
    download: { name: `cat-${channel.slug}-${new Date().toISOString().slice(0, 10)}.md`, body: transcript },
    clear_up_to: upTo,
  });
}

// ---------------------------------------------------------------- /answer

// Off by default, per channel, and remembered with the name of whoever turned
// it on -- because while it is on, people who cannot summon an agent are
// nonetheless spending the balance, and the person who allowed that should be
// on the record.
async function answerCommand(
  admin: SupabaseClient,
  args: string[],
  member: { id: string; display_name: string },
  channelId: string,
): Promise<Response> {
  if (!channelId) return json({ error: "No channel." }, 400);

  const { data: channel } = await admin
    .from("channels")
    .select("id, slug, auto_answer_agent, auto_answer_by, auto_answer_since")
    .eq("id", channelId)
    .maybeSingle();

  if (!channel) return json({ error: "Unknown channel." }, 404);

  const want = (args[0] ?? "").toLowerCase();

  // `/answer` with nothing after it reports rather than toggles. A switch that
  // changes state when you ask it what state it is in is a bad switch.
  if (!want) {
    if (!channel.auto_answer_agent) {
      return ok(
        `Automatic answers are **off** in #${channel.slug}.\n\n` +
          "`/answer on` to let anyone's question be answered without an " +
          "@mention; `/answer on gemini` to choose which agent.",
      );
    }
    const { data: who } = await admin
      .from("members")
      .select("display_name")
      .eq("id", channel.auto_answer_by ?? "")
      .maybeSingle();

    return ok(
      `Automatic answers are **on** in #${channel.slug}: ` +
        `**@${channel.auto_answer_agent}** replies to anyone but ` +
        `${who?.display_name ?? "whoever set it"}, since ` +
        `${String(channel.auto_answer_since ?? "").slice(0, 16).replace("T", " ")}.\n\n` +
        "`/answer off` to stop.",
    );
  }

  if (want === "off") {
    const { error } = await admin
      .from("channels")
      .update({ auto_answer_agent: null, auto_answer_by: null, auto_answer_since: null })
      .eq("id", channelId);
    if (error) throw new Error(error.message);
    return ok(`Automatic answers are **off** in #${channel.slug}. Agents wait to be named again.`);
  }

  if (want !== "on") return ok("Usage: `/answer`, `/answer on [agent]`, `/answer off`.");

  const slug = (args[1] ?? "claude").toLowerCase();
  const { data: agent } = await admin
    .from("agents")
    .select("slug, display_name, enabled")
    .eq("slug", slug)
    .maybeSingle();

  if (!agent || !agent.enabled) return ok(`There is no enabled agent called \`${slug}\`.`);

  const { error } = await admin
    .from("channels")
    .update({
      auto_answer_agent: agent.slug,
      auto_answer_by: member.id,
      auto_answer_since: new Date().toISOString(),
    })
    .eq("id", channelId);

  if (error) throw new Error(error.message);

  return ok(
    `Automatic answers are **on** in #${channel.slug}.\n\n` +
      `**@${agent.slug}** now answers every message in this channel except ` +
      `yours -- no @mention needed, and from anyone, including people without ` +
      `permission to summon an agent. That is the point of it, and it is also ` +
      `the cost: each message buys a reply. It cannot open pull requests on ` +
      `this path whatever anyone's permissions say.\n\n` +
      `\`/answer off\` when the conversation is done.`,
  );
}

// ---------------------------------------------------------------- /status

async function statusCommand(admin: SupabaseClient): Promise<Response> {
  const [{ data: channels }, { data: messages }, { data: members }] = await Promise.all([
    admin.from("channels").select("id, slug, auto_answer_agent").order("position"),
    admin.from("messages").select("channel_id, author_id, agent_slug, status, metadata, created_at"),
    admin.from("members").select("id, display_name, username"),
  ]);

  const msgs = messages ?? [];
  const nameOf = new Map((members ?? []).map((m) => [m.id as string, m.username ?? m.display_name]));

  const perChannel = (channels ?? []).map((c) => {
    const mine = msgs.filter((m) => m.channel_id === c.id);
    const last = mine.reduce<string | null>(
      (acc, m) => (!acc || m.created_at > acc ? m.created_at as string : acc),
      null,
    );
    return `| #${c.slug} | ${mine.length} | ${mine.filter((m) => m.agent_slug).length} | ` +
      `${last ? new Date(last).toISOString().slice(0, 16).replace("T", " ") : "--"} | ` +
      `${c.auto_answer_agent ? "**@" + c.auto_answer_agent + "**" : "--"} |`;
  }).join("\n");

  // Token and cost accounting rides along in each agent message's metadata,
  // so the totals are free -- no separate usage table to keep in step.
  let inTok = 0, outTok = 0, cachedTok = 0;
  const perModel = new Map<string, number>();
  for (const m of msgs) {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const usage = (meta.usage ?? {}) as Record<string, number>;
    inTok += Number(usage.input_tokens ?? 0);
    outTok += Number(usage.output_tokens ?? 0);
    cachedTok += Number(usage.cache_read_input_tokens ?? 0);
    if (meta.model) perModel.set(String(meta.model), (perModel.get(String(meta.model)) ?? 0) + 1);
  }

  const humans = msgs.filter((m) => m.author_id);
  const perPerson = [...new Set(humans.map((m) => m.author_id as string))]
    .map((id) => ({ id, n: humans.filter((m) => m.author_id === id).length }))
    .sort((a, b) => b.n - a.n)
    .map((r) => `| @${nameOf.get(r.id) ?? "gone"} | ${r.n} |`)
    .join("\n");

  const pending = msgs.filter((m) => m.status === "pending").length;
  const errored = msgs.filter((m) => m.status === "error").length;

  const modelRowsUsed = [...perModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, n]) => `| \`${model}\` | ${n} |`)
    .join("\n");

  return ok(
    `**Workspace**\n\n` +
      `${msgs.length} messages · ${members?.length ?? 0} members · ` +
      `${pending} pending · ${errored} errored\n\n` +
      `**By channel**\n\n| channel | messages | agent | last | /answer |\n` +
      `|---|---|---|---|---|\n${perChannel}\n\n` +
      `**By person**\n\n| who | messages |\n|---|---|\n${perPerson || "| -- | 0 |"}\n\n` +
      `**Agent replies by model**\n\n| model | replies |\n|---|---|\n${modelRowsUsed || "| -- | 0 |"}\n\n` +
      `**Tokens** ${inTok.toLocaleString()} in · ${outTok.toLocaleString()} out · ` +
      `${cachedTok.toLocaleString()} read from cache`,
  );
}

// ---------------------------------------------------------------- /who

async function whoCommand(admin: SupabaseClient): Promise<Response> {
  const [{ data: allow }, { data: members }, { data: specialties }] = await Promise.all([
    admin.from("allowlist").select("email, display_name, specialty, is_admin, added_at"),
    admin.from("members").select("id, email, username, specialty, created_at"),
    admin.from("specialties").select("slug, label"),
  ]);

  const label = new Map((specialties ?? []).map((s) => [s.slug as string, s.label as string]));
  const signedIn = new Map((members ?? []).map((m) => [(m.email as string).toLowerCase(), m]));

  // Driven from the allowlist rather than members, so someone who has been
  // invited but has not clicked their link yet is visible as exactly that.
  const rows = (allow ?? [])
    .sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)))
    .map((a) => {
      const m = signedIn.get(String(a.email).toLowerCase());
      const handle = m?.username ? "@" + m.username : "--";
      const spec = label.get(String(a.specialty ?? "")) ?? "--";
      const state = m
        ? "signed in " + new Date(m.created_at as string).toISOString().slice(0, 10)
        : "**not signed in yet**";
      return `| ${a.display_name ?? a.email} | ${handle} | ${spec} | ${state} |`;
    })
    .join("\n");

  return ok(
    "**People**\n\n| name | handle | specialty | status |\n|---|---|---|---|\n" + rows,
  );
}

// ---------------------------------------------------------------- /cost

async function costCommand(): Promise<Response> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}.`);

  const { data } = await res.json() as {
    data: { total_credits: number; total_usage: number };
  };
  const left = data.total_credits - data.total_usage;

  // The one number worth walking across the room for. Everything else about
  // the account is a click away on OpenRouter and was only ever clutter here.
  return ok(`**$${left.toFixed(2)} left** -- OpenRouter`);
}

// ---------------------------------------------------------------- /invite

async function inviteCommand(admin: SupabaseClient, args: string[]): Promise<Response> {
  const email = (args[0] ?? "").toLowerCase().trim();
  const specialty = (args[1] ?? "").toLowerCase().trim();

  if (!email.includes("@")) {
    return ok("Usage: `/invite <email> <specialty> [display name]`");
  }

  const { data: specialties } = await admin
    .from("specialties")
    .select("slug, label")
    .order("position");

  const slugs = (specialties ?? []).map((s) => s.slug as string);
  if (specialty && !slugs.includes(specialty)) {
    return ok(
      `\`${specialty}\` is not a specialty. One of:\n\n` +
        (specialties ?? []).map((s) => `- \`${s.slug}\` -- ${s.label}`).join("\n"),
    );
  }

  const display = args.slice(2).join(" ").trim() || email.split("@")[0];
  // The handle is only a preference: derive_username settles collisions when
  // they actually sign in, so two people named chris cannot collide here.
  const username = display.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9_]/g, "");

  const { error } = await admin.from("allowlist").upsert({
    email,
    display_name: display,
    username,
    specialty: specialty || null,
    can_invoke_agent: false,
    is_admin: false,
  }, { onConflict: "email" });

  if (error) throw new Error(error.message);

  return ok(
    `**${display}** is on the allowlist as \`@${username}\`` +
      (specialty ? `, ${specialty}` : "") + `.\n\n` +
      `No invitation is sent -- send them https://metaphorz.github.io/cat/ and ` +
      `they sign in with **${email}**. Their member row is created on that first click.`,
  );
}
