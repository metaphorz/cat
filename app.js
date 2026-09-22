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
  input: $("input"), send: $("send"), hint: $("hint"), palette: $("palette"),
  tray: $("tray"), attach: $("attach"), attachBtn: $("attach-btn"),
  fontSize: $("font-size"), theme: $("theme"),
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

// -------------------------------------------------------------------- theme

// Light is the default and the theme is only ever what someone chose here --
// the system's own light/dark preference is deliberately not consulted. A
// workspace that looked different on two machines belonging to the same person
// would be a puzzle, not a feature.
//
// The document may already carry data-theme: the inline script in the head
// applies the saved choice before the first paint, and this only has to keep
// the toggle in step with it from here on.
const THEME_KEY = "cat:theme";

function applyTheme(name) {
  if (name === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

el.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {
    // Unwritable storage costs the preference on reload, not the click.
  }
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
  notes: [],         // command replies: local to this browser, never stored
  tray: [],          // images picked but not yet sent
  shots: new Map(),  // storage path -> signed URL, refreshed on load
  paletteAt: -1,     // highlighted row in the command palette, -1 when closed
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
    specialties: new Map(), channel: null, messages: [], notes: [],
    tray: [], shots: new Map(),
    paletteAt: -1, feed: null, presence: null, entering: null,
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
  // A command's answer was about the channel it was run in, so it does not
  // follow you to the next one.
  state.notes = [];
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
    .select("id, channel_id, author_id, agent_slug, body, status, metadata, attachments, created_at")
    .eq("channel_id", state.channel.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error || !data) {
    console.error("[cat] could not load messages:", error);
    return;
  }

  state.messages = data.reverse();
  await signShots(state.messages);
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
      async (payload) => {
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
        // Someone else's image arrives as a path with no signature, so render
        // once to place the message and again once its URL exists.
        renderMessages();
        if (payload.new?.attachments?.length) {
          await signShots([payload.new]);
          renderMessages();
        }
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

  const rows = [];
  let prev = null;

  if (!state.messages.length) {
    rows.push(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: `No messages in #${state.channel.slug} yet.`,
    }));
  }

  // Notes are merged in by time rather than appended, so a message sent after
  // a command appears after it. Appending them put every later message below
  // the reply -- and under a tall one like /model, below the fold, which read
  // as the message never having been sent at all.
  const timeline = [
    ...state.messages.map((m) => ({ at: m.created_at, message: m })),
    ...state.notes.map((n) => ({ at: n.created_at, note: n })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  for (const item of timeline) {
    if (item.note) {
      rows.push(renderNote(item.note));
      prev = null; // never continue a speaker's run across a note
      continue;
    }
    const m = item.message;
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
  // An image-only message has no text to draw, and an empty bubble above it
  // reads as a rendering fault rather than as a deliberate silence.
  if (m.body || m.status !== "complete") body.append(text);

  const shots = shotsFor(m);
  if (shots) body.append(shots);

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
  // A dollar amount is not an equation. Two prices on one line -- "$5.00 in,
  // $25.00 out" -- otherwise pair up and render as mathematics, which is how
  // /model and /cost first came out. Real inline maths never opens on a digit
  // or a space ($x^2$, $\alpha$), so requiring that is enough to tell them
  // apart without a flag.
  text = text.replace(/(^|[^\\$])\$(?![\d\s])([^$\n]+?)\$/g, (_, before, tex) =>
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

  // A single newline inside a paragraph is a space, not a line break; two
  // trailing spaces, or a trailing backslash, make it a break. That is the
  // Markdown rule, and it matters more than it sounds: text copied out of a
  // terminal arrives already wrapped at the terminal's width, and treating
  // every one of those wraps as a break reproduced the ragged right edge of
  // somebody's terminal in the middle of the conversation.
  const parts = lines.map((line, i) => {
    const hard = /(\s{2}|\\)$/.test(line);
    const html = inline(hard ? line.replace(/(\s{2}|\\)$/, "") : line);
    if (i === lines.length - 1) return html;
    return html + (hard ? "<br>" : " ");
  });

  return `<p>${parts.join("")}</p>`;
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
  renderPalette();
  updateHint();
});

el.input.addEventListener("keydown", (e) => {
  // While the palette is open it owns the arrows, Enter, Tab and Escape --
  // Enter especially, which would otherwise send "/mod" as a message.
  if (!el.palette.hidden) {
    const hits = paletteHits();

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      state.paletteAt = (state.paletteAt + step + hits.length) % hits.length;
      renderPalette();
      return;
    }

    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const picked = hits[state.paletteAt].dataset.name;

      // Enter on a command already typed in full runs it. Otherwise the
      // palette would swallow the keystroke, leaving the draft untouched and
      // the command apparently ignored until Enter was pressed a second time.
      if (e.key === "Enter" && commandDraft() === picked) {
        el.palette.hidden = true;
        state.paletteAt = -1;
        el.composer.requestSubmit();
        return;
      }

      paletteChoose(picked);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      el.palette.hidden = true;
      state.paletteAt = -1;
      return;
    }
  }

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
  const waiting = state.tray.filter((t) => !t.path && !t.error).length;
  const ready = state.tray.filter((t) => t.path).length;
  const failed = state.tray.filter((t) => t.error).length;

  if (waiting || ready || failed) {
    el.hint.className = "hint" + (failed ? " err" : "");
    el.hint.textContent = failed
      ? `${failed} image${failed === 1 ? "" : "s"} failed to upload`
      : waiting
      ? `Uploading ${waiting} image${waiting === 1 ? "" : "s"}...`
      : `${ready} image${ready === 1 ? "" : "s"} ready. Send with or without a message.`;
    return;
  }

  if (state.me?.is_admin && el.input.value.startsWith("/")) {
    el.hint.className = "hint";
    el.hint.textContent = "Commands run for you alone -- nothing is posted.";
    return;
  }

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


// ------------------------------------------------------------------- images

// The bucket is private, so nothing has a lasting URL. Each path is signed
// for an hour at load time and cached; a link that expires is the price of a
// link that cannot be forwarded out of the workspace and still work.
const SHOT_TTL = 3600;

async function signShots(messages) {
  const paths = [];
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.path && !state.shots.has(a.path)) paths.push(a.path);
    }
  }
  if (!paths.length) return;

  const { data, error } = await supabase.storage
    .from("attachments")
    .createSignedUrls(paths, SHOT_TTL);

  if (error) {
    console.error("[cat] could not sign attachments:", error);
    return;
  }
  for (const row of data ?? []) {
    if (row.signedUrl) state.shots.set(row.path, row.signedUrl);
  }
}

