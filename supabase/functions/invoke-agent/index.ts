// invoke-agent — the security boundary of the whole system.
//
// The browser may ask for an agent, but it is this function that decides
// whether the asker is allowed one, and it is this function that holds the
// Anthropic credentials. Hiding the button in the UI is cosmetic; this is
// the part that actually enforces the permission.
//
// Flow:
//   1. Identify the caller from their Supabase JWT.
//   2. Refuse unless members.can_invoke_agent is true for them.
//   3. Insert a `pending` message so every connected client immediately sees
//      that the agent is working.
//   4. Return 202 and finish the model call in the background, updating that
//      row when the reply lands. Realtime delivers it to everyone.
//
// Step 4 matters: an Opus call on a real question can take longer than a
// browser is willing to keep a fetch open.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
// Deliberately a second, narrower credential: reading a repository and writing
// to one are different privileges and should not share a token.
const GITHUB_WRITE_TOKEN = Deno.env.get("GITHUB_WRITE_TOKEN") ?? "";

// How much of the channel's conversation the agent is shown.
const TRANSCRIPT_LIMIT = 40;

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

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Missing bearer token." }, 401);
  }

  // Two clients, deliberately. The scoped one answers "who is calling?" using
  // only the caller's own privileges. The admin one does the privileged work
  // afterwards, and is never reachable before the check below passes.
  const scoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await scoped.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: "Not signed in." }, 401);
  }
  const userId = userData.user.id;

  const { data: member } = await admin
    .from("members")
    .select("id, display_name, username, specialty, can_invoke_agent, can_request_changes")
    .eq("id", userId)
    .maybeSingle();

  if (!member) return json({ error: "You are not a member of this workspace." }, 403);
  if (!member.can_invoke_agent) {
    return json(
      { error: "You do not have permission to invoke an agent in this workspace." },
      403,
    );
  }

  let payload: { channel_id?: string; agent?: string; prompt?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const { channel_id, agent: agentSlug, prompt } = payload;
  if (!channel_id || !agentSlug || !prompt?.trim()) {
    return json({ error: "channel_id, agent and prompt are all required." }, 400);
  }

  const { data: agent } = await admin
    .from("agents")
    .select("slug, display_name, provider, model, enabled")
    .eq("slug", agentSlug)
    .maybeSingle();

  if (!agent || !agent.enabled) return json({ error: `Unknown agent @${agentSlug}.` }, 404);
  if (agent.provider !== "anthropic" && agent.provider !== "openrouter") {
    return json(
      { error: `@${agent.slug} is registered as a ${agent.provider} agent, which is not wired up yet.` },
      501,
    );
  }

  const { data: channel } = await admin
    .from("channels")
    .select("id, slug, name, purpose, github_owner, github_repo, github_branch, allow_writes")
    .eq("id", channel_id)
    .maybeSingle();

  if (!channel) return json({ error: "Unknown channel." }, 404);

  // The placeholder. Everyone sees "Claude is thinking..." from this moment on.
  const { data: placeholder, error: placeholderError } = await admin
    .from("messages")
    .insert({
      channel_id: channel.id,
      agent_slug: agent.slug,
      body: "",
      status: "pending",
      metadata: { invoked_by: member.display_name, invoked_by_id: member.id },
    })
    .select("id")
    .single();

  if (placeholderError || !placeholder) {
    return json({ error: "Could not post the agent placeholder message." }, 500);
  }

  const work = respond(admin, {
    messageId: placeholder.id,
    agent,
    channel,
    prompt: prompt.trim(),
    asker: member,
  });

  // Hand the slow part to the runtime so the browser is not held open for it.
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return json({ status: "accepted", message_id: placeholder.id }, 202);
});

type Agent = { slug: string; display_name: string; provider: string; model: string };
type Channel = {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string;
  allow_writes: boolean;
};

type Person = {
  id?: string;
  display_name: string;
  username: string | null;
  specialty: string | null;
  can_request_changes?: boolean;
};

