#!/usr/bin/env bash
set -euo pipefail

# Local preflight for doc-suggest workflow auth.
# Validates:
# 1) Cisco OAuth token mint (if BRIDGE_OAUTH_BASIC/CISCO_OAUTH_BASIC is set)
# 2) Docs repo access with GITHUB_TOKEN
# 3) Chat-AI auth with minted/static token
#
# Usage:
#   scripts/preflight-doc-suggest.sh
# Optional env:
#   BRIDGE_OAUTH_BASIC or CISCO_OAUTH_BASIC
#   BRIDGE_OAUTH_SCOPE (default: customscope)
#   AZURE_OPENAI_API_KEY or OPENAI_API_KEY (fallback static token)
#   GITHUB_TOKEN
#   DOCS_REPO (default: girishshankaran/docops-copilot-docs)
#   OPENAI_BASE_URL (default: https://chat-ai.cisco.com/openai/deployments/gpt-4o-mini)
#   OPENAI_MODEL (default: gpt-4o-mini)
#   OPENAI_USER or BRIDGE_API_APP_KEY or OPENAI_USER_APPKEY

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

DOCS_REPO="${DOCS_REPO:-girishshankaran/docops-copilot-docs}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://chat-ai.cisco.com/openai/deployments/gpt-4o-mini}"
OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o-mini}"
BRIDGE_OAUTH_SCOPE="${BRIDGE_OAUTH_SCOPE:-customscope}"
OAUTH_BASIC="${BRIDGE_OAUTH_BASIC:-${CISCO_OAUTH_BASIC:-}}"
API_KEY="${AZURE_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"

echo "[1/3] Resolving API token..."
if [[ -n "${OAUTH_BASIC}" ]]; then
  token_json="$(
    curl -sS -X POST "https://id.cisco.com/oauth2/default/v1/token" \
      -H "Authorization: Basic ${OAUTH_BASIC}" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data "grant_type=client_credentials&scope=${BRIDGE_OAUTH_SCOPE}"
  )"
  minted_token="$(echo "${token_json}" | jq -r '.access_token // empty')"
  if [[ -z "${minted_token}" ]]; then
    echo "ERROR: token mint failed." >&2
    echo "${token_json}" | jq -c '{error,error_description,errorCode,errorSummary}' >&2 || true
    exit 1
  fi
  API_KEY="${minted_token}"
  echo "OK: minted Cisco access token."
elif [[ -n "${API_KEY}" ]]; then
  echo "OK: using static AZURE_OPENAI_API_KEY/OPENAI_API_KEY fallback."
else
  echo "ERROR: no OAuth basic secret and no static API key found." >&2
  exit 1
fi

echo "[2/3] Validating docs repo access..."
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN is missing." >&2
  exit 1
fi
gh_code="$(
  curl -sS -o /tmp/local_docs_auth_check.json -w "%{http_code}" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${DOCS_REPO}"
)"
if [[ "${gh_code}" -lt 200 || "${gh_code}" -ge 300 ]]; then
  echo "ERROR: docs repo auth failed (HTTP ${gh_code})." >&2
  head -c 500 /tmp/local_docs_auth_check.json >&2 || true
  echo >&2
  exit 1
fi
echo "OK: docs repo access passed for ${DOCS_REPO}."

echo "[3/3] Validating LLM auth..."
OPENAI_USER_JSON="${OPENAI_USER:-}"
if [[ -z "${OPENAI_USER_JSON}" && -n "${BRIDGE_API_APP_KEY:-}" ]]; then
  OPENAI_USER_JSON="{\"appkey\":\"${BRIDGE_API_APP_KEY}\"}"
fi
if [[ -z "${OPENAI_USER_JSON}" && -n "${OPENAI_USER_APPKEY:-}" ]]; then
  OPENAI_USER_JSON="{\"appkey\":\"${OPENAI_USER_APPKEY}\"}"
fi
if [[ -z "${OPENAI_USER_JSON}" ]]; then
  echo "ERROR: OPENAI_USER is missing (set OPENAI_USER or BRIDGE_API_APP_KEY)." >&2
  exit 1
fi

llm_url="${OPENAI_BASE_URL%/}/chat/completions"
jq -n \
  --arg model "${OPENAI_MODEL}" \
  --arg user "${OPENAI_USER_JSON}" \
  '{model:$model,user:$user,messages:[{role:"user",content:"ping"}],max_tokens:1}' \
  > /tmp/local_llm_preflight_payload.json

llm_code="$(
  curl -sS -o /tmp/local_llm_auth_check.json -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "api-key: ${API_KEY}" \
    -X POST "${llm_url}" \
    -d @/tmp/local_llm_preflight_payload.json
)"
if [[ "${llm_code}" -lt 200 || "${llm_code}" -ge 300 ]]; then
  echo "ERROR: LLM auth failed (HTTP ${llm_code})." >&2
  head -c 700 /tmp/local_llm_auth_check.json >&2 || true
  echo >&2
  exit 1
fi
echo "OK: LLM auth check passed."
echo "Preflight passed."