function shotsFor(m) {
  const list = (m.attachments ?? []).filter((a) => state.shots.has(a.path));
  if (!list.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "shots";
  for (const a of list) {
    const link = document.createElement("a");
    link.href = state.shots.get(a.path);
    link.target = "_blank";
    link.rel = "noopener";
    const img = document.createElement("img");
    img.src = state.shots.get(a.path);
    img.alt = a.name || "attached image";
    img.loading = "lazy";
    // Reserve the right box before the bytes arrive, so a long conversation
    // does not jump about as each image lands.
    if (a.width && a.height) {
      img.width = a.width;
      img.height = a.height;
    }
    link.append(img);
    wrap.append(link);
  }
  return wrap;
}

// Measure in the browser rather than trusting a name: the dimensions are only
// used to reserve layout space, but a wrong aspect ratio is visible.
function measure(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight, preview: null });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null, preview: null });
    };
    img.src = url;
  });
}

const MAX_SHOT = 10 * 1024 * 1024;

function renderTray() {
  el.tray.hidden = state.tray.length === 0;
  el.tray.replaceChildren(...state.tray.map((item, i) => {
    const fig = document.createElement("figure");
    fig.className = item.error ? "failed" : (item.path ? "" : "busy");
    const img = document.createElement("img");
    img.src = item.preview;
    img.alt = item.file.name;
    const drop = document.createElement("button");
    drop.type = "button";
    drop.textContent = "\u00d7";
    drop.title = item.error ? item.error : "Remove";
    drop.addEventListener("click", () => {
      URL.revokeObjectURL(state.tray[i].preview);
      state.tray.splice(i, 1);
      renderTray();
      updateHint();
    });
    fig.append(img, drop);
    return fig;
  }));
}

