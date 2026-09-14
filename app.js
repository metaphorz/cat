import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "./config.js";

const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

const $ = (id) => document.getElementById(id);
const el = {
  gate: $("gate"), signin: $("signin"), email: $("email"), signinBtn: $("signin-btn"),
  gateMsg: $("gate-msg"), app: $("app"), channels: $("channels"), agents: $("agents"),
  people: $("people"), meName: $("me-name"), meBadge: $("me-badge"), signout: $("signout"),
  channelName: $("channel-name"), channelPurpose: $("channel-purpose"),
  channelRepo: $("channel-repo"), messages: $("messages"), composer: $("composer"),
  input: $("input"), send: $("send"), hint: $("hint"),
  fontSize: $("font-size"),
};

// ---------------------------------------------------------------- text size

// Applied before anything renders, so a reader who has chosen a larger
// interface never sees a frame of the small one.
const FONT_KEY = "cat:font-size";
const DEFAULT_FONT = "18";

function applyFontSize(px) {
  document.documentElement.style.setProperty("--ui-font", px + "px");
}

applyFontSize(localStorage.getItem(FONT_KEY) ?? DEFAULT_FONT);

el.fontSize.value = localStorage.getItem(FONT_KEY) ?? DEFAULT_FONT;
el.fontSize.addEventListener("change", () => {
  localStorage.setItem(FONT_KEY, el.fontSize.value);
  applyFontSize(el.fontSize.value);
});

const state = {
  me: null,          // our row in `members`
  channels: [],
  agents: [],
  people: new Map(), // member id -> member row
  specialties: new Map(), // slug -> { label, position }
  online: new Set(), // member ids currently present
  channel: null,
  messages: [],
  feed: null,        // realtime subscription for the open channel
  presence: null,    // workspace-wide presence subscription
  entering: null,    // the user id currently being loaded, if any
};

// ---------------------------------------------------------------- session

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) enter(session);
  else showGate();
});

supabase.auth.getSession().then(({ data }) => {
  if (data.session) enter(data.session);
  else showGate();
});

function showGate() {
  teardown();
  el.app.hidden = true;
  el.gate.hidden = false;
}

el.signin.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el.email.value.trim();
  if (!email) return;

  el.signinBtn.disabled = true;
  setGateMsg("Sending...", "");

  // Send people back to this exact page, minus any leftover query string.
  const redirect = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect },
  });

  el.signinBtn.disabled = false;
  if (error) setGateMsg(error.message, "err");
  else setGateMsg("Check your email for a sign-in link.", "ok");
});

function setGateMsg(text, cls) {
  el.gateMsg.textContent = text;
  el.gateMsg.className = "msg" + (cls ? " " + cls : "");
}

el.signout.addEventListener("click", () => supabase.auth.signOut());

async function enter(session) {
  // On load, onAuthStateChange and getSession both fire, so without this guard
  // the whole workspace loads twice concurrently -- and if the second pass
  // fails, its empty results overwrite the good ones from the first.
  if (state.entering === session.user.id || state.me?.id === session.user.id) {
    supabase.realtime.setAuth(session.access_token);
    return;
  }
  state.entering = session.user.id;

  // Realtime authorizes each subscriber against RLS using this token, so it
  // has to be handed over before any channel is opened.
  supabase.realtime.setAuth(session.access_token);

  const { data: me, error } = await supabase
    .from("members")
    .select("id, email, display_name, can_invoke_agent, is_admin")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !me) {
    // Authenticated with Supabase, but with no row in `members` -- which the
    // signup trigger only creates for allowlisted addresses.
    state.entering = null;
    await supabase.auth.signOut();
    showGate();
    setGateMsg("That account is not a member of this workspace.", "err");
    return;
  }

  state.me = me;
  el.meName.textContent = me.display_name;
  el.meBadge.hidden = !me.can_invoke_agent;

  el.gate.hidden = true;
  el.app.hidden = false;

  await loadSpecialties();
  await Promise.all([loadChannels(), loadAgents(), loadPeople()]);
  watchPresence();
  updateHint();

  state.entering = null;

  if (state.channels.length) {
    // A magic-link return lands with the auth tokens in the fragment
    // (#access_token=...). Supabase normally clears it before we get here,
    // but only a clean slug is ever treated as a channel name.
    const hash = window.location.hash.replace(/^#/, "");
    const wanted = /^[a-z0-9_-]+$/i.test(hash) ? hash : "";
    openChannel(state.channels.find((c) => c.slug === wanted) ?? state.channels[0]);
  }
}

