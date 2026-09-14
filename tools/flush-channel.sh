#!/usr/bin/env bash
# Empty a channel without destroying it.
#
# #general is meant to be cleared out now and then. That is a different act
# from archiving a channel: the channel row stays, its messages go. Nothing
# cascades, no bindings are lost, and the channel is there to talk in again a
# second later.
#
# It still writes the conversation to a local file first. Deleted messages are
# not recoverable from Supabase, and a backup that takes one second to make is
# cheaper than finding out afterwards that something in there mattered.
#
# Deletion needs the service role -- row level security lets a member delete
# only their own messages, never an agent's -- so this goes through the
# Management API with the personal access token.
#
#   export SUPABASE_ACCESS_TOKEN='...'       # ~/.env has one
#   ./tools/flush-channel.sh general [backup-dir]
#
# Add --yes to skip the confirmation prompt.

set -euo pipefail

PROJECT_REF="strqudnflohtwsmxqtpv"
API="https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"

ASSUME_YES=0
args=()
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    *) args+=("$a") ;;
  esac
done

SLUG="${args[0]:-general}"
BACKUP_DIR="${args[1]:-.}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "It lives in ~/.env; or make a new one at" >&2
  echo "https://supabase.com/dashboard/account/tokens" >&2
  exit 1
fi

# Run one SQL statement and print the JSON result.
query() {
  curl -s -X POST "$API" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @<(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")
}

esc_slug=${SLUG//\'/\'\'}

rows=$(query "
  select m.id, m.body, m.status, m.created_at,
         coalesce(a.display_name, p.display_name, 'someone') as speaker,
         (m.agent_slug is not null) as is_agent
  from public.messages m
  join public.channels c on c.id = m.channel_id
  left join public.members p on p.id = m.author_id
  left join public.agents  a on a.slug = m.agent_slug
  where c.slug = '$esc_slug'
  order by m.created_at;
")

backup=$(python3 - "$rows" "$SLUG" "$BACKUP_DIR" <<'PY'
import datetime, json, os, sys

rows, slug, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    messages = json.loads(rows)
except json.JSONDecodeError:
    print("Unexpected response from Supabase:\n" + rows, file=sys.stderr)
    sys.exit(1)

if isinstance(messages, dict):          # an error body, not a result set
    print(json.dumps(messages, indent=2), file=sys.stderr)
    sys.exit(1)

if not messages:
    print("EMPTY")
    sys.exit(0)

stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
path = os.path.join(out_dir, f"{slug}-{stamp}.md")

lines = [f"# #{slug} — flushed {stamp}", ""]
for m in messages:
    who = m["speaker"] + (" (AI)" if m["is_agent"] else "")
    lines.append(f"**{who}** · {m['created_at']}")
    lines.append("")
    lines.append(m["body"] or "")
    lines.append("")

with open(path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))

print(f"{len(messages)}\t{path}")
PY
)

if [ "$backup" = "EMPTY" ]; then
  echo "#$SLUG has no messages. Nothing to flush."
  exit 0
fi

count=${backup%%$'\t'*}
path=${backup##*$'\t'}

echo "#$SLUG holds $count message(s)."
echo "Saved a transcript to $path"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Delete all %s message(s) from #%s? [y/N] ' "$count" "$SLUG"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Left alone."; exit 0 ;;
  esac
fi

query "
  delete from public.messages
  where channel_id = (select id from public.channels where slug = '$esc_slug');
" > /dev/null

echo "#$SLUG is empty. The channel itself is untouched."
