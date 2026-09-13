#!/usr/bin/env bash
# Mint a sign-in link without sending email.
#
# Useful when SMTP is misconfigured, when onboarding someone whose mail is
# slow, or when you simply do not want to spend a rate-limited message to test
# something. The link it prints is a single-use credential for the named
# account, so treat it like a password: paste it straight into the browser and
# do not forward it.
#
# The service role key bypasses row level security entirely. It is read from
# the environment so it never ends up in this file or in shell history.
#
#   export SUPABASE_SERVICE_ROLE_KEY='...'   # Project Settings -> API Keys
#   ./tools/magic-link.sh [email] [redirect-url]
#
# Defaults to metaphorz@gmail.com against the local dev server.

set -euo pipefail

PROJECT_URL="https://strqudnflohtwsmxqtpv.supabase.co"
EMAIL="${1:-metaphorz@gmail.com}"
REDIRECT="${2:-http://localhost:8000}"

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "SUPABASE_SERVICE_ROLE_KEY is not set." >&2
  echo "Find it under Project Settings -> API Keys (service_role / secret)," >&2
  echo "then: export SUPABASE_SERVICE_ROLE_KEY='...'" >&2
  exit 1
fi

response=$(curl -s -X POST "$PROJECT_URL/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\",\"redirect_to\":\"$REDIRECT\"}")

python3 - "$response" <<'PY'
import json, sys

try:
    body = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print("Unexpected response:\n" + sys.argv[1], file=sys.stderr)
    sys.exit(1)

link = body.get("properties", {}).get("action_link")
if link:
    print("\nOpen this in your browser (single use):\n")
    print(link + "\n")
else:
    print("No link returned. Supabase said:\n", file=sys.stderr)
    print(json.dumps(body, indent=2), file=sys.stderr)
    sys.exit(1)
PY
