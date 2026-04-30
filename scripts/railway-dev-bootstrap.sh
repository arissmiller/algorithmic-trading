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

echo "[railway-dev-bootstrap] Done. Next commands:"
echo "  npm run railway:status:dev"
echo "  npm run dev:railway"
echo "  npm run railway:deploy:dev:frontend"
echo "  npm run railway:deploy:dev:data"
echo "  npm run railway:deploy:dev:auth"