// Uploads start the moment a file is chosen rather than on send, so the wait
// happens while the message is still being typed.
async function takeFiles(files) {
  const all = [...files];
  const images = all.filter((f) => f.type.startsWith("image/"));
  const rejected = all.filter((f) => !f.type.startsWith("image/"));

  // Say so. Dropping a spreadsheet and having nothing at all happen reads as
  // a broken page rather than as a limit.
  if (rejected.length) {
    el.hint.className = "hint err";
    el.hint.textContent = rejected.length === 1
      ? `${rejected[0].name} is not an image -- only images can be attached.`
      : `${rejected.length} files were not images and were not attached.`;
  }

  if (!images.length) return;

  for (const file of images) {
    if (file.size > MAX_SHOT) {
      el.hint.className = "hint err";
      el.hint.textContent = `${file.name} is larger than 10 MB.`;
      continue;
    }

    const item = { file, preview: URL.createObjectURL(file), path: null, error: null };
    state.tray.push(item);
    renderTray();

    const dims = await measure(file);
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "png").toLowerCase();
    const path = `${state.me.id}/${crypto.randomUUID()}.${ext}`;

    const { error } = await supabase.storage
      .from("attachments")
      .upload(path, file, { contentType: file.type, upsert: false });

    if (error) {
      item.error = error.message;
      console.error("[cat] upload failed:", error);
    } else {
      item.path = path;
      item.width = dims.width;
      item.height = dims.height;
    }
    renderTray();
    updateHint();
  }
}

el.attachBtn.addEventListener("click", () => el.attach.click());
el.attach.addEventListener("change", () => {
  takeFiles(el.attach.files);
  el.attach.value = "";
});

// A screen grab copied with cmd-ctrl-shift-4 arrives on the clipboard, not as
// a file, so paste has to be handled separately from drop.
el.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.some((f) => f.type.startsWith("image/"))) {
    e.preventDefault();
    takeFiles(files);
  }
});

// The whole message area accepts a drop. dragenter and dragleave fire for
// every child element the pointer crosses, so the highlight is counted in
// rather than toggled, or it flickers its way across the conversation.
let dragDepth = 0;

function draggingFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

el.messages.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  el.messages.classList.add("dropping");
});

el.messages.addEventListener("dragover", (e) => {
  if (draggingFiles(e)) e.preventDefault();
});

el.messages.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.messages.classList.remove("dropping");
});

el.messages.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.messages.classList.remove("dropping");
  takeFiles(e.dataTransfer.files);
  el.input.focus();
});

// Text dragged out of a message and dropped on the composer. A textarea will
// accept a text drop on its own, but only onto the textarea itself and only
// once the browser has decided the gesture is a drag rather than a selection.
// Handling it here makes the whole composer a target and makes the insertion
// point predictable: it lands where the caret is, not where the pointer was.
function insertAtCaret(text) {
  const input = el.input;
  const at = input.selectionStart ?? input.value.length;
  const to = input.selectionEnd ?? at;
  const before = input.value.slice(0, at);
  const after = input.value.slice(to);

  // Keep words apart when dropping into the middle of a sentence, without
  // inventing a space at the start of an empty box.
  const lead = before && !/\s$/.test(before) ? " " : "";
  input.value = before + lead + text + after;

  const caret = (before + lead + text).length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input"));
  input.focus();
}

function draggingText(e) {
  const types = [...(e.dataTransfer?.types ?? [])];
  return types.includes("text/plain") && !types.includes("Files");
}

el.composer.addEventListener("dragover", (e) => {
  if (draggingText(e) || draggingFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = draggingFiles(e) ? "copy" : "copy";
    el.composer.classList.add("dropping");
  }
});

el.composer.addEventListener("dragleave", (e) => {
  if (!el.composer.contains(e.relatedTarget)) el.composer.classList.remove("dropping");
});

el.composer.addEventListener("drop", (e) => {
  el.composer.classList.remove("dropping");

  if (draggingFiles(e)) {
    e.preventDefault();
    takeFiles(e.dataTransfer.files);
    el.input.focus();
    return;
  }

  if (!draggingText(e)) return;
  const text = e.dataTransfer.getData("text/plain");
  if (!text) return;

  e.preventDefault();
  insertAtCaret(text.replace(/\s+$/, ""));
});