function teardown() {
  if (state.feed) supabase.removeChannel(state.feed);
  if (state.presence) supabase.removeChannel(state.presence);
  Object.assign(state, {
    me: null, channels: [], agents: [], people: new Map(), online: new Set(),
    specialties: new Map(), channel: null, messages: [], feed: null,
    presence: null, entering: null,
  });
}

// ---------------------------------------------------------------- loading

async function loadChannels() {
  const { data, error } = await supabase
    .from("channels")
    .select("id, slug, name, purpose, github_owner, github_repo, github_branch")
    .order("position")
    .order("slug");

  // Leaving a correct list alone beats replacing it with an empty one.
  if (error || !data) {
    console.error("[cat] could not load channels:", error);
    return;
  }

  state.channels = data;
  el.channels.replaceChildren(...state.channels.map((c) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "# " + c.slug;
    b.addEventListener("click", () => openChannel(c));
    li.append(b);
    return li;
  }));
}

async function loadAgents() {
  const { data, error } = await supabase
    .from("agents")
    .select("slug, display_name, model, enabled")
    .eq("enabled", true)
    .order("slug");

  if (error || !data) {
    console.error("[cat] could not load agents:", error);
    return;
  }

  state.agents = data;
  el.agents.replaceChildren(...state.agents.map((a) => {
    const li = document.createElement("li");
    li.className = "agent";
    li.innerHTML = `<span class="dot on"></span><span>@${escapeHtml(a.slug)}</span>`;
    li.title = a.model;
    return li;
  }));
}

async function loadSpecialties() {
  const { data } = await supabase
    .from("specialties")
    .select("slug, label, description, position")
    .order("position");

  state.specialties = new Map((data ?? []).map((s) => [s.slug, s]));
}

async function loadPeople() {
  const { data, error } = await supabase
    .from("members")
    .select("id, display_name, username, specialty, can_invoke_agent")
    .order("display_name");

  if (error || !data) {
    console.error("[cat] could not load people:", error);
    return;
  }

  state.people = new Map(data.map((m) => [m.id, m]));
  renderPeople();
}

function specialtyLabel(slug) {
  return state.specialties.get(slug)?.label ?? slug ?? "";
}

// Grouped by discipline rather than listed flat: in a mixed group, knowing
// who the meteorologists are is most of the value of a member list.
function renderPeople() {
  const groups = new Map();
  for (const m of state.people.values()) {
    const key = m.specialty ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const ordered = [...groups.entries()].sort(([a], [b]) => {
    // Anyone who has not set a specialty sorts to the bottom.
    const pa = a ? state.specialties.get(a)?.position ?? 99 : 999;
    const pb = b ? state.specialties.get(b)?.position ?? 99 : 999;
    return pa - pb;
  });

  const out = [];
  for (const [slug, members] of ordered) {
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = slug ? specialtyLabel(slug) : "No specialty set";
    if (slug) head.title = state.specialties.get(slug)?.description ?? "";
    out.push(head);

    for (const m of members) {
      const li = document.createElement("li");
      const on = state.online.has(m.id);
      li.innerHTML =
        `<span class="dot${on ? " on" : ""}"></span>` +
        `<span class="who">${escapeHtml(m.display_name)}` +
        (m.id === state.me.id ? " (you)" : "") +
        (m.username ? `<span class="handle">@${escapeHtml(m.username)}</span>` : "") +
        `</span>`;
      out.push(li);
    }
  }

  el.people.replaceChildren(...out);
}

// Presence is workspace-wide rather than per-channel: with a group this size,
// "who is around" is more useful than "who is looking at this channel".
function watchPresence() {
  state.presence = supabase.channel("presence:workspace", {
    config: { presence: { key: state.me.id } },
  });

  state.presence
    .on("presence", { event: "sync" }, () => {
      state.online = new Set(Object.keys(state.presence.presenceState()));
      renderPeople();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await state.presence.track({ name: state.me.display_name });
      }
    });
}