async function respond(
  admin: SupabaseClient,
  args: { messageId: number; agent: Agent; channel: Channel; prompt: string; asker: Person },
): Promise<void> {
  const { messageId, agent, channel, prompt, asker } = args;
  const askedBy = asker.display_name;

  try {
    const labels = await loadSpecialtyLabels(admin);
    const [transcript, repo, directory, areas] = await Promise.all([
      loadTranscript(admin, channel.id, messageId, labels),
      loadRepoContext(channel),
      loadDirectory(admin, labels),
      loadAreas(admin, channel.id),
    ]);

    // A channel bound to a repository is a channel about that repository, and
    // the prompt says so. A channel with no repository -- #general -- is a
    // room the group talks in, so the codebase framing is dropped rather than
    // left in to be quietly contradicted by every message.
    const bound = Boolean(channel.github_owner && channel.github_repo);

    // The prompt is provider-independent: both paths below are handed the same
    // instructions, the same repository context and the same user turn. Only
    // the transport differs.
    const instructions = [
          bound
            ? `You are ${agent.display_name}, a participant in a small shared chat workspace where a research group discusses a specific GitHub codebase.`
            : `You are ${agent.display_name}, a participant in the shared chat workspace of a small interdisciplinary research group. The group's other channels are each about a particular GitHub codebase; this one is not.`,
          `This is the #${channel.slug} channel${channel.purpose ? `: ${channel.purpose}` : "."}`,
          "",
          "Several different people talk here, so the transcript labels each speaker with their handle and discipline. Address them by name when it helps.",
          "",
          directory,
          "",
          areas,
          "",
          bound
            ? "The group is deliberately interdisciplinary, so pitch each answer at the person who asked: a statistician asking about the wind field wants a different explanation than a meteorologist asking the same thing. Use their vocabulary, and point them at the specific files above that belong to their area."
            : "The group is deliberately interdisciplinary, so pitch each answer at the person who asked: a statistician asking about the wind field wants a different explanation than a meteorologist asking the same thing. Use their vocabulary.",
          "When a question really belongs to someone else's discipline, say so and name the person -- that is more useful than an answer at the edge of your confidence.",
          "",
          bound
            ? "You can read and reason about the codebase, but you cannot modify it: you have no ability to write files, push branches, or open pull requests. If someone asks for a change, describe the change concretely -- name the files and show the code -- and say plainly that a human needs to apply it."
            : "You have no repository in front of you here and no ability to write files, push branches or open pull requests. If the question is really about one of the group's codebases, answer what you can and suggest they ask in that codebase's channel, where you can actually read it.",
          "",
          bound
            ? "Keep the discussion to this codebase and the work around it. If the conversation wanders somewhere unrelated, say so briefly rather than following it."
            : "This channel has no set subject. Answer whatever is asked, on any topic, the way a knowledgeable colleague in the room would -- briefly, and without steering the conversation back to work.",
          "",
          "The chat window renders Markdown, so use it where it carries meaning: fenced code blocks for code, tables for comparisons, headings and lists to structure a long answer, and LaTeX for mathematics -- $...$ inline and $$...$$ for displayed equations. This group works on wind and loss modelling, so write the physics and statistics as notation rather than prose where notation is clearer.",
          "",
          "Do not reach for structure that a sentence would carry better. Be direct and concrete, skip preamble and pleasantries, and let a few sentences be a few sentences; headings and tables are for answers that genuinely have parts.",
    ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");

    const userTurn = [
      transcript ? `Recent conversation in #${channel.slug}:\n\n${transcript}\n\n---\n` : "",
      `${describe(asker, labels)} is now asking you:\n\n${prompt}`,
    ].join("");

    const mayWrite = bound &&
      channel.allow_writes === true &&
      asker.can_request_changes === true;

    const reply = agent.provider === "openrouter"
      ? await callOpenRouter(agent, instructions, repo, userTurn, mayWrite)
      : await callAnthropic(agent, instructions, repo, userTurn);

    // The model asked to open a pull request. Everything about whether it was
    // allowed to was decided before the tool was ever offered.
    if (reply.codeChange && mayWrite) {
      await dispatchCodeChange(admin, {
        messageId,
        agent,
        channel,
        asker,
        transcript,
        title: reply.codeChange.title,
        brief: reply.codeChange.brief,
      });
      return;
    }

    if (reply.refused) {
      await fail(admin, messageId, "I declined to answer that one.", {
        stop_reason: "refusal",
        stop_details: reply.refused,
      });
      return;
    }

    await admin
      .from("messages")
      .update({
        body: reply.text || "(no response)",
        status: "complete",
        metadata: {
          invoked_by: askedBy,
          provider: agent.provider,
          model: reply.model,
          repo_context: repo ? `${channel.github_owner}/${channel.github_repo}` : null,
          usage: reply.usage,
        },
      })
      .eq("id", messageId);
  } catch (err) {
    const detail = err instanceof Anthropic.APIError
      ? `${agent.display_name} API error ${err.status}: ${err.message}`
      : err instanceof Error
      ? err.message
      : String(err);
    await fail(admin, messageId, detail, {});
  }
}

// One shape for every provider, so respond() does not care who answered.
type AgentReply = {
  text: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
  refused?: Record<string, unknown>;
  codeChange?: { title: string; brief: string };
};

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

// The native path. Worth preferring for Claude models: adaptive thinking,
// effort control, prompt caching of the repository context, and server-side
// refusal fallbacks are all Anthropic-specific and do not survive a proxy.
async function callAnthropic(
  agent: Agent,
  instructions: string,
  repo: string | null,
  userTurn: string,
): Promise<AgentReply> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Either set it, or point this agent at " +
        "the openrouter provider.",
    );
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Stable content first: the repository block is the expensive part and is
  // identical for a whole conversation, so it sits behind the cache
  // breakpoint with an unchanging prefix ahead of it.
  const system = [
    { type: "text" as const, text: instructions },
    ...(repo
      ? [{
        type: "text" as const,
        text: repo,
        cache_control: { type: "ephemeral" as const },
      }]
      : []),
  ];

  const params = {
    model: agent.model,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user" as const, content: userTurn }],
    // deno-lint-ignore no-explicit-any
  } as any;

  // Streaming: max_tokens is high enough that a non-streaming request risks an
  // HTTP timeout on a long answer.
  const stream = anthropic.beta.messages.stream(params);
  const reply = await stream.finalMessage();

  if (reply.stop_reason === "refusal") {
    return {
      text: "",
      model: reply.model,
      usage: NO_USAGE,
      refused: (reply.stop_details ?? {}) as Record<string, unknown>,
    };
  }

  return {
    text: reply.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim(),
    model: reply.model,
    usage: {
      input_tokens: reply.usage.input_tokens,
      output_tokens: reply.usage.output_tokens,
      cache_read_input_tokens: reply.usage.cache_read_input_tokens ?? 0,
    },
  };
}