// --------------------------------------------------------------- copying out

// Copying from a rendered message and pasting it back should produce what was
// copied. Two things stop that by default. KaTeX renders every formula twice
// -- once visually and once as MathML for screen readers -- and hides the
// second with clipping rather than with user-select, so a plain copy picks up
// both and yields doubled nonsense. And the markers are gone: bold is a
// <strong>, code is a <code>, so the paste arrives as flat prose.
//
// So the selection is walked and turned back into Markdown. The vocabulary is
// small because renderMarkdown's is small: whatever it can render, this has to
// be able to reproduce.
function texOf(node) {
  const ann = node.querySelector?.('annotation[encoding="application/x-tex"]');
  return ann ? ann.textContent : null;
}

function wrap(text, mark) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m && m[2] ? m[1] + mark + m[2] + mark + m[3] : text;
}

function toMarkdown(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1) return "";

  const tag = node.tagName?.toLowerCase();
  const cls = node.classList;

  // A formula: take the TeX the model actually wrote, not the glyphs.
  if (cls?.contains("katex") || cls?.contains("katex-display")) {
    const tex = texOf(node);
    if (tex) return cls.contains("katex-display") ? `$$${tex}$$` : `$${tex}$`;
  }
  // Reached only when a selection starts or ends inside a formula, so the
  // wrapper was not cloned. The visual half is aria-hidden duplicate text.
  if (cls?.contains("katex-mathml")) return "";

  const kids = () => [...node.childNodes].map(toMarkdown).join("");

  switch (tag) {
    case "br": return "\n";
    // Markers have to hug their text: "**bold **" is not bold in CommonMark,
    // and bold wrapping a code span produces exactly that if the whitespace
    // is left where it fell.
    case "strong": case "b": return wrap(kids(), "**");
    case "em": case "i": return wrap(kids(), "*");
    case "code": return node.closest?.("pre") ? kids() : `\`${kids()}\``;
    case "pre": return "```\n" + node.textContent.replace(/\n$/, "") + "\n```\n\n";
    case "a": {
      const href = node.getAttribute?.("href");
      const text = kids();
      return href && href !== text ? `[${text}](${href})` : text;
    }
    case "li": return `- ${kids()}\n`;
    case "ul": case "ol": return kids() + "\n";
    case "blockquote":
      return kids().trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return `${"#".repeat(Math.max(1, Number(tag[1]) - 2))} ${kids()}\n\n`;
    case "p": case "div": return kids() + "\n\n";
    case "tr": return [...node.children].map((c) => toMarkdown(c).trim()).join(" | ") + "\n";
    case "td": case "th": return kids();
    default: return kids();
  }
}

document.addEventListener("copy", (e) => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  // Only rewrite copies taken from a rendered message. A selection anywhere
  // else -- the sidebar, the composer, a command note -- is left alone.
  const from = (sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement);
  if (!from?.closest?.(".text")) return;

  const md = toMarkdown(sel.getRangeAt(0).cloneContents())
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!md) return;
  e.clipboardData.setData("text/plain", md);
  e.preventDefault();
});

// ------------------------------------------------------------ slash commands



// Offered only to admins, and only as a convenience: admin-command refuses
// the request itself, so knowing the names buys a non-admin nothing.
const COMMANDS = [
  { name: "model", args: "[agent] [model]", blurb: "list or switch the default model" },
  { name: "retry", args: "[model]", blurb: "rerun the last ask on another model" },
  { name: "answer", args: "on|off [agent]", blurb: "answer this channel without @mentions" },
  { name: "clear", args: "", blurb: "save the transcript and empty the channel" },
  { name: "verbose", args: "on|off", blurb: "how long agent replies should be here" },
  { name: "status", args: "", blurb: "messages, tokens and channels" },
  { name: "who", args: "", blurb: "members, and who has yet to sign in" },
  { name: "cost", args: "", blurb: "OpenRouter credit remaining" },
  { name: "invite", args: "<email> <specialty>", blurb: "add someone to the allowlist" },
];

// Hand a file to the browser without it ever having been stored anywhere.
function saveFile(name, body) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderNote(note) {
  const box = document.createElement("div");
  box.className = "note" + (note.error ? " err" : "");
  box.innerHTML =
    `<div class="note-head"><b>/${escapeHtml(note.command)}</b>` +
    `<span>only you can see this</span></div>` +
    renderMarkdown(note.text);
  return box;
}