// ---------------------------------------------------------------- channel

async function openChannel(channel) {
  state.channel = channel;
  window.location.hash = channel.slug;

  for (const b of el.channels.querySelectorAll("button")) {
    b.setAttribute("aria-current", String(b.textContent === "# " + channel.slug));
  }

  el.channelName.textContent = "# " + channel.slug;
  el.channelPurpose.textContent = channel.purpose ?? "";
  if (channel.github_owner && channel.github_repo) {
    el.channelRepo.hidden = false;
    el.channelRepo.href = `https://github.com/${channel.github_owner}/${channel.github_repo}`;
    el.channelRepo.textContent = `github.com/${channel.github_owner}/${channel.github_repo}`;
  } else {
    el.channelRepo.hidden = true;
  }

  el.input.placeholder = `Message #${channel.slug}`;
  el.messages.replaceChildren();

  await loadMessages();
  subscribe();
  updateHint();
}

// The most recent HISTORY_LIMIT messages, oldest first for display.
// Ordering ascending and limiting would take the oldest ones instead, which
// looks identical until a channel passes the limit and then silently hides
// everything anyone has said recently.
const HISTORY_LIMIT = 300;

async function loadMessages() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, channel_id, author_id, agent_slug, body, status, metadata, created_at")
    .eq("channel_id", state.channel.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error || !data) {
    console.error("[cat] could not load messages:", error);
    return;
  }

  state.messages = data.reverse();
  renderMessages();
}

function subscribe() {
  if (state.feed) supabase.removeChannel(state.feed);

  state.feed = supabase
    .channel(`messages:${state.channel.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "messages",
        filter: `channel_id=eq.${state.channel.id}`,
      },
      (payload) => {
        if (payload.eventType === "INSERT") {
          if (!state.messages.some((m) => m.id === payload.new.id)) {
            state.messages.push(payload.new);
          }
        } else if (payload.eventType === "UPDATE") {
          const i = state.messages.findIndex((m) => m.id === payload.new.id);
          if (i !== -1) state.messages[i] = payload.new;
        } else if (payload.eventType === "DELETE") {
          state.messages = state.messages.filter((m) => m.id !== payload.old.id);
        }
        renderMessages();
      },
    )
    .subscribe();
}

// ---------------------------------------------------------------- rendering

function renderMessages() {
  // Only follow the tail if the reader is already there, so an arriving
  // message never yanks someone away from what they were reading.
  const pinned =
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;

  if (!state.messages.length) {
    el.messages.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "empty",
        textContent: `No messages in #${state.channel.slug} yet.`,
      }),
    );
    return;
  }

  const rows = [];
  let prev = null;

  for (const m of state.messages) {
    const speaker = speakerOf(m);
    const sameSpeaker = prev && speakerOf(prev).key === speaker.key;
    const soonAfter =
      prev && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60 * 1000;
    rows.push(renderMessage(m, speaker, sameSpeaker && soonAfter));
    prev = m;
  }

  el.messages.replaceChildren(...rows);
  if (pinned) el.messages.scrollTop = el.messages.scrollHeight;
}

function speakerOf(m) {
  if (m.agent_slug) {
    const agent = state.agents.find((a) => a.slug === m.agent_slug);
    return {
      key: "agent:" + m.agent_slug,
      name: agent?.display_name ?? m.agent_slug,
      isAgent: true,
    };
  }
  const person = state.people.get(m.author_id);
  return {
    key: "person:" + m.author_id,
    name: person?.display_name ?? "someone",
    specialty: person?.specialty ? specialtyLabel(person.specialty) : "",
    isAgent: false,
  };
}

