#!/usr/bin/env bash
set -euo pipefail

# Fetches a short-lived access token from Cisco OAuth and runs the suggester
# against the OpenAI-compatible gateway configured in .env (OPENAI_BASE_URL).
# Required env vars:
#   CISCO_OAUTH_BASIC    base64 client credentials for id.cisco.com
# Optional:
#   OPENAI_USER_APPKEY   appkey value; if set, sent as {"appkey":"..."} in OPENAI_USER
#
# Usage:
#   CISCO_OAUTH_BASIC=... OPENAI_USER_APPKEY=... scripts/run-bridge.sh \
#     --diff /tmp/diff.patch --docs-map docs-map.yaml --docs-repo <owner/repo> --docs-branch main --out-dir suggestions

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${CISCO_OAUTH_BASIC:-}" ]]; then
  echo "CISCO_OAUTH_BASIC is required (base64 client credentials for id.cisco.com)" >&2
  exit 1
fi

if [[ -z "${OPENAI_BASE_URL:-}" ]]; then
  echo "OPENAI_BASE_URL must be set (e.g., https://chat-ai.cisco.com/openai/deployments/gpt-4o-mini)" >&2
  exit 1
fi

echo "Fetching access token from id.cisco.com..."
access_token="$(
  curl -s -X POST "https://id.cisco.com/oauth2/default/v1/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Authorization: Basic ${CISCO_OAUTH_BASIC}" \
    -d "grant_type=client_credentials" \
  | node -e "const fs=require('fs');const d=fs.readFileSync(0,'utf8')||'{}';try{const j=JSON.parse(d);console.log(j.access_token||'');}catch{console.log('');}"
)"

if [[ -z "$access_token" || "$access_token" == "null" ]]; then
  echo "Failed to obtain access token (empty response)" >&2
  exit 1
fi

export OPENAI_API_KEY="$access_token"

if [[ -n "${OPENAI_USER_APPKEY:-}" ]]; then
  export OPENAI_USER="{\"appkey\":\"${OPENAI_USER_APPKEY}\"}"
fi

cmd=(npx ts-node src/index.ts "$@")
echo "Running: ${cmd[*]}"
"${cmd[@]}"