// The repository context is large and identical for a whole conversation, so
// paying for it on every single call is waste. OpenRouter passes cache_control
// through to Anthropic models, which needs the content-array form; everything
// else takes a plain string, and sending a breakpoint a model cannot honour
// is a request error rather than a silent no-op.
function systemContent(
  model: string,
  instructions: string,
  repo: string | null,
): unknown {
  const plain = [instructions, repo].filter(Boolean).join("\n\n");
  if (!repo || !model.startsWith("anthropic/")) return plain;

  return [
    { type: "text", text: instructions },
    { type: "text", text: repo, cache_control: { type: "ephemeral" } },
  ];
}

// The proxy path: one key reaching every vendor. This is what makes adding
// @codex or @gemini a row in the agents table rather than new code -- at the
// cost of the Anthropic-specific features above, which the OpenAI-compatible
// wire format has nowhere to put.
// Offered only when the caller and the channel both permit writing. The
// description does the real work: the model, not a keyword match, decides
// whether "make a PR for that" and "we shouldn't open a PR yet" mean the same
// thing -- and they do not.
const CODE_CHANGE_TOOL = {
  type: "function",
  function: {
    name: "request_code_change",
    description:
      "Open a pull request against this channel's repository. Call this ONLY when someone has explicitly asked you to make, open or raise a pull request. Do not call it while merely discussing a possible change, when someone is thinking aloud about what might be done, when they are asking what a change would involve, or when they have said not to yet. If you are unsure whether they meant it as an instruction, ask them instead of calling this.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short pull request title in the imperative mood.",
        },
        brief: {
          type: "string",
          description:
            "What the change should be: which files, what behaviour, and any constraints or decisions the conversation settled on. The engineer who receives this also receives the full conversation, but should not have to reconstruct the task from it.",
        },
      },
      required: ["title", "brief"],
    },
  },
};