function renderMessage(m, speaker, continued) {
  const row = document.createElement("div");
  row.className = "msg-row" +
    (speaker.isAgent ? " by-agent" : "") +
    (continued ? " continued" : " fresh");

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = speaker.isAgent ? "AI" : initials(speaker.name);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (!continued) {
    const head = document.createElement("div");
    head.className = "msg-head";
    head.innerHTML =
      `<span class="author">${escapeHtml(speaker.name)}</span>` +
      (speaker.isAgent ? `<span class="tag">agent</span>` : "") +
      (speaker.specialty ? `<span class="tag">${escapeHtml(speaker.specialty)}</span>` : "") +
      `<span class="time">${formatTime(m.created_at)}</span>`;
    body.append(head);
  }

  const text = document.createElement("div");
  if (m.status === "pending") {
    text.className = "text thinking";
    text.textContent = `${speaker.name} is thinking`;
  } else if (m.status === "error") {
    text.className = "text errored";
    text.textContent = m.body;
  } else {
    text.className = "text";
    text.innerHTML = renderMarkdown(m.body);
  }
  body.append(text);

  const usage = m.metadata?.usage;
  if (m.status === "complete" && usage) {
    const note = document.createElement("div");
    note.className = "usage";
    note.textContent = [
      m.metadata.model,
      `${usage.input_tokens} in / ${usage.output_tokens} out`,
      usage.cache_read_input_tokens ? `${usage.cache_read_input_tokens} cached` : null,
      m.metadata.invoked_by ? `asked by ${m.metadata.invoked_by}` : null,
    ].filter(Boolean).join("  -  ");
    body.append(note);
  }

  row.append(avatar, body);
  return row;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function formatTime(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
}

// Markdown, rendered to the extent this conversation needs: fenced code,
// tables, headings, lists, blockquotes, LaTeX maths, and the usual inline
// marks. Written by hand rather than pulled from a library because the input
// is untrusted -- everything is escaped before any structure is applied, so
// nothing a message contains can become live markup.
//
// Code and maths are lifted out first and restored last, so the inline rules
// never touch their contents. The placeholders are private-use code points,
// which cannot occur in anything a person would type.
const HOLD_OPEN = "";
const HOLD_CLOSE = "";

function renderMarkdown(src) {
  const held = [];
  const hold = (html) => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };

  let text = String(src);

  // 1. Fenced code.
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return hold(
      `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
    );
  });

  // 2. Maths, display before inline so $$...$$ is not eaten by $...$.
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => hold(renderMath(tex, true)));
  text = text.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, before, tex) =>
    before + hold(renderMath(tex, false)));

  // 3. Everything that survives is prose, and is escaped before any structure
  //    is applied to it.
  text = escapeHtml(text);

  // 4. Block structure.
  const blocks = text.split(/\n{2,}/).map(renderBlock).join("");

  // 5. Put the code and maths back.
  return blocks.replace(
    new RegExp(HOLD_OPEN + "(\\d+)" + HOLD_CLOSE, "g"),
    (_, i) => held[i],
  );
}

function renderMath(tex, display) {
  // KaTeX is loaded from a CDN; if it did not arrive, show the source rather
  // than a blank space, so the reader can still follow the notation.
  if (typeof katex === "undefined") {
    return `<code class="math-raw">${escapeHtml(tex)}</code>`;
  }
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return `<code class="math-raw">${escapeHtml(tex)}</code>`;
  }
}

function renderBlock(block) {
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return "";

  // A held code block or display equation standing alone: emit it bare rather
  // than wrapping a <pre> inside a <p>.
  if (lines.length === 1 && /^\d+$/.test(lines[0].trim())) {
    return lines[0].trim();
  }

  if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(block)) return "<hr>";

  const heading = lines[0].match(/^(#{1,4})\s+(.*)$/);
  if (heading && lines.length === 1) {
    const level = Math.min(heading[1].length + 2, 6); // h1 is the page, not a message
    return `<h${level}>${inline(heading[2])}</h${level}>`;
  }

  // Escaping has already run by this point, so a quote marker is &gt;, not >.
  if (lines.every((l) => /^\s*&gt;/.test(l))) {
    const body = lines.map((l) => l.replace(/^\s*&gt;\s?/, "")).join(" ");
    return `<blockquote>${inline(body)}</blockquote>`;
  }

  if (isTable(lines)) return renderTable(lines);

  if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
    const items = lines
      .map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    const items = lines
      .map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  }

  // Mixed content: headings and list items can share a paragraph when an agent
  // writes them without blank lines between, so handle them line by line.
  if (lines.some((l) => /^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s)/.test(l))) {
    return renderMixed(lines);
  }

  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

// Agents frequently write a heading, then bullets, with no blank line between.
// Treating that as one paragraph loses the structure entirely.
function renderMixed(lines) {
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      if (list?.tag !== "ul") { closeList(); list = { tag: "ul", items: [] }; }
      list.items.push(`<li>${inline(bullet[1])}</li>`);
    } else if (number) {
      if (list?.tag !== "ol") { closeList(); list = { tag: "ol", items: [] }; }
      list.items.push(`<li>${inline(number[1])}</li>`);
    } else if (list) {
      // A continuation line belongs to the item above it.
      list.items[list.items.length - 1] =
        list.items[list.items.length - 1].replace("</li>", " " + inline(line) + "</li>");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }

  closeList();
  return out.join("");
}

function isTable(lines) {
  return (
    lines.length >= 2 &&
    lines[0].includes("|") &&
    /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[1]) &&
    lines[1].includes("-")
  );
}

function renderTable(lines) {
  const cells = (row) =>
    row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

  // The separator row may carry alignment, as :--- or ---: or :---:
  const aligns = cells(lines[1]).map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return " style=\"text-align:center\"";
    if (right) return " style=\"text-align:right\"";
    return "";
  });

  const head = cells(lines[0])
    .map((c, i) => `<th${aligns[i] ?? ""}>${inline(c)}</th>`)
    .join("");

  const body = lines
    .slice(2)
    .map((row) =>
      "<tr>" +
      cells(row).map((c, i) => `<td${aligns[i] ?? ""}>${inline(c)}</td>`).join("") +
      "</tr>")
    .join("");

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>`;
}

// Inline marks. Operates on already-escaped text.
function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/(^|\s)(@[a-z0-9_-]+)/gi, '$1<span class="mention">$2</span>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- composing

el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + "px";
  updateHint();
});