function addNote(command, text, error = false) {
  state.notes.push({ command, text, error, created_at: new Date().toISOString() });
  renderMessages();
  el.messages.scrollTop = el.messages.scrollHeight;
}

// The command word while it is still being typed -- "mod" for "/mod". Null
// once a space is typed, since by then the palette would be in the way of
// the arguments rather than helping with them.
function commandDraft() {
  if (!state.me?.is_admin) return null;
  const m = /^\/([a-z]*)$/i.exec(el.input.value);
  return m ? m[1].toLowerCase() : null;
}

function renderPalette() {
  const draft = commandDraft();
  const hits = draft === null
    ? []
    : COMMANDS.filter((c) => c.name.startsWith(draft));

  if (!hits.length) {
    el.palette.hidden = true;
    state.paletteAt = -1;
    return;
  }

  if (state.paletteAt < 0 || state.paletteAt >= hits.length) state.paletteAt = 0;

  el.palette.innerHTML = hits
    .map((c, i) =>
      `<div class="palette-item" role="option" data-name="${c.name}" ` +
      `aria-selected="${i === state.paletteAt}">` +
      `<span class="palette-name">/${c.name}</span>` +
      `<span class="palette-args">${escapeHtml(c.args)}</span>` +
      `<span class="palette-blurb">${escapeHtml(c.blurb)}</span></div>`
    )
    .join("");
  el.palette.hidden = false;
}

function paletteHits() {
  return [...el.palette.querySelectorAll(".palette-item")];
}

// Completing a command leaves the trailing space in place: every command that
// takes arguments is then ready for them, and the palette closes because the
// draft is no longer a bare command word.
function paletteChoose(name) {
  const spec = COMMANDS.find((c) => c.name === name);
  el.input.value = "/" + name + (spec?.args ? " " : "");
  el.palette.hidden = true;
  state.paletteAt = -1;
  el.input.focus();
  updateHint();
}

el.palette.addEventListener("mousedown", (e) => {
  // mousedown, not click: the textarea must not lose focus first.
  e.preventDefault();
  const item = e.target.closest(".palette-item");
  if (item) paletteChoose(item.dataset.name);
});


// /clear is one command that does two things, because being asked to confirm
// something you already asked for is a poor guard. The real guard is the
// order: the transcript is fetched and written to disk first, and the delete
// only runs if that succeeded. A browser that refuses the download leaves the
// channel exactly as it was.
async function clearChannel() {
  const channelId = state.channel.id;

  const { data, error } = await supabase.functions.invoke("admin-command", {
    body: { command: "clear", args: [], channel_id: channelId },
  });

  if (error) {
    addNote("clear", await detailOf(error), true);
    return;
  }
  if (!data?.download) {
    addNote("clear", data?.text ?? "Nothing to clear.");
    return;
  }

  try {
    saveFile(data.download.name, data.download.body);
  } catch (e) {
    addNote(
      "clear",
      `Could not save the transcript (${e.message}), so **nothing was deleted**. ` +
        "The channel is untouched.",
      true,
    );
    return;
  }

  const { data: done, error: failed } = await supabase.functions.invoke("admin-command", {
    body: {
      command: "clear",
      args: ["confirm", String(data.clear_up_to)],
      channel_id: channelId,
    },
  });

  if (failed) {
    addNote(
      "clear",
      `**${data.download.name}** was saved, but the channel could not be emptied: ` +
        (await detailOf(failed)),
      true,
    );
    return;
  }

  state.notes = [];
  await loadMessages();
  addNote("clear", `Saved **${data.download.name}** to your downloads.\n\n${done?.text ?? ""}`);
}

// The function's own refusals arrive as an HTTP error carrying a JSON body.
async function detailOf(error) {
  try {
    const parsed = await error.context?.json?.();
    if (parsed?.error) return parsed.error;
  } catch { /* fall through to the generic message */ }
  return error.message;
}