async function callOpenRouter(
  agent: Agent,
  instructions: string,
  repo: string | null,
  userTurn: string,
  mayWrite = false,
): Promise<AgentReply> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set for this function.");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "cat",
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 8000,
      messages: [
        { role: "system", content: systemContent(agent.model, instructions, repo) },
        { role: "user", content: userTurn },
      ],
      ...(mayWrite ? { tools: [CODE_CHANGE_TOOL] } : {}),
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenRouter returned ${res.status}: ${detail}`);
  }

  const data = await res.json();

  // OpenRouter can report a provider-side failure inside a 200 response.
  if (data.error) {
    throw new Error(
      `OpenRouter: ${data.error.message ?? JSON.stringify(data.error)}`,
    );
  }

  const message = data.choices?.[0]?.message ?? {};

  // deno-lint-ignore no-explicit-any
  const call = (message.tool_calls ?? []).find((c: any) =>
    c?.function?.name === "request_code_change"
  );

  let codeChange: { title: string; brief: string } | undefined;
  if (call) {
    try {
      const args = JSON.parse(call.function.arguments ?? "{}");
      if (args.title && args.brief) {
        codeChange = { title: String(args.title), brief: String(args.brief) };
      }
    } catch {
      // A malformed tool call is treated as no tool call; the text still stands.
    }
  }

  return {
    text: (message.content ?? "").trim(),
    codeChange,
    model: data.model ?? agent.model,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
    },
  };
}

// How much conversation the coding agent is given. The brief says what to do;
// the transcript says why, which is usually where the constraints actually
// live -- a decision reached over twenty messages does not survive being
// restated in one sentence.
const DISPATCH_TRANSCRIPT_LIMIT = 24000;

async function dispatchCodeChange(
  admin: SupabaseClient,
  args: {
    messageId: number;
    agent: Agent;
    channel: Channel;
    asker: Person;
    transcript: string;
    title: string;
    brief: string;
  },
): Promise<void> {
  const { messageId, agent, channel, asker, transcript, title, brief } = args;
  const repo = `${channel.github_owner}/${channel.github_repo}`;

  const { data: request } = await admin
    .from("code_requests")
    .insert({
      channel_id: channel.id,
      message_id: messageId,
      requested_by: asker.id ?? null,
      agent_slug: agent.slug,
      brief: `${title}\n\n${brief}`,
      status: "dispatched",
    })
    .select("id")
    .single();

  if (!GITHUB_WRITE_TOKEN) {
    await fail(
      admin,
      messageId,
      "I was asked to open a pull request, but no write credential is configured for this workspace.",
      { code_request_id: request?.id ?? null },
    );
    if (request) {
      await admin.from("code_requests")
        .update({ status: "failed", detail: "GITHUB_WRITE_TOKEN is not set." })
        .eq("id", request.id);
    }
    return;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_WRITE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cat-workspace",
    },
    body: JSON.stringify({
      event_type: "cat-code-request",
      client_payload: {
        request_id: request?.id ?? null,
        channel: channel.slug,
        base: channel.github_branch,
        requested_by: asker.display_name,
        title,
        brief,
        transcript: transcript.slice(-DISPATCH_TRANSCRIPT_LIMIT),
      },
    }),
  });

  if (!res.ok) {
    const detail = `GitHub refused the dispatch (${res.status}): ${(await res.text()).slice(0, 200)}`;
    await fail(admin, messageId, detail, { code_request_id: request?.id ?? null });
    if (request) {
      await admin.from("code_requests")
        .update({ status: "failed", detail }).eq("id", request.id);
    }
    return;
  }

  // The chat message becomes the visible record of the request. The workflow
  // updates it again when the pull request exists.
  await admin
    .from("messages")
    .update({
      body: [
        `Opening a pull request against \`${repo}\`.`,
        "",
        `**${title}**`,
        "",
        brief,
        "",
        "_Working on it. I will post the link here when the branch is pushed._",
      ].join("\n"),
      status: "complete",
      metadata: {
        invoked_by: asker.display_name,
        provider: agent.provider,
        code_request_id: request?.id ?? null,
        repo,
      },
    })
    .eq("id", messageId);
}

