#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-development}"

die() {
  echo "[railway-dev-bootstrap] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_cmd railway
require_cmd grep

if ! railway whoami >/dev/null 2>&1; then
  die "Railway CLI is not authenticated. Run: railway login"
fi

if ! railway status >/dev/null 2>&1; then
  die "This repo is not linked to a Railway project. Run: railway link"
fi

echo "[railway-dev-bootstrap] Ensuring environment '$ENV_NAME' exists..."
bootstrap_log="$(mktemp)"
trap 'rm -f "$bootstrap_log"' EXIT

if railway environment new "$ENV_NAME" --duplicate production >"$bootstrap_log" 2>&1; then
  echo "[railway-dev-bootstrap] Created environment '$ENV_NAME' (duplicated from production)."
else
  if grep -qi "already exists" "$bootstrap_log"; then
    echo "[railway-dev-bootstrap] Environment '$ENV_NAME' already exists."
  else
    echo "[railway-dev-bootstrap] Could not auto-create '$ENV_NAME'. CLI output:"
    cat "$bootstrap_log"
    echo "[railway-dev-bootstrap] Continuing and trying to link existing environment..."
  fi
fi

echo "[railway-dev-bootstrap] Linking local context to '$ENV_NAME'..."
railway environment link "$ENV_NAME"

echo "[railway-dev-bootstrap] Validating service topology..."
services_output="$(railway service list --environment "$ENV_NAME")"
required_services=(frontend data-service dispatch-service)
missing_services=()

for service in "${required_services[@]}"; do
  if ! printf '%s\n' "$services_output" | grep -Eq "^${service}( \(linked\))?$"; then
    missing_services+=("$service")
  fi
done

if [[ ${#missing_services[@]} -gt 0 ]]; then
  echo "[railway-dev-bootstrap] Missing required services in '$ENV_NAME': ${missing_services[*]}"
  echo "[railway-dev-bootstrap] Add them before running dev or deploy commands. Example: railway add --service dispatch-service"
fi

extract_service_url() {
  local target_service="$1"
  printf '%s\n' "$services_output" | awk -v service="$target_service" '
    $0 ~ "^" service "( \\(linked\\))?$" { in_service=1; next }
    in_service && $1 == "url:" { print $2; exit }
    in_service && $0 ~ /^[^[:space:]]/ { in_service=0 }
  '
}

read_variable() {
  local service="$1"
  local variable_name="$2"
  railway variable list --service "$service" --environment "$ENV_NAME" --kv 2>/dev/null \
    | sed -n "s/^${variable_name}=//p" \
    | head -n 1
}

data_url="$(extract_service_url data-service)"
frontend_url="$(extract_service_url frontend)"

frontend_api_base="$(read_variable frontend VITE_API_BASE_URL)"
data_allowed_origins="$(read_variable data-service ALLOWED_ORIGINS)"
dispatch_allowed_origins="$(read_variable dispatch-service ALLOWED_ORIGINS)"

if [[ -z "$frontend_api_base" && -n "$data_url" ]]; then
  echo "[railway-dev-bootstrap] Missing frontend VITE_API_BASE_URL."
  echo "[railway-dev-bootstrap] Set it with: railway variable set --service frontend --environment $ENV_NAME VITE_API_BASE_URL=$data_url"
fi

if [[ -n "$frontend_url" && -z "$data_allowed_origins" ]]; then
  echo "[railway-dev-bootstrap] data-service ALLOWED_ORIGINS is not set. Recommended value: $frontend_url"
fi

if [[ -n "$frontend_url" && -z "$dispatch_allowed_origins" ]]; then
  echo "[railway-dev-bootstrap] dispatch-service ALLOWED_ORIGINS is not set. Recommended value: $frontend_url"
fi

echo "[railway-dev-bootstrap] Done. Next commands:"
echo "  npm run railway:status:dev"
echo "  npm run dev:railway"
echo "  npm run railway:deploy:dev:frontend"
echo "  npm run railway:deploy:dev:data"
echo "  npm run railway:deploy:dev:dispatch"
