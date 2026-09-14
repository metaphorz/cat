// agent-callback — the return path from a GitHub Actions run.
//
// A workflow that has just opened a pull request needs to say so in the
// channel. It cannot hold a Supabase user session, so this endpoint is
// authenticated with a shared secret instead, and is deliberately the
// narrowest thing that will do the job: it can update one code request and
// post one message about it, and nothing else.
//
// It is not a general write API. The service role key stays here rather than
// being handed to GitHub Actions, which is the whole reason this exists.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CALLBACK_SECRET = Deno.env.get("CAT_CALLBACK_SECRET") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Compare in constant time, so a caller cannot learn the secret by measuring
// how long a wrong guess takes to be rejected.
function secretMatches(given: string): boolean {
  if (!CALLBACK_SECRET || given.length !== CALLBACK_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ CALLBACK_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!CALLBACK_SECRET) {
    return json({ error: "This endpoint is not configured." }, 503);
  }
  if (!secretMatches(req.headers.get("x-cat-secret") ?? "")) {
    return json({ error: "Bad secret." }, 401);
  }

  let payload: {
    request_id?: number;
    status?: string;
    pr_url?: string;
    branch?: string;
    detail?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const { request_id, status, pr_url, branch, detail } = payload;
  if (!request_id || !status) {
    return json({ error: "request_id and status are required." }, 400);
  }
  if (status !== "opened" && status !== "failed" && status !== "running") {
    return json({ error: "status must be running, opened or failed." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // The request row is the audit trail, and also the only thing this endpoint
  // is permitted to talk about: the channel and agent come from it, not from
  // the caller, so a leaked secret cannot be used to post anywhere it likes.
  const { data: request } = await admin
    .from("code_requests")
    .select("id, channel_id, agent_slug, brief, status")
    .eq("id", request_id)
    .maybeSingle();

  if (!request) return json({ error: "Unknown request." }, 404);

  await admin
    .from("code_requests")
    .update({
      status,
      pr_url: pr_url ?? null,
      branch: branch ?? null,
      detail: detail ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id);

  // 'running' is progress, not news: record it, but do not post about it.
  if (status === "running") return json({ ok: true });

  const title = request.brief.split("\n")[0];

  const body = status === "opened"
    ? [
      `Pull request opened: [${title}](${pr_url})`,
      "",
      branch ? `Branch \`${branch}\`. Nothing is merged -- review it there.` : "",
    ].filter(Boolean).join("\n")
    : [
      `I could not open the pull request for **${title}**.`,
      "",
      detail ? "```\n" + detail.slice(0, 1500) + "\n```" : "No detail was reported.",
    ].join("\n");

  await admin.from("messages").insert({
    channel_id: request.channel_id,
    agent_slug: request.agent_slug,
    body,
    status: status === "opened" ? "complete" : "error",
    metadata: { code_request_id: request.id, pr_url: pr_url ?? null, branch: branch ?? null },
  });

  return json({ ok: true });
});