async function fail(
  admin: SupabaseClient,
  messageId: number,
  body: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await admin
    .from("messages")
    .update({ body, status: "error", metadata: extra })
    .eq("id", messageId);
}

// "Alice (@alice, Statistician)" -- the form used in both the system prompt and
// the transcript, so the agent sees one consistent way of naming people.
function describe(p: Person, labels?: Map<string, string>): string {
  const parts: string[] = [];
  if (p.username) parts.push("@" + p.username);
  if (p.specialty) parts.push(labels?.get(p.specialty) ?? p.specialty);
  return parts.length ? `${p.display_name} (${parts.join(", ")})` : p.display_name;
}

// Who is in the workspace, so the agent can tell a question about sampling
// from a question about storm physics by who is asking it.
async function loadDirectory(
  admin: SupabaseClient,
  labels: Map<string, string>,
): Promise<string> {
  const { data: people } = await admin
    .from("members")
    .select("display_name, username, specialty")
    .order("display_name");

  if (!people?.length) return "";

  const lines = people.map((p) => "- " + describe(p as Person, labels));

  return ["People in this workspace:", ...lines].join("\n");
}

// Which paths in THIS repository belong to which discipline. Curated per
// channel, because "the statistics code" means something different in every
// repository.
async function loadAreas(admin: SupabaseClient, channelId: string): Promise<string> {
  const { data } = await admin
    .from("channel_areas")
    .select("paths, note, specialties(label, position)")
    .eq("channel_id", channelId);

  if (!data?.length) return "";

  const rows = data
    // deno-lint-ignore no-explicit-any
    .map((r) => r as any)
    .sort((a, b) => (a.specialties?.position ?? 0) - (b.specialties?.position ?? 0))
    .map((r) => {
      const label = r.specialties?.label ?? "Other";
      const note = r.note ? ` ${r.note}` : "";
      return `- ${label}:${note} ${(r.paths ?? []).join(", ")}`;
    });

  return [
    "Which parts of this repository concern which discipline:",
    ...rows,
  ].join("\n");
}

// The channel's recent history, oldest first, with the placeholder excluded.
async function loadSpecialtyLabels(admin: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await admin.from("specialties").select("slug, label");
  return new Map((data ?? []).map((s) => [s.slug as string, s.label as string]));
}

async function loadTranscript(
  admin: SupabaseClient,
  channelId: string,
  excludeId: number,
  labels: Map<string, string>,
): Promise<string> {
  const { data } = await admin
    .from("messages")
    .select("id, body, status, agent_slug, members(display_name, username, specialty), agents(display_name)")
    .eq("channel_id", channelId)
    .neq("id", excludeId)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(TRANSCRIPT_LIMIT);

  if (!data?.length) return "";

  return data
    .slice()
    .reverse()
    .map((row) => {
      // deno-lint-ignore no-explicit-any
      const r = row as any;
      const speaker = r.agent_slug
        ? `${r.agents?.display_name ?? r.agent_slug} (AI)`
        : r.members
        ? describe(r.members as Person, labels)
        : "someone";
      return `${speaker}: ${r.body}`;
    })
    .join("\n\n");
}

const FILE_LIST_LIMIT = 600;