async function runCommand(raw) {
  const [word, ...args] = raw.slice(1).split(/\s+/).filter(Boolean);
  const command = (word ?? "").toLowerCase();

  if (!COMMANDS.some((c) => c.name === command)) {
    addNote(command || "?", `No such command. Type \`/\` to see them all.`, true);
    return;
  }

  if (command === "retry") return await retryCommand(args);

  if (command === "clear") return await clearChannel();

  const sendArgs = args;
  const { data, error } = await supabase.functions.invoke("admin-command", {
    body: { command, args: sendArgs, channel_id: state.channel.id },
  });

  if (error) {
    let detail = error.message;
    try {
      const parsed = await error.context?.json?.();
      if (parsed?.error) detail = parsed.error;
    } catch { /* fall back to the generic message */ }
    addNote(command, detail, true);
    return;
  }

  addNote(command, data?.text ?? "Done.");

  // /model changes stored state the sidebar is showing, and /invite changes
  // who the people list should contain.
  if (command === "model") await loadAgents();
  if (command === "invite") await loadPeople();
}

// Rerun the last thing you asked an agent, on a different model, without
// touching the stored default. The reply is a real message: everyone sees it.
async function retryCommand(args) {
  const last = [...state.messages]
    .reverse()
    .find((m) => m.author_id === state.me.id && mentionedAgent(m.body));

  if (!last) {
    addNote("retry", "Nothing of yours in this channel has addressed an agent yet.", true);
    return;
  }

  const agent = mentionedAgent(last.body);
  let model = null;

  if (args.length) {
    const { data, error } = await supabase.functions.invoke("admin-command", {
      body: { command: "resolve", args, channel_id: state.channel.id },
    });
    if (error) {
      addNote("retry", "Could not check that model.", true);
      return;
    }
    if (!data?.model) {
      addNote("retry", data?.text ?? "That model could not be resolved.", true);
      return;
    }
    model = data.model;
  }

  addNote(
    "retry",
    `Re-asking **@${agent.slug}**` + (model ? ` on \`${model}\`` : " on its current model") +
      `:\n\n> ${last.body.slice(0, 200)}`,
  );

  await invoke(agent, last.body, model);
}

el.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = el.input.value.trim();
  const ready = state.tray.filter((t) => t.path);
  if ((!body && !ready.length) || !state.channel) return;

  // An upload still in flight would be dropped silently from the message, so
  // wait for it rather than sending half of what was attached.
  if (state.tray.some((t) => !t.path && !t.error)) {
    el.hint.className = "hint";
    el.hint.textContent = "Still uploading...";
    return;
  }

  // Commands are intercepted before the insert, which is the whole reason
  // nobody else ever sees one: no row, so no realtime event, and nothing in
  // the transcript invoke-agent hands the model as history.
  if (state.me?.is_admin && body.startsWith("/")) {
    el.input.value = "";
    el.input.style.height = "auto";
    el.palette.hidden = true;
    state.paletteAt = -1;
    el.send.disabled = true;
    try {
      await runCommand(body);
    } finally {
      el.send.disabled = false;
      updateHint();
      el.input.focus();
    }
    return;
  }

  el.send.disabled = true;
  el.input.value = "";
  el.input.style.height = "auto";

  const { data: posted, error } = await supabase
    .from("messages")
    .insert({
      channel_id: state.channel.id,
      author_id: state.me.id,
      body,
      attachments: ready.map((t) => ({
        path: t.path,
        name: t.file.name,
        type: t.file.type,
        width: t.width ?? null,
        height: t.height ?? null,
      })),
    })
    .select("id, channel_id, author_id, agent_slug, body, status, metadata, attachments, created_at")
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
  for (const t of state.tray) URL.revokeObjectURL(t.preview);
  state.tray = [];
  renderTray();

  await signShots([posted]);

  if (!state.messages.some((m) => m.id === posted.id)) {
    state.messages.push(posted);
    renderMessages();
  }

  const agent = mentionedAgent(body);
  if (agent && state.me.can_invoke_agent) await invoke(agent, body);

  updateHint();
  el.input.focus();
});

async function invoke(agent, prompt, modelOverride = null) {
  const { error } = await supabase.functions.invoke("invoke-agent", {
    body: {
      channel_id: state.channel.id,
      agent: agent.slug,
      prompt,
      ...(modelOverride ? { model_override: modelOverride } : {}),
    },
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