el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

// Which agent, if any, this draft is addressed to.
function mentionedAgent(text) {
  for (const a of state.agents) {
    if (new RegExp(`(^|\\s)@${a.slug}\\b`, "i").test(text)) return a;
  }
  return null;
}

function updateHint() {
  const agent = mentionedAgent(el.input.value);
  if (!agent) {
    const names = state.agents.map((a) => "@" + a.slug).join(", ");
    el.hint.className = "hint";
    el.hint.innerHTML = state.me?.can_invoke_agent && names
      ? `Address <span class="mention">${escapeHtml(names)}</span> to bring an agent in.`
      : "";
  } else if (state.me?.can_invoke_agent) {
    el.hint.className = "hint";
    el.hint.innerHTML = `<span class="mention">@${escapeHtml(agent.slug)}</span> will reply.`;
  } else {
    el.hint.className = "hint err";
    el.hint.textContent =
      `You can mention @${agent.slug}, but only members with agent permission can summon one.`;
  }
}

el.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = el.input.value.trim();
  if (!body || !state.channel) return;

  el.send.disabled = true;
  el.input.value = "";
  el.input.style.height = "auto";

  const { data: posted, error } = await supabase
    .from("messages")
    .insert({ channel_id: state.channel.id, author_id: state.me.id, body })
    .select("id, channel_id, author_id, agent_slug, body, status, metadata, created_at")
    .single();

  el.send.disabled = false;

  if (error) {
    el.input.value = body;
    el.hint.className = "hint err";
    el.hint.textContent = "Could not send: " + error.message;
    return;
  }

  // Realtime usually beats this, but showing our own message immediately
  // keeps the composer feeling responsive on a slow connection.
  if (!state.messages.some((m) => m.id === posted.id)) {
    state.messages.push(posted);
    renderMessages();
  }

  const agent = mentionedAgent(body);
  if (agent && state.me.can_invoke_agent) await invoke(agent, body);

  updateHint();
  el.input.focus();
});

async function invoke(agent, prompt) {
  const { error } = await supabase.functions.invoke("invoke-agent", {
    body: { channel_id: state.channel.id, agent: agent.slug, prompt },
  });

  if (!error) return;

  // The function's own refusals arrive as an HTTP error carrying a JSON body.
  let detail = error.message;
  try {
    const parsed = await error.context?.json?.();
    if (parsed?.error) detail = parsed.error;
  } catch { /* fall back to the generic message */ }

  el.hint.className = "hint err";
  el.hint.textContent = `@${agent.slug} could not be reached: ${detail}`;
}