// Directories that are checked in but are not the codebase: build output,
// dependencies, caches.
const SKIP_DIRS = new Set([
  "outputs", "output", "venv", ".venv", "env", "node_modules", "__pycache__",
  "vendor", "site-packages", ".ipynb_checkpoints", ".git", "dist", "build",
  ".pytest_cache", ".mypy_cache",
]);

// Files that cannot be read or discussed as text.
const SKIP_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".pdf", ".zip",
  ".gz", ".tar", ".7z", ".npy", ".npz", ".nc", ".tif", ".tiff", ".shp",
  ".dbf", ".shx", ".prj", ".cpg", ".parquet", ".pkl", ".whl", ".so",
  ".dylib", ".dll", ".exe", ".log", ".eml", ".mp4", ".mov", ".woff",
  ".woff2", ".ttf", ".eot",
];

function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.split("/").some((seg) => SKIP_DIRS.has(seg))) return false;
  if (SKIP_EXTS.some((ext) => lower.endsWith(ext))) return false;
  return true;
}

// Repo context is a nicety, not a requirement. A missing token, a renamed
// repo or a GitHub outage degrades the answer rather than failing the call.
async function loadRepoContext(channel: Channel): Promise<string | null> {
  const { github_owner: owner, github_repo: repo, github_branch: branch } = channel;
  if (!owner || !repo) return null;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cat-workspace",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  try {
    const [readmeRes, treeRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: { ...headers, Accept: "application/vnd.github.raw" },
      }),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers },
      ),
    ]);

    const parts: string[] = [
      `Repository: github.com/${owner}/${repo} (branch ${branch})`,
    ];

    let all: string[] = [];
    if (treeRes.ok) {
      const tree = await treeRes.json();
      all = (tree.tree ?? [])
        .filter((n: { type: string }) => n.type === "blob")
        .map((n: { path: string }) => n.path);
    }

    // An overview document: the README when there is one, otherwise the most
    // promising top-level markdown file. Plenty of research repositories keep
    // their orientation in a plan or notes file and never add a README.
    let overview = readmeRes.ok ? await readmeRes.text() : "";
    let overviewName = "README";

    if (!overview.trim() && all.length) {
      const candidate = pickOverviewDoc(all);
      if (candidate) {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${candidate}?ref=${branch}`,
          { headers: { ...headers, Accept: "application/vnd.github.raw" } },
        );
        if (res.ok) {
          overview = await res.text();
          overviewName = candidate;
        }
      }
    }

    if (overview.trim()) {
      parts.push(`${overviewName}:\n\n${overview.slice(0, 20000)}`);
    }

    // Truncating an unfiltered listing is worse than useless: a repository
    // that commits its generated output would spend the whole budget on
    // artifacts, alphabetically crowding out the source entirely.
    const source = all.filter(isSourcePath);
    const shown = source.slice(0, FILE_LIST_LIMIT);

    if (shown.length) {
      const omitted = all.length - shown.length;
      parts.push(
        `Source files in the repository` +
          (omitted > 0
            ? ` (${shown.length} of ${all.length}; generated output, vendored dependencies and binaries omitted)`
            : "") +
          `:\n\n${shown.join("\n")}`,
      );
    }

    if (parts.length === 1) {
      const why = treeRes.status === 404
        ? "not found, or not visible with the configured credentials"
        : `GitHub returned ${treeRes.status}`;
      return `Repository github.com/${owner}/${repo} could not be read (${why}). Answer from the conversation alone, and say so if the question needs the code.`;
    }

    return parts.join("\n\n");
  } catch {
    return null;
  }
}

// Prefer a real README, then something that reads like an overview, then a
// plan; failing all that, the first top-level markdown file there is.
function pickOverviewDoc(paths: string[]): string | null {
  const roots = paths.filter(
    (p) => !p.includes("/") && p.toLowerCase().endsWith(".md"),
  );
  if (!roots.length) return null;

  const rank = (p: string) => {
    const l = p.toLowerCase();
    if (l.includes("readme")) return 0;
    if (l.includes("overview")) return 1;
    if (l.includes("plan")) return 2;
    return 3;
  };

  return roots.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}
